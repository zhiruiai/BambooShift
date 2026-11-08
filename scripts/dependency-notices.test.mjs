import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectDependencyNotices } from './dependency-notices.mjs';
import { MAX_NOTICE_BYTES } from './dependency-notice-files.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'openbot-legal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'project');
  await mkdir(join(sourceRoot, 'server/api'), { recursive: true });
  await writeFile(
    join(sourceRoot, 'server/api/Cargo.lock'),
    '# Synthetic locked fixture\nversion = 4\n',
  );
  const lock = { lockfileVersion: 3, packages: { '': {} } };
  const cargoMetadata = {
    host: 'synthetic-host',
    metadata: {
      packages: [{ id: 'own', name: 'openbot', version: '0.1.0' }],
      workspace_members: ['own'],
      resolve: { nodes: [{ id: 'own' }] },
    },
  };
  async function npm(name = 'synthetic-dependency', extras = {}) {
    const directory = join(sourceRoot, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    lock.packages[`node_modules/${name}`] = { version: '1.2.3', integrity: 'sha512-synthetic' };
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        version: '1.2.3',
        license: 'MIT',
        repository: 'https://example.test/public-repository',
        ...extras,
      }),
    );
    return directory;
  }
  async function cargo(name = 'synthetic-crate', extras = {}) {
    const directory = join(root, 'registry', name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'Cargo.toml'),
      '[package]\nname="synthetic-crate"\nversion="2.0.0"\n',
    );
    cargoMetadata.metadata.packages.push({
      id: name,
      name,
      version: '2.0.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
      manifest_path: join(directory, 'Cargo.toml'),
      license: 'MIT OR Apache-2.0',
      repository: 'https://example.test/native',
      ...extras,
    });
    cargoMetadata.metadata.resolve.nodes.push({ id: name });
    return directory;
  }
  async function run(extra = {}) {
    await writeFile(join(sourceRoot, 'package-lock.json'), JSON.stringify(lock));
    return collectDependencyNotices({
      sourceRoot,
      output: join(root, 'notices'),
      cargoMetadata,
      ...extra,
    });
  }
  return {
    root,
    sourceRoot,
    lock,
    cargoMetadata,
    npm,
    cargo,
    run,
    index: async () => JSON.parse(await readFile(join(root, 'notices/index.json'), 'utf8')),
  };
}

test('copies exact locked npm, Web, Cargo and nested native legal texts without private paths', async (t) => {
  const f = await fixture(t);
  const npm = await f.npm('@synthetic/web');
  const original = Buffer.from('Synthetic upstream copyright\r\nMIT license text\r\n');
  await writeFile(join(npm, 'LICENSE'), original);
  await mkdir(join(npm, 'native/licenses'), { recursive: true });
  await writeFile(join(npm, 'native/licenses/codec.txt'), 'Synthetic native legal terms.');
  await writeFile(join(npm, 'implementation.js'), 'PRIVATE_IMPLEMENTATION_NOT_A_LICENSE');
  const cargo = await f.cargo();
  await writeFile(join(cargo, 'LICENSE-MIT'), 'Synthetic crate MIT text');
  await writeFile(join(cargo, 'LICENSE-APACHE'), 'Synthetic crate Apache text');
  await mkdir(join(cargo, 'native'), { recursive: true });
  await writeFile(join(cargo, 'native/COPYING'), 'Synthetic C library COPYING');
  const explicit = await f.cargo('declared-crate', { license_file: 'Legal.md', license: null });
  await writeFile(join(explicit, 'Legal.md'), 'Synthetic declared upstream legal text');
  const summary = await f.run();
  assert.equal(summary.packages, 3);
  assert.equal(summary.files, 6);
  assert.deepEqual(summary.missing, []);
  const index = await f.index();
  assert.equal(JSON.stringify(index).includes(f.root), false);
  assert.equal(JSON.stringify(index).includes('manifest_path'), false);
  const web = index.packages.find((p) => p.ecosystem === 'npm');
  assert.equal(web.spdx, 'MIT');
  assert.equal(web.repository, 'https://example.test/public-repository');
  assert.deepEqual(
    await readFile(join(f.root, 'notices', web.files.find((p) => p.source === 'LICENSE').path)),
    original,
  );
  assert.ok(web.files.some((p) => p.source === 'native/licenses/codec.txt'));
  assert.ok(!web.files.some((p) => p.source.includes('implementation')));
});

