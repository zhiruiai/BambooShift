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

function tempDir() {
  const root = join(__dirname, '../data');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'client-test-'));
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function fakeElectron() {
  const ipc = new Map(),
    sessions = new Map(),
    windows = [],
    views = [],
    calls = { external: [], dialogs: [], saves: [], menu: [], contextMenus: [], responders: [] };
  class Contents extends EventEmitter {
    constructor() {
      super();
      this.url = '';
      this.destroyed = false;
      this.mainFrame = {
        url: '',
        origin: '',
        visibilityState: 'visible',
        detached: false,
        isDestroyed: () => this.destroyed,
      };
      this.focusedFrame = this.mainFrame;
      this.focused = true;
      this.loading = false;
      this.messages = [];
      this.edits = [];
      this.focusCount = 0;
      for (const action of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
        this[action] = () => this.edits.push(action);
    }
    getURL() {
      return this.url;
    }
    isDestroyed() {
      return this.destroyed;
    }
    setWindowOpenHandler(handler) {
      this.openHandler = handler;
    }
    setUserAgent(agent) {
      this.ua = agent;
    }
    loadURL(url) {
      this.url = url;
      this.mainFrame.url = url;
      this.mainFrame.origin = new URL(url).origin;
      if (this.loadGate) return this.loadGate.promise;
      queueMicrotask(() => this.emit('did-finish-load'));
      return Promise.resolve();
    }
    close() {
      this.destroyed = true;
      this.loadGate?.reject(new Error('closed'));
      this.emit('destroyed');
    }
    send(channel, state) {
      this.messages.push({ channel, state });
    }
    focus() {
      this.focusCount += 1;
      this.focused = true;
    }
    isFocused() {
      return this.focused;
    }
    isLoadingMainFrame() {
      return this.loading;
    }
    getZoomLevel() {
      return 0;
    }
    setZoomLevel() {}
  }
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new Contents();
      this.destroyed = false;
      this.visible = false;
      this.focused = true;
      this.minimized = false;
      this.children = [];
      this.contentView = {
        addChildView: (view) => this.children.push(view),
        removeChildView: (view) => {
          assert.ok(this.children.includes(view));
          this.children = this.children.filter((item) => item !== view);
        },
      };
      windows.push(this);
    }
    loadURL(url) {
      return this.webContents.loadURL(url);
    }
    isDestroyed() {
      return this.destroyed;
    }
    getContentSize() {
      return [1250, 800];
    }
    setTitle(title) {
      this.title = title;
    }
    show() {
      this.visible = true;
    }
    focus() {
      this.focused = true;
    }
    isVisible() {
      return this.visible;
    }
    isFocused() {
      return this.focused;
    }
    isMinimized() {
      return this.minimized;
    }
  }
  class View {
    constructor(options) {
      this.options = options;
      this.webContents = new Contents();
      this.webContents.session = options.webPreferences.session;
      this.webContents.loadGate = deferred();
      views.push(this);
    }
    setBackgroundColor() {}
    setBounds(bounds) {
      this.bounds = bounds;
    }
  }
  const getSession = (partition) => {
    if (!sessions.has(partition)) {
      const ses = new EventEmitter();
      Object.assign(ses, {
        cookies: new EventEmitter(),
        protocol: {
          handle: (scheme, handler) => {
            ses.protocolHandler = handler;
          },
        },
        webRequest: {
          onBeforeRequest: (handler) => {
            ses.beforeRequest = handler;
          },
        },
        setPermissionRequestHandler: (handler) => {
          ses.requestPermission = handler;
        },
        setPermissionCheckHandler: (handler) => {
          ses.checkPermission = handler;
        },
        setDevicePermissionHandler: (handler) => {
          ses.devicePermission = handler;
        },
        setDisplayMediaRequestHandler: (handler, options) => {
          ses.displayPermission = handler;
          ses.displayOptions = options;
        },
        getUserAgent: () => 'FakeChromium',
        setUserAgent: (ua) => {
          ses.ua = ua;
        },
      });
      sessions.set(partition, ses);
    }
    return sessions.get(partition);
  };
  return {
    app: { getVersion: () => '0.1.0' },
    BrowserWindow: Window,
    WebContentsView: View,
    session: { fromPartition: getSession },
    ipcMain: { handle: (channel, fn) => ipc.set(channel, fn) },
    Menu: {
      buildFromTemplate: (items) => ({
        items,
        popup() {
          calls.contextMenus.push(items);
        },
      }),
      setApplicationMenu: (menu) => calls.menu.push(menu),
      sendActionToFirstResponder: (action) => calls.responders.push(action),
    },
    dialog: {
      showSaveDialog: async (...args) => {
        calls.saves.push(args);
        return { canceled: true, filePath: '' };
      },
      showMessageBox: async (...args) => {
        calls.dialogs.push(args);
        return { response: 0 };
      },
    },
    shell: { openExternal: async (url) => calls.external.push(url) },
    ipc,
    sessions,
    windows,
    views,
    calls,
  };
}

