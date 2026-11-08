import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type WebDependency = { name: string; version: string; packagePath: string };
async function packageFor(root: string, moduleId: string): Promise<WebDependency | undefined> {
  const id = moduleId.split('?')[0];
  const nodeRoot = join(root, 'node_modules');
  if (!id.startsWith(nodeRoot + sep)) return;
  let directory = dirname(id);
  while (directory.startsWith(nodeRoot + sep)) {
    const manifest = join(directory, 'package.json');
    try {
      const info = await lstat(manifest);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
        throw Error('A bundled dependency has an invalid manifest.');
      const value = JSON.parse(await readFile(manifest, 'utf8'));
      if (typeof value.name === 'string' && typeof value.version === 'string')
        return {
          name: value.name,
          version: value.version,
          packagePath: relative(root, directory).replaceAll('\\', '/'),
        };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    directory = dirname(directory);
  }
  throw Error('A bundled dependency has no versioned package manifest.');
}
export function webLicenseInputs(root: string, surface: 'product' | 'operations'): Plugin {
  return {
    name: 'openbot-web-license-inputs',
    apply: 'build',
    enforce: 'post',
    async writeBundle(options, bundle) {
      const outDir = resolve(options.dir!);
      const packages = new Map<string, WebDependency>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const [moduleId, details] of Object.entries(output.modules)) {
          if (details.renderedLength === 0) continue;
          const pkg = await packageFor(root, moduleId);
          if (pkg) packages.set(pkg.packagePath, pkg);
        }
      }
      const files = [];
      for (const output of Object.values(bundle)) {
        if (!/\.(?:js|css|html)$/.test(output.fileName)) continue;
        const bytes = await readFile(join(outDir, output.fileName));
        files.push({ path: output.fileName, sha256: digest(bytes) });
      }
      const directory = join(root, '.build/web-notice-inputs');
      await mkdir(directory, { recursive: true });
      const metadata = {
        version: 1,
        surface,
        lockSha256: digest(await readFile(join(root, 'package-lock.json'))),
        packages: [...packages.values()].sort((a, b) => a.packagePath.localeCompare(b.packagePath)),
        files: files.sort((a, b) => a.path.localeCompare(b.path)),
      };
      await writeFile(join(directory, `${surface}.json`), JSON.stringify(metadata, null, 2) + '\n');
    },
  };
}
export async function readWebLicenseInputs(root: string): Promise<WebDependency[]> {
  const packages = new Map<string, WebDependency>();
  const lock = digest(await readFile(join(root, 'package-lock.json')));
  for (const surface of ['product', 'operations'] as const) {
    const value = JSON.parse(
      await readFile(join(root, `.build/web-notice-inputs/${surface}.json`), 'utf8'),
    );
    if (
      value.version !== 1 ||
      value.surface !== surface ||
      value.lockSha256 !== lock ||
      !Array.isArray(value.packages) ||
      !Array.isArray(value.files) ||
      !value.files.length
    )
      throw Error('Web dependency inputs are stale. Rebuild both web applications.');
    const outDir = join(root, surface === 'product' ? 'dist' : 'operations-dist');
    for (const file of value.files) {
      if (
        typeof file.path !== 'string' ||
        !/^[A-Za-z0-9_./-]+$/.test(file.path) ||
        file.path.split('/').includes('..') ||
        file.path.startsWith('/')
      )
        throw Error('Invalid web artifact path.');
      if (digest(await readFile(join(outDir, file.path))) !== file.sha256)
        throw Error(
          'Web artifacts changed after dependency collection. Rebuild both web applications.',
        );
    }
    for (const pkg of value.packages) {
      if (
        typeof pkg.name !== 'string' ||
        typeof pkg.version !== 'string' ||
        typeof pkg.packagePath !== 'string' ||
        !pkg.packagePath.startsWith('node_modules/') ||
        pkg.packagePath.split('/').includes('..') ||
        pkg.packagePath.includes('\\')
      )
        throw Error('Invalid web dependency identity.');
      packages.set(pkg.packagePath, pkg);
    }
  }
  return [...packages.values()];
}
