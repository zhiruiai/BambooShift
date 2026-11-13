import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { nativeNoticeFixture, nativeDistributionFixture } from './fixtures/native-runtime.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const legal = 'legal/third-party/sharp-libvips-1.3.4';

test('native legal collection retains exact bytes and nonstandard referenced notices', async (t) => {
  const f = await nativeNoticeFixture(t);
  const result = await f.collect();
  assert.equal(result.components, 1);
  assert.equal(result.files, 2);
  const indexBytes = await readFile(join(f.output, 'index.json'));
  assert.equal(result.indexSha256, digest(indexBytes));
  const index = JSON.parse(indexBytes);
  assert.equal(index.identity, 'bambooshift-source-built-native-image-codecs');
  assert.equal(index.unchangedUpstreamTexts, true);
  assert.doesNotMatch(indexBytes.toString(), new RegExp(f.root));
  for (const [path, bytes] of f.originals)
    assert.deepEqual(await readFile(join(f.output, 'synthetic', path)), bytes);
  assert.equal(index.components[0].archive.sha256, f.input.sha256);
  assert.equal(index.components[0].files[1].source, 'upstream/nested/README.ijg');
  await assert.rejects(f.collect(), /already exists/);
});

test('tampered archive bytes fail before publishing a notices directory', async (t) => {
  const f = await nativeNoticeFixture(t);
  const bytes = await readFile(f.archivePath);
  bytes[0] ^= 1;
  await writeFile(f.archivePath, bytes);
  await assert.rejects(f.collect(), /reviewed identity/);
  assert.equal(
    (await readdir(f.root)).some((name) => name.startsWith('.native-notices-')),
    false,
  );
  await assert.rejects(readFile(join(f.output, 'index.json')), { code: 'ENOENT' });
});

test('missing components and divergent source identities cannot clear legal collection', async (t) => {
  const f = await nativeNoticeFixture(t);
  f.inputs.inputs.push({ ...f.input, component: 'second' });
  await f.save();
  await assert.rejects(f.collect(), /exact source archives/);
  f.inputs.inputs.pop();
  f.catalog.components[0].sha256 = '0'.repeat(64);
  await f.save();
  await assert.rejects(f.collect(), /exact archives/);
});

test('path traversal, absent members and modified notice bytes are rejected', async (t) => {
  const f = await nativeNoticeFixture(t);
  const file = f.catalog.components[0].files[0];
  file.path = '../escape';
  await f.save();
  await assert.rejects(f.collect(), /safe paths/);
  file.path = 'COPYING';
  file.archivePath = 'upstream/missing';
  await f.save();
  await assert.rejects(f.collect(), /missing or ambiguous/);
  file.archivePath = 'upstream/COPYING';
  file.sha256 = '0'.repeat(64);
  await f.save();
  await assert.rejects(f.collect(), /reviewed bytes/);
  await assert.rejects(readFile(join(f.root, 'escape')), { code: 'ENOENT' });
});

test('the reviewed native catalog includes the notices referenced by JPEG and FreeType', async () => {
  const catalog = JSON.parse(
    await readFile(new URL(`../../${legal}/NATIVE-NOTICES.json`, import.meta.url)),
  );
  const names = catalog.components.map((item) => item.component);
  assert.equal(names.length, 27);
  assert.equal(new Set(names).size, 27);
  assert.equal(names.includes('rsvg'), false);
  const paths = (name) =>
    catalog.components.find((item) => item.component === name).files.map((file) => file.path);
  assert.ok(paths('jpeg').includes('README.ijg'));
  for (const file of ['docs/FTL.TXT', 'src/bdf/README', 'src/pcf/README', 'src/gzip/zlib.h'])
    assert.ok(paths('freetype').includes(file));
  assert.ok(paths('glib').includes('subprojects/gvdb/COPYING'));
  assert.ok(paths('heif').includes('COPYING'));
  assert.ok(paths('vips').includes('libvips/foreign/libnsgif/COPYING'));
});

test('custom distribution verifies binary, every source member and notices under its own identity', async (t) => {
  const f = await nativeDistributionFixture(t);
  const result = await f.verify();
  assert.equal(result.identity, 'bambooshift-native-image-codecs');
  assert.equal(result.sourceInputs, 2);
  assert.equal(result.legalFiles, 2);
  assert.equal(result.releaseApproval, false);
  await assert.rejects(f.verify('0'.repeat(64)), /independently reviewed/);
  const bytes = await readFile(join(f.artifacts, 'binary.tar.gz'));
  bytes[0] ^= 1;
  await writeFile(join(f.artifacts, 'binary.tar.gz'), bytes);
  await assert.rejects(f.verify(), /checksum differs/);
});

test('a newly pinned manifest cannot hide missing original source or legal materials', async (t) => {
  for (const path of ['source-cache/synthetic.tar.gz', 'LICENSES/synthetic/nested/README.ijg']) {
    const f = await nativeDistributionFixture(t);
    await rm(join(f.source, path));
    await f.seal();
    await assert.rejects(f.verify(), /missing or changed a required build input/);
  }
});

test('source symlinks and stale official feature metadata cannot masquerade as a clean custom build', async (t) => {
  const link = await nativeDistributionFixture(t);
  await symlink('../binary', join(link.source, 'linked-tree'));
  await link.seal();
  await assert.rejects(link.verify(), /cannot contain links/);
  const stale = await nativeDistributionFixture(t);
  await writeFile(
    join(stale.binary, 'versions.json'),
    JSON.stringify({ vips: '8.18.7', rsvg: '2.63.2' }),
  );
  await stale.seal();
  await assert.rejects(stale.verify(), /no-rsvg build/);
});
