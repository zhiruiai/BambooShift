import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveMacSigningProfile,
  macSigningDirectory,
  certificateRequirement,
  verifyStableMacSignature,
} from './macos-signing-profile.mjs';
import { signLocalMacClient } from './macos-signing.mjs';
import { buildMacAccessibilityHelper } from './macos-accessibility-helper.mjs';

const profile = {
  version: 1,
  kind: 'local',
  identity: 'A'.repeat(40),
  certificateSha256: 'b'.repeat(64),
  commonName: 'Synthetic BambooShift signing identity',
  bundleId: 'com.openbot.client',
};
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'bambooshift-signing-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function resolveTestProfile(options) {
  return resolveMacSigningProfile({
    signingDirectory: join(options.sourceRoot, 'user-signing'),
    environment: {},
    inspectExisting: async () => false,
    ...options,
  });
}
async function save(root, value = profile, { canonical = false } = {}) {
  const directory = join(root, canonical ? 'user-signing' : '.local/macos-signing');
  const path = join(directory, 'identity.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

test('an absent default profile permits preview signing; configured missing or invalid profiles never downgrade', async (t) => {
  const sourceRoot = await directory(t);
  const inspect = async () => {};
  assert.equal(await resolveTestProfile({ sourceRoot, inspect }), undefined);
  await assert.rejects(
    resolveTestProfile({
      sourceRoot,
      profilePath: join(sourceRoot, 'missing.json'),
      inspect,
    }),
  );
  const path = await save(sourceRoot);
  const restored = await resolveTestProfile({ sourceRoot, inspect });
  assert.deepEqual(restored, profile);
  assert.ok(Object.isFrozen(restored));
  await assert.rejects(
    resolveTestProfile({
      sourceRoot,
      inspect: async () => {
        throw Error('private identity missing');
      },
    }),
    /private identity missing/,
  );
  for (const invalid of [
    { ...profile, identity: '-' },
    { ...profile, identity: '"; arbitrary' },
    { ...profile, certificateSha256: '' },
    { ...profile, bundleId: 'foreign.app' },
    { ...profile, commonName: 'unexpected\nvalue' },
    { ...profile, key: 'unexpected private material' },
  ]) {
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(resolveTestProfile({ sourceRoot, inspect }));
  }
  await rm(path);
  await assert.rejects(resolveTestProfile({ sourceRoot, inspect }));
});

test('signing identity metadata must be private, owned ordinary files', async (t) => {
  const sourceRoot = await directory(t);
  const path = await save(sourceRoot);
  const inspect = async () => {};
  await chmod(path, 0o644);
  await assert.rejects(resolveTestProfile({ sourceRoot, inspect }));
  await chmod(path, 0o600);
  await chmod(join(sourceRoot, '.local/macos-signing'), 0o755);
  await assert.rejects(resolveTestProfile({ sourceRoot, inspect }));
  await chmod(join(sourceRoot, '.local/macos-signing'), 0o700);
  await rm(path);
  const elsewhere = join(sourceRoot, 'elsewhere.json');
  await writeFile(elsewhere, JSON.stringify(profile), { mode: 0o600 });
  await symlink(elsewhere, path);
  await assert.rejects(resolveTestProfile({ sourceRoot, inspect }));
});

test('user signing identity follows new checkouts and takes precedence over legacy profiles', async (t) => {
  const home = await directory(t),
    checkout = await directory(t),
    worktree = await directory(t);
  const signingDirectory = macSigningDirectory({ home });
  assert.equal(
    signingDirectory,
    join(home, 'Library/Application Support/BambooShift/build-signing'),
  );
  await mkdir(signingDirectory, { recursive: true, mode: 0o700 });
  const profilePath = join(signingDirectory, 'identity.json');
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const inspect = async () => {};
  for (const sourceRoot of [checkout, worktree]) {
    await save(sourceRoot, { ...profile, identity: 'C'.repeat(40) });
    assert.deepEqual(await resolveTestProfile({ sourceRoot, signingDirectory, inspect }), profile);
  }
  await writeFile(profilePath, 'invalid JSON');
  await assert.rejects(resolveTestProfile({ sourceRoot: checkout, signingDirectory, inspect }));
  await rm(profilePath);
  await assert.rejects(resolveTestProfile({ sourceRoot: checkout, signingDirectory, inspect }));
});

test('missing metadata cannot downgrade an existing keychain identity to an ad-hoc preview', async (t) => {
  const sourceRoot = await directory(t);
  await assert.rejects(
    resolveTestProfile({
      sourceRoot,
      inspectExisting: async () => true,
    }),
    /钥匙串中已有/,
  );
  const path = await save(sourceRoot, profile, { canonical: true });
  const inspect = async () => {};
  assert.deepEqual(await resolveTestProfile({ sourceRoot, inspect }), profile);
  await assert.rejects(
    resolveTestProfile({
      sourceRoot,
      inspect,
      profilePath: join(sourceRoot, 'missing-explicit.json'),
    }),
  );
  assert.deepEqual(await resolveTestProfile({ sourceRoot, inspect, profilePath: path }), profile);
});

test('valid certificate bytes alone cannot hide an update-unstable or overbroad embedded identity', async () => {
  const requirement = certificateRequirement(profile);
  const calls = [];
  const command = async (...args) => {
    calls.push(args);
  };
  const verify = (value) =>
    verifyStableMacSignature('/synthetic.app', profile, {
      command,
      readRequirements: async () => value,
    });
  await verify(`Executable=/synthetic.app\ndesignated => ${requirement}\n`);
  assert.deepEqual(calls[0][1], [
    '--verify',
    '--strict',
    '-R',
    '=' + requirement,
    '/synthetic.app',
  ]);
  await verify(`designated => ${requirement.replace('A'.repeat(40), 'a'.repeat(40))}`);
  for (const value of [
    'designated => identifier "com.openbot.client"',
    'designated => cdhash H"' + 'a'.repeat(40) + '"',
    'designated => ' + requirement + ' or true',
    'designated => ' + requirement.replace('com.openbot.client', 'foreign.app'),
    'designated => ' + requirement.replace('A'.repeat(40), 'C'.repeat(40)),
  ])
    await assert.rejects(verify(value));
});

test('stable app signing binds main/helper to one certificate without assigning main identity to nested code', async (t) => {
  const working = await directory(t);
  const app = join(working, 'BambooShift.app');
  const helper = join(app, 'Contents/Resources/bambooshift-runtime/bin/OpenBot Desktop Helper.app');
  let options;
  const commands = [];
  await signLocalMacClient({
    app,
    working,
    electronVersion: '45.2.1',
    signingProfile: profile,
    bundledRuntime: { accessibilityHelper: 'synthetic' },
    command: async (...args) => {
      commands.push(args);
    },
    readRequirements: async (path) =>
      'designated => ' +
      certificateRequirement(
        profile,
        path === helper ? 'com.openbot.desktop-helper' : 'com.openbot.client',
      ),
    sign: async (value) => {
      options = value;
    },
  });
  assert.equal(options.identity, profile.identity);
  assert.equal(options.identityValidation, false);
  assert.equal(options.ignore(helper), true);
  assert.equal(options.ignore(join(helper, 'Contents/MacOS/helper')), true);
  assert.equal(options.ignore(app), false);
  assert.equal(
    options.optionsForFile(app).requirements,
    '=designated => ' + certificateRequirement(profile),
  );
  assert.equal(
    options.optionsForFile(join(app, 'Contents/Frameworks/Electron Framework.framework'))
      .requirements,
    undefined,
  );
  assert.equal(options.optionsForFile(app).hardenedRuntime, true);
  assert.ok(commands.some(([, args]) => args.includes('--deep')));
  assert.match(await readFile(join(working, 'client-entitlements.plist'), 'utf8'), /allow-jit/);
  let invoked = false;
  await assert.rejects(
    signLocalMacClient({
      app,
      working,
      signingProfile: profile,
      bundledRuntime: { accessibilityHelper: 'synthetic' },
      command: async () => {},
      readRequirements: async () => 'designated => cdhash H"old"',
      sign: async () => {
        invoked = true;
      },
    }),
  );
  assert.equal(invoked, false, 'A stale helper must fail before the outer app is signed');
});

test('unconfigured preview signing remains explicitly ad-hoc', async (t) => {
  const working = await directory(t);
  let options;
  await signLocalMacClient({
    app: join(working, 'Preview.app'),
    working,
    resolveProfile: async () => undefined,
    command: async () => {},
    sign: async (value) => {
      options = value;
    },
  });
  assert.equal(options.identity, '-');
  assert.equal(options.optionsForFile(options.app).requirements, undefined);
});

test(
  'native helper uses the same persisted certificate and its own bundle requirement',
  {
    skip: process.platform !== 'darwin',
  },
  async (t) => {
    const sourceRoot = await directory(t);
    const output = join(sourceRoot, 'built');
    await mkdir(join(sourceRoot, 'server/native/macos'), { recursive: true });
    await writeFile(join(sourceRoot, 'server/native/macos/Info.plist'), '<plist/>');
    const calls = [];
    await buildMacAccessibilityHelper({
      sourceRoot,
      output,
      signingProfile: profile,
      readRequirements: async () =>
        'designated => ' + certificateRequirement(profile, 'com.openbot.desktop-helper'),
      command: async (program, args) => {
        calls.push([program, args]);
        if (program === '/usr/bin/xcrun') {
          const header = Buffer.alloc(64);
          header.writeUInt32LE(0xfeedfacf, 0);
          header.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
          header.writeUInt32LE(2, 12);
          await writeFile(args[args.indexOf('-o') + 1], header, { mode: 0o755 });
        }
      },
    });
    const signing = calls.find(([, args]) => args.includes('--sign'))[1];
    assert.equal(signing[signing.indexOf('--sign') + 1], profile.identity);
    assert.equal(
      signing[signing.indexOf('--requirements') + 1],
      '=designated => ' + certificateRequirement(profile, 'com.openbot.desktop-helper'),
    );
  },
);
