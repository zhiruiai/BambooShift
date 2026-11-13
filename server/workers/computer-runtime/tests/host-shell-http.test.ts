import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComputerWorker } from '../http/worker.js';
import { WORKSPACE_SCOPE_HEADER } from '../../../../shared/computer-screens.js';
import { desktop, listen, until, exists, delay, token } from './isolated-shell.fixture.js';

async function fixture(t: test.TestContext, hostShell = true) {
  const dir = await mkdtemp(join(tmpdir(), 'host-shell-http-'));
  const workspace = join(dir, 'workspace');
  const workspaceId = randomUUID();
  const worker = createComputerWorker({
    token,
    workspaceDir: workspace,
    workspaceScopeId: workspaceId,
    hostShell,
    desktopAdapter: desktop(),
  });
  const server = await listen(worker.app);
  const health = await (
    await fetch(server.base + '/health', {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-OpenBot-Worker-Instance': health.instanceId,
    'X-OpenBot-Control-Origin': health.controlOrigin ?? 'none',
    [WORKSPACE_SCOPE_HEADER]: workspaceId,
  };
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(server.base + path, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  const command = (command: string, path = '.', id = randomUUID()) =>
    post('/execute', { type: 'local_shell', command, path }, { 'X-OpenBot-Action-Id': id });
  const currentHealth = () => fetch(server.base + '/health', { headers });
  t.after(async () => {
    await worker.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { workspace, post, command, health, currentHealth };
}

test('host shell preflight directory failures do not poison the worker or consume future approvals', async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const failure = await f.command('printf must-not-run > marker', 'missing-dir', id);
  assert.equal(failure.status, 400);
  assert.equal(await exists(join(f.workspace, 'marker')), false);
  const health = await f.currentHealth();
  assert.equal(health.status, 200);
  assert.ok((await health.json()).capabilities.includes('local-shell-v1'));
  const cleanup = await f.post('/shell/cancel', { id });
  assert.equal(cleanup.status, 200);
  assert.equal((await cleanup.json()).stopped, true);
  const next = await f.command('printf next');
  assert.equal(next.status, 200);
  assert.equal((await next.json()).stdout, 'next');
  assert.equal((await f.command('printf must-not-replay > marker', '.', id)).status, 400);
  assert.equal(await exists(join(f.workspace, 'marker')), false);
});

test('host shell requires opt-in, server token, current workspace and a unique action identity', async (t) => {
  const disabled = await fixture(t, false);
  assert.equal(disabled.health.capabilities.includes('local-shell-v1'), false);
  assert.equal((await disabled.command('printf blocked > marker')).status, 400);
  assert.equal(await exists(join(disabled.workspace, 'marker')), false);
  const enabled = await fixture(t);
  const action = { type: 'local_shell', command: 'printf blocked > marker' };
  assert.equal((await enabled.post('/execute', action)).status, 400);
  assert.equal(
    (
      await enabled.post('/execute', action, {
        'X-OpenBot-Action-Id': randomUUID(),
        Authorization: 'Bearer invalid',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await enabled.post('/execute', action, {
        'X-OpenBot-Action-Id': randomUUID(),
        [WORKSPACE_SCOPE_HEADER]: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await enabled.post('/execute', action, {
        'X-OpenBot-Action-Id': randomUUID(),
        Origin: 'https://example.invalid',
      })
    ).status,
    403,
  );
  assert.equal(await exists(join(enabled.workspace, 'marker')), false);
  assert.equal((await enabled.command('printf permitted')).status, 200);
});

test('host shell cancellation waits for the tracked process and rejects delayed replays', async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const pending = f.command('printf ready > started; sleep 1; printf unsafe > late', '.', id);
  await until(() => exists(join(f.workspace, 'started')));
  const stopped = await f.post('/shell/cancel', { id });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).stopped, true);
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal((await result.json()).cancelled, true);
  await delay(1100);
  assert.equal(await exists(join(f.workspace, 'late')), false);
  assert.equal((await f.command('printf late > replayed', '.', id)).status, 400);
  const beforeDispatch = randomUUID();
  assert.equal((await f.post('/shell/cancel', { id: beforeDispatch })).status, 200);
  assert.equal((await f.command('printf late > replayed', '.', beforeDispatch)).status, 400);
  assert.equal(await exists(join(f.workspace, 'replayed')), false);
  assert.equal((await f.command('printf safe')).status, 200);
});

test('cancel and takeover confirm cleanup after a shell exits with redirected background children', async (t) => {
  const f = await fixture(t);
  const groupFile = join(f.workspace, 'process-group');
  try {
    const id = randomUUID();
    const response = await f.command(
      [
        'printf %s "$$" > process-group;',
        '(trap "" TERM; printf ready > background-ready; sleep 1; printf unsafe > late)',
        '</dev/null >/dev/null 2>&1 &',
        'while [ ! -f background-ready ]; do sleep 0.01; done;',
        'printf complete',
      ].join(' '),
      '.',
      id,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'complete');
    assert.equal(result.cancelled, false);
    const cancelled = await f.post('/shell/cancel', { id });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).stopped, true);
    assert.equal((await f.post('/surface', { surface: 'desktop', confirm: true })).status, 200);
    const takeover = await f.post('/takeover/start', {});
    assert.equal(takeover.status, 200);
    const lease = await takeover.json();
    assert.equal(lease.active, true);
    const group = Number(await readFile(groupFile, 'utf8'));
    assert.ok(Number.isSafeInteger(group) && group > 1);
    assert.throws(
      () => process.kill(-group, 0),
      { code: 'ESRCH' },
      'Stopped and takeover acknowledgements require the original process group to be gone',
    );
    await delay(1100);
    assert.equal(await exists(join(f.workspace, 'late')), false);
    assert.equal((await f.post('/takeover/end', { leaseId: lease.leaseId })).status, 200);
    assert.equal((await f.currentHealth()).status, 200);
    assert.equal((await f.command('printf safe')).status, 200);
  } finally {
    const group = Number(await readFile(groupFile, 'utf8').catch(() => '0'));
    if (Number.isSafeInteger(group) && group > 1) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch (error: any) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
});

test('host shell remains blocked during private human takeover and can resume after release', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post('/surface', { surface: 'desktop', confirm: true })).status, 200);
  const takeover = await f.post('/takeover/start', {});
  assert.equal(takeover.status, 200);
  const { leaseId } = await takeover.json();
  assert.equal((await f.command('printf blocked > marker')).status, 400);
  assert.equal(await exists(join(f.workspace, 'marker')), false);
  assert.equal((await f.post('/takeover/end', { leaseId })).status, 200);
  const resumed = await f.command('printf resumed');
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).stdout, 'resumed');
});
