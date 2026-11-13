import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { nativeDistributionFixture } from './fixtures/native-runtime.mjs';
import { nativeSourceSupportPaths } from './native-runtime-distribution.mjs';
import {
  stageNativeRuntimeOverlay,
  verifyStagedNativeRuntimeOverlay,
} from './native-runtime-overlay.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const legal = 'legal/third-party/sharp-libvips-1.3.4';

async function overlayFixture(t) {
  const f = await nativeDistributionFixture(t);
  const output = join(f.root, 'runtime-package');
  const pkg = 'runtime/node_modules/@img/sharp-libvips-darwin-arm64';
  const addon = 'runtime/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.5.node';
  const original = Buffer.from('Original reviewed synthetic official library');
  const addonBytes = Buffer.from('Unchanged synthetic native addon');
  const write = async (path, bytes) => {
    await mkdir(join(output, path, '..'), { recursive: true });
    await writeFile(
      join(output, path),
      typeof bytes === 'object' && !Buffer.isBuffer(bytes) ? JSON.stringify(bytes) : bytes,
    );
  };
  await write(`${pkg}/lib/libvips-cpp.8.18.7.dylib`, original);
  await write(`${pkg}/versions.json`, { vips: '8.18.7', rsvg: '2.63.2' });
  await write(`${pkg}/package.json`, { name: '@img/sharp-libvips-darwin-arm64', version: '1.3.4' });
  await write(`${pkg}/README.md`, 'Original upstream package description');
  await write(`${pkg}/lib/index.js`, 'module.exports = __dirname;');
  await write(`${pkg}/lib/glib-2.0/include/glibconfig.h`, 'Original header');
  await write(addon, addonBytes);
  const npm = {
    name: '@img/sharp-libvips-darwin-arm64',
    version: '1.3.4',
    integrity: 'sha512-c3ludGhldGlj',
  };
  await write('runtime/package-lock.json', { packages: { [pkg.slice(8)]: npm } });
  const candidate = {
    platform: 'darwin-arm64',
    status: 'local-candidate-only',
    candidate: { distributionManifestSha256: f.pin() },
    abi: { unchangedOriginalAddonSha256: digest(addonBytes) },
  };
  await writeFile(join(f.root, legal, 'CANDIDATE-DARWIN-ARM64.json'), JSON.stringify(candidate));
  await writeFile(join(f.root, legal, 'DISTRIBUTION.json'), JSON.stringify({ packages: [npm] }));
  const retainedFileSha256 = {};
  for (const path of [
    'package.json',
    'README.md',
    'lib/index.js',
    'lib/glib-2.0/include/glibconfig.h',
    'versions.json',
  ])
    retainedFileSha256[path] = digest(await readFile(join(output, pkg, path)));
  await writeFile(
    join(f.root, legal, 'BINARY-EVIDENCE.json'),
    JSON.stringify({
      retainedFileSha256,
      package: { name: npm.name, version: npm.version },
      binaryPath: `${pkg.slice(8)}/lib/libvips-cpp.8.18.7.dylib`,
      binarySha256: digest(original),
    }),
  );
  return {
    ...f,
    output,
    pkg,
    addon,
    original,
    write,
    stage: (options = {}) =>
      stageNativeRuntimeOverlay({
        sourceRoot: f.root,
        output,
        artifactsDirectory: f.artifacts,
        platform: 'darwin',
        arch: 'arm64',
        ...options,
      }),
    check: () => verifyStagedNativeRuntimeOverlay({ sourceRoot: f.root, output }),
  };
}

async function reviewedSupport(f) {
  const manifest = JSON.parse(await readFile(join(f.artifacts, 'distribution.json')));
  const path = join(f.root, legal, 'CANDIDATE-DARWIN-ARM64.json');
  const candidate = JSON.parse(await readFile(path));
  candidate.candidate.correspondingSource = { sha256: manifest.source.sha256 };
  await writeFile(path, JSON.stringify(candidate));
  return {
    schemaVersion: 1,
    distributionManifestSha256: f.pin(),
    sourceArchiveSha256: manifest.source.sha256,
    sourceCommit: 'e'.repeat(40),
    files: await Promise.all(
      nativeSourceSupportPaths.map(async (path) => ({
        path,
        sha256: digest(await readFile(join(f.source, path))),
      })),
    ),
  };
}

