import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import { readFile } from 'node:fs/promises';

import { join } from 'node:path';

import test from 'node:test';

import { LocalComputer, validateComputerAction } from '../../computer-worker/index.js';

import { IsolatedShellRunner, validateShellInput } from '../isolated-shell.js';

import { connected, delay, desktop, exists, fixture, until } from './isolated-shell.fixture.js';

test('remote shell validates bounded command/relative cwd and never falls through to local spawn', async () => {
  for (const command of ['', ' ', 'x'.repeat(16001), 'bad\0text'])
    assert.throws(() => validateShellInput(command));
  for (const path of ['/tmp', '../x', 'a/../b', 'a\\b', 'bad\0path', ''])
    assert.throws(() => validateShellInput('ok', path));
  assert.deepEqual(
    validateComputerAction({ type: 'remote_shell', command: 'printf hello', timeoutMs: 999999 }),
    { type: 'remote_shell', command: 'printf hello', path: '.' },
  );
  assert.throws(
    () => validateComputerAction({ type: 'terminal_command', command: 'printf hello' }),
    /只读命令/,
  );
  const f = await fixture();
  const local = new LocalComputer(f.workspace, undefined, { desktopAdapter: desktop() });
  try {
    await assert.rejects(
      local.execute({ type: 'remote_shell', command: 'anything' }),
      /本机不可执行/,
    );
  } finally {
    await local.close();
    await f.close();
  }
});

test('runner probes fail closed, reports real protocol exit result, and never inherits credentials', async () => {
  const f = await fixture();
  const original = process.env.OPENBOT_WORKER_TOKEN;
  process.env.OPENBOT_WORKER_TOKEN = 'SYNTHETIC_SECRET_MUST_NOT_REACH_CHILD';
  const runner = new IsolatedShellRunner(f.workspace, f.config);
  try {
    assert.equal(await new IsolatedShellRunner(f.workspace).available(), false);
    assert.equal(await new IsolatedShellRunner(join(f.dir, 'wrong'), f.config).available(), false);
    assert.equal(await runner.available(), true);
    const result = await runner.run('success', 'subdir');
    const body = JSON.parse(result.stdout);
    assert.equal(body.request.cwd, 'subdir');
    assert.equal(body.request.timeoutMs, 30_000);
    assert.equal(body.env.OPENBOT_WORKER_TOKEN, undefined);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, 'synthetic stderr');
    assert.equal((await runner.run('timeout')).timedOut, true);
    assert.equal((await runner.run('memory')).resourceLimit, 'memory');
    assert.equal(await runner.available(), true);
    await assert.rejects(
      runner.run('broken'),
      (e: Error) => !e.message.includes('SECRET') && /不可用/.test(e.message),
    );
    assert.equal(await runner.available(), false);
  } finally {
    if (original === undefined) delete process.env.OPENBOT_WORKER_TOKEN;
    else process.env.OPENBOT_WORKER_TOKEN = original;
    await runner.close();
    await f.close();
  }
});

test('runner rejects oversized supervisor results and waits for cancelled cleanup before releasing capacity', async () => {
  const f = await fixture();
  const runner = new IsolatedShellRunner(f.workspace, f.config);
  try {
    const cancel = new AbortController();
    const operation = runner.run('wait', '.', cancel.signal);
    await until(() => exists(join(f.workspace, 'started')));
    cancel.abort();
    await assert.rejects(runner.run('second'), /仍在执行/);
    await delay(50);
    assert.equal(await exists(join(f.workspace, 'stopped')), false);
    const result = await operation;
    assert.equal(result.cancelled, true);
    assert.equal(await exists(join(f.workspace, 'stopped')), true);
    await assert.rejects(runner.run('oversized'), /不可用/);
    assert.equal(await runner.available(), false);
  } finally {
    await runner.close();
    await f.close();
  }
});

test('Worker cancellation tombstone prevents a delayed approved request from running', async () => {
  const f = await connected();
  try {
    const id = randomUUID();
    const cancel = await fetch(f.workerBase + '/shell/cancel', {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ id }),
    });
    assert.equal((await cancel.json()).stopped, true);
    // Result retention is bounded, but an older cancellation must remain a tombstone.
    for (let index = 0; index < 501; index++) {
      const response = await fetch(f.workerBase + '/shell/cancel', {
        method: 'POST',
        headers: f.headers,
        body: JSON.stringify({ id: randomUUID() }),
      });
      assert.equal(response.status, 200);
      await response.json();
    }
    const late = await fetch(f.workerBase + '/execute', {
      method: 'POST',
      headers: { ...f.headers, 'X-OpenBot-Action-Id': id },
      body: JSON.stringify({ type: 'remote_shell', command: 'late' }),
    });
    assert.equal(late.status, 400);
    assert.equal(await exists(join(f.workspace, 'runs.log')), false);
    const invalid = await fetch(f.workerBase + '/shell/cancel', {
      method: 'POST',
      headers: { ...f.headers, 'X-OpenBot-Worker-Instance': randomUUID() },
      body: JSON.stringify({ id: randomUUID() }),
    });
    assert.equal(invalid.status, 409);
  } finally {
    await f.close();
  }
});

test('Worker HTTP disconnection aborts the supervisor and holds its queue until cleanup completes', async () => {
  const f = await connected();
  try {
    const abort = new AbortController();
    const request = fetch(f.workerBase + '/execute', {
      method: 'POST',
      signal: abort.signal,
      headers: { ...f.headers, 'X-OpenBot-Action-Id': randomUUID() },
      body: JSON.stringify({ type: 'remote_shell', command: 'wait' }),
    }).catch(() => undefined);
    await until(() => exists(join(f.workspace, 'started')));
    abort.abort();
    await request;
    const next = fetch(f.workerBase + '/execute', {
      method: 'POST',
      headers: { ...f.headers, 'X-OpenBot-Action-Id': randomUUID() },
      body: JSON.stringify({ type: 'remote_shell', command: 'after-disconnect' }),
    });
    await delay(50);
    assert.equal(await readFile(join(f.workspace, 'runs.log'), 'utf8'), 'wait\n');
    assert.equal((await next).status, 200);
    assert.equal(await exists(join(f.workspace, 'stopped')), true);
  } finally {
    await f.close();
  }
});
