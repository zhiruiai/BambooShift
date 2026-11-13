import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectDependencyNotices } from '../dependency-notices.mjs';
import { verifyStagedNativeRuntimeOverlay } from './native-runtime-overlay.mjs';

/** Desktop packages ship worker dependencies, so preserve their legal texts as well as the Web notices. */
export async function collectRuntimeNotices({ sourceRoot, output, nativeImage }) {
  const runtime = join(output, 'runtime');
  // Never omit an npm component on the strength of caller-supplied metadata.
  // Its replacement, original wrapper, complete notices and source must be present.
  const verified = nativeImage
    ? await verifyStagedNativeRuntimeOverlay({ sourceRoot, output })
    : undefined;
  if (verified && verified.manifestSha256 !== nativeImage.manifestSha256)
    throw Error('Native image notice coverage differs from the staged runtime.');
  const lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8'));
  const npmPackages = [];
  for (const [packagePath, value] of Object.entries(lock.packages)) {
    if (!packagePath) continue;
    try { await lstat(join(runtime, packagePath)); }
    catch (error) { if (error.code === 'ENOENT' && value.optional) continue; throw error; }
    const name = value.name ?? packagePath.slice(packagePath.lastIndexOf('node_modules/') + 13);
    if (verified && packagePath === `node_modules/${verified.npmPackage}`) continue;
    npmPackages.push({
      packagePath,
      name,
      version: value.version,
    });
  }
  const result = await collectDependencyNotices({
    sourceRoot, npmPackages, npmScope: 'bundled-runtime',
    output: join(output, 'runtime-notices'),
  });
  if (verified) {
    await writeFile(join(output, 'runtime-notices/native-image.json'), JSON.stringify({
      schemaVersion: 1,
      inventoryScope: 'pre-sign-runtime-inputs',
      npmIndex: 'index.json',
      separatelyCoveredNpmPackage: verified.npmPackage,
      nativeImage: verified,
      releaseApproval: false,
    }, null, 2) + '\n', { flag: 'wx' });
  }
  return { ...result, ...(verified ? { nativeImage: verified } : {}) };
}