test('missing upstream license is explicit, leaves an auditable index and fails strict publishing', async (t) => {
  const f = await fixture(t);
  await f.npm();
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.summary.missing[0].name, 'synthetic-dependency');
    assert.equal(error.summary.files, 0);
    return /incomplete/.test(error.message);
  });
  const index = await f.index();
  assert.equal(index.missing.length, 1);
  assert.deepEqual(index.packages[0].files, []);
  assert.equal(index.packages[0].spdx, 'MIT');
  await assert.rejects(f.run(), /already exists/);
});

test('absent optional platforms are recorded but absent required npm dependencies fail', async (t) => {
  const f = await fixture(t);
  f.lock.packages['node_modules/platform-optional'] = { version: '1.0.0', optional: true };
  assert.equal((await f.run()).packages, 0);
  assert.deepEqual((await f.index()).absentOptional, [
    { name: 'node_modules/platform-optional', version: '1.0.0' },
  ]);
  f.lock.packages['node_modules/required-web'] = { version: '1.0.0' };
  await assert.rejects(f.run({ output: join(f.root, 'another') }), /required-web.*npm ci/);
});

test('installed metadata must match the locked version', async (t) => {
  const f = await fixture(t);
  await f.npm('mismatched', { version: '2.0.0' });
  await assert.rejects(f.run(), /does not match the lock/);
});

test('does not follow outside license files or native legal directory links', async (t) => {
  const f = await fixture(t);
  const npm = await f.npm();
  await writeFile(join(f.root, 'outside'), 'Synthetic private text');
  await symlink(join(f.root, 'outside'), join(npm, 'LICENSE'));
  await assert.rejects(f.run(), /symbolic links/);
  await rm(join(npm, 'LICENSE'));
  await mkdir(join(f.root, 'external'));
  await symlink(join(f.root, 'external'), join(npm, 'licenses'), 'dir');
  await assert.rejects(f.run(), /symbolic links/);
});

test('rejects symlinked package roots and escaping explicit Cargo license paths', async (t) => {
  const f = await fixture(t);
  const npm = await f.npm();
  await rm(npm, { recursive: true });
  await mkdir(join(f.root, 'outside-package'));
  await symlink(join(f.root, 'outside-package'), npm, 'dir');
  await assert.rejects(f.run(), /not a real directory/);
  await rm(npm);
  delete f.lock.packages['node_modules/synthetic-dependency'];
  await f.cargo('escaping-crate', { license_file: '../../private.txt' });
  await assert.rejects(f.run(), /escapes its package/);
});

test('bounded file reads reject oversized legal files before copying them', async (t) => {
  const f = await fixture(t);
  const npm = await f.npm();
  await writeFile(join(npm, 'LICENSE'), '');
  await truncate(join(npm, 'LICENSE'), MAX_NOTICE_BYTES + 1);
  await assert.rejects(f.run(), /byte limit/);
  await assert.rejects(readFile(join(f.root, 'notices/index.json')), { code: 'ENOENT' });
});

test('Cargo resolution cannot silently omit a dependency or use local path sources', async (t) => {
  const f = await fixture(t);
  f.cargoMetadata.metadata.resolve.nodes.push({ id: 'missing-crate' });
  await assert.rejects(f.run(), /omitted resolved/);
  f.cargoMetadata.metadata.resolve.nodes.pop();
  await f.cargo('path-crate', { source: null });
  await assert.rejects(f.run(), /Non-registry/);
});

test('metadata repository credentials and local paths are never included in the public index', async (t) => {
  const f = await fixture(t);
  const npm = await f.npm('private-repo', {
    repository: 'https://synthetic:password@example.test/repo?secret=fixture',
  });
  await writeFile(join(npm, 'LICENSE'), 'Synthetic exact text');
  await f.run();
  const index = await f.index();
  assert.equal(index.packages[0].repository, undefined);
  assert.equal(JSON.stringify(index).includes('password'), false);
});

