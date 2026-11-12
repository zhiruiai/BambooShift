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

test('fake main download integration always prompts and rejects a cross-origin redirect or forged initiator', async () => {
  const dataDir = tempDir();
  const fake = fakeElectron();
  const controller = createController(fake, { dataDir });
  try {
    controller.createWindow();
    const opening = controller.connect('https://files.example.com');
    const view = fake.views[0];
    view.webContents.loadGate.resolve();
    await opening;
    const ses = fake.sessions.get(partitionFor('https://files.example.com'));
    function item(overrides = {}) {
      const download = new EventEmitter();
      Object.assign(download, {
        getURL: () => 'https://files.example.com/api/files/test-id/download',
        getURLChain: () => ['https://files.example.com/api/files/test-id/download'],
        getInitiatorOrigin: () => 'https://files.example.com',
        hasUserGesture: () => true,
        getFilename: () => '../../my-report.pdf',
        setSaveDialogOptions: (options) => {
          download.dialog = options;
        },
        setSavePath: () => assert.fail('Save path must never bypass user dialog'),
        cancel: () => {
          download.cancelled = true;
        },
        ...overrides,
      });
      return download;
    }
    let prevented = false;
    const allowed = item();
    ses.emit(
      'will-download',
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      allowed,
      view.webContents,
      view.webContents.mainFrame,
    );
    assert.equal(prevented, false);
    assert.equal(allowed.dialog.defaultPath, 'my-report.pdf');
    assert.equal(allowed.dialog.title, '保存 BambooShift 文件');
    for (const rejected of [
      item({ getInitiatorOrigin: () => 'https://evil.example' }),
      item({
        getURLChain: () => [
          'https://files.example.com/api/files/test-id/download',
          'https://evil.example/final',
        ],
      }),
      item({ hasUserGesture: () => false }),
    ]) {
      prevented = false;
      ses.emit(
        'will-download',
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        rejected,
        view.webContents,
        view.webContents.mainFrame,
      );
      assert.equal(prevented, true);
      assert.equal(rejected.dialog, undefined);
    }
    controller.showSetup();
    assert.equal(allowed.cancelled, true, 'changing space cancels an unfinished local download');
  } finally {
    controller.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sandbox preload exposes only narrow setup methods and strips IPC event objects', async () => {
  const { runInNewContext } = require('node:vm');
  const source = readFileSync(join(__dirname, 'preload.cjs'), 'utf8');
  function evaluate(url, isMainFrame) {
    let exposed, listener;
    const invoked = [];
    const electron = {
      contextBridge: {
        exposeInMainWorld: (name, api) => {
          assert.equal(name, 'openbotDesktop');
          exposed = api;
        },
      },
      ipcRenderer: {
        invoke: (...args) => {
          invoked.push(args);
          return Promise.resolve({ status: 'setup' });
        },
        on: (_channel, callback) => {
          listener = callback;
        },
        removeListener: (_channel, callback) => {
          assert.equal(listener, callback);
          listener = undefined;
        },
      },
    };
    runInNewContext(source, {
      require: (name) => {
        assert.equal(name, 'electron');
        return electron;
      },
      process: { isMainFrame },
      location: { href: url },
    });
    return {
      get exposed() {
        return exposed;
      },
      invoked,
      get listener() {
        return listener;
      },
    };
  }
  assert.equal(evaluate('https://bot.example.com/', true).exposed, undefined);
  assert.equal(evaluate(SETUP_URL, false).exposed, undefined);
  const setup = evaluate(SETUP_URL, true);
  assert.deepEqual(Object.keys(setup.exposed).sort(), [
    'cancelLocal',
    'connect',
    'getState',
    'onState',
    'retry',
    'setLanguage',
    'startLocal',
  ]);
  await setup.exposed.connect({
    url: 'https://bot.example.com',
    arbitraryCommand: 'not forwarded',
  });
  assert.equal(setup.invoked[0][0], 'openbot-client:connect');
  assert.deepEqual(Object.keys(setup.invoked[0][1]), ['url']);
  await setup.exposed.startLocal({ hostControl: true, arbitraryCommand: 'not forwarded' });
  await setup.exposed.cancelLocal({ arbitraryPath: 'not forwarded' });
  assert.deepEqual(JSON.parse(JSON.stringify(setup.invoked.slice(1))), [
    ['openbot-client:start-local', { hostControl: true }],
    ['openbot-client:cancel-local'],
  ]);
  let received;
  const unsubscribe = setup.exposed.onState((value) => {
    received = value;
  });
  const value = { status: 'error' };
  setup.listener({ sender: 'must-not-leak' }, value);
  assert.equal(received, value);
  unsubscribe();
  assert.equal(setup.listener, undefined);
});