const sharedDownloadIds = {
  workspace: '11111111-1111-4111-8111-111111111111',
  share: '22222222-2222-4222-8222-222222222222',
  user: '33333333-3333-4333-8333-333333333333',
};
const sharedDownloadPath = `/api/shared-bots/${sharedDownloadIds.share}/files/source-file/download?revision=${'a'.repeat(64)}`;
const sharedOwnerPath = `/api/workspaces/${sharedDownloadIds.workspace}/agents/chief/sharing/files/source-file/download?revision=${'a'.repeat(64)}`;

async function sharedDownloadFixture(makeController = createController) {
  const dataDir = tempDir(),
    fake = fakeElectron();
  const controller = makeController(fake, { dataDir });
  controller.start();
  await Promise.resolve();
  const connecting = controller.connect('https://files.example.com');
  const contents = fake.views[0].webContents;
  contents.loadGate.resolve();
  await connecting;
  contents.url = `https://files.example.com/w/${sharedDownloadIds.workspace}`;
  contents.mainFrame.url = contents.url;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const destination = join(dataDir, 'selected.txt');
  const requests = [];
  const state = { user: sharedDownloadIds.user, accountCalls: 0, fileCalls: 0, headCalls: 0 };
  const file = Buffer.from('SYNTHETIC_SHARED_FILE 中文');
  let beforeAccount = () => {},
    readHeadResponse = () =>
      new Response(null, { headers: { 'Content-Length': String(file.length) } }),
    readFileResponse = () =>
      new Response(file, { headers: { 'Content-Length': String(file.length) } });
  contents.session.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/api/account/session')) {
      state.accountCalls++;
      await beforeAccount(state.accountCalls);
      return Response.json({ authenticated: true, user: { id: state.user } });
    }
    if (init.method === 'HEAD') {
      state.headCalls++;
      return readHeadResponse(url, init);
    }
    state.fileCalls++;
    return readFileResponse(url, init);
  };
  fake.dialog.showSaveDialog = async (...args) => {
    fake.calls.saves.push(args);
    return { canceled: false, filePath: destination };
  };
  return {
    dataDir,
    fake,
    controller,
    contents,
    event,
    destination,
    requests,
    state,
    file,
    arm() {
      contents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
    },
    invoke(
      value = {
        path: sharedDownloadPath,
        expectedUser: sharedDownloadIds.user,
        name: '../../safe.txt',
      },
      sender = event,
    ) {
      return fake.ipc.get('openbot-files:download-shared')(sender, value);
    },
    setAccountHook(callback) {
      beforeAccount = callback;
    },
    setResponse(callback) {
      readFileResponse = callback;
    },
    setHeadResponse(callback) {
      readHeadResponse = callback;
    },
    assertNoTemps() {
      assert.deepEqual(
        readdirSync(dataDir).filter((name) => name.startsWith('.openbot-download-')),
        [],
      );
    },
    close() {
      controller.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
async function waitForDownload(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('synthetic download fixture did not reach its boundary');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function controllerWithFilesystem(fsOverrides = {}, promiseOverrides = {}) {
  const { runInNewContext } = require('node:vm');
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const mod = { exports: {} };
    modules.set(filename, mod);
    const injectedRequire = (name) =>
      name === 'node:fs'
        ? { ...require('node:fs'), ...fsOverrides }
        : name === 'node:fs/promises'
          ? { ...require('node:fs/promises'), ...promiseOverrides }
          : name.startsWith('./') && !name.endsWith('.json')
            ? load(join(__dirname, name))
            : require(name);
    runInNewContext(
      readFileSync(filename, 'utf8'),
      {
        require: injectedRequire,
        module: mod,
        exports: mod.exports,
        __dirname,
        Buffer,
        URL,
        Response,
        AbortController,
        AbortSignal,
        performance,
        setTimeout,
        clearTimeout,
        process,
        console,
      },
      { filename },
    );
    return mod.exports;
  }
  return load(join(__dirname, 'main.cjs')).createController;
}
module.exports = {
  tempDir,
  deferred,
  fakeElectron,
  sharedDownloadIds,
  sharedDownloadPath,
  sharedOwnerPath,
  sharedDownloadFixture,
  waitForDownload,
  controllerWithFilesystem,
};
