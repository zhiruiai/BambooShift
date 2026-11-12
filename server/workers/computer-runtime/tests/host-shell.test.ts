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
  t.after(async () => { await runner.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, runner };
}

test('personal command opt-in is separate from readonly and isolated terminal capabilities', async (t) => {
  const { dir, runner } = await fixture(t);
  await assert.rejects(new HostShellRunner(dir).run('printf denied'), /尚未启用/);
  assert.throws(() => validateComputerAction({ type: 'terminal_command', command: 'printf denied' }));
  assert.deepEqual(validateComputerAction({ type: 'local_shell', command: 'printf allowed' }),
    { type: 'local_shell', command: 'printf allowed', path: '.' });
  for (const path of ['../outside', '/outside', 'bad\0path'])
    await assert.rejects(runner.run('true', path));
  const result = await runner.run('printf synthetic > result.txt; printf done; printf problem >&2; exit 7');
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'done');
  assert.equal(result.stderr, 'problem');
  assert.equal(await readFile(join(dir, 'result.txt'), 'utf8'), 'synthetic');
  assert.equal(result.cancelled, false);
});

test('cancelling a command waits for its process group and prevents delayed writes', async (t) => {
  const { dir, runner } = await fixture(t);
  const abort = new AbortController();
  const command = runner.run('printf ready > started; sleep 1; printf unsafe > late', '.', abort.signal);
  for (let i = 0; i < 100; i++) {
    if (await access(join(dir, 'started')).then(() => true, () => false)) break;
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

test('local shell output is bounded and service credentials are not inherited', async (t) => {
  const { runner } = await fixture(t);
  const key = 'BAMBOOSHIFT_TEST_SERVICE_SECRET';
  const old = process.env[key];
  process.env[key] = 'synthetic-secret';
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  assert.equal((await runner.run('printf "%s" "$BAMBOOSHIFT_TEST_SERVICE_SECRET"')).stdout, '');
  const result = await runner.run('yes synthetic');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= REMOTE_SHELL_MAX_OUTPUT_BYTES);
});
