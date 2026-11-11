import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  rm,
  symlink,
  readdir,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportSource } from './export-source.mjs';
import { releaseFiles, releaseRoots, privateReleaseValues } from './source-release-policy.mjs';

async function fixture() {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'openbot-source-release-'));
  for (const path of releaseFiles)
    await writeFile(join(sourceRoot, path), 'synthetic public source\n');
  for (const path of releaseRoots) await mkdir(join(sourceRoot, path));
  const put = async (path, value) => {
    const target = join(sourceRoot, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, value);
  };
  await put('desktop/package.json', '{"productName":"BambooShift"}');
  return {
    sourceRoot,
    put,
    output: join(sourceRoot, 'release/source/v1'),
    close: () => rm(sourceRoot, { recursive: true, force: true }),
  };
}
test('source export selects original source without local data, generated files or historical media', async () => {
  const f = await fixture();
  try {
    await f.put('web/src/app.ts', 'export const example = true;\n');
    await f.put('mobile/tool/flutter.sh', '#!/bin/sh\nexit 0\n');
    await chmod(join(f.sourceRoot, 'mobile/tool/flutter.sh'), 0o755);
    await f.put('data/platform/operator-setup-code', 'SYNTHETIC_CODE_MUST_NOT_BE_READ');
    await f.put('config/private/server.private.json', 'PRIVATE_CONFIG');
    await f.put('server/api/target/debug/synthetic', 'BUILD_CACHE');
    await f.put('mobile/ios/Flutter/Generated.xcconfig', 'LOCAL_TOOLCHAIN');
    await f.put('mobile/android/key.properties', 'SIGNING_CONFIGURATION');
    const generated = [
      'mobile/android/gradlew',
      'mobile/android/gradlew.bat',
      'mobile/android/gradle/wrapper/gradle-wrapper.jar',
      'mobile/openbot_mobile.iml',
      'web/src/tsconfig.tsbuildinfo',
    ];
    for (const path of generated) await f.put(path, 'LOCAL_TOOLCHAIN');
    await f.put('mobile/android/gradle/wrapper/gradle-wrapper.properties', 'PUBLIC_TOOLCHAIN');
    await f.put('mobile/android/app/release.jks', 'SIGNING_BINARY');
    await f.put('mobile/ios/distribution.p12', 'SIGNING_CERTIFICATE');
    await f.put('docs/screenshots/history.png', 'OLD_MEDIA');
    await f.put('docs/evidence/private-peer.png', 'UNREVIEWED_MEDIA');
    const reviewedMedia = ['docs/demo/avatar-themes.gif', 'docs/evidence/gui/reference-settings-en.png'];
    const unreviewedMedia = ['docs/demo/extra.GIF', 'docs/evidence/gui/current-desktop.png'];
    for (const path of reviewedMedia) await f.put(path, 'REVIEWED_SYNTHETIC_MEDIA');
    for (const path of unreviewedMedia) await f.put(path, 'UNREVIEWED_MEDIA');
    const result = await exportSource({ ...f, privateValues: [] });
    const bytes = await readFile(join(f.output, 'source-manifest.json'));
    const manifest = JSON.parse(bytes);
    const paths = manifest.files.map((file) => file.path);
    assert.ok(paths.includes('web/src/app.ts'));
    assert.equal((await lstat(join(f.output, 'mobile/tool/flutter.sh'))).mode & 0o777, 0o755);
    for (const path of reviewedMedia) assert.ok(paths.includes(path));
    for (const path of unreviewedMedia) assert.ok(!paths.includes(path));
    assert.ok(paths.includes('mobile/android/gradle/wrapper/gradle-wrapper.properties'));
    for (const path of generated) assert.ok(!paths.includes(path));
    assert.ok(
      !paths.some((path) =>
        /^(data|config)\/|\/target\/|Generated.xcconfig|key\.properties|\.jks$|\.p12$|screenshots|private-peer/.test(
          path,
        ),
      ),
    );
    assert.equal(manifest.name, 'BambooShift');
    assert.equal(manifest.license, 'MIT');
    assert.equal(result.manifestSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.files, paths.length);
    for (const file of manifest.files)
      assert.equal(
        file.sha256,
        createHash('sha256')
          .update(await readFile(join(f.output, file.path)))
          .digest('hex'),
      );
    await assert.rejects(exportSource({ ...f, privateValues: [] }), /already exists/);
  } finally {
    await f.close();
  }
});
test('source export retains playable showcase files and excludes unrelated showcase content', async () => {
  const f = await fixture();
  try {
    const playable = [
      'docs/showcase/index.html',
      'docs/showcase/panda.svg',
      'docs/showcase/showcase.css',
      'docs/showcase/zh.html',
      ...['en', 'zh'].flatMap((lang) =>
        ['index.html', 'assets/flight.css', 'assets/ship.svg', 'src/flight.mjs', 'src/physics.mjs'].map(
          (file) => 'docs/showcase/' + lang + '/' + file,
        ),
      ),
    ];
    for (const path of playable) await f.put(path, 'PUBLIC SHOWCASE');
    await f.put('docs/showcase/internal.md', 'UNREVIEWED DOCUMENT');
    await f.put('docs/showcase/en/src/extra.mjs', 'UNREVIEWED CODE');
    await exportSource({ ...f, privateValues: [] });
    const manifest = JSON.parse(await readFile(join(f.output, 'source-manifest.json'), 'utf8'));
    assert.deepEqual(
      manifest.files.map(({ path }) => path).filter((path) => path.startsWith('docs/showcase/')),
      playable.sort(),
    );
  } finally {
    await f.close();
  }
});
test('private UUID credentials stop publication without echoing their value or reading account codes', async () => {
  const f = await fixture();
  const credential = [
    'f'.repeat(8),
    'a'.repeat(4),
    'b'.repeat(4),
    'c'.repeat(4),
    'd'.repeat(12),
  ].join('-');
  try {
    const workspace = '11111111-1111-4111-8111-111111111111';
    await f.put(
      `data/spaces/${workspace}/config/models.private.json`,
      JSON.stringify({ entries: { model: { apiKey: credential } } }),
    );
    await f.put('data/platform/operator-setup-code', 'NEVER_INSPECT_THIS_FILE');
    await f.put('web/src/leak.ts', `export const leaked = '${credential}';\n`);
    const values = await privateReleaseValues(f.sourceRoot);
    assert.ok(values.includes(credential));
    await assert.rejects(exportSource(f), (error) => {
      assert.ok(!JSON.stringify(error).includes(credential));
      assert.deepEqual(error.findings, [{ path: 'web/src/leak.ts', line: 1, rule: 'private-value' }]);
      return true;
    });
    await assert.rejects(lstat(f.output), { code: 'ENOENT' });
    assert.ok(
      !(await readdir(join(f.sourceRoot, 'release/source'))).some((name) =>
        name.startsWith('.openbot-source-'),
      ),
    );
  } finally {
    await f.close();
  }
});
test('export rejects a deployed IP, account email, and a non-default loopback port', async () => {
  const f = await fixture();
  const privateIp = '10.187.219.52';
  const accountEmail = 'operator@private-fixture.test';
  const loopbackEndpoint = '127.0.0.1:61942';
  try {
    await f.put(
      'config/private/operator.json',
      JSON.stringify({ host: privateIp, email: accountEmail }),
    );
    await f.put(
      'data/computer/cloud.json',
      JSON.stringify({ workerUrl: 'http://' + loopbackEndpoint }),
    );
    await f.put(
      'docs/run.md',
      [
        privateIp,
        accountEmail,
        loopbackEndpoint,
        'A generic product example uses 127.0.0.1:3001.',
      ].join('\n'),
    );
    await assert.rejects(exportSource(f), (error) => {
      for (const privateValue of [privateIp, accountEmail, loopbackEndpoint])
        assert.ok(!JSON.stringify(error).includes(privateValue));
      assert.deepEqual(
        error.findings,
        [1, 2, 3].map((line) => ({
          path: 'docs/run.md',
          line,
          rule: 'private-value',
        })),
      );
      return true;
    });
  } finally {
    await f.close();
  }
});
test('source and output links are rejected while private directories are never traversed', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.sourceRoot, 'web/src'));
    await symlink(join(f.sourceRoot, 'data'), join(f.sourceRoot, 'web/src/escape'));
    await assert.rejects(exportSource({ ...f, privateValues: [] }), /symbolic link/);
    await rm(join(f.sourceRoot, 'web/src/escape'));
    await mkdir(join(f.sourceRoot, 'data'));
    await symlink(join(f.sourceRoot, 'web/src'), join(f.sourceRoot, 'data/ignored-link'));
    await rm(join(f.sourceRoot, 'release'), { recursive: true });
    await symlink(join(f.sourceRoot, 'data'), join(f.sourceRoot, 'release'));
    await assert.rejects(exportSource({ ...f, privateValues: [] }), /traverse a link/);
  } finally {
    await f.close();
  }
});