test('a repository-reviewed support inventory preserves the exact older candidate after builder changes', async (t) => {
  const f = await overlayFixture(t);
  const support = await reviewedSupport(f);
  await writeFile(join(f.root, legal, 'CANDIDATE-SOURCE-SUPPORT.json'), JSON.stringify(support));
  await writeFile(
    join(f.root, 'scripts/desktop/native-codecs/build.mjs'),
    'New reviewed build implementation',
  );
  await assert.rejects(f.verify(), /missing or changed a required build input/);
  const result = await f.stage();
  assert.equal(result.releaseApproval, false);
  assert.equal((await f.check()).releaseApproval, false);
});

test('candidate artifacts cannot supply their own source support exemption', async (t) => {
  const f = await overlayFixture(t);
  await writeFile(
    join(f.artifacts, 'CANDIDATE-SOURCE-SUPPORT.json'),
    JSON.stringify(await reviewedSupport(f)),
  );
  await writeFile(
    join(f.root, 'scripts/desktop/native-codecs/build.mjs'),
    'Different checkout support',
  );
  await assert.rejects(f.stage(), /missing or changed a required build input/);
  assert.deepEqual(
    await readFile(join(f.output, f.pkg, 'lib/libvips-cpp.8.18.7.dylib')),
    f.original,
  );
});

test('reviewed source support cannot cover another distribution, source archive or changed source file', async (t) => {
  for (const mutation of ['distribution', 'archive', 'member', 'missing']) {
    const f = await overlayFixture(t);
    const support = await reviewedSupport(f);
    if (mutation === 'distribution') support.distributionManifestSha256 = '0'.repeat(64);
    if (mutation === 'archive') support.sourceArchiveSha256 = '0'.repeat(64);
    if (mutation === 'member') support.files[0].sha256 = '0'.repeat(64);
    if (mutation === 'missing') support.files.pop();
    await writeFile(join(f.root, legal, 'CANDIDATE-SOURCE-SUPPORT.json'), JSON.stringify(support));
    await assert.rejects(
      f.stage(),
      /Reviewed source support|missing or changed a required build input/,
    );
    assert.deepEqual(
      await readFile(join(f.output, f.pkg, 'lib/libvips-cpp.8.18.7.dylib')),
      f.original,
    );
  }
});

test('candidate overlay keeps source and notices, replaces only library/versions and preserves addon', async (t) => {
  const f = await overlayFixture(t);
  const result = await f.stage();
  assert.equal(result.releaseApproval, false);
  assert.equal(result.npmPackage, '@img/sharp-libvips-darwin-arm64');
  const record = JSON.parse(await readFile(join(f.output, result.manifestPath)));
  assert.equal(record.inventoryScope, 'before-desktop-code-signing');
  assert.equal(record.replacements.length, 2);
  for (const replacement of record.replacements) {
    assert.equal((await readlink(join(f.output, replacement.path))).startsWith('/'), false);
    assert.equal(digest(await readFile(join(f.output, replacement.path))), replacement.sha256);
  }
  assert.equal(JSON.parse(await readFile(join(f.output, f.pkg, 'versions.json'))).rsvg, undefined);
  assert.deepEqual(
    await readFile(join(f.output, result.sourceArtifactPath)),
    await readFile(join(f.artifacts, 'source.tar.gz')),
  );
  assert.equal(
    await readFile(join(f.output, result.wrapperLicensePath), 'utf8'),
    'Synthetic complete Apache wrapper license',
  );
  assert.equal(
    record.originalFiles.find((file) => file.path.endsWith('glibconfig.h')).sha256,
    digest(await readFile(join(f.output, f.pkg, 'lib/glib-2.0/include/glibconfig.h'))),
  );
  for (const [path, bytes] of f.originals)
    assert.deepEqual(await readFile(join(f.output, result.noticesPath, 'synthetic', path)), bytes);
  await assert.rejects(f.stage(), /links or special files|already exists/);
});

