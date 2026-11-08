'use strict';
const { productName } = require('./package.json');
const { sameOrigin } = require('./security.cjs');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function createNotifications({
  getConnection,
  getWindow,
  foregroundFrame,
  Notification,
  dialog,
  t,
  now,
}) {
  const states = new WeakMap();
  function bind(current) {
    const state = { epoch: 0, grants: new Map(), notices: new Map(), events: new Set(), times: [] };
    states.set(current, state);
    const clear = () => {
      state.epoch++;
      state.grants.clear();
      for (const notice of state.notices.values()) notice.close();
      state.notices.clear();
      state.events.clear();
      state.times = [];
    };
    const contents = current.view.webContents;
    const navigation = (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame !== false) clear();
    };
    contents.on('did-start-navigation', navigation);
    contents.on('did-navigate-in-page', navigation);
    contents.session.cookies.on('changed', clear);
    current.disposeNotifications = () => {
      clear();
      contents.session.cookies.removeListener('changed', clear);
      contents.removeListener('did-start-navigation', navigation);
      contents.removeListener('did-navigate-in-page', navigation);
    };
  }
  function context(event, value, notice = false) {
    try {
      const current = getConnection();
      const contents = current?.view.webContents;
      if (
        !current ||
        !current.attached ||
        contents.isDestroyed() ||
        event.sender !== contents ||
        event.senderFrame !== contents.mainFrame ||
        contents.mainFrame.isDestroyed() ||
        contents.mainFrame.detached ||
        !sameOrigin(contents.getURL(), current.origin) ||
        contents.mainFrame.url !== contents.getURL()
      )
        return;
      const keys = notice
        ? 'body,eventId,expectedUser,title,workspaceId'
        : 'expectedUser,workspaceId';
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== keys ||
        !uuid.test(value.workspaceId) ||
        !uuid.test(value.expectedUser)
      )
        return;
      const page = new URL(contents.getURL());
      if (![`/w/${value.workspaceId}`, `/w/${value.workspaceId}/`].includes(page.pathname)) return;
      if (
        notice &&
        (typeof value.eventId !== 'string' ||
          !/^[A-Za-z0-9:_-]{1,384}$/.test(value.eventId) ||
          typeof value.title !== 'string' ||
          !value.title.trim() ||
          value.title.length > 120 ||
          /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value.title) ||
          value.body !== '')
      )
        return;
      const state = states.get(current);
      if (!state) return;
      const epoch = state.epoch,
        url = contents.getURL(),
        frame = contents.mainFrame;
      return {
        current,
        contents,
        state,
        key: `${value.expectedUser}:${value.workspaceId}`,
        valid: () =>
          getConnection() === current &&
          state.epoch === epoch &&
          current.attached &&
          !contents.isDestroyed() &&
          contents.getURL() === url &&
          contents.mainFrame === frame &&
          !frame.isDestroyed() &&
          !frame.detached &&
          frame.url === url,
      };
    } catch {
      return;
    }
  }
  async function authenticated(ctx, scope) {
    try {
      const response = await ctx.contents.session.fetch(
        `${ctx.current.origin}/api/account/session`,
        {
          credentials: 'include',
          redirect: 'error',
          cache: 'no-store',
          headers: { 'X-OpenBot-Expected-User': scope.expectedUser },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!ctx.valid() || !response.ok || !response.body) return false;
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 128 * 1024 || !ctx.valid()) return false;
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const account = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return (
        ctx.valid() &&
        account.authenticated === true &&
        account.user?.id === scope.expectedUser &&
        account.user.status === 'active' &&
        Array.isArray(account.workspaces) &&
        account.workspaces.some(
          (workspace) => workspace.id === scope.workspaceId && workspace.status === 'active',
        )
      );
    } catch {
      return false;
    }
  }
  const supported = () => Boolean(Notification?.isSupported?.());
  async function permission(event, scope) {
    if (!supported()) return 'unsupported';
    const ctx = context(event, scope);
    if (!ctx || !(await authenticated(ctx, scope))) return 'denied';
    return ctx.state.grants.get(ctx.key) || 'prompt';
  }
  async function requestPermission(event, scope) {
    if (!supported()) return 'unsupported';
    const ctx = context(event, scope);
    const token = ctx?.current.notificationInput;
    if (ctx) ctx.current.notificationInput = undefined;
    if (
      !ctx ||
      !token ||
      token.frame !== event.senderFrame ||
      token.url !== ctx.contents.getURL() ||
      now() >= token.expiresAt ||
      foregroundFrame(event.sender, ctx.current.origin) !== event.senderFrame ||
      ctx.state.opening ||
      !(await authenticated(ctx, scope)) ||
      foregroundFrame(event.sender, ctx.current.origin) !== event.senderFrame
    )
      return 'denied';
    ctx.state.opening = true;
    try {
      const { response } = await dialog.showMessageBox(getWindow(), {
        type: 'question',
        title: productName,
        message: t('notificationsAllow'),
        detail: t('notificationsHelp'),
        buttons: [t('cancel'), t('notificationsEnable')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (!ctx.valid() || !(await authenticated(ctx, scope))) return 'denied';
      const result = response === 1 ? 'granted' : 'denied';
      ctx.state.grants.set(ctx.key, result);
      return result;
    } catch {
      return 'denied';
    } finally {
      ctx.state.opening = false;
    }
  }
  async function show(event, value) {
    if (!supported()) return false;
    const ctx = context(event, value, true);
    if (!ctx || ctx.state.grants.get(ctx.key) !== 'granted' || !(await authenticated(ctx, value)))
      return false;
    const { state } = ctx;
    if (state.events.has(value.eventId)) return true;
    state.times = state.times.filter((time) => now() - time < 60_000);
    if (state.events.size >= 4096 || state.times.length >= 20 || state.notices.size >= 20)
      return false;
    let notice;
    try {
      notice = new Notification({ title: value.title, body: '', silent: false });
      state.events.add(value.eventId);
      state.times.push(now());
      state.notices.set(value.eventId, notice);
      notice.on('close', () => state.notices.delete(value.eventId));
      notice.on('failed', () => state.notices.delete(value.eventId));
      notice.on('click', () => {
        const window = getWindow();
        if (ctx.valid() && window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
        }
        notice.close();
      });
      if (!ctx.valid()) {
        notice.close();
        return false;
      }
      notice.show();
      return true;
    } catch {
      notice?.close();
      return false;
    }
  }
  function clear(event, scope) {
    const ctx = context(event, scope);
    if (!ctx) return;
    for (const notice of ctx.state.notices.values()) notice.close();
    ctx.state.notices.clear();
  }
  return { bind, permission, requestPermission, show, clear };
}
module.exports = { createNotifications };
