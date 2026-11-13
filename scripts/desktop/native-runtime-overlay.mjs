import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { boundedBytes, guardedPath, realDirectory } from '../dependency-notice-files.mjs';
import { verifyNativeDistribution } from './native-runtime-distribution.mjs';

import {
  packageName,
  packagePath,
  addonPath,
  digest,
  sha,
  readJson,
  review,
  packageFiles,
  originalInputs,
} from './native-runtime-overlay-inputs.mjs';

const execute = promisify(execFile);
const overlayPath = 'runtime/native-image-runtime/overlay.json';
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const safe = (value) =>
  typeof value === 'string' &&
  value
    .split('/')
    .every(
      (part) =>
        part &&
        part !== '.' &&
        part !== '..' &&
        !part.startsWith('-') &&
        !/[:\\\x00-\x1f]/.test(part),
    );

async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw Error('Native overlay output already exists.');
}

async function member(archive, path, maximum = 128 * 1024 * 1024) {
  if (!safe(path)) throw Error('Unsafe native archive member.');
  const { stdout: types } = await execute('tar', ['-tvf', archive, path], {
    maxBuffer: 1024 * 1024,
  });
  const lines = types.trim().split('\n');
  if (lines.length !== 1 || !lines[0].startsWith('-'))
    throw Error('Selected native archive member must be one regular file.');
  const { stdout } = await execute('tar', ['-xOf', archive, path], {
    encoding: 'buffer',
    maxBuffer: maximum,
    timeout: 120000,
  });
  return stdout;
}

async function writeMember(stage, path, bytes) {
  if (!safe(path)) throw Error('Unsafe native overlay path.');
  await mkdir(dirname(join(stage, path)), { recursive: true });
  await writeFile(join(stage, path), bytes, { flag: 'wx', mode: 0o644 });
  return { path, bytes: bytes.length, sha256: digest(bytes) };
}

async function snapshotArtifacts({ artifactsDirectory, stage, pin }) {
  artifactsDirectory = await realDirectory(resolve(artifactsDirectory));
  const manifestBytes = await boundedBytes(
    artifactsDirectory,
    join(artifactsDirectory, 'distribution.json'),
  );
  if (digest(manifestBytes) !== pin)
    throw Error('Native distribution differs from the reviewed candidate.');
  const manifest = JSON.parse(manifestBytes);
  const directory = join(stage, 'distribution');
  await mkdir(directory);
  await writeFile(join(directory, 'distribution.json'), manifestBytes, { flag: 'wx' });
  for (const item of [manifest.binary, manifest.source]) {
    if (
      !/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(item?.filename) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes <= 0 ||
      item.bytes > 512 * 1024 * 1024
    )
      throw Error('Invalid native artifact description.');
    const bytes = await boundedBytes(
      artifactsDirectory,
      join(artifactsDirectory, item.filename),
      item.bytes,
    );
    if (bytes.length !== item.bytes || digest(bytes) !== item.sha256)
      throw Error('Native artifact checksum differs from the reviewed distribution.');
    await writeFile(join(directory, item.filename), bytes, { flag: 'wx' });
  }
  return manifest;
}

