import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  inspectServices,
  runServices,
  loadServicesConfig,
  parseServicesArguments,
  type ServicesConfig,
  type ServiceDependencies,
} from './computer-services.js';

const workerToken = 'fixture-only-worker-token-for-services';
const workerInstance = 'fixture-worker-instance-123456789';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'openbot-services-'));
  const config: ServicesConfig = {
    version: 1,
    ports: { api: 41001, cubeApi: 41002, cubeProxy: 41003, bridge: 41004, cubeApiTarget: 41005 },
    dataDir: dir,
    cubeConfigPath: join(dir, 'cube.json'),
    connectionPath: join(dir, 'connection.json'),
    ssh: {
      host: 'fixture.example.test',
      user: 'fixture',
      port: 22,
      controlPath: join(dir, 'ssh.sock'),
      knownHostsPath: join(dir, 'known-hosts'),
    },
  };
  await mkdir(join(dir, 'platform'));
  await writeFile(
    config.cubeConfigPath,
    JSON.stringify({
      sandboxID: 'assigned-fixture-vm',
      templateID: 'fixture-template',
      domain: 'fixture.test',
      trafficAccessToken: 'fixture-only-traffic',
      bridge: { listenPort: config.ports.bridge, upstreamPort: config.ports.cubeProxy },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    config.connectionPath,
    JSON.stringify({
      version: 1,
      selection: 'remote',
      remote: {
        url: 'http://127.0.0.1:41004',
        token: workerToken,
        instanceId: workerInstance,
        controlOrigin: null,
      },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, 'cloud.json'),
    JSON.stringify({
      provider: 'cubesandbox',
      sandboxId: 'assigned-fixture-vm',
      workerUrl: 'http://127.0.0.1:41004',
      apiBaseUrl: 'http://127.0.0.1:41002',
      autoResume: false,
    }),
    { mode: 0o600 },
  );
  const configPath = join(dir, 'services.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const listeners = new Map<number, { pid: number; loopback: boolean }>([
    [41001, { pid: 201, loopback: true }],
    [41002, { pid: 90, loopback: true }],
    [41003, { pid: 90, loopback: true }],
    [41004, { pid: 202, loopback: true }],
  ]);
  let apiOwned = true,
    bridgeOwned = true,
    vmState = 'running',
    backend = 'rust',
    sandboxID = 'assigned-fixture-vm',
    instanceId = workerInstance;
  const requests: { method: string; path: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method!, path: req.url! });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health')
      return res.end(JSON.stringify({ ok: true, architecture: 'platform', backend }));
    if (req.url === '/sandboxes/assigned-fixture-vm')
      return res.end(
        JSON.stringify({
          sandboxID,
          templateID: 'fixture-template',
          state: vmState,
          endAt: '2026-11-05T23:00:00Z',
        }),
      );
    if (req.url === '/health') {
      assert.equal(req.headers.authorization, `Bearer ${workerToken}`);
      assert.equal(req.headers['x-openbot-worker-instance'], workerInstance);
      return res.end(
        JSON.stringify({ protocol: 'openbot-computer-v2', instanceId, controlOrigin: null }),
      );
    }
    res.writeHead(404);
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const children: ChildProcess[] = [];
  const deps: ServiceDependencies = {
    listener: async (port) => listeners.get(port) ?? null,
    master: async () => listeners.get(41002)?.pid,
    ownsApi: async () => apiOwned,
    ownsBridge: async () => bridgeOwned,
    fetch: async (url, init) => {
      const target = new URL(String(url));
      assert.ok(['41001', '41002', '41004'].includes(target.port));
      assert.equal(init?.method ?? 'GET', 'GET');
      return fetch(base + target.pathname + target.search, init);
    },
    spawn: (role) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      children.push(child);
      const port = role === 'api' ? 41001 : 41004;
      listeners.set(port, { pid: child.pid!, loopback: true });
      child.once('exit', () => listeners.delete(port));
      return child;
    },
  };
  return {
    config,
    configPath,
    deps,
    children,
    listeners,
    requests,
    set(values: {
      apiOwned?: boolean;
      backend?: string;
      bridgeOwned?: boolean;
      state?: string;
      id?: string;
      instanceId?: string;
    }) {
      if (values.backend !== undefined) backend = values.backend;
      if (values.apiOwned !== undefined) apiOwned = values.apiOwned;
      if (values.bridgeOwned !== undefined) bridgeOwned = values.bridgeOwned;
      if (values.state) vmState = values.state;
      if (values.id) sandboxID = values.id;
      if (values.instanceId) instanceId = values.instanceId;
    },
    async close() {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('services configuration and CLI accept only fixed roles, private absolute paths and SSH metadata', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await loadServicesConfig(f.configPath), f.config);
    assert.equal(parseServicesArguments(['status', '--config', f.configPath]).mode, 'status');
    for (const args of [
      ['restart', '--config', f.configPath],
      ['run', '--config', f.configPath, '--command', 'anything'],
    ])
      assert.throws(() => parseServicesArguments(args));
    for (const value of [
      { ...f.config, command: 'arbitrary' },
      { ...f.config, port: 9090 },
      { ...f.config, dataDir: 'relative' },
      { ...f.config, ports: undefined },
      { ...f.config, ports: { ...f.config.ports, bridge: f.config.ports.api } },
      { ...f.config, ports: { ...f.config.ports, cubeProxy: 65536 } },
      { ...f.config, ports: { ...f.config.ports, cubeProxy: 'https://other.example' } },
      { ...f.config, ssh: { ...f.config.ssh, password: 'must-not-be-accepted' } },
      { ...f.config, ssh: { ...f.config.ssh, host: '-oProxyCommand=anything' } },
    ]) {
      await writeFile(f.configPath, JSON.stringify(value));
      await assert.rejects(loadServicesConfig(f.configPath), { code: 'CONFIG_INVALID' });
    }
    await writeFile(f.configPath, JSON.stringify(f.config));
    await chmod(f.configPath, 0o644);
    await assert.rejects(loadServicesConfig(f.configPath), { code: 'CONFIG_INVALID' });
  } finally {
    await f.close();
  }
});

