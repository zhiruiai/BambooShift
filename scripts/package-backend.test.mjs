import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageBackend, copyPublicWeb } from './package-backend.mjs';

test('service assembly includes exactly two binaries and public assets without source, private data or migration utilities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-package-test-'));
  const calls = [];
  try {
    const sourceRoot = join(directory, 'source');
    await mkdir(join(sourceRoot, 'desktop'), { recursive: true });
    await writeFile(join(sourceRoot, 'desktop', 'package.json'), '{"productName":"BambooShift"}');
    await writeFile(join(sourceRoot, 'LICENSE'), 'Synthetic project license');
    await writeFile(join(sourceRoot, 'NOTICE'), 'Synthetic OpenBot notice');
    await writeFile(join(sourceRoot, 'THIRD_PARTY.md'), 'Synthetic dependency licensing guide');
    await mkdir(join(sourceRoot, 'dist/assets'), { recursive: true });
    await writeFile(join(sourceRoot, 'dist/index.html'), '<html>Synthetic UI</html>');
    await writeFile(join(sourceRoot, 'dist/assets/app.js'), 'export const synthetic = true;');
    await mkdir(join(sourceRoot, 'operations-dist/assets'), { recursive: true });
    await writeFile(
      join(sourceRoot, 'operations-dist/index.html'),
      '<html>Synthetic operations</html>',
    );
    await writeFile(
      join(sourceRoot, 'operations-dist/assets/app.js'),
      'export const operations = true;',
    );
    await mkdir(join(sourceRoot, 'server/api/deployment'), { recursive: true });
    await writeFile(
      join(sourceRoot, 'server/api/deployment/server.example.json'),
      '{"dataDir":"PLACEHOLDER"}',
    );
    await writeFile(
      join(sourceRoot, 'server/api/deployment/README.md'),
      'Synthetic deployment guide',
    );
    for (const name of ['openbot-backend', 'openbot-image-worker', 'openbot-migration-probe'])
      await writeFile(join(directory, name), name);
    await mkdir(join(sourceRoot, 'data'));
    await writeFile(join(sourceRoot, 'data/synthetic.private.json'), 'MUST_NOT_COPY');
    const output = join(directory, 'release');
    const result = await packageBackend({
      output,
      sourceRoot,
      release: true,
      compile: async (...args) => calls.push(args),
      binaryPath: (name) => join(directory, name),
      build: async (runtime) => {
        await mkdir(runtime);
        await writeFile(join(runtime, 'package.json'), '{}');
      },
      buildNotices: async ({ output }) => {
        await mkdir(output);
        await writeFile(join(output, 'index.json'), '{"synthetic":true}');
      },
    });
    assert.deepEqual(calls, [
      ['build', ['--bin', 'openbot-backend', '--bin', 'openbot-image-worker', '--release']],
    ]);
    assert.equal(result.profile, 'release');
    const manifest = JSON.parse(await readFile(join(output, 'package-manifest.json'), 'utf8'));
    assert.equal(manifest.productName, 'BambooShift');
    assert.deepEqual(
      manifest.files.filter((file) => file.path.startsWith('openbot-')).map((f) => f.path),
      ['openbot-backend', 'openbot-image-worker'],
    );
    assert.ok(
      !manifest.files.some((file) => /private|migration-probe|\/src\/|\/server\//.test(file.path)),
    );
    assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(join(output, 'LICENSE'), 'utf8'), 'Synthetic project license');
    assert.equal(await readFile(join(output, 'NOTICE'), 'utf8'), 'Synthetic OpenBot notice');
    assert.equal(
      JSON.parse(await readFile(join(output, 'third-party/index.json'), 'utf8')).synthetic,
      true,
    );
    assert.equal(
      await readFile(join(output, 'runtime/dist/assets/app.js'), 'utf8'),
      'export const synthetic = true;',
    );
    assert.equal(
      await readFile(join(output, 'runtime/operations-dist/assets/app.js'), 'utf8'),
      'export const operations = true;',
    );
    assert.equal(
      await readFile(join(output, 'runtime/operations-dist/index.html'), 'utf8'),
      '<html>Synthetic operations</html>',
    );
    await assert.rejects(packageBackend({ output }), /already exists/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unexpected private files or links in dist fail assembly and remove its incomplete staging directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-package-private-'));
  try {
    const source = join(directory, 'dist');
    await mkdir(source);
    await writeFile(join(source, '.env'), 'SYNTHETIC_PRIVATE_CONFIGURATION');
    await assert.rejects(copyPublicWeb(source, join(directory, 'target')), /Private or source/);
    await rm(join(source, '.env'));
    await writeFile(join(directory, 'outside.html'), 'SYNTHETIC_PRIVATE_CONTENT');
    await symlink(join(directory, 'outside.html'), join(source, 'index.html'));
    await assert.rejects(copyPublicWeb(source, join(directory, 'target')), /links/);
    await assert.rejects(
      packageBackend({
        output: join(directory, 'release'),
        compile: async () => {
          throw Error('synthetic build failure');
        },
      }),
      /synthetic build failure/,
    );
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith('.openbot-package-')),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
