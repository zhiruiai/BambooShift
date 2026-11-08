'use strict';
const { createHash } = require('node:crypto');
const { version } = require('./package.json');

const DEFAULT_ORIGIN = 'http://127.0.0.1:3001';
const SETUP_URL = 'openbot-app://setup/';
const ASSETS = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
});
const SETUP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

function normalizeServerOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error('请输入完整的 PandaMate 服务地址。');
  const text = value.trim();
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(text) || /[\\\u0000-\u0020\u007f]/.test(text))
    throw new Error('只填写服务地址，不包含路径、查询参数或片段。');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('服务地址无效。');
  }
  const authority = text.slice(text.indexOf('://') + 3).replace(/\/$/, '');
  if (url.username || url.password || authority.includes('@'))
    throw new Error('服务地址不能包含账号或密码。');
  if (!url.hostname || url.pathname !== '/' || url.search || url.hash)
    throw new Error('服务地址必须是一个完整来源地址。');
  if (url.protocol === 'http:') {
    const rawHost = authority.startsWith('[')
      ? authority.slice(0, authority.indexOf(']') + 1)
      : authority.split(':')[0];
    if (!['localhost', '127.0.0.1', '[::1]'].includes(rawHost.toLowerCase()))
      throw new Error('远程服务必须使用 HTTPS；只有 localhost、127.0.0.1 和 [::1] 可以使用 HTTP。');
  } else if (url.protocol !== 'https:') throw new Error('服务地址必须使用 HTTPS。');
  return url.origin;
}
function webUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\\\u0000-\u0020\u007f]/.test(value))
    return null;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      value.split('/')[2]?.includes('@')
    )
      return null;
    return url;
  } catch {
    return null;
  }
}
function sameOrigin(value, origin) {
  const url = webUrl(value);
  return !!url && url.origin === origin;
}
function appAuthorizationRequest(value, pageUrl, origin) {
  const keys = ['connectionId', 'expectedUserId', 'flowId', 'workspaceId'];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.join(',') ||
    keys.some((key) => typeof value[key] !== 'string' || !uuid.test(value[key])) ||
    !sameOrigin(pageUrl, origin)
  )
    return null;
  const path = new URL(pageUrl).pathname;
  if (
    ![
      `/w/${value.workspaceId}`,
      `/w/${value.workspaceId}/`,
      `/w/${value.workspaceId}/manage`,
    ].includes(path)
  )
    return null;
  return {
    ...value,
    launchPath: `/app-authorize/${value.workspaceId}/${value.connectionId}/${value.flowId}`,
  };
}
function partitionFor(origin) {
  return (
    'persist:openbot-' + createHash('sha256').update(normalizeServerOrigin(origin)).digest('hex')
  );
}
function setupAsset(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'openbot-app:' ||
      url.host !== 'setup' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return ASSETS[url.pathname] || null;
  } catch {
    return null;
  }
}
function trustedSetupSender(event, contents) {
  try {
    return (
      !!contents &&
      !contents.isDestroyed() &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame &&
      event.senderFrame.url === SETUP_URL &&
      contents.getURL() === SETUP_URL
    );
  } catch {
    return false;
  }
}
function allowedResource(value, origin, resourceType = '') {
  if (sameOrigin(value, origin)) return true;
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:')
      return ['image', 'media'].includes(resourceType) && url.origin === origin;
    if (url.protocol === 'data:')
      return (
        resourceType === 'image' && /^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/i.test(value)
      );
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      return sameOrigin(url.href, origin);
    }
  } catch {
    /* Invalid URLs never reach a network or local resource. */
  }
  return false;
}
function allowedDownload({ url, chain, initiatorOrigin, userGesture, mainFrame, active }, origin) {
  if (
    !active ||
    !mainFrame ||
    !userGesture ||
    initiatorOrigin !== origin ||
    !sameOrigin(url, origin)
  )
    return false;
  const target = new URL(url);
  return (
    /^\/api\/(?:workspaces\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/)?files\/[a-zA-Z0-9_-]+\/download$/.test(
      target.pathname,
    ) &&
    !target.search &&
    !target.hash &&
    Array.isArray(chain) &&
    chain.length > 0 &&
    chain.every((item) => sameOrigin(item, origin))
  );
}
function sharedFileDownloadRequest(value, pageUrl, origin) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'expectedUser,name,path' ||
    typeof value.expectedUser !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.expectedUser) ||
    typeof value.path !== 'string' ||
    value.path.length > 1024 ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name.length > 4096 ||
    !sameOrigin(pageUrl, origin)
  )
    return null;
  const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
  const opaque = '[A-Za-z0-9_-]{1,128}';
  const recipient = new RegExp(
    `^/api/shared-bots/(${uuid})/files/${opaque}/download\\?revision=[a-f0-9]{64}$`,
  ).exec(value.path);
  const owner = new RegExp(
    `^/api/workspaces/(${uuid})/agents/${opaque}/sharing/files/${opaque}/download\\?revision=[a-f0-9]{64}$`,
  ).exec(value.path);
  if (!recipient && !owner) return null;
  const page = new URL(pageUrl).pathname;
  const workspace = new RegExp(`^/w/(${uuid})(?:/(?:manage|members))?/?$`).exec(page);
  if (owner && workspace?.[1] !== owner[1]) return null;
  if (recipient && !workspace && page !== `/shared-bots/${recipient[1]}`) return null;
  return { path: value.path, expectedUser: value.expectedUser, name: safeFilename(value.name) };
}
function safeFilename(value) {
  return (
    String(value || 'download')
      .split(/[\\/]/)
      .at(-1)
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '')
      .replace(/^\.+$/, 'download')
      .slice(0, 180) || 'download'
  );
}
function rendererPreferences(partition, preload) {
  return {
    partition,
    ...(preload ? { preload } : {}),
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools: false,
  };
}
class ConnectionState {
  constructor(suggestion = DEFAULT_ORIGIN, lastOrigin) {
    this.sequence = 0;
    this.lastAttempt = undefined;
    let url = DEFAULT_ORIGIN,
      error;
    try {
      url = normalizeServerOrigin(suggestion);
    } catch (failure) {
      error = failure.message;
    }
    this.value = {
      status: error ? 'error' : 'setup',
      url,
      ...(lastOrigin ? { lastOrigin: normalizeServerOrigin(lastOrigin) } : {}),
      ...(error ? { error } : {}),
      version,
    };
  }
  snapshot() {
    return { ...this.value };
  }
  begin(url) {
    const origin = normalizeServerOrigin(url);
    this.lastAttempt = origin;
    this.value = { ...this.value, status: 'connecting', url: origin, error: undefined };
    return { sequence: ++this.sequence, origin };
  }
  connected(attempt) {
    if (attempt.sequence !== this.sequence) return false;
    this.value = {
      ...this.value,
      status: 'connected',
      lastOrigin: attempt.origin,
      error: undefined,
    };
    return true;
  }
  failed(attempt, reason) {
    if (attempt.sequence !== this.sequence) return false;
    this.value = { ...this.value, status: 'error', error: String(reason).slice(0, 1000) };
    return true;
  }
  setup() {
    this.sequence++;
    this.value = { ...this.value, status: 'setup', error: undefined };
  }
  retryOrigin() {
    if (!this.lastAttempt) throw new Error('请先填写地址并点击连接。');
    return this.lastAttempt;
  }
}
module.exports = {
  trustedProductSender,
  DEFAULT_ORIGIN,
  SETUP_URL,
  SETUP_CSP,
  normalizeServerOrigin,
  webUrl,
  sameOrigin,
  appAuthorizationRequest,
  partitionFor,
  setupAsset,
  trustedSetupSender,
  allowedResource,
  allowedDownload,
  sharedFileDownloadRequest,
  safeFilename,
  rendererPreferences,
  ConnectionState,
};
function trustedProductSender(event, current) {
  try {
    const contents = current?.view.webContents;
    return (
      !!current?.attached &&
      !contents.isDestroyed() &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame &&
      !contents.mainFrame.isDestroyed() &&
      !contents.mainFrame.detached &&
      contents.mainFrame.url === contents.getURL() &&
      contents.mainFrame.origin === current.origin &&
      sameOrigin(contents.getURL(), current.origin)
    );
  } catch {
    return false;
  }
}