test('services refuses a changed saved endpoint or bridge port before sending Worker credentials', async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.config.dataDir, 'cloud.json'),
      JSON.stringify({
        provider: 'cubesandbox',
        sandboxId: 'assigned-fixture-vm',
        autoResume: false,
        workerUrl: `http://127.0.0.1:${f.config.ports.bridge}`,
        apiBaseUrl: 'https://other.example',
      }),
    );
    await assert.rejects(inspectServices(f.config, f.deps), { code: 'BINDING_INVALID' });
    assert.ok(f.requests.every((request) => request.path === '/api/health'));
  } finally {
    await f.close();
  }
});

test('services status uses only read requests, validates both identities and never probes a paused Worker', async () => {
  const f = await fixture();
  try {
    const live = await inspectServices(f.config, f.deps);
    assert.equal(live.ready, true);
    assert.equal(live.worker.state, 'ready');
    assert.doesNotMatch(
      JSON.stringify(live),
      /fixture-only-worker|fixture-only-traffic|Authorization/,
    );
    f.requests.length = 0;
    f.set({ state: 'paused' });
    const paused = await inspectServices(f.config, f.deps);
    assert.equal(paused.ready, true);
    assert.equal(paused.worker.state, 'paused');
    assert.equal(
      f.requests.some((r) => r.path === '/health'),
      false,
    );
    assert.ok(f.requests.every((r) => r.method === 'GET'));
    f.set({ state: 'running', id: 'other-vm' });
    assert.equal((await inspectServices(f.config, f.deps)).worker.state, 'identity_mismatch');
    f.set({ id: 'assigned-fixture-vm', instanceId: 'unexpected-worker-instance-123' });
    assert.equal((await inspectServices(f.config, f.deps)).worker.state, 'identity_mismatch');
  } finally {
    await f.close();
  }
});

