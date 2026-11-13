import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeDistribution } from '../native-runtime-distribution.mjs';
import { prepareDesktopDependencies } from '../runtime-dependencies.mjs';
import { addonPath } from '../native-runtime-overlay-inputs.mjs';
import { readNativeArchiveMember, snapshotNativeArtifacts } from '../native-runtime-overlay.mjs';
import { hostedProfile, readToolchainReport } from './toolchain.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const library = 'libvips-cpp.8.18.7.dylib';
const packageName = '@img/sharp-libvips-darwin-arm64';
export const candidateAddonPath = addonPath.slice('runtime/'.length);

export async function exportCandidate(snapshot, manifestBytes, record, output) {
  output = resolve(output);
  const staging = await mkdtemp(join(dirname(output), '.codec-artifacts-'));
  try {
    const manifest = await snapshotNativeArtifacts({
      artifactsDirectory: snapshot,
      stage: staging,
      pin: hash(manifestBytes),
    });
    const files = join(staging, 'distribution');
    await writeFile(join(files, 'CANDIDATE-CI.json'), JSON.stringify(record, null, 2) + '\n', {
      flag: 'wx',
    });
    const names = [
      manifest.binary.filename,
      manifest.source.filename,
      'distribution.json',
      'CANDIDATE-CI.json',
    ];
    await writeFile(
      join(files, 'SHA256SUMS'),
      (
        await Promise.all(
          names.map(async (name) => `${hash(await readFile(join(files, name)))}  ${name}`),
        )
      ).join('\n') + '\n',
      { flag: 'wx' },
    );
    // A reservation prevents replacing an existing candidate directory.
    await mkdir(output, { recursive: false });
    try {
      await rename(files, output);
    } catch (error) {
      await rmdir(output).catch(() => {});
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function contractResult(output) {
  const tests = /^# tests (\d+)$/m.exec(output)?.[1];
  if (
    !tests ||
    Number(tests) < 27 ||
    !/^# fail 0$/m.test(output) ||
    !/^# cancelled 0$/m.test(output) ||
    !/^# skipped 0$/m.test(output)
  )
    throw Error('The complete image contract did not finish successfully.');
  return { tests: Number(tests), failed: 0, cancelled: 0, skipped: 0 };
}

export function candidateRecord({
  manifest,
  manifestSha256,
  verification,
  runtime,
  contract,
  commit,
}) {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    manifest.releaseApproval !== false ||
    manifest.toolchain?.profile !== hostedProfile ||
    verification.manifestSha256 !== manifestSha256 ||
    runtime.actualLoadedLibrarySha256 !== manifest.binary.library.sha256 ||
    runtime.actualLoadedContained !== true ||
    runtime.svgInput !== false ||
    runtime.addonBeforeSha256 !== runtime.addonAfterSha256 ||
    ![runtime.addonAfterSha256, runtime.originalLibrarySha256, runtime.npmLockSha256].every(
      (value) => /^[a-f0-9]{64}$/.test(value),
    ) ||
    !Number.isSafeInteger(contract.tests) ||
    contract.tests < 27 ||
    [contract.failed, contract.cancelled, contract.skipped].some((value) => value !== 0)
  )
    throw Error('Candidate qualification identities do not agree.');
  return {
    schemaVersion: 1,
    status: 'clean-ci-candidate-only',
    sourceCommit: commit,
    target: { platform: 'darwin', arch: 'arm64' },
    distributionManifestSha256: manifestSha256,
    binaryArchiveSha256: manifest.binary.sha256,
    sourceArchiveSha256: manifest.source.sha256,
    librarySha256: runtime.actualLoadedLibrarySha256,
    unchangedAddonSha256: runtime.addonAfterSha256,
    originalLibrarySha256: runtime.originalLibrarySha256,
    npmLockSha256: runtime.npmLockSha256,
    toolchain: readToolchainReport(manifest.toolchain),
    contract: { tests: contract.tests, failed: 0, cancelled: 0, skipped: 0 },
    checks: {
      sourceInventory: true,
      completeNotices: true,
      actualLoadedContained: true,
      svgDisabled: true,
    },
    originalNpmArtifact: false,
    productionDependenciesChanged: false,
    releaseApproval: false,
  };
}

function privateCommand(file, args, { cwd = root, env = {}, timeout = 300_000 } = {}) {
  const safeEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'DEVELOPER_DIR'])
    if (process.env[name]) safeEnv[name] = process.env[name];
  try {
    return execFileSync(file, args, {
      cwd,
      env: { ...safeEnv, ...env },
      timeout,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Upstream diagnostics can include absolute paths. Only the local exit is public.
    throw Error('An isolated candidate check failed; no candidate artifact was exported.');
  }
}

async function runtimeCheck(runtime, manifest) {
  const { buildWorkers } = await import('../../build-workers.mjs');
  await buildWorkers(runtime);
  await prepareDesktopDependencies(runtime, { platform: 'darwin', arch: 'arm64' });
  privateCommand('npm', ['ci', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'], {
    cwd: runtime,
  });
  const npmLockSha256 = hash(await readFile(join(runtime, 'package-lock.json')));
  const addon = join(runtime, candidateAddonPath);
  const addonBeforeSha256 = hash(await readFile(addon));
  const official = join(runtime, 'node_modules', packageName);
  const originalLibrarySha256 = hash(await readFile(join(official, 'lib', library)));
  for (const [path, replacement] of [
    [`lib/${library}`, `lib/${library}`],
    ['versions.json', 'versions.json'],
  ]) {
    const original = join(official, path);
    if (!(await lstat(original)).isFile()) throw Error('Expected a regular original runtime file.');
    await rm(original);
    await symlink(
      relative(dirname(original), join(runtime, 'native-image-runtime', replacement)),
      original,
    );
  }
  const probe = join(runtime, 'candidate-probe.mjs');
  await writeFile(
    probe,
    `import sharp from 'sharp';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
const expected = realpathSync(fileURLToPath(new URL('./native-image-runtime/lib/${library}', import.meta.url)));
const loaded = process.report.getReport().sharedObjects.filter(path => path.includes('libvips-cpp'));
const actualLoadedContained = loaded.length === 1 && realpathSync(loaded[0]) === expected;
if (!actualLoadedContained || sharp.format.svg.input.buffer) throw Error('Unexpected loaded codecs');
console.log(JSON.stringify({ actualLoadedContained, svgInput: sharp.format.svg.input.buffer,
  actualLoadedLibrarySha256: createHash('sha256').update(readFileSync(expected)).digest('hex') }));\n`,
  );
  const loaded = JSON.parse(privateCommand(process.execPath, [probe], { cwd: runtime }));
  if (loaded.actualLoadedLibrarySha256 !== manifest.binary.library.sha256)
    throw Error('The loaded library is not the candidate.');
  const contract = contractResult(
    privateCommand(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        '--test-reporter=tap',
        'server/workers/document-worker/tests/image-contract.test.ts',
      ],
      {
        env: {
          TSX_DISABLE_CACHE: '1',
          OPENBOT_IMAGE_CONTRACT_RUNTIME: runtime,
          OPENBOT_IMAGE_CONTRACT_NODE: process.execPath,
        },
      },
    ),
  );
  return {
    contract,
    runtime: {
      ...loaded,
      npmLockSha256,
      originalLibrarySha256,
      addonBeforeSha256,
      addonAfterSha256: hash(await readFile(addon)),
    },
  };
}

export async function qualifyCandidate({ distribution, expectedManifestSha256, output, commit }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('Candidate qualification requires native macOS arm64.');
  const work = await mkdtemp(join(tmpdir(), 'bambooshift-codec-check-'));
  try {
    const manifest = await snapshotNativeArtifacts({
      artifactsDirectory: resolve(distribution),
      stage: work,
      pin: expectedManifestSha256,
    });
    const snapshot = join(work, 'distribution');
    const manifestPath = join(snapshot, 'distribution.json');
    const manifestBytes = await readFile(manifestPath);
    const verification = await verifyNativeDistribution({
      sourceRoot: root,
      manifestPath,
      artifactsDirectory: snapshot,
      expectedManifestSha256,
    });
    if (
      manifest.releaseApproval !== false ||
      !/^[a-f0-9]{40}$/.test(commit) ||
      readToolchainReport(manifest.toolchain).profile !== hostedProfile
    )
      throw Error('A reviewed source commit and hosted toolchain profile are required.');
    // Never extract arbitrary archive entries or symlinks into the temporary runtime.
    for (const entry of [manifest.binary.library, manifest.binary.versions]) {
      const bytes = await readNativeArchiveMember(
        join(snapshot, manifest.binary.filename),
        entry.path,
      );
      if (hash(bytes) !== entry.sha256)
        throw Error('Selected native archive member checksum differs.');
      const destination = join(work, 'native-image-runtime', entry.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx' });
    }
    const result = await runtimeCheck(work, manifest);
    const record = candidateRecord({
      manifest,
      manifestSha256: hash(manifestBytes),
      verification,
      ...result,
      commit,
    });
    await exportCandidate(snapshot, manifestBytes, record, output);
    return record;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [distribution, expectedManifestSha256, output, commit, ...extra] = process.argv.slice(2);
  if (extra.length || !distribution || !expectedManifestSha256 || !output || !commit)
    throw Error(
      'Use qualify.mjs <distribution> <observed-manifest-sha256> <new-artifacts> <source-commit>.',
    );
  qualifyCandidate({ distribution, expectedManifestSha256, output, commit }).then(
    () =>
      console.log(
        'Candidate archives and sanitized qualification record are ready; release approval remains false.',
      ),
    () => {
      console.error('Native candidate qualification failed; artifacts must not be distributed.');
      process.exitCode = 1;
    },
  );
}
