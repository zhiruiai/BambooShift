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

test('OAuth native bridge opens only a server-confirmed same-origin handoff after current-frame native input', async () => {
  const dataDir = tempDir(),
    fake = fakeElectron();
  let clock = 1;
  const controller = createController(fake, { dataDir, now: () => clock });
  const ids = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    connectionId: '22222222-2222-4222-8222-222222222222',
    flowId: '33333333-3333-4333-8333-333333333333',
    expectedUserId: '44444444-4444-4444-8444-444444444444',
  };
  const path = `/app-authorize/${ids.workspaceId}/${ids.connectionId}/${ids.flowId}`;
  try {
    controller.start();
    await Promise.resolve();
    const opening = controller.connect('https://bot.example.com');
    const contents = fake.views[0].webContents;
    contents.loadGate.resolve();
    await opening;
    contents.url = `https://bot.example.com/w/${ids.workspaceId}`;
    contents.mainFrame.url = contents.url;
    const event = { sender: contents, senderFrame: contents.mainFrame };
    const invoke = (body = ids, sender = event) =>
      fake.ipc.get('openbot-app:authorize')(sender, body);
    const arm = () => contents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
    const requests = [];
    contents.session.fetch = async (url, init) => {
      requests.push({ url, init });
      return Response.json({ launchPath: path });
    };
    await assert.rejects(invoke());
    assert.equal(requests.length, 0);
    arm();
    await assert.rejects(invoke({ ...ids, url: 'https://evil.example' }));
    arm();
    await assert.rejects(invoke(ids, { ...event, senderFrame: { ...contents.mainFrame } }));
    assert.equal(requests.length, 0);
    arm();
    assert.deepEqual(await invoke(), { opened: true });
    assert.deepEqual(fake.calls.external, ['https://bot.example.com' + path]);
    assert.equal(
      requests[0].url,
      `https://bot.example.com/api/workspaces/${ids.workspaceId}/apps/${ids.connectionId}/oauth/${ids.flowId}/launch`,
    );
    assert.equal(requests[0].init.headers['X-OpenBot-Expected-User'], ids.expectedUserId);
    assert.equal(requests[0].init.redirect, 'error');
    assert.equal(requests[0].init.credentials, 'include');
    await assert.rejects(invoke());
    assert.equal(requests.length, 1, 'a native input is consumed once');
    arm();
    clock += 5001;
    await assert.rejects(invoke());
    contents.session.fetch = async () =>
      Response.json({ launchPath: 'https://provider.example/authorize' });
    arm();
    await assert.rejects(invoke());
    assert.equal(fake.calls.external.length, 1);
    contents.session.fetch = async () =>
      Response.json({ launchPath: path + '?next=https://evil.example' });
    arm();
    await assert.rejects(invoke());
    const waiting = deferred();
    contents.session.fetch = () => waiting.promise;
    arm();
    const stale = invoke();
    controller.showSetup();
    waiting.resolve(Response.json({ launchPath: path }));
    await assert.rejects(stale);
    assert.equal(fake.calls.external.length, 1);
    assert.equal(
      contents.openHandler({ url: 'https://provider.example/authorize' }).action,
      'deny',
    );
  } finally {
    controller.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('remote preload exposes bounded task methods in a main HTTP frame, without raw IPC or arbitrary URLs', () => {
  const { runInNewContext } = require('node:vm');
  const source = readFileSync(join(__dirname, 'remote-preload.cjs'), 'utf8');
  function evaluate(protocol, isMainFrame) {
    let exposed;
    const calls = [];
    runInNewContext(source, {
      process: { isMainFrame },
      location: { protocol },
      require: () => ({
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.ok(
              [
                'openbotAuthorization',
                'openbotFiles',
                'openbotNotifications',
                'openbotVersion',
              ].includes(name),
            );
            exposed ||= {};
            exposed[name] = value;
          },
        },
        ipcRenderer: { invoke: (...args) => calls.push(args) },
      }),
    });
    return { exposed, calls };
  }
  assert.equal(evaluate('https:', false).exposed, undefined);
  assert.equal(evaluate('file:', true).exposed, undefined);
  const remote = evaluate('https:', true);
  assert.deepEqual(Object.keys(remote.exposed).sort(), [
    'openbotAuthorization',
    'openbotFiles',
    'openbotNotifications',
    'openbotVersion',
  ]);
  assert.deepEqual(Object.keys(remote.exposed.openbotAuthorization), ['open']);
  assert.deepEqual(Object.keys(remote.exposed.openbotFiles), ['downloadSharedFile']);
  remote.exposed.openbotAuthorization.open({ flowId: 'test' });
  assert.deepEqual(remote.calls, [['openbot-app:authorize', { flowId: 'test' }]]);
  remote.exposed.openbotFiles.downloadSharedFile({ path: '/not-trusted-until-main-validation' });
  assert.equal(remote.calls[1][0], 'openbot-files:download-shared');
  assert.deepEqual(Object.keys(remote.exposed.openbotNotifications), [
    'permission',
    'requestPermission',
    'show',
    'clear',
  ]);
  remote.exposed.openbotNotifications.show({ eventId: 'synthetic' });
  assert.equal(remote.calls[2][0], 'openbot-notifications:show');
  assert.deepEqual(Object.keys(remote.exposed.openbotVersion), ['getVersion']);
  remote.exposed.openbotVersion.getVersion('ignored-renderer-value');
  assert.deepEqual(remote.calls[3], ['openbot-client:get-version']);
});
