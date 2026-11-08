import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCubeWorkerBridge, loadCubeWorkerBridgeConfig } from './cube-worker-bridge.js';

const target = {
  sandboxID: 'synthetic-vm',
  domain: 'example.test',
  trafficAccessToken: 'synthetic-traffic-only',
};

test('bridge has no deployed port fallback and validates private distinct loopback ports', async () => {
  assert.throws(() => createCubeWorkerBridge({ config: target }), /端口无效/);
  const dir = await mkdtemp(join(tmpdir(), 'bridge-ports-'));
  const path = join(dir, 'private.json');
  try {
    const valid = { ...target, bridge: { listenPort: 41004, upstreamPort: 41003 } };
    await writeFile(path, JSON.stringify(valid), { mode: 0o600 });
    assert.deepEqual(await loadCubeWorkerBridgeConfig(path), valid);
    for (const bridge of [
      { listenPort: 41004, upstreamPort: 41004 },
      { listenPort: 0, upstreamPort: 41003 },
      { listenPort: 41004, upstreamPort: 'https://other.example' },
      { listenPort: 41004, upstreamPort: 41003, host: 'other.example' },
    ]) {
      await writeFile(path, JSON.stringify({ ...target, bridge }));
      await assert.rejects(loadCubeWorkerBridgeConfig(path));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit loopback proxy keeps fixed VM headers and rejects network rebinding on reload', async () => {
  let calls = 0;
  const proxy = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer synthetic-worker-only-credential');
    assert.equal(req.headers['cube-traffic-access-token'], target.trafficAccessToken);
    assert.ok(req.headers.host?.endsWith('-synthetic-vm.example.test'));
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  proxy.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => proxy.once('listening', resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === 'object');
  const config = { ...target, bridge: { listenPort: 41004, upstreamPort: address.port } };
  let loaded = config;
  const bridge = createCubeWorkerBridge({ config, configLoader: async () => loaded });
  bridge.server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => bridge.server.once('listening', resolve));
  const local = bridge.server.address();
  assert.ok(local && typeof local === 'object');
  const url = `http://127.0.0.1:${local.port}/health`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: 'Bearer synthetic-worker-only-credential' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    loaded = {
      ...config,
      bridge: { ...config.bridge, upstreamPort: address.port === 65535 ? 65534 : address.port + 1 },
    };
    const denied = await fetch(url, {
      headers: { Authorization: 'Bearer synthetic-worker-only-credential' },
    });
    assert.equal(denied.status, 503);
    assert.doesNotMatch(await denied.text(), /synthetic-traffic|synthetic-worker/);
    assert.equal(calls, 1);
  } finally {
    await bridge.close();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
