'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  renameSync,
  statSync,
} = require('node:fs');
const { join } = require('node:path');
const {
  normalizeServerOrigin,
  partitionFor,
  setupAsset,
  trustedSetupSender,
  allowedResource,
  allowedDownload,
  sharedFileDownloadRequest,
  rendererPreferences,
  ConnectionState,
  SETUP_URL,
} = require('./security.cjs');
const {
  createController,
  createSetupProtocolHandler,
  installSessionPolicy,
  saveLastOrigin,
  readLastOrigin,
} = require('./main.cjs');

const {
  tempDir,
  deferred,
  fakeElectron,
  sharedDownloadIds,
  sharedDownloadPath,
  sharedOwnerPath,
  sharedDownloadFixture,
  waitForDownload,
  controllerWithFilesystem,
} = require('./test-fixture.cjs');

test('connection state never auto-connects, retries only the attempted origin, and ignores stale completions', () => {
  const state = new ConnectionState(
    'https://suggested.example.com',
    'https://previous.example.com',
  );
  assert.equal(state.snapshot().status, 'setup');
  assert.throws(() => state.retryOrigin());
  const first = state.begin('https://first.example.com');
  const second = state.begin('https://second.example.com');
  assert.equal(state.connected(first), false);
  assert.equal(state.failed(first, 'late failure'), false);
  assert.equal(state.failed(second, 'offline'), true);
  assert.equal(state.retryOrigin(), second.origin);
  assert.equal(state.snapshot().url, second.origin);
  state.setup();
  assert.equal(state.connected(second), false);
  assert.equal(state.snapshot().status, 'setup');
});

