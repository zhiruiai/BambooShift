import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { ScreenLifecycleRequest } from '../../../../shared/computer-screen-lifecycle.js';
import { ScreenLifecycleStore } from '../computer-screen-lifecycle.js';
import { linuxDesktopMaintenanceState } from '../linux-desktop.js';

import { deferred, fixture } from './computer-screen-lifecycle.fixture.js';

test('release rotates durable slot and session identity, shares the peer, and cannot replay into its replacement', async () => {
  const f = await fixture(),
    gate = deferred();
  try {
    const before = await f.inventory(),
      req = await f.request();
    f.controls.driverWait = gate.promise;
    const running = f.call(0, '/lifecycle', req, req.expectedRevision);
    const deadline = Date.now() + 5000;
    while (!f.controls.driverCalls) {
      assert.ok(Date.now() < deadline, 'lifecycle driver must start within the fixture deadline');
      await new Promise((done) => setTimeout(done, 5));
    }
    const duplicate = f.call(0, '/lifecycle', req, req.expectedRevision);
    const busy = await f.call(0, '/health', undefined, req.expectedRevision);
    assert.equal(busy.status, 409);
    assert.equal((await f.call(1, '/health', undefined, before.screens[1].revision)).status, 200);
    assert.equal(
      (await f.call(0, '/lifecycle', { ...req, operationId: randomUUID() }, req.expectedRevision))
        .status,
      409,
    );
    gate.resolve();
    const result = await running;
    assert.equal(result.status, 200);
    assert.deepEqual((await duplicate).json, result.json);
    assert.equal(f.controls.driverCalls, 1);
    assert.equal(f.controls.starts, 1);
    const after = await f.inventory();
    assert.notEqual(after.screens[0].revision, before.screens[0].revision);
    assert.notEqual(after.screens[0].session.id, before.screens[0].session.id);
    assert.deepEqual(after.screens[1], before.screens[1]);
    for (const [path, body] of [
      ['/health', undefined],
      ['/operations/cancel', { id: randomUUID() }],
      ['/takeover/end', { leaseId: randomUUID() }],
    ] as const)
      assert.equal((await f.call(0, path, body, req.expectedRevision)).status, 409);
    assert.equal((await f.call(0, '/health')).status, 409);
    assert.equal(
      (await f.call(0, '/health', undefined, after.screens[0].revision)).json.screenRevision,
      after.screens[0].revision,
    );
    assert.equal(
      (await f.call(0, '/lifecycle', { ...req, kind: 'reset' }, req.expectedRevision)).status,
      409,
    );
    await f.restart();
    assert.equal((await f.inventory()).screens[0].revision, after.screens[0].revision);
    assert.deepEqual(
      (await f.call(0, '/lifecycle/' + req.operationId, undefined, req.expectedRevision)).json,
      result.json,
    );
    assert.deepEqual((await f.call(0, '/lifecycle', req, req.expectedRevision)).json, result.json);
    assert.equal(f.controls.driverCalls, 1);
  } finally {
    gate.resolve();
    await f.close();
  }
});

test('HTTP disconnection does not abandon an accepted lifecycle transaction or repeat its effects', async () => {
  const f = await fixture(),
    gate = deferred(),
    abort = new AbortController();
  try {
    const req = await f.request();
    assert.equal(
      (await f.call(0, '/lifecycle', { ...req, manifestPath: '/untrusted' }, req.expectedRevision))
        .status,
      400,
    );
    assert.equal(
      (
        await f.call(
          0,
          '/lifecycle',
          {
            ...req,
            expectedSession: {
              ...req.expectedSession,
              path: '/untrusted',
            },
          },
          req.expectedRevision,
        )
      ).status,
      400,
    );
    assert.equal(
      (await f.call(0, '/lifecycle/invalid', undefined, req.expectedRevision)).status,
      400,
    );
    assert.equal(f.controls.driverCalls, 0);
    f.controls.driverWait = gate.promise;
    const running = f.call(0, '/lifecycle', req, req.expectedRevision, undefined, abort.signal);
    const deadline = Date.now() + 5000;
    while (!f.controls.driverCalls) {
      assert.ok(Date.now() < deadline);
      await new Promise((done) => setTimeout(done, 5));
    }
    abort.abort();
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal((await f.inventory()).screens[0].lifecycle?.state, 'changing');
    gate.resolve();
    const result = await f.call(0, '/lifecycle', req, req.expectedRevision);
    assert.equal(result.status, 200);
    assert.equal(result.json.status, 'complete');
    assert.equal(f.controls.driverCalls, 1);
    assert.equal(f.controls.starts, 1);
    assert.deepEqual(
      (await f.call(0, '/lifecycle/' + req.operationId, undefined, req.expectedRevision)).json,
      result.json,
    );
  } finally {
    gate.resolve();
    await f.close();
  }
});

