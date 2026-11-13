import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the documented standalone plugin example runs without a model, account or tool grant', () => {
  const example = fileURLToPath(new URL('./examples/minimal-plugin.fixture.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'tsx', example], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    plugin: 'example-lifecycle',
    activeTimers: 0,
    cleanupCalls: 1,
    toolCalls: 0,
  });
});
