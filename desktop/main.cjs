'use strict';
const { mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const security = require('./security.cjs');
const { productName } = require('./package.json');
const {
  readLastOrigin,
  saveLastOrigin,
  createSetupProtocolHandler,
  installSessionPolicy,
  createProductSessions,
  downloadAllowed,
} = require('./session-policy.cjs');
const { createInputPermissions } = require('./input-permissions.cjs');
const { createAuthorizationHandler } = require('./authorization.cjs');
const { createSharedDownloadHandler } = require('./shared-download.cjs');
const { createNotifications } = require('./notifications.cjs');
const { createMenus } = require('./menus.cjs');
const { createClientLanguage } = require('./language.cjs');
const { createProductView, closeProductView, createSetupWindow } = require('./product-view.cjs');
const {
  createLocalRuntime,
  authenticateLocalSession,
  localPartition,
  readLocalSelection,
  saveLocalSelection,
  installRuntimeQuit,
} = require('./local-runtime.cjs');
const {
  DEFAULT_ORIGIN,
  SETUP_URL,
  normalizeServerOrigin,
  isWorkspaceService,
  partitionFor,
  trustedSetupSender,
  trustedProductSender,
  ConnectionState,
} = security;

/** Electron is injected so policy/lifecycle tests can use pure fake objects without launching UI. */
function createController(
  electron,
  {
    dataDir,
    suggestedUrl,
    resourcesPath = process.resourcesPath,
    localRuntime = createLocalRuntime({ resourcesPath, dataDir }),
    loadTimeoutMs = 20_000,
    now = () => performance.now(),
  },
) {
  const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, dialog, shell } = electron;
  const language = createClientLanguage(
    dataDir,
    app.getPreferredSystemLanguages?.()[0] || app.getLocale?.() || 'zh-CN',
  );
  const t = language.t;
  const localAvailable = localRuntime.available();
  const localHostControlAvailable = localRuntime.hostControlAvailable();
  let localSelection = readLocalSelection(dataDir);
  let localOperation, localError;
  const snapshot = () => {
    const state = machine.snapshot();
    return {
      ...state,
      localAvailable,
      localHostControlAvailable,
      localHostControlSelected: localHostControlAvailable && localSelection?.hostControl === true,
      localStarting: Boolean(localOperation),
      ...(localError ? { localError: t(localError) } : {}),
      ...(state.error ? { error: language.message(state.error) } : {}),
      ...language.snapshot(),
    };
  };
  function localized(work) {
    try {
      const result = work();
      return result?.then
        ? result.catch((error) => {
            throw new Error(language.message(error.message));
          })
        : result;
    } catch (error) {
      throw new Error(language.message(error.message));
    }
  }
  function setLanguage(value) {
    language.set(value);
    return publish();
  }
  const lastOrigin = readLastOrigin(dataDir);
  const machine = new ConnectionState(suggestedUrl || lastOrigin || DEFAULT_ORIGIN, lastOrigin);
  let window, connection;
  let startupAttempted = false;
  let reopenOrigin, reopenLocal;
  const getConnection = () => connection;
  const getWindow = () => window;
  const { foregroundFrame, consumeClipboardWrite, consumeMicrophone, bindNativeInput } =
    createInputPermissions({ getConnection, getWindow, machine, now });
  const notifications = createNotifications({
    getConnection,
    getWindow,
    foregroundFrame,
    Notification: electron.Notification,
    dialog,
    t,
    now,
  });
  const openAppAuthorization = createAuthorizationHandler({
    getConnection,
    foregroundFrame,
    now,
    shell,
  });
  const downloadSharedFile = createSharedDownloadHandler({
    getConnection,
    getWindow,
    foregroundFrame,
    now,
    machine,
    dialog,
    t,
  });
  const { explainBlocked, menuTarget, bindContextMenu, installMenu } = createMenus({
    getConnection,
    getWindow,
    machine,
    Menu,
    dialog,
    shell,
    reconnect: () => (connection?.managed ? startLocal() : connect(machine.retryOrigin())),
    showSetup,
    t,
    getLanguage: () => language.snapshot().language,
    setLanguage,
  });
  const productSession = createProductSessions({
    session,
    getConnection,
    consumeClipboardWrite,
    consumeMicrophone,
    explainBlocked,
    t,
  });
  const setupSession = session.fromPartition('openbot-setup');
  installSessionPolicy(setupSession);
  setupSession.protocol.handle('openbot-app', createSetupProtocolHandler());
  setupSession.on('will-download', (event) => event.preventDefault());

  function publish() {
    if (window && !window.isDestroyed()) {
      if (window.webContents.getURL() === SETUP_URL)
        window.webContents.send('openbot-client:state', snapshot());
      window.setTitle(productName);
    }
    installMenu();
    return snapshot();
  }
  function resize() {
    if (!connection || !window || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    connection.view.setBounds({ x: 0, y: 0, width, height });
  }
  function destroyConnection() {
    const old = connection;
    connection = undefined;
    closeProductView(old, window);
  }
  function showSetup() {
    cancelLocal();
    localError = undefined;
    reopenLocal = false;
    reopenOrigin = undefined;
    machine.setup();
    destroyConnection();
    if (!window || window.isDestroyed()) createWindow();
    else window.webContents.focus();
    return publish();
  }
  function fail(current, reason) {
    if (connection !== current || !machine.failed(current.attempt, reason)) return;
    if (current.managed) {
      localError = reason === t('localRuntimeExited') ? 'localRuntimeExited' : 'localRuntimeFailed';
      cancelLocal();
      machine.setup();
    }
    destroyConnection();
    publish();
    if (window && !window.isDestroyed()) window.webContents.focus();
  }
  function cancelLocal() {
    localOperation?.abort();
    localOperation = undefined;
    return localRuntime.stop();
  }
  async function startLocal(
    hostControl = localHostControlAvailable && localSelection?.hostControl === true,
  ) {
    if (localOperation) return snapshot();
    showSetup();
    const operation = new AbortController();
    localOperation = operation;
    publish();
    let origin;
    try {
      const runtime = await localRuntime.start({
        signal: operation.signal,
        hostControl,
        onExit: () => {
          if (connection?.managed && connection.origin === origin)
            fail(connection, t('localRuntimeExited'));
        },
      });
      origin = runtime.origin;
      operation.signal.throwIfAborted();
      await connect(origin, { token: runtime.token, hostControl });
    } catch (error) {
      if (localOperation === operation) {
        localError = [
          'localRuntimeTimeout',
          'localRuntimeUnavailable',
          'localHostControlUnavailable',
          'localHostControlFailed',
        ].includes(error?.message)
          ? error.message
          : 'localRuntimeFailed';
        cancelLocal();
      }
    } finally {
      if (localOperation === operation) localOperation = undefined;
    }
    return publish();
  }
  async function connect(value, localLaunch) {
    const managed = localLaunch !== undefined;
    const attempt = machine.begin(value, managed);
    reopenOrigin = undefined;
    reopenLocal = false;
    if (!managed) {
      cancelLocal();
      localError = undefined;
    }
    destroyConnection();
    if (!window || window.isDestroyed()) createWindow();
    const partition = managed ? localPartition : partitionFor(attempt.origin);
    const ses = productSession(partition, attempt.origin, managed);
    const current = createProductView({
      WebContentsView,
      ses,
      partition,
      attempt,
      machine,
      bindNativeInput,
      notifications,
      explainBlocked,
      fail,
      bindContextMenu,
    });
    connection = current;
    const { view } = current;
    const contents = view.webContents;
    publish();
    current.timer = setTimeout(
      () => fail(current, '连接超时。请检查网络和服务状态，然后重试相同地址。'),
      loadTimeoutMs,
    );
    try {
      const supported = await isWorkspaceService(ses, current.origin, current.healthCheck.signal);
      if (connection !== current) return snapshot();
      if (!supported) {
        fail(current, t('workspaceRequired'));
        return snapshot();
      }
      const entry = managed
        ? await authenticateLocalSession(
            ses,
            current.origin,
            localLaunch.token,
            current.healthCheck.signal,
          )
        : '/';
      if (connection !== current) return snapshot();
      await contents.loadURL(current.origin + entry);
      if (connection !== current || !machine.connected(attempt)) return snapshot();
      clearTimeout(current.timer);
      localSelection = managed ? { hostControl: localLaunch.hostControl } : undefined;
      saveLocalSelection(dataDir, localSelection);
      if (!managed) {
        try {
          saveLastOrigin(dataDir, current.origin);
        } catch {
          /* A read-only profile must not prevent this explicitly requested connection. */
        }
      }
      window.contentView.addChildView(view);
      current.attached = true;
      resize();
      contents.focus();
      publish();
    } catch {
      fail(current, '无法连接这个空间。请检查地址、网络和服务状态，然后重试。');
    }
    return snapshot();
  }
  function createWindow() {
    window = createSetupWindow({
      BrowserWindow,
      setupSession,
      dialog,
      t,
      resize,
      publish,
      installMenu,
      onBlur: () => {
        if (!connection) return;
        connection.clipboardInput = undefined;
        connection.microphoneInput = undefined;
        connection.oauthInput = undefined;
        connection.sharedFileInput = undefined;
        connection.notificationInput = undefined;
      },
      onClose: () => {
        reopenLocal = connection?.attached && connection.managed;
        reopenOrigin = connection?.attached && !reopenLocal ? connection.origin : undefined;
        cancelLocal();
        machine.setup();
        destroyConnection();
      },
      onClosed: (closed) => {
        if (window === closed) window = undefined;
      },
    });
    return window;
  }
  ipcMain.handle('openbot-app:authorize', (event, value) =>
    localized(() => openAppAuthorization(event, value)),
  );
  ipcMain.handle('openbot-files:download-shared', (event, value) =>
    localized(() => downloadSharedFile(event, value)),
  );
  for (const method of ['permission', 'requestPermission', 'show', 'clear'])
    ipcMain.handle(`openbot-notifications:${method}`, (event, value) =>
      notifications[method](event, value),
    );
  ipcMain.handle('openbot-client:set-language', (event, value) => {
    if (!trustedSetupSender(event, window?.webContents) || connection)
      throw new Error(t('setupOnly'));
    return setLanguage(value);
  });
  ipcMain.handle('openbot-client:get-version', (event, value) => {
    if (
      value !== undefined ||
      machine.snapshot().status !== 'connected' ||
      !trustedProductSender(event, connection)
    )
      throw new Error('Client version is unavailable.');
    return app.getVersion();
  });
  ipcMain.handle('openbot-client:start-local', (event, value) => {
    if (connection || !trustedSetupSender(event, window?.webContents))
      throw new Error(t('setupOnly'));
    if (
      value !== undefined &&
      (!value || Object.keys(value).length !== 1 || typeof value.hostControl !== 'boolean')
    )
      throw new Error(t('invalidParameters'));
    return startLocal(value?.hostControl ?? false);
  });
  ipcMain.handle('openbot-client:cancel-local', (event, value) => {
    if (value !== undefined || !localOperation || !trustedSetupSender(event, window?.webContents))
      throw new Error(t('setupOnly'));
    localSelection = undefined;
    saveLocalSelection(dataDir, localSelection);
    return showSetup();
  });
  for (const [channel, handler] of [
    ['openbot-client:get-state', snapshot],
    [
      'openbot-client:connect',
      (value) => {
        if (!value || typeof value !== 'object' || Object.keys(value).some((key) => key !== 'url'))
          throw new Error('连接参数无效。');
        return connect(value.url);
      },
    ],
    ['openbot-client:retry', () => connect(machine.retryOrigin())],
  ])
    ipcMain.handle(channel, (event, value) => {
      if (!trustedSetupSender(event, window?.webContents) || connection)
        throw new Error(t('setupOnly'));
      return localized(() => handler(value));
    });
  return {
    start: () => {
      if (startupAttempted) return;
      startupAttempted = true;
      createWindow();
      // A persisted success records the user's prior explicit choice. An environment-only
      // suggestion, or a different suggestion, never authorizes connecting a new origin.
      let resume = Boolean(lastOrigin) && !suggestedUrl;
      if (lastOrigin && suggestedUrl) {
        try {
          resume = normalizeServerOrigin(suggestedUrl) === lastOrigin;
        } catch {
          resume = false;
        }
      }
      if (!suggestedUrl && localSelection) {
        if (localAvailable) void startLocal();
      } else if (resume) void connect(lastOrigin);
    },
    createWindow,
    connect,
    showSetup,
    state: snapshot,
    focus: () => {
      if (!window || window.isDestroyed()) {
        if (reopenLocal) void startLocal();
        else if (reopenOrigin) void connect(reopenOrigin);
        else createWindow();
      } else {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (window.isFocused()) menuTarget()?.focus();
      }
    },
    close: () => {
      const stopping = cancelLocal();
      reopenLocal = false;
      reopenOrigin = undefined;
      machine.setup();
      destroyConnection();
      return stopping;
    },
  };
}
async function boot(electron = require('electron')) {
  const { app, protocol } = electron;
  // Resolve the legacy profile before setting the visible name.
  app.setName('OpenBot');
  const dataDir = resolve(process.env.OPENBOT_CLIENT_DATA_DIR || app.getPath('userData'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, 'sessions'), { recursive: true, mode: 0o700 });
  app.setPath('userData', dataDir);
  app.setPath('sessionData', join(dataDir, 'sessions'));
  app.setName(productName);
  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([
    { scheme: 'openbot-app', privileges: { standard: true, secure: true } },
  ]);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Default certificate checks remain enabled; no certificate trust override is installed.
  app.on('select-client-certificate', (event, _contents, _url, _list, callback) => {
    event.preventDefault();
    callback();
  });
  app.on('open-url', (event) => event.preventDefault());
  app.on('open-file', (event) => event.preventDefault());
  await app.whenReady();
  const controller = createController(electron, {
    dataDir,
    suggestedUrl: process.env.OPENBOT_CLIENT_URL,
  });
  controller.start();
  app.on('activate', () => controller.focus());
  app.on('second-instance', () => controller.focus());
  installRuntimeQuit(app, controller.close);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  return controller;
}
module.exports = {
  boot,
  createController,
  createSetupProtocolHandler,
  installSessionPolicy,
  downloadAllowed,
  readLastOrigin,
  saveLastOrigin,
};
if (require.main === module)
  void boot().catch((error) => {
    console.error(`${productName} client could not start:`, error.message);
    process.exitCode = 1;
  });
