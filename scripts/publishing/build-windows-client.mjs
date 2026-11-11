import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { desktopProductName } from './package-names.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Use a native Windows x64 runner to build and verify this client.');

const root = resolve(import.meta.dirname, '../..');
const temp = process.env.RUNNER_TEMP;
assert.ok(temp && isAbsolute(temp), 'The Windows build requires a GitHub runner temp directory.');

function run(executable, args, capture = false) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${executable} exited with ${result.status ?? result.signal}.`);
  return result.stdout;
}

run(process.execPath, ['scripts/run.mjs', '--test', 'desktop/*.test.cjs']);
run(process.execPath, [
  'scripts/run.mjs',
  'scripts/package-client.mjs',
  '--platform',
  'win32',
  '--arch',
  'x64',
]);
run(process.execPath, ['scripts/check-windows-client.mjs']);

const clientOutput = join(root, 'release', 'client');
const manifestName = 'manifest-win32-x64.json';
const manifest = JSON.parse(readFileSync(join(clientOutput, manifestName), 'utf8'));
const source = JSON.parse(readFileSync(join(root, 'desktop', 'package.json'), 'utf8'));
const product = desktopProductName(source);
const { version } = source;
assert.equal(manifest.name, product);
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.version, process.env.RELEASE_VERSION ?? version);
assert.equal(manifest.platform, 'win32');
assert.equal(manifest.arch, 'x64');
assert.equal(manifest.serviceIncluded, false);
const tag = `v${version}`;
if (process.env.RELEASE_TAG) assert.equal(process.env.RELEASE_TAG, tag);

const name = `${product}-${tag}-client-windows-x64`;
const assets = join(temp, 'pandamate-assets');
mkdirSync(assets, { recursive: true });
const scratch = mkdtempSync(join(temp, 'pandamate-windows-client-'));
try {
  const bundle = join(scratch, name);
  cpSync(join(clientOutput, product + '-win32-x64'), bundle, { recursive: true });
  copyFileSync(join(clientOutput, manifestName), join(bundle, manifestName));
  const licenses = join(bundle, product + '-licenses');
  mkdirSync(licenses);
  for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY.md'])
    copyFileSync(join(root, file), join(licenses, file));
  const archive = join(assets, `${name}.zip`);
  run('tar.exe', ['-a', '-cf', archive, '-C', scratch, name]);
  const entries = new Set(run('tar.exe', ['-tf', archive], true).split(/\r?\n/));
  for (const entry of [product + '.exe', 'resources/app.asar', manifestName])
    assert.ok(entries.has(`${name}/${entry}`), `The Windows ZIP is missing ${entry}.`);
  console.log(`Verified portable Windows archive: ${name}.zip`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