test('wrong target, altered lock, missing addon and unexpected native input never install overlay', async (t) => {
  const target = await overlayFixture(t);
  await assert.rejects(target.stage({ platform: 'linux' }), /darwin-arm64/);
  const lock = await overlayFixture(t);
  await lock.write('runtime/package-lock.json', { packages: {} });
  await assert.rejects(lock.stage(), /reviewed npm lock/);
  const addon = await overlayFixture(t);
  await addon.write(addon.addon, 'tampered addon');
  await assert.rejects(addon.stage(), /reviewed hash/);
  const extra = await overlayFixture(t);
  await extra.write(`${extra.pkg}/lib/unknown.dylib`, 'unknown');
  await assert.rejects(extra.stage(), /unexpected file/);
});

test('tampered distribution and incomplete corresponding source leave original package untouched', async (t) => {
  const f = await overlayFixture(t);
  await writeFile(join(f.artifacts, 'source.tar.gz'), 'damaged');
  await assert.rejects(f.stage(), /checksum differs/);
  assert.deepEqual(
    await readFile(join(f.output, f.pkg, 'lib/libvips-cpp.8.18.7.dylib')),
    f.original,
  );
  assert.equal(
    (await readdir(join(f.output, 'runtime'))).some((name) => name.includes('native')),
    false,
  );
});

test('rechecking stage rejects changed legal bytes, escaping replacement links and addon changes', async (t) => {
  for (const mutation of ['legal', 'link', 'addon', 'inventory']) {
    const f = await overlayFixture(t);
    const result = await f.stage();
    if (mutation === 'legal')
      await writeFile(join(f.output, result.wrapperLicensePath), 'missing original notice');
    if (mutation === 'link') {
      const path = join(f.output, f.pkg, 'versions.json');
      await rm(path);
      await symlink('/tmp/other-library', path);
    }
    if (mutation === 'addon') await f.write(f.addon, 'different addon');
    if (mutation === 'inventory') {
      const path = join(f.output, result.manifestPath);
      const record = JSON.parse(await readFile(path));
      record.files.pop();
      await writeFile(path, JSON.stringify(record));
    }
    await assert.rejects(f.check(), /changed|contained relative link|inventory is incomplete/);
  }
});

test(
  'failure replacing the second link restores the first original file',
  {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async (t) => {
    const f = await overlayFixture(t);
    await chmod(join(f.output, f.pkg, 'lib/libvips-cpp.8.18.7.dylib'), 0o755);
    // The library directory stays writable; its parent denies the later versions link.
    await chmod(join(f.output, f.pkg), 0o555);
    try {
      await assert.rejects(f.stage(), /EACCES|EPERM/);
    } finally {
      await chmod(join(f.output, f.pkg), 0o755);
    }
    const path = join(f.output, f.pkg, 'lib/libvips-cpp.8.18.7.dylib');
    assert.equal((await lstat(path)).isFile(), true);
    assert.equal((await lstat(path)).mode & 0o777, 0o755);
    assert.deepEqual(await readFile(path), f.original);
    assert.equal((await lstat(join(f.output, f.pkg, 'versions.json'))).isFile(), true);
    assert.equal(
      (await readdir(join(f.output, 'runtime'))).some((name) => name.includes('native')),
      false,
    );
  },
);

test('a modified record cannot hide omitted retained headers or unlisted native material', async (t) => {
  for (const kind of ['header', 'extra']) {
    const f = await overlayFixture(t);
    const result = await f.stage();
    const path = join(f.output, result.manifestPath);
    const record = JSON.parse(await readFile(path));
    if (kind === 'header') {
      const header = `${f.pkg}/lib/glib-2.0/include/glibconfig.h`;
      await rm(join(f.output, header));
      record.originalFiles = record.originalFiles.filter((file) => file.path !== header);
      await writeFile(path, JSON.stringify(record));
    } else {
      await writeFile(join(f.output, result.noticesPath, 'undocumented.dylib'), 'unlisted');
    }
    await assert.rejects(f.check(), /inventory is incomplete|unexpected file/);
  }
});
