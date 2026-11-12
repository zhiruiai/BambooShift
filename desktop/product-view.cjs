'use strict';
const { join } = require('node:path');
const { rendererPreferences, sameOrigin, SETUP_URL } = require('./security.cjs');
const { productName } = require('./package.json');

function createProductView({
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
}) {
  const view = new WebContentsView({
    webPreferences: {
      ...rendererPreferences(partition, join(__dirname, 'remote-preload.cjs')),
      // The product controls individual fields through HTML spellcheck.
      // Keep the setup renderer and the shared security defaults disabled.
      spellcheck: true,
      session: ses,
    },
  });
  const current = {
    view,
    origin: attempt.origin,
    managed: attempt.managed,
    partition,
    attempt,
    downloads: new Set(),
    healthCheck: new AbortController(),
    timer: undefined,
    attached: false,
  };
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
  return current;
}
function closeProductView(old, window) {
  if (!old) return;
  old.clipboardInput = undefined;
  old.microphoneInput = undefined;
  old.sharedFileInput = undefined;
  old.notificationInput = undefined;
  old.disposeNotifications?.();
  old.sharedFileDownload?.abort();
  old.healthCheck.abort();
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
}
function createSetupWindow({
  BrowserWindow,
  setupSession,
  dialog,
  t,
  resize,
  publish,
  installMenu,
  onBlur,
  onClose,
  onClosed,
}) {
  const window = new BrowserWindow({
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
  for (const event of ['resize', 'enter-full-screen', 'leave-full-screen'])
    window.on(event, resize);
  for (const event of ['blur', 'hide', 'minimize']) window.on(event, onBlur);
  window.on('close', onClose);
  window.on('closed', () => onClosed(window));
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if ((url || event.url) !== SETUP_URL) event.preventDefault();
  });
  contents.on('will-frame-navigate', (event) => {
    if (event.url !== SETUP_URL || !event.isMainFrame) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('page-title-updated', (event) => event.preventDefault());
  contents.on('did-finish-load', () => {
    publish();
    window.show();
  });
  void window.loadURL(SETUP_URL).catch(() => {
    if (window.isDestroyed()) return;
    window.show();
    void dialog.showMessageBox(window, {
      type: 'error',
      title: productName,
      message: t('setupFailed'),
    });
  });
  installMenu();
  return window;
}
module.exports = { createProductView, closeProductView, createSetupWindow };
