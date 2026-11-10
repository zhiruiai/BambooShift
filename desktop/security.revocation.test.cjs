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

test('final HEAD rechecks the exact file grant after bytes arrived and prevents late unauthorized replacement', async (t) => {
  for (const scenario of ['revoked', 'different-size', 'redirect'])
    await t.test(scenario, async () => {
      const f = await sharedDownloadFixture();
      writeFileSync(f.destination, 'ORIGINAL_MUST_SURVIVE');
      f.setHeadResponse((_url, init) => {
        assert.equal(init.headers['X-OpenBot-Expected-User'], sharedDownloadIds.user);
        assert.equal(
          f.state.user,
          sharedDownloadIds.user,
          'account remains valid when file authority changes',
        );
        assert.ok(
          readdirSync(f.dataDir).some((name) => name.startsWith('.openbot-download-')),
          'the pending bytes are private and not yet committed',
        );
        if (scenario === 'revoked') return new Response(null, { status: 403 });
        if (scenario === 'redirect')
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://elsewhere.example/' },
          });
        return new Response(null, { headers: { 'Content-Length': String(f.file.length + 1) } });
      });
      try {
        f.arm();
        await assert.rejects(f.invoke(), /共享资料或账户权限已变化/);
        assert.equal(f.state.fileCalls, 1);
        assert.equal(f.state.headCalls, 1);
        assert.equal(readFileSync(f.destination, 'utf8'), 'ORIGINAL_MUST_SURVIVE');
        f.assertNoTemps();
      } finally {
        f.close();
      }
    });
});

test('account changes and navigation while the native save sheet is open cancel its later result', async (t) => {
  for (const scenario of ['cookie', 'navigation'])
    await t.test(scenario, async () => {
      const f = await sharedDownloadFixture(),
        gate = deferred();
      let choosing = false;
      f.fake.dialog.showSaveDialog = async () => {
        choosing = true;
        return gate.promise;
      };
      try {
        f.arm();
        const pending = f.invoke();
        await waitForDownload(() => choosing);
        if (scenario === 'cookie')
          f.contents.session.cookies.emit(
            'changed',
            {},
            { name: 'openbot_account' },
            'explicit',
            false,
          );
        else
          f.contents.emit(
            'did-start-navigation',
            {},
            'https://files.example.com/account',
            false,
            true,
          );
        gate.resolve({ canceled: false, filePath: f.destination });
        assert.deepEqual(await pending, { status: 'cancelled' });
        assert.equal(f.state.fileCalls, 0);
        assert.equal(existsSync(f.destination), false);
        f.assertNoTemps();
      } finally {
        gate.resolve({ canceled: true });
        f.close();
      }
    });
});

test('a moved temporary-file parent cannot retain cancelled plaintext or trick cleanup into removing a replacement file', async (t) => {
  for (const scenario of ['head403', 'cancel', 'parent-check'])
    await t.test(scenario, async () => {
      const f = await sharedDownloadFixture();
      const parent = join(f.dataDir, 'downloads'),
        moved = join(f.dataDir, 'moved-downloads');
      mkdirSync(parent);
      f.fake.dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: join(parent, 'saved.txt'),
      });
      let temporaryName, originalInode, moveBlocked;
      f.setHeadResponse(() => {
        const temporaries = readdirSync(parent).filter((name) =>
          name.startsWith('.openbot-download-'),
        );
        assert.equal(
          temporaries.length,
          1,
          'HEAD runs after a real temporary file has been written',
        );
        temporaryName = temporaries[0];
        assert.deepEqual(readFileSync(join(parent, temporaryName)), f.file);
        originalInode = statSync(join(parent, temporaryName), { bigint: true }).ino;
        try {
          renameSync(parent, moved);
        } catch (error) {
          if (process.platform !== 'win32' || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code))
            throw error;
          moveBlocked = true;
          if (scenario === 'cancel')
            f.contents.emit('did-navigate-in-page', {}, 'https://files.example.com/account', true);
          return new Response(null, { status: 403 });
        }
        mkdirSync(parent);
        writeFileSync(join(parent, temporaryName), 'REPLACEMENT_CANARY_MUST_SURVIVE');
        if (scenario === 'head403') return new Response(null, { status: 403 });
        if (scenario === 'cancel')
          f.contents.emit('did-navigate-in-page', {}, 'https://files.example.com/account', true);
        return new Response(null, { headers: { 'Content-Length': String(f.file.length) } });
      });
      try {
        f.arm();
        if (scenario === 'cancel') assert.deepEqual(await f.invoke(), { status: 'cancelled' });
        else
          await assert.rejects(f.invoke(), (error) =>
            (scenario === 'head403' || moveBlocked
              ? /共享资料或账户权限/
              : /保存位置发生变化/
            ).test(error.message),
          );
        if (moveBlocked) {
          // NTFS may block the rename while the original file handle is open.
          assert.equal(existsSync(join(parent, temporaryName)), false);
          assert.equal(existsSync(join(parent, 'saved.txt')), false);
          assert.equal(existsSync(moved), false);
          return;
        }
        assert.equal(statSync(join(moved, temporaryName), { bigint: true }).ino, originalInode);
        assert.equal(
          readFileSync(join(moved, temporaryName)).length,
          0,
          'the held original inode is cleared even when its parent moved',
        );
        assert.equal(
          readFileSync(join(parent, temporaryName), 'utf8'),
          'REPLACEMENT_CANARY_MUST_SURVIVE',
        );
        assert.equal(existsSync(join(parent, 'saved.txt')), false);
        assert.equal(existsSync(join(moved, 'saved.txt')), false);
      } finally {
        f.close();
      }
    });
});
