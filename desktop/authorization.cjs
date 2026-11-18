'use strict';
const { appAuthorizationRequest, trustedProductSender } = require('./security.cjs');
const { openLocalAuthorization } = require('./local-authorization.cjs');
function createAuthorizationHandler({
  getConnection,
  getWindow,
  foregroundFrame,
  now,
  shell,
  dialog,
  t,
}) {
  async function openAppAuthorization(event, value) {
    const current = getConnection();
    const frame = current && foregroundFrame(event.sender, current.origin);
    const token = current?.oauthInput;
    if (current) current.oauthInput = undefined;
    const request = frame && appAuthorizationRequest(value, frame.url, current.origin);
    if (
      !request ||
      !token ||
      token.frame !== frame ||
      token.url !== frame.url ||
      now() >= token.expiresAt ||
      event.senderFrame !== frame ||
      current.oauthOpening
    )
      throw new Error('请在当前工作空间点击授权按钮。');
    current.oauthOpening = true;
    const originalUrl = frame.url;
    const valid = (foreground = true) =>
      getConnection() === current &&
      trustedProductSender(event, current) &&
      event.senderFrame === frame &&
      (!foreground || foregroundFrame(event.sender, current.origin) === frame) &&
      frame.url === originalUrl;
    const root = `${current.origin}/api/workspaces/${request.workspaceId}/apps/${request.connectionId}/oauth/${request.flowId}`;
    async function read(suffix, method, foreground = true) {
      if (!valid(foreground)) throw new Error();
      const response = await current.view.webContents.session.fetch(root + suffix, {
        method,
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        headers: {
          ...(method === 'POST' && { 'Content-Type': 'application/json' }),
          Origin: current.origin,
          'X-OpenBot-Expected-User': request.expectedUserId,
        },
        ...(method === 'POST' && { body: '{}' }),
        signal: AbortSignal.any([current.healthCheck.signal, AbortSignal.timeout(15000)]),
      });
      if (!valid(foreground) || !response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      let length = 0;
      const chunks = [];
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          length += chunk.byteLength;
          if (length > 16384 || !valid(foreground)) throw new Error();
          chunks.push(Buffer.from(chunk));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!valid(foreground)) throw new Error();
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    try {
      if (current.managed)
        return await openLocalAuthorization({
          current,
          request,
          read,
          valid,
          dialog,
          getWindow,
          t,
          shell,
        });
      const result = await read('/launch', 'POST');
      if (!valid() || result.launchPath !== request.launchPath) throw new Error();
      await shell.openExternal(current.origin + request.launchPath);
      return { opened: true };
    } catch {
      throw new Error('未能打开授权页面，请检查账号与连接后重试。');
    } finally {
      current.oauthOpening = false;
    }
  }
  return openAppAuthorization;
}
module.exports = { createAuthorizationHandler };
