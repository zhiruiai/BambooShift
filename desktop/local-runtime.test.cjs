'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const {
  createLocalRuntime,
  installRuntimeQuit,
  localPartition,
  readLocalSelection,
  saveLocalSelection,
} = require('./local-runtime.cjs');
const { createController, readLastOrigin, saveLastOrigin } = require('./main.cjs');
const { deferred, fakeElectron } = require('./test-fixture.cjs');

const platformSupported = ['darwin', 'linux'].includes(process.platform);
const manifest = {
  version: 1,
  platform: process.platform,
  architecture: process.arch,
  server: 'openbot-backend',
  node: 'bin/node',
  runtime: 'runtime',
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await pause(10);
  }
  throw Error('Fixture did not reach the expected state');
}

function bundleFixture(t, body, spec = manifest, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bambooshift-client-fixture-'));
  const dataDir = join(directory, 'profile');
  const resourcesPath = join(directory, 'Resources');
  const bundle = join(resourcesPath, 'bambooshift-runtime');
  const put = (path, data, mode) => writeFileSync(join(bundle, path), data, { mode });
  for (const path of ['bin', 'runtime/dist', 'runtime/node_modules', 'runtime/packages'])
    mkdirSync(join(bundle, path), { recursive: true });
  for (const name of ['pi', 'computer', 'document', 'mcp']) {
    mkdirSync(join(bundle, 'runtime/packages', name + '-worker'));
    put('runtime/packages/' + name + '-worker/index.mjs', '', 0o600);
  }
  put('runtime/dist/index.html', '<!doctype html>', 0o600);
  put('desktop-runtime.json', JSON.stringify(spec), 0o600);
  put('bin/node', 'runtime fixture', 0o700);
  put('openbot-image-worker', 'image fixture', 0o700);
  put('openbot-backend', '#!' + process.execPath + '\n' + body, 0o700);
  mkdirSync(dataDir, { mode: 0o700 });
  const runtime = createLocalRuntime({
    dataDir,
    resourcesPath,
    startTimeoutMs: 5000,
    stopTimeoutMs: 300,
    ...options,
  });
  t.after(async () => {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, dataDir, resourcesPath, bundle, runtime };
}

const fixtureServer = `
const http = require('node:http');
const { readFileSync } = require('node:fs');
const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/health') {
    res.end(JSON.stringify({ok:true,backend:'rust',architecture:'platform',runtime:'pi'}));
  } else if (req.url === '/api/account/local-session') {
    const valid = req.method === 'POST' && req.headers['x-bambooshift-local-token'] === config.localDesktop.bootstrapToken;
    res.statusCode = valid ? 200 : 403;
    res.end(JSON.stringify({authenticated:valid, workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',user:{localOnly:true}}));
  } else {
    const { homedir, username } = require('node:os').userInfo();
    const { HOME, USER, LOGNAME, PATH, BAMBOOSHIFT_FIXTURE_SECRET } = process.env;
    res.end(JSON.stringify({
      pid: process.pid,
      leaked: Boolean(BAMBOOSHIFT_FIXTURE_SECRET),
      hostIdentity: HOME === homedir && USER === username && LOGNAME === username,
      hostPath: PATH === '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    }));
  }
});
server.listen(0, '127.0.0.1', () => {
  const ready = JSON.stringify({type:'openbot:ready',backend:'rust',address:'127.0.0.1:' + server.address().port});
  process.stdout.write(ready.slice(0, 20));
  setTimeout(() => process.stdout.write(ready.slice(20) + '\\n'), 20);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

test(
  'launches a real packaged child, keeps private config and stops the loopback service',
  { skip: !platformSupported },
  async (t) => {
    const f = bundleFixture(t, fixtureServer);
    process.env.BAMBOOSHIFT_FIXTURE_SECRET = 'synthetic';
    let launched;
    try {
      assert.equal(f.runtime.available(), true);
      launched = await f.runtime.start({
        signal: new AbortController().signal,
        onExit: () => assert.fail('unexpected exit'),
      });
    } finally {
      delete process.env.BAMBOOSHIFT_FIXTURE_SECRET;
    }
    const response = await fetch(launched.origin);
    const { pid, leaked, hostIdentity, hostPath } = await response.json();
    assert.equal(leaked, false);
    assert.equal(hostIdentity, false);
    assert.equal(hostPath, false);
    const profile = join(f.dataDir, 'local-workspace');
    const config = join(profile, 'service.json');
    assert.equal(statSync(profile).mode & 0o777, 0o700);
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), {
      dataDir: join(profile, 'data'),
      bind: '127.0.0.1:0',
      runtimeDir: join(f.bundle, 'runtime'),
      nodeBinary: join(f.bundle, 'bin/node'),
      localDesktop: { bootstrapToken: launched.token },
    });
    assert.match(launched.token, /^[a-f0-9]{64}$/);
    await f.runtime.stop();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(f.runtime.stop(), undefined);
  },
);

test(
  'forwards only the two browser launch options to the packaged service',
  { skip: !platformSupported },
  async (t) => {
    const supplied = {
      OPENBOT_BROWSER_EXECUTABLE: '/synthetic/Chromium.app/browser',
      OPENBOT_BROWSER_HEADLESS: 'false',
      OPENBOT_BROWSER_ALLOWED_ORIGINS: 'http://synthetic.invalid',
      BAMBOOSHIFT_FIXTURE_SECRET: 'must-not-inherit',
    };
    const previous = Object.fromEntries(
      Object.keys(supplied).map((name) => [name, process.env[name]]),
    );
    const f = bundleFixture(
      t,
      fixtureServer.replace(
        'pid: process.pid,',
        `pid: process.pid,
      browser: [process.env.OPENBOT_BROWSER_EXECUTABLE, process.env.OPENBOT_BROWSER_HEADLESS],
      networkException: process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS,`,
      ),
    );
    let launched;
    try {
      Object.assign(process.env, supplied);
      launched = await f.runtime.start({
        signal: new AbortController().signal,
        onExit: () => assert.fail('unexpected exit'),
      });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const result = await (await fetch(launched.origin)).json();
    assert.deepEqual(result.browser, [supplied.OPENBOT_BROWSER_EXECUTABLE, 'false']);
    assert.equal(result.networkException, undefined);
    assert.equal(result.leaked, false);
    assert.equal(result.hostIdentity, false);
  },
);

test(
  'rejects foreign and oversized handshakes, missing bundles, and substituted executables',
  { skip: !platformSupported },
  async (t) => {
    for (const ready of [
      JSON.stringify({ type: 'openbot:ready', backend: 'rust', address: '198.51.100.3:4321' }),
      JSON.stringify({ type: 'openbot:ready', backend: 'rust', address: '127.0.0.1:70000' }),
      'A'.repeat(5000),
    ]) {
      const f = bundleFixture(
        t,
        'console.log(' + JSON.stringify(ready) + '); setInterval(() => {}, 500);',
      );
      await assert.rejects(
        f.runtime.start({ signal: new AbortController().signal, onExit: () => {} }),
        /localRuntimeFailed/,
      );
      assert.equal(f.runtime.stop(), undefined);
    }
    const mismatched = bundleFixture(t, '', { ...manifest, server: '../../untrusted' });
    assert.equal(mismatched.runtime.available(), false);
    const f = bundleFixture(t, '');
    rmSync(join(f.bundle, 'openbot-backend'));
    symlinkSync(process.execPath, join(f.bundle, 'openbot-backend'));
    assert.equal(f.runtime.available(), false);
    await assert.rejects(
      f.runtime.start({ signal: new AbortController().signal, onExit: () => {} }),
      /localRuntimeUnavailable/,
    );
  },
);

test(
  'cancels an unready child and bounds timeout cleanup even when SIGTERM is ignored',
  { skip: !platformSupported },
  async (t) => {
    const body = `
const fs = require('node:fs');
const path = require('node:path');
process.on('SIGTERM', () => {});
fs.writeFileSync(path.join(path.dirname(process.argv[3]), 'fixture.pid'), String(process.pid));
setInterval(() => {}, 1000);
`;
    const f = bundleFixture(t, body);
    const signal = new AbortController();
    const start = f.runtime.start({
      signal: signal.signal,
      onExit: () => assert.fail('unexpected exit'),
    });
    const pidFile = join(f.dataDir, 'local-workspace', 'fixture.pid');
    let pid;
    await until(() => {
      try {
        pid = Number(readFileSync(pidFile));
        return pid > 0;
      } catch {
        return false;
      }
    });
    signal.abort();
    await assert.rejects(start, { name: 'AbortError' });
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

    const timed = bundleFixture(t, body, manifest, { startTimeoutMs: 800 });
    await assert.rejects(
      timed.runtime.start({ signal: new AbortController().signal, onExit: () => {} }),
      /localRuntimeTimeout/,
    );
    assert.equal(timed.runtime.stop(), undefined);
  },
);

test(
  'observes an unexpected real child exit after readiness',
  { skip: !platformSupported },
  async (t) => {
    const f = bundleFixture(t, fixtureServer + 'setTimeout(() => process.exit(2), 300);');
    const exited = deferred();
    await f.runtime.start({ signal: new AbortController().signal, onExit: exited.resolve });
    await exited.promise;
    await f.runtime.stop();
    assert.equal(f.runtime.stop(), undefined);
  },
);

test('application quit waits for owned backend shutdown', async () => {
  const app = new EventEmitter();
  const stopped = deferred();
  let closing = true;
  let prevented = 0;
  let quit = 0;
  app.quit = () => {
    quit++;
    app.emit('before-quit', event);
  };
  const event = { preventDefault: () => prevented++ };
  installRuntimeQuit(app, () => (closing ? stopped.promise : undefined));
  app.emit('before-quit', event);
  app.emit('before-quit', event);
  assert.equal(quit, 0);
  assert.equal(prevented, 2);
  closing = false;
  stopped.resolve();
  await stopped.promise;
  assert.equal(quit, 1);
  assert.equal(prevented, 2);
});

test(
  'a trusted setup can attach a managed local view without saving its port, and preserves the partition when it restarts',
  { skip: !platformSupported },
  async (t) => {
    const f = bundleFixture(t, fixtureServer);
    const remoteOrigin = 'https://existing.example.test';
    saveLastOrigin(f.dataDir, remoteOrigin);
    const authRequests = [];
    const setupSession = (fake) => {
      const local = fake.session.fromPartition(localPartition);
      local.fetch = async (url, init) => {
        if (new URL(url).pathname === '/api/account/local-session')
          authRequests.push({ url, init });
        return fetch(url, init);
      };
    };
    let fake = fakeElectron();
    setupSession(fake);
    let controller = createController(fake, {
      dataDir: f.dataDir,
      localRuntime: f.runtime,
      suggestedUrl: 'https://other.example.test',
    });
    controller.start();
    let contents = fake.windows[0].webContents;
    const sender = { sender: contents, senderFrame: contents.mainFrame };
    const invoke = fake.ipc.get('openbot-client:start-local');
    assert.throws(() => invoke({}, undefined), /available only|只允许/);
    assert.throws(
      () => invoke(sender, { command: 'untrusted' }),
      /Invalid connection parameters|连接参数无效/,
    );
    const starting = invoke(sender);
    await until(() => fake.views.length === 1);
    const view = fake.views[0];
    view.webContents.loadGate.resolve();
    const status = await starting;
    assert.equal(status.status, 'connected');
    assert.equal(status.localStarting, false);
    assert.equal(status.lastOrigin, remoteOrigin);
    assert.equal(readLastOrigin(f.dataDir), remoteOrigin);
    assert.deepEqual(readLocalSelection(f.dataDir), { hostControl: false });
    assert.equal(authRequests.length, 1);
    const token = authRequests[0].init.headers['X-BambooShift-Local-Token'];
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(authRequests[0].init.redirect, 'error');
    assert.equal(authRequests[0].init.credentials, 'include');
    assert.equal(JSON.stringify(status).includes(token), false);
    assert.equal(JSON.stringify(contents.messages).includes(token), false);
    assert.equal(JSON.stringify(view.options).includes(token), false);
    assert.equal(view.options.webPreferences.partition, localPartition);
    const localUrl = new URL(view.webContents.getURL());
    assert.equal(localUrl.pathname, '/w/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const origin = localUrl.origin;
    const session = fake.sessions.get(localPartition);
    let blocked;
    session.beforeRequest({ url: origin + '/', resourceType: 'mainFrame' }, (value) => {
      blocked = value.cancel;
    });
    assert.equal(blocked, false);
    await controller.close();
    session.beforeRequest({ url: origin + '/', resourceType: 'mainFrame' }, (value) => {
      blocked = value.cancel;
    });
    assert.equal(blocked, true);

    fake = fakeElectron();
    setupSession(fake);
    controller = createController(fake, { dataDir: f.dataDir, localRuntime: f.runtime });
    controller.start();
    await until(() => fake.views.length === 1);
    fake.views[0].webContents.loadGate.resolve();
    await until(() => controller.state().status === 'connected');
    assert.equal(fake.views[0].options.webPreferences.partition, localPartition);
    assert.equal(authRequests.length, 2);
    assert.notEqual(authRequests[1].init.headers['X-BambooShift-Local-Token'], token);
    assert.equal(readLastOrigin(f.dataDir), remoteOrigin);
    await controller.close();
  },
);

test(
  'setup can cancel a local process before it attaches a product view',
  { skip: !platformSupported },
  async (t) => {
    const f = bundleFixture(t, 'setInterval(() => {}, 500);');
    const fake = fakeElectron();
    const controller = createController(fake, { dataDir: f.dataDir, localRuntime: f.runtime });
    controller.start();
    const contents = fake.windows[0].webContents;
    const sender = { sender: contents, senderFrame: contents.mainFrame };
    const starting = fake.ipc.get('openbot-client:start-local')(sender);
    assert.equal(controller.state().localStarting, true);
    fake.ipc.get('openbot-client:cancel-local')(sender);
    assert.equal(controller.state().localStarting, false);
    await starting;
    assert.equal(fake.views.length, 0);
    assert.equal(readLocalSelection(f.dataDir), undefined);
    await controller.close();
  },
);

test('a remembered local workspace without its bundle leaves setup open', async (t) => {
  const f = bundleFixture(t, '', { ...manifest, version: -1 });
  saveLastOrigin(f.dataDir, 'https://previous.example.test');
  saveLocalSelection(f.dataDir, { hostControl: false });
  const fake = fakeElectron();
  const controller = createController(fake, { dataDir: f.dataDir, localRuntime: f.runtime });
  controller.start();
  await pause(25);
  assert.equal(controller.state().status, 'setup');
  assert.equal(controller.state().localAvailable, false);
  assert.equal(fake.views.length, 0);
  controller.close();
});

test(
  'explicit managed host control starts one private embedded driver and removes it on shutdown',
  { skip: !platformSupported },
  async (t) => {
    const f = bundleFixture(
      t,
      fixtureServer,
      { ...manifest, platform: 'darwin', hostControl: true },
      { platform: 'darwin' },
    );
    const executable = join(f.bundle, 'bin', 'cua-driver');
    assert.equal(f.runtime.hostControlAvailable(), false);
    const driverSource = `
const {createServer} = require('node:net');
const {chmodSync, writeFileSync} = require('node:fs');
const {join, dirname} = require('node:path');
const assert = require('node:assert/strict');
const socket = process.argv[5];
assert.deepEqual(process.argv.slice(2, 5), ['serve', '--embedded', '--socket']);
assert.equal(process.env.CUA_DRIVER_EMBEDDED, '1');
assert.equal(process.env.CUA_DRIVER_HOST_BUNDLE_ID, undefined);
assert.equal(process.env.CUA_DRIVER_PERMISSION_MODE, 'standard');
writeFileSync(join(dirname(socket), 'driver.pid'), String(process.pid));
const server = createServer();
server.listen(socket, () => chmodSync(socket, 0o600));
process.once('SIGTERM', () => server.close());
`;
    writeFileSync(executable, '#!' + process.execPath + '\n' + driverSource, { mode: 0o700 });
    assert.equal(f.runtime.hostControlAvailable(), true);
    const profile = join(f.dataDir, 'local-workspace');
    const config = () =>
      JSON.parse(readFileSync(join(profile, 'service.json'), 'utf8')).localDesktop;
    const start = (hostControl) =>
      f.runtime.start({
        hostControl,
        signal: new AbortController().signal,
        onExit: () => assert.fail('unexpected Rust exit'),
      });
    await start(false);
    assert.equal(config().hostControl, undefined);
    assert.equal(config().desktopDriver, undefined);
    await f.runtime.stop();
    process.env.BAMBOOSHIFT_FIXTURE_SECRET = 'synthetic';
    const previousBundleId = process.env.CUA_DRIVER_HOST_BUNDLE_ID;
    process.env.CUA_DRIVER_HOST_BUNDLE_ID = 'com.synthetic.unrelated-parent';
    let launched;
    try {
      launched = await start(true);
    } finally {
      delete process.env.BAMBOOSHIFT_FIXTURE_SECRET;
      if (previousBundleId === undefined) delete process.env.CUA_DRIVER_HOST_BUNDLE_ID;
      else process.env.CUA_DRIVER_HOST_BUNDLE_ID = previousBundleId;
    }
    const { leaked, hostIdentity, hostPath } = await fetch(launched.origin).then((res) =>
      res.json(),
    );
    assert.equal(leaked, false);
    assert.equal(hostIdentity, true);
    assert.equal(hostPath, true);
    assert.equal(config().hostControl, true);
    const { kind, executablePath, socketPath } = config().desktopDriver;
    assert.equal(kind, 'cua');
    assert.equal(executablePath, executable);
    const directory = require('node:path').dirname(socketPath);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(socketPath).isSocket(), true);
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    const pid = Number(readFileSync(join(directory, 'driver.pid'), 'utf8'));
    await f.runtime.stop();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.throws(() => statSync(directory), { code: 'ENOENT' });
  },
);

test('managed preference saves only an explicit host choice and safely reads the previous marker format', async (t) => {
  const f = bundleFixture(t, '');
  const marker = join(f.dataDir, 'local-workspace.selected');
  writeFileSync(marker, '1\n', { mode: 0o600 });
  assert.deepEqual(readLocalSelection(f.dataDir), { hostControl: false });
  saveLocalSelection(f.dataDir, { hostControl: true });
  assert.deepEqual(readLocalSelection(f.dataDir), { hostControl: true });
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  saveLocalSelection(f.dataDir, { hostControl: false });
  assert.deepEqual(readLocalSelection(f.dataDir), { hostControl: false });
});
