import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { DesktopAdapter, DesktopInput } from '../desktop.js';
import { createComputerWorker } from '../../../../scripts/computer-worker.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-frame-worker-'));
  const png = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#7855aa' },
  })
    .png()
    .toBuffer();
  const adapter: DesktopAdapter & {
    enabled: boolean;
    inputs: DesktopInput[];
    captures: number;
    beforeExecute?: () => Promise<void>;
    beforeCapture?: () => Promise<void>;
  } = {
    enabled: false,
    inputs: [],
    captures: 0,
    async status() {
      return {
        available: true,
        authorized: true,
        enabled: this.enabled,
        width: 120,
        height: 80,
        displays: [],
        permissions: { screenRecording: 'granted', accessibility: 'granted' },
      };
    },
    async capture() {
      this.captures++;
      await this.beforeCapture?.();
      return { png, width: 120, height: 80, capturedAt: new Date().toISOString() };
    },
    async execute(input) {
      this.inputs.push(input);
      await this.beforeExecute?.();
      return { ok: true };
    },
    setEnabled(value) {
      this.enabled = value;
    },
    async close() {
      this.enabled = false;
    },
  };
  const token = 'synthetic-frame-worker-token-123456';
  const worker = createComputerWorker({
    token,
    workspaceDir: join(dir, 'workspace'),
    desktopAdapter: adapter,
  });
  const server = worker.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const health = await (
    await fetch(base + '/health', { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  assert.ok(health.capabilities.includes('action-frames'));
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-OpenBot-Worker-Instance': health.instanceId,
    'X-OpenBot-Control-Origin': health.controlOrigin ?? 'none',
    'Content-Type': 'application/json',
  };
  const post = (path: string, body: unknown = {}) =>
    fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const get = (path: string, extraHeaders: Record<string, string> = {}) =>
    fetch(base + path, { headers: { ...headers, ...extraHeaders } });
  assert.equal((await post('/surface', { surface: 'desktop', confirm: true })).status, 200);
  return {
    adapter,
    png,
    post,
    get,
    base,
    server,
    async close() {
      await worker.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test(
  'Worker holds one queue slot for action and frame, rejects unsupported actions, and preserves successful result on capture failure',
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    const capturing = deferred(),
      release = deferred(),
      secondArrived = deferred();
    f.adapter.beforeCapture = async () => {
      capturing.resolve();
      await release.promise;
    };
    try {
      assert.equal((await fetch(f.base + '/execute-with-frame', { method: 'POST' })).status, 401);
      assert.equal(
        (await f.post('/execute-with-frame', { type: 'desktop_type', text: 'secret' })).status,
        400,
      );
      assert.equal(f.adapter.inputs.length, 0);
      const firstRequest = f.post('/execute-with-frame', { type: 'desktop_click', x: 20, y: 20 });
      await capturing.promise;
      f.server.on('request', (req) => {
        if (req.url === '/execute') secondArrived.resolve();
      });
      const secondRequest = f.post('/execute', { type: 'desktop_click', x: 40, y: 30 });
      await secondArrived.promise;
      assert.equal(
        f.adapter.inputs.length,
        1,
        'other controller action cannot run before frame completes',
      );
      release.resolve();
      const firstResponse = await firstRequest;
      assert.equal(firstResponse.status, 200);
      const first = await firstResponse.json();
      assert.equal(first.result.ok, true);
      assert.equal(first.frame.mimeType, 'image/png');
      assert.deepEqual(Buffer.from(first.frame.data, 'base64'), f.png);
      assert.ok(Number.isFinite(Date.parse(first.frame.capturedAt)));
      assert.equal((await secondRequest).status, 200);
      assert.equal(f.adapter.inputs.length, 2);
      f.adapter.beforeCapture = async () => {
        throw new Error('Synthetic capture failure');
      };
      const failedCapture = await f.post('/execute-with-frame', {
        type: 'desktop_click',
        x: 20,
        y: 20,
      });
      assert.equal(failedCapture.status, 200);
      const done = await failedCapture.json();
      assert.equal(done.result.ok, true);
      assert.equal(done.frame, undefined);
      assert.match(done.frameUnavailable, /操作已完成/);
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test(
  'Worker suppresses a historical frame when another controller starts takeover during the action',
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    const executing = deferred(),
      release = deferred(),
      takeoverArrived = deferred();
    f.adapter.beforeExecute = async () => {
      executing.resolve();
      await release.promise;
    };
    try {
      const operation = f.post('/execute-with-frame', { type: 'desktop_click', x: 20, y: 20 });
      await executing.promise;
      f.server.on('request', (req) => {
        if (req.url === '/takeover/start') takeoverArrived.resolve();
      });
      const takeover = f.post('/takeover/start');
      await takeoverArrived.promise;
      // The request handler sets takeoverPending before waiting on the action queue.
      await new Promise<void>((resolve) => setImmediate(resolve));
      release.resolve();
      const response = await operation;
      assert.equal(response.status, 200);
      const done = await response.json();
      assert.equal(done.result.ok, true);
      assert.equal(done.frame, undefined);
      assert.match(done.frameUnavailable, /画面未能保存/);
      assert.equal(f.adapter.captures, 0);
      const leaseResponse = await takeover;
      assert.equal(leaseResponse.status, 200);
      const lease = await leaseResponse.json();
      assert.equal(
        (
          await f.post('/takeover/input', {
            leaseId: lease.leaseId,
            type: 'type',
            text: 'Synthetic manual secret',
          })
        ).status,
        200,
      );
      assert.equal((await f.post('/takeover/end', { leaseId: lease.leaseId })).status, 200);
      assert.equal(
        f.adapter.captures,
        0,
        'a complete manual login does not retroactively add an image',
      );
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test(
  'Worker restricts current takeover frames to the live lease',
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    try {
      const health = await (await f.get('/health')).json();
      assert.ok(health.capabilities.includes('private-takeover-frames-v1'));
      const started = await f.post('/takeover/start');
      assert.equal(started.status, 200);
      const { leaseId } = await started.json();
      const proof = { 'X-OpenBot-Computer-Lease': leaseId };
      const status = await (await f.get('/takeover/status')).json();
      assert.equal(status.active, true);
      assert.equal(status.leaseId, undefined);

      for (const response of [
        await f.get('/screenshot'),
        await f.get('/screenshot', { 'X-OpenBot-Computer-Lease': 'different-lease' }),
      ]) {
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, 'COMPUTER_PRIVATE_TAKEOVER');
      }
      assert.equal(f.adapter.captures, 0);

      const screenshot = await f.get('/screenshot', proof);
      assert.equal(screenshot.status, 200);
      assert.equal(screenshot.headers.get('cache-control'), 'no-store');
      assert.equal(screenshot.headers.get('x-openbot-computer-lease'), null);
      assert.deepEqual(Buffer.from(await screenshot.arrayBuffer()), f.png);

      assert.equal((await f.post('/takeover/end', { leaseId })).status, 200);
      const stale = await f.get('/screenshot', proof);
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).code, 'COMPUTER_PRIVATE_TAKEOVER');
      assert.equal(f.adapter.captures, 1);
      const ordinary = await f.get('/screenshot');
      assert.equal(ordinary.status, 200);
      assert.deepEqual(Buffer.from(await ordinary.arrayBuffer()), f.png);
    } finally {
      await f.close();
    }
  },
);

test(
  'Worker discards a takeover frame when its lease is revoked during capture',
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    const capturing = deferred(),
      release = deferred();
    f.adapter.beforeCapture = async () => {
      capturing.resolve();
      await release.promise;
    };
    try {
      const started = await f.post('/takeover/start');
      assert.equal(started.status, 200);
      const { leaseId } = await started.json();
      const frame = f.get('/screenshot', { 'X-OpenBot-Computer-Lease': leaseId });
      await capturing.promise;
      const surface = f.post('/surface', { surface: 'browser' });
      // Switching surfaces revokes the lease before its queued surface change.
      await waitForTakeoverRevocation(f.get);
      release.resolve();
      const response = await frame;
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'COMPUTER_PRIVATE_TAKEOVER');
      assert.equal((await surface).status, 200);
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

async function waitForTakeoverRevocation(get: (path: string) => Promise<Response>) {
  const deadline = Date.now() + 3000;
  do {
    const response = await get('/takeover/status');
    assert.equal(response.status, 200);
    if ((await response.json()).active === false) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail('Surface change did not revoke the active takeover');
}