test('fake main lifecycle keeps setup IPC off remote pages, isolates sessions, handles offline retry and closes without backend actions', async () => {
  const dataDir = tempDir();
  const fake = fakeElectron();
  const controller = createController(fake, {
    dataDir,
    suggestedUrl: 'https://one.example.com',
    loadTimeoutMs: 1000,
  });
  try {
    controller.start();
    await Promise.resolve();
    const win = fake.windows[0];
    assert.equal(win.title, 'BambooShift');
    assert.deepEqual(win.options.webPreferences, {
      ...rendererPreferences('openbot-setup', join(__dirname, 'preload.cjs')),
      session: fake.sessions.get('openbot-setup'),
    });
    assert.equal(win.options.webPreferences.spellcheck, false);
    assert.equal(fake.views.length, 0, 'environment suggestion must not initiate a connection');
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    assert.equal(fake.ipc.get('openbot-client:get-state')(event).status, 'setup');
    assert.throws(() =>
      fake.ipc.get('openbot-client:connect')(
        { sender: {}, senderFrame: win.webContents.mainFrame },
        { url: 'https://one.example.com' },
      ),
    );
    const first = fake.ipc.get('openbot-client:connect')(event, { url: 'https://one.example.com' });
    const firstView = fake.views[0];
    assert.equal(firstView.options.webPreferences.preload, join(__dirname, 'remote-preload.cjs'));
    assert.equal(firstView.options.webPreferences.nodeIntegration, false);
    assert.deepEqual(
      firstView.options.webPreferences,
      {
        ...rendererPreferences(
          partitionFor('https://one.example.com'),
          join(__dirname, 'remote-preload.cjs'),
        ),
        spellcheck: true,
        session: fake.sessions.get(partitionFor('https://one.example.com')),
      },
      'only the actual product view overrides native spelling; all isolation settings remain intact',
    );
    assert.throws(
      () => fake.ipc.get('openbot-client:get-state')(event),
      /连接页面/,
      'hidden setup bridge is unavailable while remote view exists',
    );
    firstView.webContents.loadGate.reject(new Error('offline'));
    assert.equal((await first).status, 'error');
    assert.equal(controller.state().url, 'https://one.example.com');
    const retry = fake.ipc.get('openbot-client:retry')(event);
    const retryView = fake.views[1];
    assert.equal(retryView.webContents.url, 'https://one.example.com/');
    assert.equal(retryView.options.webPreferences.spellcheck, true);
    retryView.webContents.loadGate.resolve();
    await retry;
    assert.equal(controller.state().status, 'connected');
    assert.equal(win.title, 'BambooShift');
    assert.equal(win.children.length, 1);
    assert.deepEqual(retryView.bounds, { x: 0, y: 0, width: 1250, height: 800 });
    assert.equal(readLastOrigin(dataDir), 'https://one.example.com');
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'client.json'), 'utf8')), {
      lastOrigin: 'https://one.example.com',
    });
    assert.equal(retryView.webContents.openHandler({ url: 'file:///etc/passwd' }).action, 'deny');
    assert.equal(fake.calls.external.length, 0);
    controller.showSetup();
    assert.equal(retryView.webContents.destroyed, true);
    assert.equal(controller.state().status, 'setup');
    assert.equal(
      win.options.webPreferences.spellcheck,
      false,
      'returning to setup does not enable its spelling service',
    );
    const next = controller.connect('https://two.example.com');
    const nextView = fake.views[2];
    assert.notEqual(
      nextView.options.webPreferences.partition,
      retryView.options.webPreferences.partition,
    );
    controller.close();
    assert.equal(nextView.webContents.destroyed, true);
    await next;
    assert.equal(controller.state().status, 'setup');
    assert.equal(fake.calls.external.length, 0);
  } finally {
    controller.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('cold start resumes a previously successful origin once; environment suggestions never authorize a new connection', async () => {
  const dataDir = tempDir();
  try {
    saveLastOrigin(dataDir, 'https://remembered.example.com');
    const fake = fakeElectron();
    const controller = createController(fake, { dataDir });
    controller.start();
    assert.equal(fake.views.length, 1);
    assert.equal(fake.views[0].webContents.url, 'https://remembered.example.com/');
    assert.equal(
      fake.views[0].options.webPreferences.partition,
      partitionFor('https://remembered.example.com'),
    );
    fake.views[0].webContents.loadGate.reject(new Error('offline'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.state().status, 'error');
    assert.equal(controller.state().url, 'https://remembered.example.com');
    controller.start();
    controller.focus();
    assert.equal(fake.views.length, 1, 'failure does not silently loop or reconnect on activation');
    controller.close();
    const override = fakeElectron();
    const suggestion = createController(override, {
      dataDir,
      suggestedUrl: 'https://new.example.com',
    });
    suggestion.start();
    assert.equal(override.views.length, 0);
    assert.equal(suggestion.state().status, 'setup');
    assert.equal(suggestion.state().url, 'https://new.example.com');
    suggestion.close();
    const firstDir = join(dataDir, 'first-run');
    mkdirSync(firstDir);
    const first = fakeElectron();
    const newClient = createController(first, {
      dataDir: firstDir,
      suggestedUrl: 'https://suggested.example.com',
    });
    newClient.start();
    assert.equal(first.views.length, 0);
    assert.equal(newClient.state().status, 'setup');
    newClient.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('reopening a closed product window resumes its approved origin and retains session isolation', async () => {
  const dataDir = tempDir();
  const fake = fakeElectron();
  const controller = createController(fake, { dataDir, suggestedUrl: 'https://new.example.com' });
  const closeWindow = (window) => {
    window.emit('close');
    window.destroyed = true;
    window.emit('closed');
  };
  try {
    controller.start();
    const opening = controller.connect('https://approved.example.com');
    const contents = fake.views[0].webContents;
    contents.loadGate.resolve();
    await opening;
    closeWindow(fake.windows[0]);
    assert.equal(contents.isDestroyed(), true);
    controller.focus();
    controller.focus();
    assert.equal(fake.windows.length, 2);
    assert.equal(fake.views.length, 2);
    const resumed = fake.views[1].webContents;
    assert.equal(resumed.getURL(), 'https://approved.example.com/');
    assert.equal(resumed.session, contents.session);
    resumed.loadGate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.state().status, 'connected');

    controller.showSetup();
    closeWindow(fake.windows[1]);
    controller.focus();
    assert.equal(fake.windows.length, 3);
    assert.equal(fake.views.length, 2, 'changing workspace clears the reopen target');
    assert.equal(controller.state().status, 'setup');
  } finally {
    controller.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
