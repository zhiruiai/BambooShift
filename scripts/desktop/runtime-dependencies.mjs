import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { productionLock } from '../worker-runtime-lock.mjs';

export function desktopDependencyLock(manifest, lock, { platform, arch, libc } = {}) {
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch))
    throw Error('Native image dependencies require a supported desktop target.');
  if (platform === 'linux' && !['glibc', 'musl'].includes(libc))
    throw Error('The Linux C library must be identified before selecting native images.');
  const target = `${platform === 'linux' && libc === 'musl' ? 'linuxmusl' : platform}-${arch}`;
  const nativeImages = [`@img/sharp-${target}`, `@img/sharp-libvips-${target}`];
  const required = [...Object.keys(manifest.dependencies), ...nativeImages];
  const projected = productionLock(lock, required);
  if (manifest.overrides) projected.manifest.overrides = structuredClone(manifest.overrides);
  for (const [path, entry] of Object.entries(projected.lock.packages)) {
    if (!entry.optional) continue;
    // Installing with --omit=optional must not silently remove a new capability.
    // PDF.js text extraction does not rasterize; Sharp still receives its full native codec.
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (
      !/^@napi-rs\/canvas(?:-|$)/.test(name) &&
      !/^@img\/sharp(?:-|$)/.test(name) &&
      !['@emnapi/runtime', 'tslib'].includes(name)
    )
      throw Error(`Review the optional runtime capability before omitting ${name}.`);
  }
  return projected;
}

export async function prepareDesktopDependencies(runtime, { platform, arch } = {}) {
  const manifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8'));
  const libc =
    platform === 'linux'
      ? process.report.getReport().header.glibcVersionRuntime
        ? 'glibc'
        : 'musl'
      : undefined;
  const projected = desktopDependencyLock(manifest, lock, { platform, arch, libc });
  await writeFile(
    join(runtime, 'package.json'),
    JSON.stringify(projected.manifest, null, 2) + '\n',
  );
  await writeFile(
    join(runtime, 'package-lock.json'),
    JSON.stringify(projected.lock, null, 2) + '\n',
  );
}