test('full MIT legal text in README is retained while a bare license link remains incomplete', async (t) => {
  const f = await fixture(t);
  const complete = await f.npm('readme-license');
  const original = `Example package

## License
Copyright (c) Synthetic author

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`;
  await writeFile(join(complete, 'README.md'), original);
  const link = await f.npm('license-link-only');
  await writeFile(
    join(link, 'README.md'),
    '## License\n[MIT license](https://example.test/LICENSE)',
  );
  const summary = await f.run({ strict: false });
  assert.deepEqual(
    summary.missing.map((p) => p.name),
    ['license-link-only'],
  );
  const record = (await f.index()).packages.find((p) => p.name === 'readme-license');
  assert.equal(record.files[0].source, 'README.md');
  assert.equal(await readFile(join(f.root, 'notices', record.files[0].path), 'utf8'), original);
});

test('exact bundled Web inputs exclude external runtime packages and validate every selected version', async (t) => {
  const f = await fixture(t);
  const web = await f.npm('bundled-ui');
  await writeFile(join(web, 'LICENSE'), 'Synthetic Web license text');
  await f.npm('external-worker-sdk');
  const npmPackages = [
    { name: 'bundled-ui', version: '1.2.3', packagePath: 'node_modules/bundled-ui' },
  ];
  assert.equal((await f.run({ npmPackages })).packages, 1);
  const index = await f.index();
  assert.equal(index.npmScope, 'bundled-web');
  assert.match(index.externalRuntimeDependencies, /installed separately/);
  assert.equal(index.packages[0].name, 'bundled-ui');
  await assert.rejects(
    f.run({
      output: join(f.root, 'bad-version'),
      npmPackages: [{ ...npmPackages[0], version: '1.2.4' }],
    }),
    /differs from the installed/,
  );
  await assert.rejects(
    f.run({
      output: join(f.root, 'unknown'),
      npmPackages: [{ ...npmPackages[0], packagePath: 'node_modules/not-installed' }],
    }),
    /not present in the current lock/,
  );
});

async function legalSupplement(f, changes = {}) {
  const revision = 'a'.repeat(40);
  const crate = await f.cargo('upstream-crate');
  await writeFile(join(crate, '.cargo_vcs_info.json'), JSON.stringify({ git: { sha1: revision } }));
  const root = join(f.sourceRoot, 'legal/third-party');
  await mkdir(join(root, 'upstream-crate'), { recursive: true });
  const bytes = Buffer.from('Synthetic original upstream copyright and legal text\r\n');
  await writeFile(join(root, 'upstream-crate/LICENSE'), bytes);
  const file = {
    path: 'upstream-crate/LICENSE',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    url: `https://raw.githubusercontent.com/example/upstream/${revision}/LICENSE`,
    ...changes,
  };
  const manifest = {
    version: 1,
    packages: [
      {
        ecosystem: 'cargo',
        name: 'upstream-crate',
        version: '2.0.0',
        repository: 'https://github.com/example/upstream',
        revision,
        files: [file],
      },
    ],
  };
  const path = join(root, 'manifest.json');
  await writeFile(path, JSON.stringify(manifest));
  return { bytes, manifest, path, crate, file };
}

test('reviewed supplements preserve bytes and bind both published crate commit and upstream hash', async (t) => {
  const f = await fixture(t);
  const supplement = await legalSupplement(f);
  assert.equal((await f.run()).missing.length, 0);
  const [record] = (await f.index()).packages;
  assert.equal(record.files[0].upstream, supplement.file.url);
  assert.deepEqual(await readFile(join(f.root, 'notices', record.files[0].path)), supplement.bytes);
  assert.equal(JSON.stringify(await f.index()).includes(f.root), false);
  await writeFile(
    join(supplement.crate, '.cargo_vcs_info.json'),
    JSON.stringify({ git: { sha1: 'b'.repeat(40) } }),
  );
  await assert.rejects(
    f.run({ output: join(f.root, 'changed-commit') }),
    /differs from the locked crate/,
  );
});

test('supplement files cannot escape the legal directory, drift bytes or reference mutable upstream URLs', async (t) => {
  const f = await fixture(t);
  const supplement = await legalSupplement(f, { sha256: '0'.repeat(64) });
  await assert.rejects(f.run(), /reviewed SHA-256/);
  supplement.file.path = '../../package-lock.json';
  await writeFile(supplement.path, JSON.stringify(supplement.manifest));
  await assert.rejects(f.run(), /paths and hashes/);
  supplement.file.path = 'upstream-crate/LICENSE';
  supplement.file.url = 'https://raw.githubusercontent.com/example/upstream/main/LICENSE';
  await writeFile(supplement.path, JSON.stringify(supplement.manifest));
  await assert.rejects(f.run(), /fixed-commit/);
});