test('release and reset refuse actual input and takeover without cancelling either', async () => {
  const f = await fixture(),
    gate = deferred(),
    entered = deferred();
  try {
    const screen = (await f.inventory()).screens[0];
    assert.equal(
      (
        await f.call(
          0,
          '/surface',
          { surface: 'desktop', confirm: true },
          screen.revision,
          screen.session,
        )
      ).status,
      200,
    );
    f.controls.input = async () => {
      entered.resolve();
      await gate.promise;
    };
    const input = f.call(
      0,
      '/execute',
      { type: 'desktop_key', key: 'Enter' },
      screen.revision,
      screen.session,
    );
    await entered.promise;
    for (const kind of ['release', 'reset'] as const) {
      const req = await f.request(kind);
      const result = await f.call(0, '/lifecycle', req, req.expectedRevision);
      assert.equal(result.status, 409);
      assert.equal(result.json.operationId, undefined);
    }
    assert.equal(f.controls.inputSignal?.aborted, false);
    assert.equal(f.controls.driverCalls, 0);
    gate.resolve();
    assert.equal((await input).status, 200);
    f.controls.input = undefined;
    const lease = await f.call(0, '/takeover/start', {}, screen.revision, screen.session);
    assert.equal(lease.status, 200);
    for (const kind of ['release', 'reset'] as const) {
      const req = await f.request(kind);
      assert.equal((await f.call(0, '/lifecycle', req, req.expectedRevision)).status, 409);
    }
    assert.equal(
      (await f.call(0, '/takeover/status', undefined, screen.revision)).json.active,
      true,
    );
    assert.equal(
      (await f.call(0, '/takeover/end', { leaseId: lease.json.leaseId }, screen.revision)).status,
      200,
    );
  } finally {
    gate.resolve();
    await f.close();
  }
});

test('browser-close retries never skip closure or restart Linux before proof', async () => {
  const f = await fixture();
  try {
    const req = await f.request();
    f.controls.closeFails = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.call(0, '/lifecycle', req, req.expectedRevision);
      assert.equal(result.status, 409);
      assert.equal(result.json.status, 'blocked');
      assert.equal(result.json.phase, 'reserved');
      assert.equal(f.controls.driverCalls, 0);
    }
    f.controls.closeFails = false;
    const result = await f.call(0, '/lifecycle', req, req.expectedRevision);
    assert.equal(result.status, 200);
    assert.equal(f.controls.driverCalls, 1);
    const old = f.browsers.get(f.configuration.screens[0].id + ':' + req.expectedRevision)!;
    assert.equal(old.closes >= 3, true);
    assert.equal(old.open, false);
    assert.ok(f.browsers.has(f.configuration.screens[0].id + ':' + result.json.next.revision));
  } finally {
    await f.close();
  }
});

test('unknown input cleanup needs explicit reset and supervisor failure keeps the same durable transaction blocked', async () => {
  const f = await fixture();
  try {
    const screen = (await f.inventory()).screens[0];
    await f.call(
      0,
      '/surface',
      { surface: 'desktop', confirm: true },
      screen.revision,
      screen.session,
    );
    f.controls.captureUnknown = true;
    assert.equal(
      (
        await f.call(
          0,
          '/execute-with-frame',
          { type: 'desktop_key', key: 'Enter' },
          screen.revision,
          screen.session,
        )
      ).status,
      200,
    );
    const release = await f.request();
    assert.equal((await f.call(0, '/lifecycle', release, release.expectedRevision)).status, 409);
    assert.equal(f.controls.driverCalls, 0);
    const req = await f.request('reset');
    f.controls.driverFails = true;
    const blocked = await f.call(0, '/lifecycle', req, req.expectedRevision);
    assert.equal(blocked.json.status, 'blocked');
    assert.equal(blocked.json.next.session.id, screen.session.id);
    assert.equal((await f.inventory()).screens[0].available, false);
    f.controls.driverFails = false;
    f.controls.captureUnknown = false;
    const result = await f.call(0, '/lifecycle', req, req.expectedRevision);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.next, blocked.json.next);
    assert.equal((await f.inventory()).screens[0].available, true);
    assert.notEqual(result.json.next.session.generation, screen.session.generation);
  } finally {
    await f.close();
  }
});

