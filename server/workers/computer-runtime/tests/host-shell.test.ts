import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { HostShellRunner } from '../host-shell.js';
import { validateComputerAction } from '../../computer-worker/protocol.js';
import { REMOTE_SHELL_MAX_OUTPUT_BYTES } from '../../../../shared/isolated-shell.js';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'bambooshift-command-'));
  const runner = new HostShellRunner(dir, true);
  t.after(async () => {
    await runner.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, runner };
}

test('personal command opt-in is separate from readonly and isolated terminal capabilities', async (t) => {
  const { dir, runner } = await fixture(t);
  await assert.rejects(new HostShellRunner(dir).run('printf denied'), /尚未启用/);
  assert.throws(() =>
    validateComputerAction({ type: 'terminal_command', command: 'printf denied' }),
  );
  assert.deepEqual(validateComputerAction({ type: 'local_shell', command: 'printf allowed' }), {
    type: 'local_shell',
    command: 'printf allowed',
    path: '.',
  });
  for (const path of ['../outside', '/outside', 'bad\0path'])
    await assert.rejects(runner.run('true', path));
  const result = await runner.run(
    'printf synthetic > result.txt; printf done; printf problem >&2; exit 7',
  );
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'done');
  assert.equal(result.stderr, 'problem');
  assert.equal(await readFile(join(dir, 'result.txt'), 'utf8'), 'synthetic');
  assert.equal(result.cancelled, false);
});

test('cancelling a command waits for its process group and prevents delayed writes', async (t) => {
  const { dir, runner } = await fixture(t);
  const abort = new AbortController();
  const command = runner.run(
    'printf ready > started; sleep 1; printf unsafe > late',
    '.',
    abort.signal,
  );
  for (let i = 0; i < 100; i++) {
    if (
      await access(join(dir, 'started')).then(
        () => true,
        () => false,
      )
    )
      break;
    await pause(10);
  }
  await access(join(dir, 'started'));
  await assert.rejects(runner.run('printf overlapping'), /正在执行/);
  abort.abort();
  const result = await command;
  assert.equal(result.cancelled, true);
  await pause(1100);
  await assert.rejects(access(join(dir, 'late')));
  assert.equal((await runner.run('printf next')).stdout, 'next');
  await runner.close();
  await assert.rejects(runner.run('true'), /尚未启用/);
});

test('normal shell exit waits for redirected background processes in its group to stop', async (t) => {
  const { dir, runner } = await fixture(t);
  const groupFile = join(dir, 'process-group');
  try {
    const result = await runner.run(
      [
        'printf %s "$$" > process-group;',
        '(trap "" TERM; printf ready > background-ready; sleep 1; printf unsafe > late)',
        '</dev/null >/dev/null 2>&1 &',
        'while [ ! -f background-ready ]; do sleep 0.01; done;',
        'printf complete',
      ].join(' '),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'complete');
    assert.equal(result.cancelled, false);
    const group = Number(await readFile(groupFile, 'utf8'));
    assert.ok(Number.isSafeInteger(group) && group > 1);
    assert.throws(
      () => process.kill(-group, 0),
      { code: 'ESRCH' },
      'A successful result must not leave the original process group running',
    );
    await pause(1100);
    await assert.rejects(access(join(dir, 'late')), { code: 'ENOENT' });
    assert.equal((await runner.run('printf next')).stdout, 'next');
  } finally {
    // A failed regression must not leave even this synthetic background writer alive.
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

test('local shell output is bounded and service credentials are not inherited', async (t) => {
  const { runner } = await fixture(t);
  const key = 'BAMBOOSHIFT_TEST_SERVICE_SECRET';
  const old = process.env[key];
  process.env[key] = 'synthetic-secret';
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
  assert.equal((await runner.run('printf "%s" "$BAMBOOSHIFT_TEST_SERVICE_SECRET"')).stdout, '');
  const result = await runner.run('yes synthetic');
  assert.equal(result.truncated, true);
  assert.ok(
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <=
      REMOTE_SHELL_MAX_OUTPUT_BYTES,
  );
});

test('shell exit cleans up children that still hold its output pipes', async (t) => {
  const { dir, runner } = await fixture(t);
  const groupFile = join(dir, 'process-group');
  try {
    const result = await runner.run('printf %s "$$" > process-group; sleep 10 & printf complete');
    assert.equal(result.stdout, 'complete');
    assert.equal(result.timedOut, false);
    assert.ok(
      result.durationMs < 5000,
      'Inherited output must not keep the command alive for 10 seconds',
    );
    const group = Number(await readFile(groupFile, 'utf8'));
    assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' });
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

test('an unconfirmed process group disables the runner instead of acknowledging cleanup', async (t) => {
  const { dir, runner } = await fixture(t);
  const abort = new AbortController();
  const running = runner.run('printf %s "$$" > process-group; sleep 10', '.', abort.signal);
  const rejected = assert.rejects(running, (error: any) => error.cleanupConfirmed === false);
  const kill = process.kill.bind(process);
  try {
    for (let i = 0; i < 100; i++) {
      if (
        await access(join(dir, 'process-group')).then(
          () => true,
          () => false,
        )
      )
        break;
      await pause(10);
    }
    await access(join(dir, 'process-group'));
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0 && signal === 0)
        throw Object.assign(Error('Cannot inspect group'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    abort.abort();
    await rejected;
    assert.equal(await runner.available(), false);
    await assert.rejects(runner.run('printf unsafe'), /尚未启用/);
  } finally {
    t.mock.restoreAll();
    abort.abort();
    const group = Number(await readFile(join(dir, 'process-group'), 'utf8').catch(() => '0'));
    if (Number.isSafeInteger(group) && group > 1) {
      try {
        kill(-group, 'SIGKILL');
      } catch (error: any) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await running.catch(() => {});
  }
});
