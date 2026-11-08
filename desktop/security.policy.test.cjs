'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  renameSync,
  statSync,
} = require('node:fs');
const { join } = require('node:path');
const {
  normalizeServerOrigin,
  partitionFor,
  setupAsset,
  trustedSetupSender,
  allowedResource,
  allowedDownload,
  sharedFileDownloadRequest,
  rendererPreferences,
  ConnectionState,
  SETUP_URL,
} = require('./security.cjs');
const {
  createController,
  createSetupProtocolHandler,
  installSessionPolicy,
  saveLastOrigin,
  readLastOrigin,
} = require('./main.cjs');

const {
  tempDir,
  deferred,
  fakeElectron,
  sharedDownloadIds,
  sharedDownloadPath,
  sharedOwnerPath,
  sharedDownloadFixture,
  waitForDownload,
  controllerWithFilesystem,
} = require('./test-fixture.cjs');

test('origins reject unsafe schemes, credentials, paths, aliases and insecure remote hosts; partitions isolate exact origins', () => {
  for (const value of [
    'http://127.0.0.1:3001',
    'http://localhost:3001/',
    'http://[::1]:3001',
    'https://bot.example.com/',
    'HTTPS://BOT.EXAMPLE.COM:443',
  ])
    assert.ok(normalizeServerOrigin(value));
  assert.equal(normalizeServerOrigin(' HTTPS://BOT.EXAMPLE.COM:443/ '), 'https://bot.example.com');
  for (const value of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,test',
    'http://192.168.1.2:3001',
    'http://example.com',
    'http://127.1:3001',
    'http://2130706433:3001',
    'http://localhost.:3001',
    'https://user:secret@bot.example.com',
    'https://@bot.example.com',
    'https://bot.example.com/path',
    'https://bot.example.com/.',
    'https://bot.example.com?token=a',
    'https://bot.example.com#hash',
    'https://bot.example.com\\evil',
    'https://bot.example.com\n.evil',
    '',
    null,
  ])
    assert.throws(() => normalizeServerOrigin(value), String(value));
  assert.equal(
    partitionFor('https://bot.example.com/'),
    partitionFor('https://bot.example.com:443'),
  );
  for (const origin of [
    'https://other.example.com',
    'https://bot.example.com:8443',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ])
    assert.notEqual(partitionFor(origin), partitionFor('https://bot.example.com'));
});

test('setup protocol only serves fixed packaged resources with strict CSP, and IPC requires exact setup main frame', async () => {
  for (const url of [
    'openbot-app://setup/main.cjs',
    'openbot-app://setup/../main.cjs',
    'openbot-app://setup/%2e%2e/main.cjs',
    'openbot-app://other/app.js',
    'openbot-app://setup/app.js?x=1',
    'openbot-app://setup/app.js#x',
    'file:///app.js',
  ])
    assert.equal(setupAsset(url), null);
  const handler = createSetupProtocolHandler();
  const response = await handler({ method: 'GET', url: SETUP_URL });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(await response.text(), /connect-form/);
  assert.equal((await handler({ method: 'POST', url: SETUP_URL })).status, 404);
  const contents = {
    mainFrame: { url: SETUP_URL },
    getURL: () => SETUP_URL,
    isDestroyed: () => false,
  };
  assert.equal(
    trustedSetupSender({ sender: contents, senderFrame: contents.mainFrame }, contents),
    true,
  );
  for (const event of [
    { sender: {}, senderFrame: contents.mainFrame },
    { sender: contents, senderFrame: { url: SETUP_URL } },
    { sender: contents, senderFrame: null },
  ])
    assert.equal(trustedSetupSender(event, contents), false);
  contents.mainFrame.url = 'https://bot.example.com';
  assert.equal(
    trustedSetupSender({ sender: contents, senderFrame: contents.mainFrame }, contents),
    false,
  );
});

test('remote resources and downloads cannot escape the selected origin or bypass a user gesture and save dialog', () => {
  const origin = 'https://bot.example.com';
  assert.equal(allowedResource(origin + '/api/events', origin, 'xhr'), true);
  assert.equal(allowedResource('wss://bot.example.com/ws', origin, 'webSocket'), true);
  assert.equal(allowedResource('blob:https://bot.example.com/id', origin, 'image'), true);
  for (const url of [
    'http://127.0.0.1:3001/api/bootstrap',
    'file:///etc/passwd',
    'openbot-app://setup/',
    'https://other.example.com',
    'ws://bot.example.com/ws',
    'data:text/html,hi',
    'blob:https://other.example.com/id',
  ])
    assert.equal(allowedResource(url, origin, 'xhr'), false, url);
  const valid = {
    url: origin + '/api/files/fixture-id/download',
    chain: [origin + '/api/files/fixture-id/download'],
    initiatorOrigin: origin,
    userGesture: true,
    mainFrame: true,
    active: true,
  };
  assert.equal(allowedDownload(valid, origin), true);
  const scopedUrl =
    origin + '/api/workspaces/4d7bf53b-fc88-4535-8d75-d219d3309583/files/fixture-id/download';
  assert.equal(allowedDownload({ ...valid, url: scopedUrl, chain: [scopedUrl] }, origin), true);
  for (const path of [
    '/api/workspaces/invalid/files/fixture-id/download',
    '/api/workspaces/4d7bf53b-fc88-4535-8d75-d219d3309583/settings',
  ]) {
    assert.equal(
      allowedDownload({ ...valid, url: origin + path, chain: [origin + path] }, origin),
      false,
    );
  }
  for (const patch of [
    { userGesture: false },
    { mainFrame: false },
    { active: false },
    { initiatorOrigin: 'null' },
    { initiatorOrigin: 'https://other.example.com' },
    { chain: [valid.url, 'https://other.example.com/file'] },
    { url: origin + '/secret' },
    { url: 'blob:' + origin + '/id' },
  ])
    assert.equal(allowedDownload({ ...valid, ...patch }, origin), false);
  const fake = fakeElectron(),
    ses = fake.session.fromPartition('fixture');
  installSessionPolicy(ses, origin);
  let permission;
  ses.requestPermission(null, 'media', (value) => {
    permission = value;
  });
  assert.equal(permission, false);
  assert.equal(ses.checkPermission(), false);
  assert.equal(ses.devicePermission(), false);
  ses.displayPermission({}, (value) => {
    permission = value;
  });
  assert.equal(permission, null);
  assert.equal(ses.displayOptions.useSystemPicker, false);
  assert.match(ses.ua, /OpenBotDesktop\/0.1$/);
  assert.deepEqual(rendererPreferences('remote'), {
    partition: 'remote',
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
  });
});
