import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCandidate, sourceBytes, sourceInventory, validateInputs } from './build.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const sample = {
  component: 'synthetic',
  filename: 'source.tar.gz',
  bytes: 3,
  url: 'https://example.test/source.tar.gz',
  sha256: digest('abc'),
};

test('fixed sources reject duplicate, unsafe output and non-HTTPS identities', () => {
  assert.equal(validateInputs([sample]).length, 1);
  for (const item of [
    { filename: '../source.tar.gz' },
    { url: 'http://example.test/source' },
    { url: 'https://name:secret@example.test/source' },
    { bytes: 0 },
    { sha256: 'bad' },
    { output: '../outside' },
    { output: '/absolute' },
  ])
    assert.throws(() => validateInputs([{ ...sample, ...item }]), /fixed source/);
  assert.throws(() => validateInputs([sample, sample]), /fixed source/);
});

test('offline source reader requires exact bytes and rejects symlink/corrupt cached data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-source-test-'));
  try {
    await assert.rejects(sourceBytes(sample, directory), /Missing verified input/);
    await writeFile(join(directory, sample.filename), 'abc');
    assert.equal(String(await sourceBytes(sample, directory)), 'abc');
    await assert.rejects(sourceBytes({ ...sample, bytes: 4 }, directory), /size does not match/);
    await writeFile(join(directory, sample.filename), 'bad');
    await assert.rejects(sourceBytes(sample, directory), /checksum/);
    await rm(join(directory, sample.filename));
    await writeFile(join(directory, 'other'), 'abc');
    await symlink('other', join(directory, sample.filename));
    await assert.rejects(sourceBytes(sample, directory), /Invalid cached archive/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('clean preparation refuses to replace an existing output or a whitespace recipe path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-output-test-'));
  try {
    await writeFile(join(directory, 'sentinel'), 'keep');
    await assert.rejects(prepareCandidate({ output: directory, cache: join(directory, 'cache') }), {
      code: 'EEXIST',
    });
    assert.equal(await readFile(join(directory, 'sentinel'), 'utf8'), 'keep');
    await assert.rejects(
      prepareCandidate({ output: join(directory, 'not safe'), cache: directory }),
      /whitespace/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('published source catalog binds all recipe inputs and three local source patches', async () => {
  const legal = new URL('../../../legal/third-party/sharp-libvips-1.3.4/', import.meta.url);
  const catalog = JSON.parse(await readFile(new URL('SOURCE-INPUTS-CANDIDATE.json', legal)));
  assert.equal(validateInputs([...catalog.inputs, ...catalog.buildInputs]).length, 37);
  assert.equal(catalog.inputs.filter((input) => /\.tar\.(gz|xz)$/.test(input.filename)).length, 27);
  for (const patch of catalog.additionalLocalPatches)
    assert.equal(digest(await readFile(new URL(patch.file, legal))), patch.sha256);
  assert.equal(
    digest(await readFile(new URL('candidate-recipe.patch', legal))),
    catalog.recipePatchSha256,
  );
  const recipe = await readFile(new URL('candidate-recipe.patch', legal), 'utf8');
  assert.match(recipe, /\+.*-Drsvg=disabled/);
  assert.match(
    recipe,
    /\+.*-DENABLE_PLUGIN_LOADING=0 -DPLUGIN_DIRECTORY=\/bambooshift-native-runtime\/lib\/libheif/,
  );
  assert.doesNotMatch(recipe, /^\+.*cargo (install|update)/m);
});

test('source inventory binds exact regular members and rejects links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-inventory-test-'));
  try {
    await writeFile(join(directory, 'source'), 'abc');
    assert.deepEqual(await sourceInventory(directory), {
      version: 1,
      files: [{ path: 'source', bytes: 3, sha256: sample.sha256 }],
    });
    await symlink('source', join(directory, 'alias'));
    await assert.rejects(sourceInventory(directory), /regular files/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
