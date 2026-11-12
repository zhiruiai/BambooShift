import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectDependencyNotices } from '../dependency-notices.mjs';

/** Desktop packages ship worker dependencies, so preserve their legal texts as well as the Web notices. */
export async function collectRuntimeNotices({ sourceRoot, output }) {
  const runtime = join(output, 'runtime');
  const lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8'));
  const npmPackages = [];
  for (const [packagePath, value] of Object.entries(lock.packages)) {
    if (!packagePath) continue;
    try { await lstat(join(runtime, packagePath)); }
    catch (error) { if (error.code === 'ENOENT' && value.optional) continue; throw error; }
    npmPackages.push({
      packagePath,
      name: value.name ?? packagePath.slice(packagePath.lastIndexOf('node_modules/') + 13),
      version: value.version,
    });
  }
  return collectDependencyNotices({
    sourceRoot, npmPackages, npmScope: 'bundled-runtime',
    output: join(output, 'runtime-notices'),
  });
}
