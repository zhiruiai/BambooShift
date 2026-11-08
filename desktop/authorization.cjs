'use strict';
const { appAuthorizationRequest } = require('./security.cjs');
function createAuthorizationHandler({ getConnection, foregroundFrame, now, shell }) {
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
    const valid = () =>
      getConnection() === current &&
      event.senderFrame === frame &&
      foregroundFrame(event.sender, current.origin) === frame &&
      frame.url === originalUrl;
    try {
      const endpoint = `${current.origin}/api/workspaces/${request.workspaceId}/apps/${request.connectionId}/oauth/${request.flowId}/launch`;
      const response = await current.view.webContents.session.fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          Origin: current.origin,
          'X-OpenBot-Expected-User': request.expectedUserId,
        },
        body: '{}',
        signal: AbortSignal.timeout(15000),
      });
      if (!valid() || !response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      let length = 0;
      const chunks = [];
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          length += chunk.byteLength;
          if (length > 4096 || !valid()) throw new Error();
          chunks.push(Buffer.from(chunk));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
