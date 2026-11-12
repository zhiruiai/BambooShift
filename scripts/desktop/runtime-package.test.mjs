import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseClientArguments } from './options.mjs';
import { verifyNodeArchive, nodeArtifact } from './node-runtime.mjs';
import { stageDesktopRuntime } from './runtime-package.mjs';
import { stageCuaDriver } from './cua-driver.mjs';

async function fakeBackend({ output }, { inventory = true, binaryArch = process.arch } = {}) {
  await mkdir(join(output, 'runtime'), { recursive: true });
  await writeFile(join(output, 'runtime/package-lock.json'), '{"lockfileVersion":3}');
  const header = Buffer.alloc(64);
  if (process.platform === 'darwin') {
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(binaryArch === 'arm64' ? 0x0100000c : 0x01000007, 4);
    header.writeUInt32LE(2, 12);
  } else {
    header.set([127, 69, 76, 70, 2, 1, 1]);
    header.writeUInt16LE(3, 16);
    header.writeUInt16LE(binaryArch === 'arm64' ? 183 : 62, 18);
    header.writeUInt32LE(1, 20);
  }
  for (const name of ['openbot-backend', 'openbot-image-worker'])
    await writeFile(join(output, name), header, { mode: 0o755 });
  if (inventory)
    await writeFile(
      join(output, 'package-manifest.json'),
      JSON.stringify({
        version: 1,
        platform: process.platform,
        architecture: process.arch,
        files: [],
      }),
    );
}

test('an unverified native driver archive never reaches extraction or execution', async () => {
  await assert.rejects(
    stageCuaDriver({
      platform: 'darwin',
      output: '/unused',
      sourceRoot: '/unused',
      fetchBytes: async () => Buffer.from('tampered'),
      command: async () => assert.fail('must not execute'),
    }),
    /checksum/,
  );
  assert.deepEqual(await stageCuaDriver({ platform: 'linux' }), { hostControl: false });
});

test('a bundled service can only be built on the supported target architecture', () => {
  const host = { platform: 'darwin', arch: 'arm64' };
  assert.equal(parseClientArguments(['--with-runtime'], host).withRuntime, true);
  assert.equal(parseClientArguments(['--platform', 'win32'], host).withRuntime, false);
  assert.throws(() => parseClientArguments(['--with-runtime', '--platform', 'win32'], host));
  assert.throws(() => parseClientArguments(['--with-runtime', '--arch', 'x64'], host));
  assert.throws(() => parseClientArguments(['--with-runtime=false'], host));
  assert.throws(() => nodeArtifact('../../escape', 'darwin', 'arm64'));
});

test('Node archive verification binds bytes to the exact target filename', () => {
  const bytes = Buffer.from('synthetic verified distribution');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const name = 'node-v24.0.0-darwin-arm64.tar.gz';
  assert.equal(verifyNodeArchive(bytes, `${digest}  ${name}\n`, name), digest);
  assert.throws(() => verifyNodeArchive(Buffer.from('tampered'), `${digest}  ${name}`, name));
  assert.throws(() => verifyNodeArchive(bytes, `${digest}  other.tar.gz`, name));
});

test(
  'bundling installs the production lock and carries no local workspace or host path',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bambooshift-runtime-test-'));
    const output = join(directory, 'bambooshift-runtime');
    const calls = [];
    try {
      await writeFile(join(directory, 'private-secret.txt'), 'SYNTHETIC_PRIVATE_VALUE');
      const manifest = await stageDesktopRuntime({
        output,
        stageDriver: async () => ({ hostControl: false }),
        buildRuntimeNotices: async () => {},
        command: async (...args) => calls.push(args),
        buildBackend: fakeBackend,
        stageNode: async () => ({
          nodeVersion: '24.0.0',
          preSignNodeSha256: 'a'.repeat(64),
          nodeArchiveSha256: 'b'.repeat(64),
        }),
      });
      assert.deepEqual(calls[1][1], [
        'ci',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ]);
      assert.equal(calls[1][2], join(output, 'runtime'));
      assert.deepEqual(calls[2][1], ['--version']);
      assert.equal(manifest.server, 'openbot-backend');
      const text = await readFile(join(output, 'desktop-runtime.json'), 'utf8');
      assert.equal(text.includes(directory), false);
      assert.equal(text.includes('SYNTHETIC_PRIVATE_VALUE'), false);
      const inventory = JSON.parse(await readFile(join(output, 'package-manifest.json'), 'utf8'));
      assert.equal(
        inventory.inventoryScope,
        'backend-inputs-before-desktop-dependencies-and-signing',
      );
      assert.deepEqual((await readdir(output)).sort(), [
        'desktop-runtime.json',
        'openbot-backend',
        'openbot-image-worker',
        'package-manifest.json',
        'runtime',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'bundled runtime rejects missing inventories and foreign Rust executables before installing dependencies',
  { skip: process.platform === 'win32' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-target-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const [name, options] of [
      ['missing-inventory', { inventory: false }],
      ['foreign-architecture', { binaryArch: process.arch === 'arm64' ? 'x64' : 'arm64' }],
    ]) {
      const calls = [];
      await assert.rejects(
        stageDesktopRuntime({
          output: join(directory, name),
          buildBackend: (configuration) => fakeBackend(configuration, options),
          command: async (...args) => calls.push(args),
          stageNode: async () => assert.fail('must not download runtimes'),
        }),
      );
      assert.deepEqual(
        calls.map((call) => call[1]),
        [['run', 'build:web']],
      );
    }
  },
);
