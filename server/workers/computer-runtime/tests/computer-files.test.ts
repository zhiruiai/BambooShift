import assert from 'node:assert/strict';

import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import test from 'node:test';

import { MAX_FILE_TRANSFER_BYTES } from '../../../../shared/computer-files.js';

import {
  listComputerFiles,
  readComputerFile,
  readTransferResponse,
  writeComputerFile,
} from '../computer-files.js';

import { sample, token, workerAt } from './computer-files.fixture.js';

test('binary file helpers enforce path, ordinary-file, size and no-overwrite boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openbot-binary-files-'));
  const workspace = join(root, 'workspace');
  try {
    await writeComputerFile(workspace, 'nested/sample.bin', sample);
    assert.deepEqual(await readComputerFile(workspace, 'nested/sample.bin'), sample);
    await assert.rejects(
      writeComputerFile(workspace, 'nested/sample.bin', Buffer.from('changed')),
      /EEXIST/,
    );
    assert.deepEqual(await readFile(join(workspace, 'nested/sample.bin')), sample);
    for (const path of [
      '../escape',
      '..\\escape',
      '/absolute',
      'C:\\absolute',
      '\\\\server\\share',
      'bad\0name',
    ]) {
      await assert.rejects(writeComputerFile(workspace, path, sample));
      await assert.rejects(readComputerFile(workspace, path));
    }
    await symlink(root, join(workspace, 'linked'));
    await symlink(join(workspace, 'nested/sample.bin'), join(workspace, 'file-link'));
    await assert.rejects(readComputerFile(workspace, 'file-link'), /符号链接/);
    await assert.rejects(writeComputerFile(workspace, 'linked/escape.bin', sample), /符号链接/);
    await assert.rejects(readComputerFile(workspace, 'nested'), /普通文件/);
    const listing = await listComputerFiles(workspace);
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      ['nested'],
    );
    assert.equal((await listComputerFiles(workspace, 'nested')).entries[0].size, sample.length);
    const tooLarge = await open(join(workspace, 'large.bin'), 'wx');
    await tooLarge.truncate(MAX_FILE_TRANSFER_BYTES + 1);
    await tooLarge.close();
    await assert.rejects(readComputerFile(workspace, 'large.bin'), /10 MiB/);
    await assert.rejects(
      writeComputerFile(workspace, 'oversize.bin', Buffer.alloc(MAX_FILE_TRANSFER_BYTES + 1)),
      /10 MiB/,
    );
    await mkdir(join(workspace, 'many'));
    await Promise.all(
      Array.from({ length: 201 }, (_, n) => writeFile(join(workspace, 'many', String(n)), '')),
    );
    const many = await listComputerFiles(workspace, 'many');
    assert.equal(many.entries.length, 200);
    assert.equal(many.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounded reads cancel oversized/aborted HTTP bodies and aborted writes remove partial files', async () => {
  let cancelled = false;
  const oversized = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(readTransferResponse(oversized), /10 MiB/);
  assert.equal(cancelled, true);
  const controller = new AbortController();
  const pending = readTransferResponse(new Response(new ReadableStream()), controller.signal);
  controller.abort();
  await assert.rejects(pending, /取消/);
  const root = await mkdtemp(join(tmpdir(), 'openbot-binary-cancel-'));
  try {
    const abort = new AbortController();
    const writing = writeComputerFile(
      root,
      'partial.bin',
      Buffer.alloc(MAX_FILE_TRANSFER_BYTES, 7),
      abort.signal,
    ).then(
      () => undefined,
      (error) => error,
    );
    let observed = false;
    for (let n = 0; n < 1000; n++) {
      const file = await stat(join(root, 'partial.bin')).catch(() => undefined);
      if (file && file.size > 0) {
        observed = true;
        abort.abort();
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(observed, true, 'Cancel only after the writer has produced a real partial file');
    assert.match(String(await writing), /取消/);
    await assert.rejects(stat(join(root, 'partial.bin')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker file routes require v2 binding and preserve arbitrary binary bytes without overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openbot-binary-worker-'));
  const workspace = join(root, 'workspace');
  const worker = await workerAt(workspace);
  const url = worker.base + '/files/content?path=nested%2Fsample.bin';
  try {
    assert.equal((await fetch(worker.base + '/files')).status, 401);
    assert.equal(
      (await fetch(worker.base + '/files', { headers: { Authorization: `Bearer ${token}` } }))
        .status,
      409,
    );
    assert.equal(
      (
        await fetch(worker.base + '/files', {
          headers: { ...worker.headers, Origin: 'https://foreign.test' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          method: 'PUT',
          headers: { ...worker.headers, 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(sample),
        })
      ).status,
      201,
    );
    const download = await fetch(url, { headers: worker.headers });
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), sample);
    assert.equal(
      (
        await fetch(url, {
          method: 'PUT',
          headers: { ...worker.headers, 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array([1]),
        })
      ).status,
      409,
    );
    for (const path of ['../escape', '/etc/passwd', '..\\escape']) {
      assert.equal(
        (
          await fetch(worker.base + '/files/content?path=' + encodeURIComponent(path), {
            headers: worker.headers,
          })
        ).status,
        400,
      );
    }
    const listing: any = await (
      await fetch(worker.base + '/files?path=nested', { headers: worker.headers })
    ).json();
    assert.equal(listing.entries[0].path, 'nested/sample.bin');
    const oversized = await fetch(worker.base + '/files/content?path=large.bin', {
      method: 'PUT',
      headers: { ...worker.headers, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(MAX_FILE_TRANSFER_BYTES + 1),
    });
    assert.equal(oversized.status, 413);
    await assert.rejects(stat(join(workspace, 'large.bin')), /ENOENT/);
    const audit = await readFile(join(root, 'audit/computer.jsonl'), 'utf8');
    assert.ok(
      !audit.includes(sample.toString('base64')) &&
        !audit.includes('PRIVATE_BINARY_BYTES_DO_NOT_LOG'),
    );
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
