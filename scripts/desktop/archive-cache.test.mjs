import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifiedArchive } from './archive-cache.mjs';

test('public archive cache rechecks the digest and refuses tampering or redirected entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bambooshift-archive-'));
  const bytes = Buffer.from('synthetic public archive');
  const path = join(directory, 'fixture.tar.gz');
  const args = {
    directory,
    name: 'fixture.tar.gz',
    maxBytes: 128,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    download: async () => bytes,
  };
  try {
    assert.deepEqual(await verifiedArchive(args), bytes);
    assert.deepEqual(
      await verifiedArchive({ ...args, download: async () => assert.fail('cached') }),
      bytes,
    );
    assert.deepEqual(await readFile(path), bytes);
    await writeFile(path, 'tampered');
    await assert.rejects(verifiedArchive(args), /checksum/);
    await rm(path);
    await writeFile(join(directory, 'original'), bytes);
    await symlink(join(directory, 'original'), path);
    await assert.rejects(verifiedArchive(args), /Invalid cached/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
