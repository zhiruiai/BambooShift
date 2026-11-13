import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedBytes, guardedPath } from '../dependency-notice-files.mjs';

const legal = 'legal/third-party/sharp-libvips-1.3.4';
export const packageName = '@img/sharp-libvips-darwin-arm64';
export const packagePath = `runtime/node_modules/${packageName}`;
export const addonPath =
  'runtime/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.5.node';
// Retained files from the locked 1.3.4 darwin-arm64 npm publication.
const retainedHashes = {
  'package.json': '394ecfe4e823ebf6ddc9f9b7155046aad1f0492300920323ddfb84cae85dbac0',
  'README.md': '5dd6d3c034f925604681d49b7bedc71bd08dcf3d0cfc6d16b9f0569497d700dc',
  'lib/index.js': '516a08c06660cddb50d5f30ccac29a0514b05724956a11e8a7e6b799f2e1ab72',
  'lib/glib-2.0/include/glibconfig.h':
    '52dc7deb43d9ee5306df7489f305cc1ee4426dab443bb328f45b4fe58dff2dff',
  'versions.json': 'e2611d5d854815a8b33c8a3d2ec649511a9596ccf16844e8eae7cf81e79881c4',
};
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const readJson = async (root, path) =>
  JSON.parse(await boundedBytes(root, join(root, path)));

export async function review(sourceRoot) {
  const candidate = await readJson(sourceRoot, `${legal}/CANDIDATE-DARWIN-ARM64.json`);
  const original = await readJson(sourceRoot, `${legal}/BINARY-EVIDENCE.json`);
  const audit = await readJson(sourceRoot, `${legal}/DISTRIBUTION.json`);
  const inputs = await readJson(sourceRoot, `${legal}/SOURCE-INPUTS-CANDIDATE.json`);
  const npm = audit.packages?.find((item) => item.name === packageName);
  const license = inputs.buildInputs?.find((item) => item.filename === 'sharp-libvips-LICENSE');
  if (
    candidate.platform !== 'darwin-arm64' ||
    candidate.status !== 'local-candidate-only' ||
    !sha(candidate.candidate?.distributionManifestSha256) ||
    !sha(candidate.abi?.unchangedOriginalAddonSha256) ||
    original.package?.name !== packageName ||
    original.package.version !== '1.3.4' ||
    original.binaryPath !== `${packagePath.slice(8)}/lib/libvips-cpp.8.18.7.dylib` ||
    !sha(original.binarySha256) ||
    npm?.version !== '1.3.4' ||
    !/^sha512-[a-zA-Z0-9+/]+=*$/.test(npm?.integrity ?? '') ||
    !sha(license?.sha256)
  )
    throw Error('Native overlay requires reviewed candidate and original npm identities.');
  const retained = original.retainedFileSha256 ?? retainedHashes;
  if (
    JSON.stringify(Object.keys(retained).sort()) !==
      JSON.stringify(Object.keys(retainedHashes).sort()) ||
    Object.values(retained).some((hash) => !sha(hash))
  )
    throw Error('Reviewed retained native input inventory is incomplete.');
  return { candidate, original, npm, license, retained };
}

export async function packageFiles(output, replacementLinks = new Set()) {
  const files = [];
  let entries = 0;
  async function walk(path, depth = 0) {
    if (depth > 8) throw Error('Original native package nesting exceeds its limit.');
    for (const entry of await readdir(join(output, path), { withFileTypes: true })) {
      if (++entries > 100) throw Error('Original native package entry count exceeds its limit.');
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile() || (entry.isSymbolicLink() && replacementLinks.has(name)))
        files.push(name);
      else throw Error('Original native package cannot contain links or special files.');
    }
  }
  await guardedPath(output, join(output, packagePath));
  await walk(packagePath);
  const allowed = new Set([
    'package.json',
    'README.md',
    'lib/index.js',
    'lib/glib-2.0/include/glibconfig.h',
    'versions.json',
    'lib/libvips-cpp.8.18.7.dylib',
  ]);
  if (files.some((path) => !allowed.has(path.slice(packagePath.length + 1))))
    throw Error('Original native package contains an unexpected file.');
  return files.sort();
}

export async function originalInputs(output, reviewed) {
  const lockBytes = await boundedBytes(output, join(output, 'runtime/package-lock.json'));
  const lock = JSON.parse(lockBytes);
  const locked = lock.packages?.[packagePath.slice(8)];
  const metadata = await readJson(output, `${packagePath}/package.json`);
  if (
    locked?.version !== reviewed.npm.version ||
    locked?.integrity !== reviewed.npm.integrity ||
    metadata.name !== packageName ||
    metadata.version !== reviewed.npm.version
  )
    throw Error('Installed native package differs from the reviewed npm lock.');
  const library = `${packagePath}/lib/libvips-cpp.8.18.7.dylib`;
  const originalBytes = new Map();
  const originalModes = new Map();
  const files = [];
  for (const path of [...(await packageFiles(output)), addonPath]) {
    const bytes = await boundedBytes(output, join(output, path), 128 * 1024 * 1024);
    files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
    if (path === library || path === `${packagePath}/versions.json`) {
      originalBytes.set(path, bytes);
      originalModes.set(path, (await lstat(join(output, path))).mode & 0o777);
    }
  }
  if (
    digest(originalBytes.get(library) ?? '') !== reviewed.original.binarySha256 ||
    files.find((file) => file.path === addonPath)?.sha256 !==
      reviewed.candidate.abi.unchangedOriginalAddonSha256
  )
    throw Error('Original native library or Sharp addon differs from its reviewed hash.');
  for (const [path, expected] of Object.entries(reviewed.retained))
    if (files.find((file) => file.path === `${packagePath}/${path}`)?.sha256 !== expected)
      throw Error('Original native package retained input differs from the reviewed bytes.');
  return { files, originalBytes, originalModes, lockSha256: digest(lockBytes) };
}
