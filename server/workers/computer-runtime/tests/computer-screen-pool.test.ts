import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { COMPUTER_OPERATION_ID_HEADER } from '../../../../shared/computer-operations.js';
import { WORKSPACE_SCOPE_HEADER } from '../../../../shared/computer-screens.js';
import { validateComputerScreenPoolConfiguration } from '../computer-screen-pool.js';

import { deferred, fixture } from './computer-screen-pool.fixture.js';

test('fixed pool inventory, scoped identity and machine-only routes never fall back', async () => {
  const f = await fixture();
  try {
    assert.ok(f.health.capabilities.includes('screen-pool-v1'));
    assert.ok(f.health.capabilities.includes('operation-cleanup-v1'));
    const inventory = await (
      await fetch(f.base + '/screens', { headers: f.machineHeaders })
    ).json();
    assert.deepEqual(inventory.capacity, { max: 2, configured: 2, ready: 2 });
    assert.equal(inventory.workspaceScopeId, f.configuration.workspaceScopeId);
    assert.equal(JSON.stringify(inventory).includes('manifestPath'), false);
    assert.equal(inventory.screens[0].state.instanceId, inventory.screens[1].state.instanceId);
    assert.equal((await fetch(f.url(0, '/health'), { headers: f.machineHeaders })).status, 409);
    assert.equal((await fetch(f.url(0, '/health'), { headers: f.headers(1) })).status, 409);
    assert.equal(
      (
        await fetch(f.url(0, '/health'), {
          headers: { ...f.headers(0), [WORKSPACE_SCOPE_HEADER]: randomUUID() },
        })
      ).status,
      409,
    );
    assert.equal(
      (await fetch(f.base + '/screens/' + randomUUID() + '/health', { headers: f.headers(0) }))
        .status,
      404,
    );
    assert.equal(
      (await f.post(0, '/execute', { type: 'write_file', path: 'no.txt', content: 'no' })).status,
      404,
    );
    assert.equal((await fetch(f.url(0, '/files'), { headers: f.headers(0) })).status, 404);
    assert.equal(
      (
        await fetch(f.base + '/surface', {
          method: 'POST',
          headers: f.machineHeaders,
          body: JSON.stringify({ surface: 'desktop', confirm: true }),
        })
      ).status,
      409,
    );
    const duplicate = structuredClone(f.configuration);
    duplicate.screens[1] = duplicate.screens[0];
    assert.throws(() => validateComputerScreenPoolConfiguration(duplicate));
    assert.throws(() =>
      validateComputerScreenPoolConfiguration({
        ...f.configuration,
        screens: [...f.configuration.screens, f.configuration.screens[0]],
      }),
    );
    const wrong = structuredClone(f.configuration);
    wrong.screens[0].manifestPath = '/tmp/untrusted.json';
    assert.throws(() => validateComputerScreenPoolConfiguration(wrong));
  } finally {
    await f.close();
  }
});

