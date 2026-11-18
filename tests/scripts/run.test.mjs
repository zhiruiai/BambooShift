import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../scripts/run.mjs', import.meta.url));

test('the command runner preserves success, failure and signal termination', () => {
  function run(expression) {
    const child = spawnSync(process.execPath, [runner, '-e', expression], { encoding: 'utf8' });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    return child.status;
  }

  assert.equal(run('process.exit(0)'), 0);
  assert.equal(run('process.exit(17)'), 17);
  const terminated = run('process.kill(process.pid, "SIGTERM")');
  if (process.platform === 'win32') assert.ok(terminated > 0);
  else assert.equal(terminated, 128 + constants.signals.SIGTERM);
});