test('services borrowed run exits without spawning or stopping the existing services or SSH', async () => {
  const f = await fixture();
  const stop = new AbortController();
  try {
    await runServices(f.config, {
      signal: stop.signal,
      dependencies: f.deps,
      onStatus: (state) => {
        if (state.ready) stop.abort();
      },
    });
    assert.equal(f.children.length, 0);
    assert.deepEqual([...f.listeners.keys()], [41001, 41002, 41003, 41004]);
    assert.equal((await inspectServices(f.config, f.deps)).ready, true);
  } finally {
    await f.close();
  }
});

test('services missing tunnel and conflicting listeners fail before spawning and never replace a process', async () => {
  const f = await fixture();
  try {
    f.listeners.delete(41002);
    f.listeners.delete(41003);
    await assert.rejects(
      runServices(f.config, { signal: new AbortController().signal, dependencies: f.deps }),
      { code: 'TUNNEL_REQUIRED' },
    );
    assert.equal(f.children.length, 0);
    f.listeners.set(41002, { pid: 90, loopback: true });
    f.listeners.set(41003, { pid: 90, loopback: true });
    f.set({ apiOwned: false });
    await assert.rejects(
      runServices(f.config, { signal: new AbortController().signal, dependencies: f.deps }),
      { code: 'PORT_CONFLICT' },
    );
    assert.equal(f.listeners.get(41001)?.pid, 201);
    f.set({ apiOwned: true });
    f.listeners.set(41004, { pid: 202, loopback: false });
    await assert.rejects(
      runServices(f.config, { signal: new AbortController().signal, dependencies: f.deps }),
      { code: 'PORT_CONFLICT' },
    );
    assert.equal(f.children.length, 0);
  } finally {
    await f.close();
  }
});

test('services starts only missing API and bridge children, and waits for their cleanup on cancellation', async () => {
  const f = await fixture();
  const stop = new AbortController();
  f.listeners.delete(41001);
  f.listeners.delete(41004);
  try {
    await runServices(f.config, {
      signal: stop.signal,
      dependencies: f.deps,
      pollMs: 10,
      startupMs: 3000,
      onStatus: (s) => {
        if (s.ready) stop.abort();
      },
    });
    assert.equal(f.children.length, 2);
    assert.ok(f.children.every((child) => child.exitCode !== null || child.signalCode !== null));
    assert.deepEqual([...f.listeners.keys()], [41002, 41003]);
  } finally {
    await f.close();
  }
});

test('services child failure cleans only owned children and leaves the borrowed SSH alive', async () => {
  const f = await fixture();
  f.listeners.delete(41001);
  f.listeners.delete(41004);
  const spawnChild = f.deps.spawn;
  f.deps.spawn = (role, config) => {
    const child = spawnChild(role, config);
    if (role === 'api') child.once('spawn', () => child.kill('SIGTERM'));
    return child;
  };
  try {
    await assert.rejects(
      runServices(f.config, {
        signal: new AbortController().signal,
        dependencies: f.deps,
        pollMs: 10,
        startupMs: 3000,
      }),
      { code: 'CHILD_EXITED' },
    );
    assert.ok(f.children.every((child) => child.exitCode !== null || child.signalCode !== null));
    assert.equal(f.listeners.get(41002)?.pid, 90);
    assert.equal(f.listeners.get(41003)?.pid, 90);
  } finally {
    await f.close();
  }
});

test('services never adopts a legacy Node API as the Rust writer or stops its listener', async () => {
  const f = await fixture();
  try {
    f.set({ backend: 'node' });
    const status = await inspectServices(f.config, f.deps);
    assert.equal(status.api.state, 'conflict');
    await assert.rejects(
      runServices(f.config, {
        signal: new AbortController().signal,
        dependencies: f.deps,
      }),
      (error: any) => error.code === 'PORT_CONFLICT',
    );
    assert.equal(f.children.length, 0);
    assert.equal(f.listeners.get(41001)?.pid, 201);
  } finally {
    await f.close();
  }
});
