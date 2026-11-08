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

test('account rechecks before/after response and after temporary write prevent cross-account or late saves', async (t) => {
  for (const changeAt of [1, 2, 3, 4])
    await t.test('account check ' + changeAt, async () => {
      const f = await sharedDownloadFixture();
      f.setAccountHook((count) => {
        if (count === changeAt) f.state.user = 'other-account';
      });
      try {
        f.arm();
        await assert.rejects(f.invoke(), /账户/);
        assert.equal(existsSync(f.destination), false);
        assert.equal(f.state.fileCalls, changeAt <= 2 ? 0 : 1);
        f.assertNoTemps();
      } finally {
        f.close();
      }
    });
});

test('source errors, redirects and declared or streamed oversize responses never save', async (t) => {
  for (const scenario of ['403', 'redirect', 'declared-size', 'streamed-size'])
    await t.test(scenario, async () => {
      const f = await sharedDownloadFixture();
      f.setResponse(() => {
        if (scenario === '403') return new Response('no', { status: 403 });
        if (scenario === 'redirect')
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://elsewhere.example/' },
          });
        if (scenario === 'declared-size')
          return new Response('small', {
            headers: { 'Content-Length': String(10 * 1024 * 1024 + 1) },
          });
        return new Response(Buffer.alloc(10 * 1024 * 1024 + 1));
      });
      try {
        f.arm();
        await assert.rejects(f.invoke());
        assert.equal(f.state.fileCalls, 1);
        assert.equal(existsSync(f.destination), false);
        f.assertNoTemps();
      } finally {
        f.close();
      }
    });
});

test('native overwrite refusal preserves the original; confirmed overwrite replaces only the captured unchanged file', async (t) => {
  for (const scenario of ['cancel', 'confirm', 'target-changed', 'late-created'])
    await t.test(scenario, async () => {
      const f = await sharedDownloadFixture();
      if (scenario !== 'late-created') writeFileSync(f.destination, 'ORIGINAL');
      if (scenario === 'cancel')
        f.fake.dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
      if (scenario === 'target-changed' || scenario === 'late-created')
        f.setResponse(() => {
          writeFileSync(f.destination, 'CHANGED_WHILE_DOWNLOADING');
          return new Response(f.file);
        });
      try {
        f.arm();
        if (scenario === 'cancel') {
          assert.deepEqual(await f.invoke(), { status: 'cancelled' });
          assert.equal(readFileSync(f.destination, 'utf8'), 'ORIGINAL');
          assert.equal(f.state.fileCalls, 0);
        } else if (scenario === 'confirm') {
          assert.deepEqual(await f.invoke(), { status: 'saved' });
          assert.deepEqual(readFileSync(f.destination), f.file);
        } else {
          await assert.rejects(f.invoke());
          assert.equal(readFileSync(f.destination, 'utf8'), 'CHANGED_WHILE_DOWNLOADING');
        }
        f.assertNoTemps();
      } finally {
        f.close();
      }
    });
});

test('a changed save directory is rejected without publishing into its replacement', async () => {
  const f = await sharedDownloadFixture();
  const parent = join(f.dataDir, 'downloads'),
    moved = join(f.dataDir, 'old-downloads');
  mkdirSync(parent);
  f.fake.dialog.showSaveDialog = async () => ({
    canceled: false,
    filePath: join(parent, 'selected.txt'),
  });
  f.setResponse(() => {
    renameSync(parent, moved);
    mkdirSync(parent);
    return new Response(f.file);
  });
  try {
    f.arm();
    await assert.rejects(f.invoke(), /保存位置发生变化/);
    assert.deepEqual(readdirSync(parent), []);
    assert.deepEqual(readdirSync(moved), []);
  } finally {
    f.close();
  }
});
