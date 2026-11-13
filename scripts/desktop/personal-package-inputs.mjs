import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function argumentsForCheck(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length !== 2 || args[0] !== '--resources' || !args[1] || args[1].startsWith('--'))
    throw Error('Use --resources with an unpacked desktop application Resources directory.');
  return { resources: resolve(args[1]) };
}

export async function containedFile(root, name, maximum = 256 * 1024 * 1024) {
  const path = join(root, name),
    info = await lstat(path);
  const child = relative(root, await realpath(path));
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > maximum ||
    isAbsolute(child) ||
    child === '..' ||
    child.startsWith(`..${sep}`)
  )
    throw Error('The selected package has an invalid or escaping runtime file.');
  return path;
}

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Resolve only packaged inputs. Never fall back to the development backend or workers. */
export async function inspectPersonalPackage(resources) {
  if (!(await lstat(resources)).isDirectory()) throw Error('Resources must be a real directory.');
  resources = await realpath(resources);
  const runtime = join(resources, 'bambooshift-runtime');
  const manifestPath = await containedFile(
    resources,
    'bambooshift-runtime/desktop-runtime.json',
    4096,
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.version !== 1 ||
    !['darwin', 'linux'].includes(manifest.platform) ||
    manifest.platform !== process.platform ||
    manifest.architecture !== process.arch ||
    manifest.server !== 'openbot-backend' ||
    manifest.node !== 'bin/node' ||
    manifest.runtime !== 'runtime'
  )
    throw Error('The complete runtime must match this operating system and architecture.');
  const paths = {
    asar: await containedFile(resources, 'app.asar', 64 * 1024 * 1024),
    manifest: manifestPath,
    backend: await containedFile(runtime, manifest.server),
    node: await containedFile(runtime, manifest.node),
    pi: await containedFile(runtime, 'runtime/packages/pi-worker/index.mjs', 64 * 1024 * 1024),
  };
  return {
    resources,
    runtime,
    paths,
    platform: manifest.platform,
    architecture: manifest.architecture,
  };
}

export async function packageHashes(paths) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([key, path]) => [key, digest(await readFile(path))]),
    ),
  );
}
