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

test('shared download policy accepts only exact versioned source/recipient paths and never broadens ordinary downloads', () => {
  const origin = 'https://files.example.com';
  const page = `${origin}/w/${sharedDownloadIds.workspace}`;
  const request = {
    path: sharedDownloadPath,
    expectedUser: sharedDownloadIds.user,
    name: '../../safe.txt',
  };
  assert.equal(sharedFileDownloadRequest(request, page, origin).name, 'safe.txt');
  assert.ok(sharedFileDownloadRequest({ ...request, path: sharedOwnerPath }, page, origin));
  assert.ok(
    sharedFileDownloadRequest(request, `${origin}/shared-bots/${sharedDownloadIds.share}`, origin),
  );
  for (const path of [
    'blob:' + origin + '/value',
    origin + sharedDownloadPath,
    '//foreign.example/value',
    sharedDownloadPath + '&extra=1',
    sharedDownloadPath + '#fragment',
    sharedDownloadPath.replace('source-file', '%2e%2e'),
    sharedDownloadPath.replace('revision=', 'revision=bad&revision='),
    '/api/files/source-file/download',
    sharedDownloadPath.replace('a'.repeat(64), 'a'.repeat(63)),
  ])
    assert.equal(sharedFileDownloadRequest({ ...request, path }, page, origin), null, path);
  assert.equal(
    sharedFileDownloadRequest(
      { ...request, path: sharedOwnerPath },
      `${origin}/w/${sharedDownloadIds.share}`,
      origin,
    ),
    null,
  );
  assert.equal(sharedFileDownloadRequest(request, `${origin}/platform`, origin), null);
  assert.equal(
    sharedFileDownloadRequest({ ...request, expectedUser: 'bad\r\nHeader' }, page, origin),
    null,
  );
  assert.equal(sharedFileDownloadRequest({ ...request, savePath: '/secret' }, page, origin), null);
  assert.equal(
    allowedDownload(
      {
        url: origin + sharedDownloadPath,
        chain: [origin + sharedDownloadPath],
        initiatorOrigin: origin,
        userGesture: true,
        mainFrame: true,
        active: true,
      },
      origin,
    ),
    false,
  );
  assert.equal(
    allowedDownload(
      {
        url: 'blob:' + origin + '/value',
        chain: [],
        initiatorOrigin: origin,
        userGesture: true,
        mainFrame: true,
        active: true,
      },
      origin,
    ),
    false,
  );
});

test('native shared-file bridge consumes real input, verifies the account and atomically saves a single exact request', async () => {
  const f = await sharedDownloadFixture();
  try {
    await assert.rejects(f.invoke());
    assert.equal(f.requests.length, 0);
    f.arm();
    await assert.rejects(
      f.invoke(undefined, { ...f.event, senderFrame: { ...f.contents.mainFrame } }),
    );
    assert.equal(f.requests.length, 0);
    f.arm();
    const result = await f.invoke();
    assert.deepEqual(result, { status: 'saved' });
    assert.deepEqual(readFileSync(f.destination), f.file);
    assert.equal(statSync(f.destination).mode & 0o777, 0o600);
    assert.equal(f.fake.calls.saves.length, 1);
    assert.equal(f.fake.calls.saves[0][1].defaultPath, 'safe.txt');
    assert.ok(f.fake.calls.saves[0][1].properties.includes('showOverwriteConfirmation'));
    assert.equal(
      f.fake.calls.dialogs.length,
      0,
      'native replacement confirmation is not duplicated',
    );
    assert.equal(f.state.fileCalls, 1);
    assert.equal(f.state.headCalls, 1);
    for (const { url, init } of f.requests) {
      assert.ok(url.startsWith('https://files.example.com/api/'));
      assert.equal(init.headers['X-OpenBot-Expected-User'], sharedDownloadIds.user);
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.credentials, 'include');
      assert.ok(['GET', 'HEAD'].includes(init.method));
    }
    await assert.rejects(f.invoke());
    assert.equal(f.state.fileCalls, 1);
    f.assertNoTemps();
  } finally {
    f.close();
  }
});

test('native dialog holds one download slot; cancel never fetches file bytes or revives an old click', async () => {
  const f = await sharedDownloadFixture();
  const gate = deferred();
  let choosing = false;
  f.fake.dialog.showSaveDialog = async () => {
    choosing = true;
    return gate.promise;
  };
  try {
    f.arm();
    const pending = f.invoke();
    await waitForDownload(() => choosing);
    f.arm();
    await assert.rejects(f.invoke());
    assert.equal(f.state.fileCalls, 0);
    gate.resolve({ canceled: true, filePath: '' });
    assert.deepEqual(await pending, { status: 'cancelled' });
    await assert.rejects(f.invoke());
    assert.equal(existsSync(f.destination), false);
    f.assertNoTemps();
  } finally {
    gate.resolve({ canceled: true });
    f.close();
  }
});

test('native shared downloads drop late results after account cookie changes, navigation or window closure', async (t) => {
  for (const scenario of ['cookie', 'navigation', 'close'])
    await t.test(scenario, async () => {
      const f = await sharedDownloadFixture(),
        gate = deferred();
      f.setResponse(() => gate.promise);
      try {
        f.arm();
        const pending = f.invoke();
        await waitForDownload(() => f.state.fileCalls === 1);
        if (scenario === 'cookie')
          f.contents.session.cookies.emit(
            'changed',
            {},
            { name: '__Host-openbot_account' },
            'explicit',
            true,
          );
        else if (scenario === 'navigation')
          f.contents.emit('did-navigate-in-page', {}, 'https://files.example.com/account', true);
        else f.controller.close();
        assert.equal(f.requests.at(-1).init.signal.aborted, true);
        gate.resolve(new Response(f.file));
        assert.deepEqual(await pending, { status: 'cancelled' });
        assert.equal(existsSync(f.destination), false);
        f.assertNoTemps();
      } finally {
        gate.resolve(new Response(f.file));
        f.close();
      }
    });
});
