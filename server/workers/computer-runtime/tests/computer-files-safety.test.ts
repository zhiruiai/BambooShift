import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chown,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  listComputerEntries,
  listComputerFiles,
  readComputerFile,
  readComputerText,
  writeComputerFile,
  writeComputerText,
} from '../computer-files.js';

const linux = process.platform === 'linux';
async function fixture() {
  const root = await mkdtemp(
    join(process.env.OPENBOT_FILE_TEST_ROOT ?? tmpdir(), 'openbot-file-fd-'),
  );
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return { root, workspace, close: () => rm(root, { recursive: true, force: true }) };
}

test('text helpers preserve explicit overwrite and byte cap; listing names links without following them', async () => {
  const f = await fixture();
  try {
    await writeComputerText(f.workspace, 'nested/note.txt', '之前的较长文字');
    await writeComputerText(f.workspace, 'nested/note.txt', '短');
    assert.equal(await readComputerText(f.workspace, 'nested/note.txt'), '短');
    assert.equal((await stat(join(f.workspace, 'nested/note.txt'))).mode & 0o777, 0o600);
    await symlink('../outside', join(f.workspace, 'named-link'));
    assert.deepEqual(
      (await listComputerEntries(f.workspace)).sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'named-link', type: 'link' },
        { name: 'nested', type: 'directory' },
      ],
    );
    assert.deepEqual(
      (await listComputerFiles(f.workspace)).entries.map((e) => e.name),
      ['nested'],
    );
    await writeComputerText(f.workspace, 'limit.txt', 'a'.repeat(200_000));
    assert.equal((await readComputerText(f.workspace, 'limit.txt')).length, 200_000);
    await writeComputerText(f.workspace, 'limit.txt', 'a'.repeat(200_001));
    await assert.rejects(readComputerText(f.workspace, 'limit.txt'), /200 KB/);
    assert.equal((await readComputerFile(f.workspace, 'limit.txt')).length, 200_001);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      writeComputerText(f.workspace, 'nested/note.txt', 'replace', abort.signal),
      /取消/,
    );
    assert.equal(await readComputerText(f.workspace, 'nested/note.txt'), '短');
  } finally {
    await f.close();
  }
});

test('hard links, final symlinks and a symlink workspace never read or truncate outside files', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside-secret');
    await writeFile(outside, 'synthetic outside private content', { mode: 0o600 });
    await link(outside, join(f.workspace, 'hard'));
    await symlink(outside, join(f.workspace, 'soft'));
    for (const path of ['hard', 'soft']) {
      await assert.rejects(readComputerFile(f.workspace, path), /链接/);
      await assert.rejects(readComputerText(f.workspace, path), /链接/);
      await assert.rejects(writeComputerText(f.workspace, path, 'must not overwrite'), /链接/);
      await assert.rejects(
        writeComputerFile(f.workspace, path, Buffer.from('must not overwrite')),
        /EEXIST/,
      );
    }
    assert.equal(await readFile(outside, 'utf8'), 'synthetic outside private content');
    assert.deepEqual((await listComputerFiles(f.workspace)).entries, []);
    assert.deepEqual(await listComputerEntries(f.workspace), [{ name: 'soft', type: 'link' }]);
    const linkedRoot = join(f.root, 'linked-root');
    await symlink(f.workspace, linkedRoot);
    for (const root of [linkedRoot, linkedRoot + '/']) {
      await assert.rejects(listComputerFiles(root), /链接/);
      await assert.rejects(writeComputerText(root, 'new.txt', 'no'), /链接/);
      await assert.rejects(readComputerFile(root, 'hard'), /链接/);
    }
    await assert.rejects(stat(join(f.workspace, 'new.txt')), /ENOENT/);
  } finally {
    await f.close();
  }
});

test(
  'FIFO files are rejected without blocking or truncating ordinary neighbours',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await fixture();
    try {
      const fifo = join(f.workspace, 'pipe');
      const made = spawnSync('/usr/bin/mkfifo', [fifo], { encoding: 'utf8' });
      assert.equal(made.status, 0, 'fixture mkfifo must succeed');
      await assert.rejects(readComputerFile(f.workspace, 'pipe'));
      await assert.rejects(readComputerText(f.workspace, 'pipe'));
      await assert.rejects(writeComputerText(f.workspace, 'pipe', 'not a regular file'));
      assert.deepEqual((await listComputerFiles(f.workspace)).entries, []);
      assert.deepEqual(await listComputerEntries(f.workspace), []);
    } finally {
      await f.close();
    }
  },
);

