'use strict';
const { readFileSync, writeFileSync, renameSync, statSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const {
  normalizeServerOrigin,
  setupAsset,
  SETUP_CSP,
  allowedResource,
  allowedDownload,
  safeFilename,
} = require('./security.cjs');
function readLastOrigin(dataDir) {
  try {
    const file = join(dataDir, 'client.json');
    if (statSync(file).size > 4096) return undefined;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return normalizeServerOrigin(value.lastOrigin);
  } catch {
    return undefined;
  }
}
function saveLastOrigin(dataDir, origin) {
  const file = join(dataDir, 'client.json');
  writeFileSync(
    file + '.tmp',
    JSON.stringify({ lastOrigin: normalizeServerOrigin(origin) }) + '\n',
    { mode: 0o600 },
  );
  renameSync(file + '.tmp', file);
}
function createSetupProtocolHandler(uiDir = join(__dirname, 'ui')) {
  return async (request) => {
    const asset = request.method === 'GET' ? setupAsset(request.url) : null;
    if (!asset) return new Response('Not found', { status: 404 });
    try {
      return new Response(await readFile(join(uiDir, asset[0])), {
        headers: {
          'Content-Type': asset[1],
          'Content-Security-Policy': SETUP_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response('BambooShift setup resources are unavailable.', {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  };
}
function installSessionPolicy(
  ses,
  origin,
  allowClipboardWrite = () => false,
  allowMicrophone = () => false,
) {
  const currentOrigin = () => (typeof origin === 'function' ? origin() : origin);
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    let granted = false;
    try {
      const target = currentOrigin();
      if (target && permission === 'clipboard-sanitized-write')
        granted = allowClipboardWrite(contents, details, target) === true;
      else if (target && permission === 'media')
        granted = allowMicrophone(contents, details, target) === true;
    } catch {
      /* Destroyed frames and incomplete permission details fail closed. */
    }
    callback(granted);
  });
  // Checks never create a standing grant or consume a one-shot input token.
  // Each capture goes through RequestPermission; macOS consent still applies.
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback(null), {
    useSystemPicker: false,
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const target = currentOrigin();
    callback({
      cancel: target
        ? !allowedResource(details.url, target, details.resourceType)
        : Boolean(origin) || !setupAsset(details.url),
    });
  });
  ses.setUserAgent(
    ses.getUserAgent().replace(/\sOpenBotDesktop\/[^\s]+/g, '') + ' OpenBotDesktop/0.1',
  );
}
function createProductSessions({
  session,
  getConnection,
  consumeClipboardWrite,
  consumeMicrophone,
  explainBlocked,
  t,
}) {
  const configured = new WeakSet();
  return (partition, origin, managed) => {
    const ses = session.fromPartition(partition);
    if (configured.has(ses)) return ses;
    const boundOrigin = managed
      ? () => {
          const current = getConnection();
          return current?.partition === partition ? current.origin : undefined;
        }
      : origin;
    installSessionPolicy(ses, boundOrigin, consumeClipboardWrite, consumeMicrophone);
    ses.on('will-download', (event, item, contents, frame) => {
      const current = getConnection();
      if (!downloadAllowed(item, contents, frame, current) || current.partition !== partition) {
        event.preventDefault();
        explainBlocked();
        return;
      }
      // Leaving the save path unset keeps the native save dialog mandatory.
      item.setSaveDialogOptions({
        title: t('saveFile'),
        defaultPath: safeFilename(item.getFilename()),
        buttonLabel: t('save'),
      });
      current.downloads.add(item);
      item.once('done', () => current.downloads.delete(item));
    });
    configured.add(ses);
    return ses;
  };
}
function downloadAllowed(item, contents, frame, connection) {
  return allowedDownload(
    {
      url: item.getURL(),
      chain: item.getURLChain(),
      initiatorOrigin: item.getInitiatorOrigin(),
      userGesture: item.hasUserGesture(),
      mainFrame: !!contents && frame === contents.mainFrame,
      active: !!connection && connection.view.webContents === contents && !contents.isDestroyed(),
    },
    connection?.origin,
  );
}

module.exports = {
  readLastOrigin,
  saveLastOrigin,
  createSetupProtocolHandler,
  installSessionPolicy,
  createProductSessions,
  downloadAllowed,
};
