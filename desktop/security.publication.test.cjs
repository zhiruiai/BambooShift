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

test('successful exclusive publication never clears the saved inode when later unlink or close fails', async (t) => {
  for (const failure of ['unlink', 'close'])
    await t.test(failure, async () => {
      const fs = require('node:fs'),
        fsPromises = require('node:fs/promises');
      let failed = 0,
        truncations = 0;
      const makeController = controllerWithFilesystem(
        {
          unlinkSync(path) {
            if (failure === 'unlink' && String(path).includes('.openbot-download-')) {
              assert.equal(
                statSync(path).nlink,
                2,
                'a successful link already published this inode',
              );
              failed++;
              throw Object.assign(new Error('synthetic post-publication unlink failure'), {
                code: 'EIO',
              });
            }
            return fs.unlinkSync(path);
          },
        },
        {
          async open(...args) {
            const handle = await fsPromises.open(...args);
            return {
              stat: handle.stat.bind(handle),
              writeFile: handle.writeFile.bind(handle),
              sync: handle.sync.bind(handle),
              async truncate(...parameters) {
                truncations++;
                return handle.truncate(...parameters);
              },
              async close() {
                await handle.close();
                if (failure === 'close') {
                  failed++;
                  throw new Error('synthetic post-publication close failure');
                }
              },
            };
          },
        },
      );
      const f = await sharedDownloadFixture(makeController);
      try {
        f.arm();
        assert.equal((await f.invoke()).status, 'saved');
        assert.deepEqual(readFileSync(f.destination), f.file);
        assert.equal(failed, 1);
        assert.equal(truncations, 0, 'cleanup never truncates an already published inode');
        if (failure === 'close') f.assertNoTemps();
        else {
          const temporary = readdirSync(f.dataDir).find((name) =>
            name.startsWith('.openbot-download-'),
          );
          assert.ok(temporary);
          assert.equal(statSync(join(f.dataDir, temporary)).ino, statSync(f.destination).ino);
        }
      } finally {
        f.close();
      }
    });
});