test('a real hung helper watchdog allows reset only after cancellation and drains the process after Linux-stop proof', async () => {
  const f = await fixture(undefined, true),
    abort = new AbortController(),
    gate = deferred();
  const until = async (check: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 8000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, 'helper fixture deadline');
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  try {
    const screen = (await f.inventory()).screens[0],
      peer = (await f.inventory()).screens[1];
    assert.equal(
      (
        await f.call(
          0,
          '/surface',
          { surface: 'desktop', confirm: true },
          screen.revision,
          screen.session,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.call(0, '/execute', { type: 'desktop_screenshot' }, screen.revision, screen.session))
        .status,
      200,
    );
    const input = f.call(
      0,
      '/execute',
      { type: 'desktop_key', key: 'Enter' },
      screen.revision,
      screen.session,
      abort.signal,
    );
    await until(() =>
      readFile(f.startedPath).then(
        () => true,
        () => false,
      ),
    );
    const pid = Number(await readFile(f.startedPath, 'utf8'));
    const reset = await f.request('reset');
    assert.equal((await f.call(0, '/lifecycle', reset, reset.expectedRevision)).status, 409);
    abort.abort();
    await assert.rejects(input, { name: 'AbortError' });
    await until(() => linuxDesktopMaintenanceState(f.actualAdapters[0])?.cleanupUnknown === true);
    assert.equal(linuxDesktopMaintenanceState(f.actualAdapters[0])?.activeHelpers, 1);
    process.kill(pid, 0);
    const release = await f.request();
    assert.equal((await f.call(0, '/lifecycle', release, release.expectedRevision)).status, 409);
    f.controls.driverWait = gate.promise;
    f.controls.afterDriver = async () => {
      f.events.push('old-linux-stopped');
      await writeFile(f.releasePath, 'release');
    };
    const result = f.call(0, '/lifecycle', reset, reset.expectedRevision);
    await until(() => f.controls.driverCalls === 1);
    process.kill(pid, 0);
    assert.equal((await f.call(1, '/health', undefined, peer.revision)).status, 200);
    gate.resolve();
    const completed = await result;
    assert.equal(completed.status, 200, JSON.stringify(completed.json));
    assert.equal(linuxDesktopMaintenanceState(f.actualAdapters[0])?.activeHelpers, 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(f.actualAdapters.length, 2);
    assert.equal((await f.inventory()).screens[0].available, true);
    assert.equal((await f.call(1, '/health', undefined, peer.revision)).status, 200);
  } finally {
    gate.resolve();
    await f.close();
  }
});

for (const phase of ['reserved', 'browser_closed', 'desktop_ready'] as const)
  test(`restart during ${phase} is read-only and requires explicit resume of the original transaction`, async () => {
    const f = await fixture(phase);
    try {
      const receipt = f.pending!,
        req: ScreenLifecycleRequest = {
          operationId: receipt.operationId,
          kind: receipt.kind,
          expectedRevision: receipt.previous.revision,
          expectedSession: receipt.previous.session,
        };
      assert.equal((await f.inventory()).screens[0].lifecycle?.state, 'blocked');
      assert.equal(
        (await f.call(0, '/lifecycle/' + receipt.operationId, undefined, req.expectedRevision)).json
          .status,
        'pending',
      );
      assert.equal(f.controls.driverCalls, 0);
      assert.equal(f.events.length, 0);
      assert.equal((await f.call(0, '/health', undefined, req.expectedRevision)).status, 409);
      const result = await f.call(0, '/lifecycle', req, req.expectedRevision);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json.next, receipt.next);
      assert.equal(f.events.filter((event) => event.startsWith('browser-open:')).length, 1);
      assert.ok(f.events[0].startsWith('browser-open:'));
      assert.ok(f.events[1].startsWith('browser-close:'));
      assert.equal(f.controls.starts, phase === 'desktop_ready' ? 0 : 1);
      assert.equal((await f.call(0, '/lifecycle', req, req.expectedRevision)).status, 200);
      assert.equal(f.controls.driverCalls, 1);
    } finally {
      await f.close();
    }
  });

test('inconsistent or orphan pending receipts never reopen a slot as ready', async () => {
  const f = await fixture('reserved');
  try {
    const path = join(f.stateDir, f.configuration.screens[0].id + '.json');
    const original = JSON.parse(await readFile(path, 'utf8'));
    for (const mutate of [
      (value: any) => {
        delete value.currentOperationId;
      },
      (value: any) => {
        value.receipts[value.currentOperationId].phase = 'complete';
      },
    ]) {
      const value = structuredClone(original);
      mutate(value);
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
      assert.throws(
        () =>
          new ScreenLifecycleStore(
            f.stateDir,
            f.configuration.workspaceScopeId,
            f.configuration.screens,
          ),
        /记录损坏/,
      );
    }
  } finally {
    await f.close();
  }
});