test('different screens execute concurrently; cancellation waits for actual cleanup and blocks replay', async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  let operationSignal: AbortSignal | undefined;
  f.adapters[0].beforeInput = async (signal) => {
    operationSignal = signal;
    entered.resolve();
    await release.promise;
  };
  try {
    const id = randomUUID();
    const first = f.post(0, '/execute', { type: 'desktop_click', x: 1, y: 1 }, id);
    await entered.promise;
    assert.equal(
      (await f.post(1, '/execute', { type: 'desktop_click', x: 2, y: 2 }, randomUUID())).status,
      200,
    );
    let acknowledged = false;
    const cancellation = f.post(0, '/operations/cancel', { id }).then(async (response) => {
      acknowledged = true;
      return response.json();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(operationSignal?.aborted, true);
    assert.equal(acknowledged, false);
    release.resolve();
    await first;
    assert.deepEqual(await cancellation, { id, stopped: true, cleanupConfirmed: true });
    const duplicate = await f.post(0, '/execute', { type: 'desktop_click', x: 1, y: 1 }, id);
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).code, 'OPERATION_REPLAY');
    assert.equal(f.adapters[0].inputs.length, 1);
    const before = randomUUID();
    assert.equal((await f.post(0, '/operations/cancel', { id: before })).status, 200);
    assert.equal(
      (await f.post(0, '/execute', { type: 'desktop_click', x: 1, y: 1 }, before)).status,
      409,
    );
    assert.equal(
      (await f.post(0, '/execute', { type: 'desktop_click', x: 1, y: 1 }, 'bad')).status,
      400,
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

test('socket abort is not cleanup proof; screen-local poison rejects later actions and does not stop the peer', async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  f.adapters[0].beforeInput = async () => {
    entered.resolve();
    await release.promise;
    throw Object.assign(new Error('synthetic cleanup unconfirmed'), {
      code: 'CLEANUP_UNKNOWN',
      cleanupConfirmed: false,
    });
  };
  try {
    const id = randomUUID(),
      abort = new AbortController();
    const first = f
      .post(0, '/execute', { type: 'desktop_click', x: 1, y: 1 }, id, abort.signal)
      .catch(() => undefined);
    await entered.promise;
    abort.abort();
    await first;
    let acknowledged = false;
    const cancellation = f.post(0, '/operations/cancel', { id }).then((response) => {
      acknowledged = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(acknowledged, false);
    release.resolve();
    const response = await cancellation;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'OPERATION_CLEANUP_UNKNOWN');
    assert.equal((await fetch(f.url(0, '/health'), { headers: f.headers(0) })).status, 503);
    assert.equal(
      (await f.post(0, '/execute', { type: 'desktop_click', x: 3, y: 3 }, randomUUID())).status,
      409,
    );
    assert.equal(
      (await f.post(1, '/execute', { type: 'desktop_click', x: 2, y: 2 }, randomUUID())).status,
      200,
    );
    const inventory = await (
      await fetch(f.base + '/screens', { headers: f.machineHeaders })
    ).json();
    assert.equal(inventory.capacity.ready, 1);
    assert.equal(f.adapters[0].inputs.length, 1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('takeover and stale session affect only the selected screen; screenshot and frame operations drain', async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  try {
    const started = await f.post(0, '/takeover/start', {});
    assert.equal(started.status, 200);
    const lease = await started.json();
    const proof = { 'X-OpenBot-Computer-Lease': lease.leaseId };
    const frames = await Promise.all([
      fetch(f.url(0, '/screenshot'), { headers: f.headers(0) }),
      fetch(f.url(0, '/screenshot'), { headers: { ...f.headers(0), ...proof } }),
      fetch(f.url(1, '/screenshot'), { headers: f.headers(1) }),
      fetch(f.url(1, '/screenshot'), { headers: { ...f.headers(1), ...proof } }),
    ]);
    assert.deepEqual(
      frames.map((frame) => frame.status),
      [409, 200, 200, 409],
    );
    assert.equal((await frames[0].json()).code, 'COMPUTER_PRIVATE_TAKEOVER');
    assert.equal((await frames[3].json()).code, 'COMPUTER_PRIVATE_TAKEOVER');
    await Promise.all([frames[1].arrayBuffer(), frames[2].arrayBuffer()]);
    assert.equal(
      (await f.post(0, '/execute', { type: 'desktop_click', x: 1, y: 1 }, randomUUID())).status,
      400,
    );
    assert.equal(
      (await f.post(1, '/execute', { type: 'desktop_click', x: 2, y: 2 }, randomUUID())).status,
      200,
    );
    assert.equal(
      (
        await f.post(
          1,
          '/takeover/input',
          { leaseId: lease.leaseId, type: 'click', x: 1, y: 1 },
          randomUUID(),
        )
      ).status,
      409,
    );
    assert.equal((await f.post(0, '/takeover/end', { leaseId: lease.leaseId })).status, 200);
    f.adapters[0].beforeCapture = async () => {
      entered.resolve();
      await release.promise;
    };
    const id = randomUUID();
    const screenshot = fetch(f.url(0, '/screenshot'), {
      headers: { ...f.headers(0), [COMPUTER_OPERATION_ID_HEADER]: id },
    });
    await entered.promise;
    let finished = false;
    const cancellation = f.post(0, '/operations/cancel', { id }).then((response) => {
      finished = true;
      return response.json();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(finished, false);
    release.resolve();
    await screenshot;
    assert.equal((await cancellation).cleanupConfirmed, true);
    f.adapters[0].generation = randomUUID();
    assert.equal(
      (await f.post(0, '/execute', { type: 'desktop_click', x: 1, y: 1 }, randomUUID())).status,
      400,
    );
    assert.equal(
      (await f.post(1, '/execute-with-frame', { type: 'desktop_click', x: 2, y: 2 }, randomUUID()))
        .status,
      200,
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

test('default machine files have their own replay protection and binary transfer cleanup', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    const execute = (content: string) =>
      fetch(f.base + '/execute', {
        method: 'POST',
        headers: { ...f.machineHeaders, [COMPUTER_OPERATION_ID_HEADER]: id },
        body: JSON.stringify({ type: 'write_file', path: 'shared.txt', content }),
      });
    assert.equal((await execute('one')).status, 200);
    assert.equal((await execute('must-not-overwrite')).status, 409);
    const cancel = await fetch(f.base + '/operations/cancel', {
      method: 'POST',
      headers: f.machineHeaders,
      body: JSON.stringify({ id }),
    });
    assert.deepEqual(await cancel.json(), { id, stopped: true, cleanupConfirmed: true });
    assert.equal(
      await (
        await fetch(f.base + '/files/content?path=shared.txt', { headers: f.machineHeaders })
      ).text(),
      'one',
    );
    const uploadId = randomUUID();
    const uploadHeaders = {
      ...f.machineHeaders,
      'Content-Type': 'application/octet-stream',
      [COMPUTER_OPERATION_ID_HEADER]: uploadId,
    };
    assert.equal(
      (
        await fetch(f.base + '/files/content?path=upload.bin', {
          method: 'PUT',
          headers: uploadHeaders,
          body: Buffer.from([0, 1, 2, 255]),
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await fetch(f.base + '/files/content?path=must-not-create.bin', {
          method: 'PUT',
          headers: uploadHeaders,
          body: Buffer.from([3]),
        })
      ).status,
      409,
    );
    const downloadId = randomUUID();
    const downloadHeaders = { ...f.machineHeaders, [COMPUTER_OPERATION_ID_HEADER]: downloadId };
    const result = await fetch(f.base + '/files/content?path=upload.bin', {
      headers: downloadHeaders,
    });
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), Buffer.from([0, 1, 2, 255]));
    assert.equal(
      (await fetch(f.base + '/files/content?path=upload.bin', { headers: downloadHeaders })).status,
      409,
    );
    assert.equal(
      (
        await fetch(f.base + '/files/content?path=must-not-create.bin', {
          headers: f.machineHeaders,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(f.base + '/operations/cancel', {
          method: 'POST',
          headers: f.machineHeaders,
          body: JSON.stringify({ id: downloadId, ignored: true }),
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test('frame capture with unknown cleanup preserves completed action result but never confirms cleanup', async () => {
  const f = await fixture();
  try {
    f.adapters[0].beforeCapture = async () => {
      throw Object.assign(new Error('synthetic unknown frame cleanup'), {
        cleanupConfirmed: false,
      });
    };
    const id = randomUUID();
    const response = await f.post(
      0,
      '/execute-with-frame',
      { type: 'desktop_click', x: 1, y: 1 },
      id,
    );
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.result.ok, true);
    assert.equal(typeof value.frameUnavailable, 'string');
    assert.equal(value.frame, undefined);
    const cancelled = await f.post(0, '/operations/cancel', { id });
    assert.equal(cancelled.status, 409);
    assert.equal((await cancelled.json()).code, 'OPERATION_CLEANUP_UNKNOWN');
    assert.equal((await fetch(f.url(0, '/health'), { headers: f.headers(0) })).status, 503);
    assert.equal(
      (await f.post(1, '/execute', { type: 'desktop_click', x: 2, y: 2 }, randomUUID())).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test('tracked takeover input cancellation waits for release before acknowledging', async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  f.adapters[0].beforeInput = async () => {
    entered.resolve();
    await release.promise;
  };
  try {
    const lease = await (await f.post(0, '/takeover/start', {})).json();
    const id = randomUUID();
    const input = f.post(
      0,
      '/takeover/input',
      { leaseId: lease.leaseId, type: 'click', x: 1, y: 1 },
      id,
    );
    await entered.promise;
    let acknowledged = false;
    const cancelling = f.post(0, '/operations/cancel', { id }).then((response) => {
      acknowledged = true;
      return response.json();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(acknowledged, false);
    assert.equal(
      (await f.post(1, '/execute', { type: 'desktop_click', x: 2, y: 2 }, randomUUID())).status,
      200,
    );
    release.resolve();
    await input;
    assert.equal((await cancelling).cleanupConfirmed, true);
    assert.equal((await f.post(0, '/takeover/end', { leaseId: lease.leaseId })).status, 200);
  } finally {
    release.resolve();
    await f.close();
  }
});
