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
      return new Response('PandaMate setup resources are unavailable.', {
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
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    let granted = false;
    try {
      if (origin && permission === 'clipboard-sanitized-write')
        granted = allowClipboardWrite(contents, details, origin) === true;
      else if (origin && permission === 'media')
        granted = allowMicrophone(contents, details, origin) === true;
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
  ses.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel: origin
        ? !allowedResource(details.url, origin, details.resourceType)
        : !setupAsset(details.url),
    }),
  );
  ses.setUserAgent(
    ses.getUserAgent().replace(/\sOpenBotDesktop\/[^\s]+/g, '') + ' OpenBotDesktop/0.1',
  );
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
  downloadAllowed,
};
