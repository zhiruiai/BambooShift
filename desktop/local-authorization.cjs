'use strict';
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:http');
const { webUrl } = require('./security.cjs');

const callbackPath = '/api/app-oauth/callback';
const ticketLifetime = 60_000;

async function browserTicket(flowId, redeem, signal, retryMessage) {
  const path = '/app-oauth/' + flowId + '/' + randomBytes(32).toString('base64url');
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Connection', 'close');
    if (
      claimed ||
      req.method !== 'GET' ||
      req.url !== path ||
      req.headers.host !== host ||
      (req.headers['sec-fetch-mode'] && req.headers['sec-fetch-mode'] !== 'navigate') ||
      (req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'document') ||
      req.headers['sec-purpose'] ||
      req.headers.purpose
    ) {
      res.writeHead(404).end();
      return;
    }
    claimed = true;
    server.close();
    try {
      const { location, cookie } = await redeem();
      signal.throwIfAborted();
      res.writeHead(303, { Location: location, 'Set-Cookie': cookie }).end();
    } catch {
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }).end(retryMessage);
    }
  });
  let claimed = false,
    host;
  server.maxConnections = 16;
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  host = '127.0.0.1:' + server.address().port;
  server.unref();
  signal.addEventListener('abort', stop, { once: true });
  server.once('close', () => signal.removeEventListener('abort', stop));
  if (signal.aborted) {
    stop();
    signal.throwIfAborted();
  }
  return 'http://' + host + path;
}

async function openLocalAuthorization({
  current,
  request,
  read,
  valid,
  dialog,
  getWindow,
  t,
  shell,
}) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(current.origin)) throw new Error();
  const flow = await read('', 'GET');
  const provider = webUrl(flow.authorizationOrigin);
  if (
    flow.id !== request.flowId ||
    flow.connectionId !== request.connectionId ||
    flow.launchPath !== request.launchPath ||
    flow.status !== 'pending' ||
    !provider ||
    provider.protocol !== 'https:' ||
    provider.port ||
    provider.origin !== flow.authorizationOrigin ||
    !Array.isArray(flow.scopes) ||
    flow.scopes.length > 64 ||
    !flow.scopes.every(
      (scope) => typeof scope === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope),
    )
  )
    throw new Error();
  const scopes = flow.scopes.length
    ? t('oauthScopes', { scopes: flow.scopes.join(' · ') })
    : t('oauthNoScopes');
  const decision = await dialog.showMessageBox(getWindow(), {
    type: 'question',
    message: t('oauthProvider', { origin: provider.origin }),
    detail: scopes + '\n\n' + t('oauthReturn'),
    buttons: [t('cancel'), t('openBrowser')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (decision.response !== 1) return { opened: false };
  // The native sheet can keep keyboard focus as it closes. Keep the frame and session checks.
  if (!valid(false)) throw new Error();
  const lifetime = Math.min(ticketLifetime, Date.parse(flow.expiresAt) - Date.now());
  if (!Number.isFinite(lifetime) || lifetime < 1) throw new Error();
  current.oauthHandoff?.abort();
  const controller = new AbortController();
  current.oauthHandoff = controller;
  const signal = AbortSignal.any([
    controller.signal,
    current.healthCheck.signal,
    AbortSignal.timeout(lifetime),
  ]);
  const session = current.view.webContents.session;
  async function redeem() {
    // The browser now has focus. Rust rechecks the initiating session, owner and connection revision.
    signal.throwIfAborted();
    const latest = await read('', 'GET', false);
    if (
      latest.status !== 'pending' ||
      latest.connectionRevision !== flow.connectionRevision ||
      latest.authorizationOrigin !== provider.origin ||
      JSON.stringify(latest.scopes) !== JSON.stringify(flow.scopes)
    )
      throw new Error();
    signal.throwIfAborted();
    const result = await read('/begin', 'POST', false);
    const url = webUrl(result.authorizationUrl);
    if (!url || url.origin !== provider.origin || url.hash) throw new Error();
    const name = 'openbot_oauth_' + flow.id.replaceAll('-', '');
    const cookies = await session.cookies.get({ name, url: current.origin + callbackPath });
    const [cookie] = cookies;
    const age = Math.min(600, Math.floor((cookie?.expirationDate ?? 0) - Date.now() / 1000));
    if (
      !valid(false) ||
      cookies.length !== 1 ||
      cookie.name !== name ||
      cookie.domain !== '127.0.0.1' ||
      !cookie.hostOnly ||
      !cookie.httpOnly ||
      cookie.path !== callbackPath ||
      cookie.sameSite !== 'lax' ||
      !Number.isFinite(age) ||
      age < 1 ||
      !/^[\w-]{43}$/.test(cookie.value)
    )
      throw new Error();
    // Preserve the callback cookie's exact scope. The system browser receives no workspace session.
    return {
      location: url.href,
      cookie:
        name +
        '=' +
        cookie.value +
        '; Path=' +
        callbackPath +
        '; HttpOnly; SameSite=Lax; Max-Age=' +
        age +
        (cookie.secure ? '; Secure' : ''),
    };
  }
  try {
    const local = await browserTicket(request.flowId, redeem, signal, t('oauthRetry'));
    if (!valid(false)) throw new Error();
    await shell.openExternal(local);
    return { opened: true };
  } catch (error) {
    controller.abort();
    throw error;
  }
}
module.exports = { openLocalAuthorization };