test(
  'Linux directory replacement races cannot redirect list/read/write operations outside the pinned workspace',
  { skip: !linux },
  async () => {
    const f = await fixture();
    const control = new Int32Array(new SharedArrayBuffer(8));
    let racer: Worker | undefined;
    try {
      const outside = join(f.root, 'outside');
      const pivot = join(f.workspace, 'pivot');
      await mkdir(outside);
      await mkdir(pivot);
      await writeFile(join(outside, 'read.txt'), 'PRIVATE_OUTSIDE_SYNTHETIC');
      await writeFile(join(outside, 'write.txt'), 'OUTSIDE_UNCHANGED');
      await writeFile(join(outside, 'outside-only.txt'), 'never list');
      await writeFile(join(pivot, 'read.txt'), 'INSIDE');
      await writeFile(join(pivot, 'write.txt'), 'INSIDE');
      racer = new Worker(
        `
      const { workerData, parentPort } = require('node:worker_threads');
      const fs = require('node:fs');
      const state = new Int32Array(workerData.control);
      const live = workerData.pivot, parked = live + '-parked';
      let conflicts = 0;
      parentPort.postMessage('ready');
      while (!Atomics.load(state, 0)) {
        try {
          fs.renameSync(live, parked);
          fs.symlinkSync(workerData.outside, live);
          Atomics.add(state, 1, 1);
          Atomics.wait(state, 0, 0, 1);
          fs.unlinkSync(live);
          // An allowed write can create the absent directory between rename calls.
          // Move that synthetic directory aside rather than deleting its contents.
          try { fs.renameSync(parked, live); }
          catch (error) {
            if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
            fs.renameSync(live, live + '-created-' + conflicts++);
            fs.renameSync(parked, live);
          }
          Atomics.wait(state, 0, 0, 1);
        } catch (error) { parentPort.postMessage({ error: error.code }); break; }
      }
    `,
        { eval: true, workerData: { pivot, outside, control: control.buffer } },
      );
      await once(racer, 'message');
      let successes = 0,
        rejected = 0;
      const attempt = async <T>(operation: Promise<T>, inspect: (value: T) => void) => {
        let value: T;
        try {
          value = await operation;
        } catch {
          rejected++;
          return;
        }
        successes++;
        inspect(value);
      };
      for (let i = 0; i < 100; i++) {
        await attempt(readComputerText(f.workspace, 'pivot/read.txt'), (value) =>
          assert.equal(value, 'INSIDE'),
        );
        await attempt(readComputerFile(f.workspace, 'pivot/read.txt'), (value) =>
          assert.equal(value.toString(), 'INSIDE'),
        );
        await attempt(listComputerFiles(f.workspace, 'pivot'), (value) =>
          assert.ok(!value.entries.some((e) => e.name === 'outside-only.txt')),
        );
        await attempt(listComputerEntries(f.workspace, 'pivot'), (value) =>
          assert.ok(!value.some((e) => e.name === 'outside-only.txt')),
        );
        await attempt(
          writeComputerText(f.workspace, 'pivot/write.txt', 'workspace-write'),
          () => {},
        );
        await attempt(
          writeComputerFile(f.workspace, `pivot/new-${i}.txt`, Buffer.from('upload')),
          () => {},
        );
      }
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
      await once(racer, 'exit');
      racer = undefined;
      assert.ok(
        Atomics.load(control, 1) >= 10,
        'the adversary must actually replace the directory repeatedly',
      );
      assert.ok(
        successes > 0 && rejected > 0,
        'exercise allowed operations as well as adversarial refusals',
      );
      assert.equal(await readFile(join(outside, 'read.txt'), 'utf8'), 'PRIVATE_OUTSIDE_SYNTHETIC');
      assert.equal(await readFile(join(outside, 'write.txt'), 'utf8'), 'OUTSIDE_UNCHANGED');
      assert.deepEqual((await listComputerEntries(outside)).map((e) => e.name).sort(), [
        'outside-only.txt',
        'read.txt',
        'write.txt',
      ]);
    } finally {
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
      if (racer) await racer.terminate();
      await f.close();
    }
  },
);

test(
  'Linux root hands only newly created files/directories to the dedicated desktop UID through FDs',
  { skip: !linux || process.getuid?.() !== 0 },
  async () => {
    const f = await fixture();
    try {
      await chown(f.workspace, 65532, 65532);
      await writeComputerFile(
        f.workspace,
        'uploaded/nested/data.bin',
        Buffer.from('desktop-readable'),
      );
      await writeComputerText(f.workspace, 'notes/note.txt', 'desktop-editable');
      for (const path of [
        'uploaded',
        'uploaded/nested',
        'uploaded/nested/data.bin',
        'notes',
        'notes/note.txt',
      ]) {
        const info = await stat(join(f.workspace, path));
        assert.equal(info.uid, 65532);
        assert.equal(info.gid, 65532);
        assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600);
      }
      const existing = join(f.workspace, 'root-owned.txt');
      await writeFile(existing, 'old', { mode: 0o640 });
      await writeComputerText(f.workspace, 'root-owned.txt', 'approved replacement');
      assert.equal((await stat(existing)).uid, 0, 'do not chown existing files');
      assert.equal((await stat(existing)).mode & 0o777, 0o640);
      const normal = join(f.root, 'ordinary-root-workspace');
      await mkdir(normal);
      await writeComputerFile(normal, 'own.txt', Buffer.from('root'));
      assert.equal((await stat(join(normal, 'own.txt'))).uid, 0);
      // A child using the desktop identity really opens the upload, rather than
      // treating metadata alone as evidence of readability.
      const rootAccess = await open(f.root, 'r');
      await rootAccess.chmod(0o755);
      await rootAccess.close();
      const read = spawnSync(
        process.execPath,
        [
          '-e',
          'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))',
          join(f.workspace, 'uploaded/nested/data.bin'),
        ],
        { uid: 65532, gid: 65532, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' },
      );
      assert.equal(read.status, 0);
      assert.equal(read.stdout, 'desktop-readable');
    } finally {
      await f.close();
    }
  },
);