/** Apply a locally reviewed candidate to a fresh runtime; this does not enable publication. */
export async function stageNativeRuntimeOverlay({
  sourceRoot,
  output,
  artifactsDirectory,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== 'darwin' || arch !== 'arm64')
    throw Error('Native candidate is qualified only for a darwin-arm64 staging target.');
  sourceRoot = await realDirectory(resolve(sourceRoot));
  output = await realDirectory(resolve(output));
  const reviewed = await review(sourceRoot);
  const input = await originalInputs(output, reviewed);
  const target = join(output, 'runtime/native-image-runtime');
  await absent(target);
  const stage = await mkdtemp(join(output, 'runtime/.native-overlay-'));
  const buildId = reviewed.candidate.candidate.distributionManifestSha256.slice(0, 16);
  const buildPath = `runtime/native-image-runtime/${buildId}`;
  const buildStage = join(stage, buildId);
  await mkdir(buildStage);
  const replaced = [];
  let installed = false;
  try {
    const pin = reviewed.candidate.candidate.distributionManifestSha256;
    const manifest = await snapshotArtifacts({ artifactsDirectory, stage: buildStage, pin });
    const distribution = join(buildStage, 'distribution');
    await verifyNativeDistribution({
      sourceRoot,
      manifestPath: join(distribution, 'distribution.json'),
      artifactsDirectory: distribution,
      expectedManifestSha256: pin,
    });
    const archive = join(distribution, manifest.binary.filename);
    const index = JSON.parse(await member(archive, manifest.notices.path));
    const names = [
      manifest.binary.library.path,
      manifest.binary.versions.path,
      'BUILD-INFO.json',
      'THIRD-PARTY-NOTICES.md',
      manifest.notices.path,
      ...index.components.flatMap((component) =>
        component.files.map((file) => `LICENSES/${file.path}`),
      ),
    ];
    if (new Set(names).size !== names.length) throw Error('Duplicate native overlay member.');
    const files = [];
    for (const path of names)
      files.push(await writeMember(buildStage, path, await member(archive, path)));
    const wrapperBytes = await member(
      join(distribution, manifest.source.filename),
      'source-cache/sharp-libvips-LICENSE',
    );
    if (
      digest(wrapperBytes) !== reviewed.license.sha256 ||
      wrapperBytes.length !== reviewed.license.bytes
    )
      throw Error('Original wrapper license differs from the reviewed source.');
    files.push(await writeMember(buildStage, 'UPSTREAM-WRAPPER-LICENSE', wrapperBytes));
    const replacements = [
      [`${packagePath}/lib/libvips-cpp.8.18.7.dylib`, manifest.binary.library.path],
      [`${packagePath}/versions.json`, manifest.binary.versions.path],
    ].map(([path, to]) => ({
      path,
      originalSha256: digest(input.originalBytes.get(path)),
      replacementPath: `${buildPath}/${to}`,
      sha256: files.find((file) => file.path === to).sha256,
    }));
    const record = {
      schemaVersion: 1,
      identity: 'bambooshift-native-runtime-overlay',
      target: { platform, arch },
      releaseApproval: false,
      inventoryScope: 'before-desktop-code-signing',
      npmLockScope: 'original-installation-inputs-not-substituted-library-bytes',
      packageName,
      packageVersion: reviewed.npm.version,
      packageIntegrity: reviewed.npm.integrity,
      npmLockSha256: input.lockSha256,
      originalFiles: input.files,
      replacements,
      distribution: { path: `${buildPath}/distribution/distribution.json`, sha256: pin },
      binaryArchive: {
        path: `${buildPath}/distribution/${manifest.binary.filename}`,
        ...manifest.binary,
        filename: undefined,
      },
      correspondingSource: {
        path: `${buildPath}/distribution/${manifest.source.filename}`,
        ...manifest.source,
        filename: undefined,
      },
      files: files.map((file) => ({ ...file, path: `${buildPath}/${file.path}` })),
    };
    await writeFile(join(stage, 'overlay.json'), json(record), { flag: 'wx' });
    // Check the original inputs again immediately before making any substitutions.
    const rechecked = await originalInputs(output, reviewed);
    if (
      JSON.stringify(rechecked.files) !== JSON.stringify(input.files) ||
      rechecked.lockSha256 !== input.lockSha256
    )
      throw Error('Native installation changed during staging.');
    await rename(stage, target);
    installed = true;
    for (const replacement of replacements) {
      await rm(join(output, replacement.path));
      replaced.push(replacement.path);
      await symlink(
        relative(
          dirname(join(output, replacement.path)),
          join(output, replacement.replacementPath),
        ),
        join(output, replacement.path),
      );
    }
    return await verifyStagedNativeRuntimeOverlay({ sourceRoot, output });
  } catch (error) {
    for (const path of replaced.reverse()) {
      await rm(join(output, path), { force: true });
      await writeFile(join(output, path), input.originalBytes.get(path), {
        mode: input.originalModes.get(path),
      });
    }
    if (installed) await rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Validate actual staged bytes before allowing this exact npm codec to use separate notices. */
export async function verifyStagedNativeRuntimeOverlay({ sourceRoot, output } = {}) {
  sourceRoot = await realDirectory(resolve(sourceRoot));
  output = await realDirectory(resolve(output));
  const reviewed = await review(sourceRoot);
  const recordBytes = await boundedBytes(output, join(output, overlayPath));
  const record = JSON.parse(recordBytes);
  const pin = reviewed.candidate.candidate.distributionManifestSha256;
  const buildPath = `runtime/native-image-runtime/${pin.slice(0, 16)}`;
  if (
    record.schemaVersion !== 1 ||
    record.identity !== 'bambooshift-native-runtime-overlay' ||
    record.target?.platform !== 'darwin' ||
    record.target?.arch !== 'arm64' ||
    record.releaseApproval !== false ||
    record.inventoryScope !== 'before-desktop-code-signing' ||
    record.packageName !== packageName ||
    record.packageVersion !== reviewed.npm.version ||
    record.packageIntegrity !== reviewed.npm.integrity ||
    record.distribution?.path !== `${buildPath}/distribution/distribution.json` ||
    record.distribution?.sha256 !== pin
  )
    throw Error('Staged native overlay identity differs from the reviewed candidate.');
  const lockBytes = await boundedBytes(output, join(output, 'runtime/package-lock.json'));
  const locked = JSON.parse(lockBytes).packages?.[packagePath.slice(8)];
  if (
    digest(lockBytes) !== record.npmLockSha256 ||
    locked?.integrity !== reviewed.npm.integrity ||
    locked?.version !== reviewed.npm.version
  )
    throw Error('Staged native npm lock changed.');
  const distribution = join(output, buildPath, 'distribution');
  await verifyNativeDistribution({
    sourceRoot,
    manifestPath: join(distribution, 'distribution.json'),
    artifactsDirectory: distribution,
    expectedManifestSha256: pin,
  });
  const manifest = await readJson(output, record.distribution.path);
  for (const [key, value] of [
    ['binaryArchive', manifest.binary],
    ['correspondingSource', manifest.source],
  ]) {
    const stored = record[key];
    if (
      stored?.path !== `${buildPath}/distribution/${value.filename}` ||
      stored.sha256 !== value.sha256 ||
      stored.bytes !== value.bytes
    )
      throw Error('Staged artifact inventory differs from the verified distribution.');
  }
  const archive = join(distribution, manifest.binary.filename);
  const indexBytes = await member(archive, manifest.notices.path);
  const index = JSON.parse(indexBytes);
  const expectedNames = [
    manifest.binary.library.path,
    manifest.binary.versions.path,
    'BUILD-INFO.json',
    'THIRD-PARTY-NOTICES.md',
    manifest.notices.path,
    ...index.components.flatMap((component) =>
      component.files.map((file) => `LICENSES/${file.path}`),
    ),
    'UPSTREAM-WRAPPER-LICENSE',
  ];
  if (
    !Array.isArray(record.files) ||
    record.files.length !== expectedNames.length ||
    new Set(record.files.map((file) => file.path)).size !== expectedNames.length
  )
    throw Error('Staged native file inventory is incomplete.');
  for (const name of expectedNames) {
    const file = record.files.find((item) => item.path === `${buildPath}/${name}`);
    if (!file) throw Error('Staged native file inventory omitted a required member.');
    const expected =
      name === 'UPSTREAM-WRAPPER-LICENSE'
        ? await member(
            join(distribution, manifest.source.filename),
            'source-cache/sharp-libvips-LICENSE',
          )
        : await member(archive, name);
    const bytes = await boundedBytes(output, join(output, file.path), 128 * 1024 * 1024);
    if (
      digest(bytes) !== digest(expected) ||
      file.sha256 !== digest(bytes) ||
      file.bytes !== bytes.length
    )
      throw Error('Staged native library, metadata or legal text changed.');
  }
  const expectedReplacements = [
    [
      `${packagePath}/lib/libvips-cpp.8.18.7.dylib`,
      manifest.binary.library,
      reviewed.original.binarySha256,
    ],
    [`${packagePath}/versions.json`, manifest.binary.versions, reviewed.retained['versions.json']],
  ];
  if (
    !Array.isArray(record.replacements) ||
    record.replacements.length !== 2 ||
    !Array.isArray(record.originalFiles)
  )
    throw Error('Invalid native replacement inventory.');
  for (const [path, item, originalHash] of expectedReplacements) {
    const replacement = record.replacements.find((file) => file.path === path);
    if (
      !replacement ||
      replacement.replacementPath !== `${buildPath}/${item.path}` ||
      replacement.sha256 !== item.sha256 ||
      !sha(replacement.originalSha256) ||
      (originalHash && replacement.originalSha256 !== originalHash) ||
      record.originalFiles.find((file) => file.path === path)?.sha256 !== replacement.originalSha256
    )
      throw Error('Staged native replacement differs from its reviewed identity.');
    await guardedPath(output, dirname(join(output, path)));
    if (
      !(await lstat(join(output, path))).isSymbolicLink() ||
      (await readlink(join(output, path))) !==
        relative(dirname(join(output, path)), join(output, replacement.replacementPath))
    )
      throw Error('Native replacement must use its exact contained relative link.');
  }
  const replaced = new Set(record.replacements.map((file) => file.path));
  const actualPackageFiles = await packageFiles(output, replaced);
  const expectedOriginalPaths = [...actualPackageFiles, addonPath].sort();
  if (
    JSON.stringify(record.originalFiles.map((file) => file.path).sort()) !==
    JSON.stringify(expectedOriginalPaths)
  )
    throw Error('Retained npm input inventory is incomplete or unexpected.');
  const retained = record.originalFiles.filter((file) => !replaced.has(file.path));
  for (const required of [
    ...Object.keys(reviewed.retained)
      .filter((path) => path !== 'versions.json')
      .map((path) => `${packagePath}/${path}`),
    addonPath,
  ])
    if (!retained.some((file) => file.path === required))
      throw Error('Retained npm input inventory is incomplete.');
  for (const file of retained) {
    if (!safe(file.path) || (!file.path.startsWith(`${packagePath}/`) && file.path !== addonPath))
      throw Error('Invalid retained npm input path.');
    const bytes = await boundedBytes(output, join(output, file.path), 128 * 1024 * 1024);
    const expectedHash =
      file.path === addonPath
        ? reviewed.candidate.abi.unchangedOriginalAddonSha256
        : reviewed.retained[file.path.slice(packagePath.length + 1)];
    if (
      file.sha256 !== expectedHash ||
      bytes.length !== file.bytes ||
      digest(bytes) !== file.sha256 ||
      (file.path === addonPath &&
        file.sha256 !== reviewed.candidate.abi.unchangedOriginalAddonSha256)
    )
      throw Error('Retained npm input or unmodified Sharp addon changed.');
  }
  const expectedOutput = new Set([
    overlayPath,
    record.distribution.path,
    record.binaryArchive.path,
    record.correspondingSource.path,
    ...record.files.map((file) => file.path),
  ]);
  let seen = 0;
  async function checkTree(path, depth = 0) {
    if (depth > 24) throw Error('Native overlay directory nesting exceeds its limit.');
    for (const entry of await readdir(join(output, path), { withFileTypes: true })) {
      if (++seen > 2000) throw Error('Native overlay directory exceeds its entry limit.');
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) await checkTree(name, depth + 1);
      else if (!entry.isFile() || !expectedOutput.delete(name))
        throw Error('Native overlay contains an unexpected file or link.');
    }
  }
  await checkTree('runtime/native-image-runtime');
  if (expectedOutput.size) throw Error('Native overlay inventory is incomplete.');
  return {
    manifestPath: overlayPath,
    manifestSha256: digest(recordBytes),
    npmPackage: packageName,
    librarySha256: manifest.binary.library.sha256,
    sourceArtifactPath: `${buildPath}/distribution/${manifest.source.filename}`,
    noticesPath: `${buildPath}/LICENSES`,
    wrapperLicensePath: `${buildPath}/UPSTREAM-WRAPPER-LICENSE`,
    releaseApproval: false,
  };
}
