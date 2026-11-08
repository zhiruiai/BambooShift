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
  downloadAllowed,
} = require('./session-policy.cjs');
const { createInputPermissions } = require('./input-permissions.cjs');
const { createAuthorizationHandler } = require('./authorization.cjs');
const { createSharedDownloadHandler } = require('./shared-download.cjs');
const { createNotifications } = require('./notifications.cjs');
const { createMenus } = require('./menus.cjs');
const { createClientLanguage } = require('./language.cjs');
const {
  DEFAULT_ORIGIN,
  SETUP_URL,
  normalizeServerOrigin,
  sameOrigin,
  partitionFor,
  trustedSetupSender,
  trustedProductSender,
  safeFilename,
  rendererPreferences,
  ConnectionState,
} = security;

/** Electron is injected so policy/lifecycle tests can use pure fake objects without launching UI. */
function createController(
  electron,
  { dataDir, suggestedUrl, loadTimeoutMs = 20_000, now = () => performance.now() },
) {
  const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, dialog, shell } = electron;
  const language = createClientLanguage(
    dataDir,
    app.getPreferredSystemLanguages?.()[0] || app.getLocale?.() || 'zh-CN',
  );
  const t = language.t;
  const snapshot = () => {
    const state = machine.snapshot();
    return {
      ...state,
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
  let reopenOrigin;
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
    connect,
    showSetup,
    t,
    getLanguage: () => language.snapshot().language,
    setLanguage,
  });
  const configuredSessions = new WeakSet();
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
    if (!old) return;
    old.clipboardInput = undefined;
    old.microphoneInput = undefined;
    old.sharedFileInput = undefined;
    old.notificationInput = undefined;
    old.disposeNotifications?.();
    old.sharedFileDownload?.abort();
    clearTimeout(old.timer);
    for (const item of old.downloads) {
      try {
        item.cancel();
      } catch {
        /* Already completed. */
      }
    }
    if (window && !window.isDestroyed())
      if (old.attached) window.contentView.removeChildView(old.view);
    if (!old.view.webContents.isDestroyed())
      old.view.webContents.close({ waitForBeforeUnload: false });
    // No backend shutdown or task-cancellation request is sent when closing a view.
  }
  function showSetup() {
    reopenOrigin = undefined;
    machine.setup();
    destroyConnection();
    if (!window || window.isDestroyed()) createWindow();
    else window.webContents.focus();
    return publish();
  }
  function fail(current, reason) {
    if (connection !== current || !machine.failed(current.attempt, reason)) return;
    destroyConnection();
    publish();
    if (window && !window.isDestroyed()) window.webContents.focus();
  }
  function remoteSession(origin) {
    const ses = session.fromPartition(partitionFor(origin));
    if (!configuredSessions.has(ses)) {
      installSessionPolicy(ses, origin, consumeClipboardWrite, consumeMicrophone);
      ses.on('will-download', (event, item, contents, frame) => {
        const current = connection;
        if (!downloadAllowed(item, contents, frame, current) || current.origin !== origin) {
          event.preventDefault();
          explainBlocked();
          return;
        }
        // Never set a save path: Electron must display the native save dialog for every file.
        item.setSaveDialogOptions({
          title: t('saveFile'),
          defaultPath: safeFilename(item.getFilename()),
          buttonLabel: t('save'),
        });
        current.downloads.add(item);
        item.once('done', () => current.downloads.delete(item));
      });
      configuredSessions.add(ses);
    }
    return ses;
  }
  async function connect(value) {
    const attempt = machine.begin(value);
    reopenOrigin = undefined;
    destroyConnection();
    if (!window || window.isDestroyed()) createWindow();
    const ses = remoteSession(attempt.origin);
    const view = new WebContentsView({
      webPreferences: {
        ...rendererPreferences(partitionFor(attempt.origin), join(__dirname, 'remote-preload.cjs')),
        // The product controls individual fields through HTML spellcheck.
        // Keep the setup renderer and the shared security defaults disabled.
        spellcheck: true,
        session: ses,
      },
    });
    const current = {
      view,
      origin: attempt.origin,
      attempt,
      downloads: new Set(),
      timer: undefined,
      attached: false,
    };
    connection = current;
    view.setBackgroundColor('#fbfaf9');
    const contents = view.webContents;
    contents.setUserAgent(ses.getUserAgent());
    bindNativeInput(contents, current);
    notifications.bind(current);
    const preventNavigation = (details) => {
      if (!sameOrigin(details.url, current.origin)) {
        details.preventDefault();
        if (machine.snapshot().status === 'connecting')
          fail(current, '服务跳转到了其他地址。请确认正确地址后重新连接。');
        else explainBlocked();
      }
    };
    contents.on('will-frame-navigate', preventNavigation);
    contents.on('will-redirect', preventNavigation);
    contents.on('will-navigate', (event, url) => {
      if (!sameOrigin(url || event.url, current.origin)) {
        event.preventDefault();
        explainBlocked();
      }
    });
    contents.setWindowOpenHandler(() => {
      explainBlocked();
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('content-bounds-updated', (event) => event.preventDefault());
    contents.on('page-title-updated', (event) => event.preventDefault());
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3)
        fail(
          current,
          code <= -200 && code >= -299
            ? '服务证书验证失败。请使用有效的 HTTPS 证书；客户端不会跳过证书检查。'
            : '无法加载这个空间。请检查服务是否启动和网络连接，然后重试。',
        );
    });
    contents.on('did-navigate', (_event, _url, statusCode) => {
      if (statusCode >= 400)
        fail(current, `服务返回错误（${statusCode}）。请检查所填地址，或稍后重试。`);
    });
    contents.on('render-process-gone', () =>
      fail(current, '空间页面意外退出。服务端任务不受影响，可以重新连接。'),
    );
    contents.on('destroyed', () =>
      fail(current, '空间页面已关闭。服务端任务不受影响，可以重新连接。'),
    );
    bindContextMenu(contents, current);
    publish();
    current.timer = setTimeout(
      () => fail(current, '连接超时。请检查网络和服务状态，然后重试相同地址。'),
      loadTimeoutMs,
    );
    try {
      await contents.loadURL(current.origin + '/');
      if (connection !== current || !machine.connected(attempt)) return snapshot();
      clearTimeout(current.timer);
      try {
        saveLastOrigin(dataDir, current.origin);
      } catch {
        /* A read-only profile must not prevent this explicitly requested connection. */
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
    window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 760,
      minHeight: 540,
      title: productName,
      backgroundColor: '#fbfaf9',
      show: false,
      webPreferences: {
        ...rendererPreferences('openbot-setup', join(__dirname, 'preload.cjs')),
        session: setupSession,
      },
    });
    window.on('resize', resize);
    window.on('enter-full-screen', resize);
    window.on('leave-full-screen', resize);
    for (const event of ['blur', 'hide', 'minimize'])
      window.on(event, () => {
        if (connection) {
          connection.clipboardInput = undefined;
          connection.microphoneInput = undefined;
          connection.oauthInput = undefined;
          connection.sharedFileInput = undefined;
          connection.notificationInput = undefined;
        }
      });
    window.on('close', () => {
      reopenOrigin = connection?.attached ? connection.origin : undefined;
      machine.setup();
      destroyConnection();
    });
    window.on('closed', () => {
      window = undefined;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if ((url || event.url) !== SETUP_URL) event.preventDefault();
    });
    window.webContents.on('will-frame-navigate', (event) => {
      if (event.url !== SETUP_URL || !event.isMainFrame) event.preventDefault();
    });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('page-title-updated', (event) => event.preventDefault());
    window.webContents.on('did-finish-load', () => {
      publish();
      window?.show();
    });
    void window.loadURL(SETUP_URL).catch(() => {
      if (window && !window.isDestroyed()) {
        window.show();
        void dialog.showMessageBox(window, {
          type: 'error',
          title: productName,
          message: t('setupFailed'),
        });
      }
    });
    installMenu();
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
      if (resume) void connect(lastOrigin);
    },
    createWindow,
    connect,
    showSetup,
    state: snapshot,
    focus: () => {
      if (!window || window.isDestroyed()) {
        if (reopenOrigin) void connect(reopenOrigin);
        else createWindow();
      } else {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (window.isFocused()) menuTarget()?.focus();
      }
    },
    close: () => {
      reopenOrigin = undefined;
      machine.setup();
      destroyConnection();
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
  app.on('before-quit', () => controller.close());
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
