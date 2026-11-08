import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ComputerOperationRegistry } from '../computer-operations.js';

test('operation cancellation waits for real settle and retains replay tombstones', async () => {
  const registry = new ComputerOperationRegistry();
  const id = randomUUID(),
    operation = registry.reserve(id);
  let acknowledged = false;
  const cancellation = registry.cancel(id).then((result) => {
    acknowledged = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operation.abort.signal.aborted, true);
  assert.equal(acknowledged, false);
  registry.settle(operation, new Error('ordinary operation failed after cleanup'));
  assert.deepEqual(await cancellation, { id, stopped: true, cleanupConfirmed: true });
  assert.throws(() => registry.reserve(id), { code: 'OPERATION_REPLAY' });
  assert.deepEqual(await registry.cancel(id), { id, stopped: true, cleanupConfirmed: true });
  const early = randomUUID();
  await registry.cancel(early);
  assert.throws(() => registry.reserve(early), { code: 'OPERATION_REPLAY' });
});

test('unknown cleanup disables only its registry and never acknowledges stopped', async () => {
  const first = new ComputerOperationRegistry(),
    second = new ComputerOperationRegistry();
  const operation = first.reserve(randomUUID());
  first.settle(operation, Object.assign(new Error('unknown'), { cleanupConfirmed: false }));
  await assert.rejects(first.cancel(operation.id), { code: 'OPERATION_CLEANUP_UNKNOWN' });
  assert.throws(() => first.reserve(randomUUID()), { code: 'OPERATION_CLEANUP_UNKNOWN' });
  assert.equal(first.available, false);
  assert.equal(second.available, true);
  assert.throws(() => second.reserve('invalid'), { code: 'INVALID_OPERATION_ID' });
  const bounded = new ComputerOperationRegistry(1);
  await bounded.cancel(randomUUID());
  await assert.rejects(bounded.cancel(randomUUID()), { code: 'OPERATION_REGISTRY_FULL' });
});
