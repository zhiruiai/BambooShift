import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { cargo, root, rustBinary } from './rust-toolchain.mjs';
import { buildWorkers } from './build-workers.mjs';
import { collectDependencyNotices } from './dependency-notices.mjs';
import { readWebLicenseInputs } from './web-license-inputs.ts';

const webTypes = new Set([
  '.html',
  '.js',
  '.css',
  '.svg',
  '.png',
  '.ico',
  '.jpg',
  '.jpeg',
  '.webp',
  '.woff',
  '.woff2',
  '.webmanifest',
]);
const binaries = ['openbot-backend', 'openbot-image-worker'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function copyPublicWeb(source, target) {
  const metadata = await lstat(source);
  if (!metadata.isDirectory()) throw Error('The built public UI must be a real directory.');
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      entry.name.startsWith('.') ||
      ['data', 'config', 'server', 'src', 'node_modules'].includes(entry.name)
    )
      throw Error('Private or source directories cannot enter the published web tree.');
    const from = join(source, entry.name),
      to = join(target, entry.name);
    if (entry.isSymbolicLink()) throw Error('The published web tree cannot contain links.');
    if (entry.isDirectory()) await copyPublicWeb(from, to);
    else if (entry.isFile() && webTypes.has(extname(entry.name))) await copyFile(from, to);
    else throw Error(`Unexpected file in the built public UI: ${entry.name}`);
  }
}

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      name = join(prefix, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) files.push(...(await inventory(path, name)));
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
    } else throw Error('A published package contains an unexpected filesystem entry.');
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function packageBackend({
  output = join(root, '.build/backend-package'),
  release = false,
  compile = (operation, args) => cargo(operation, args, { portable: true }),
  sourceRoot = root,
  binaryPath = (name, release) => rustBinary(name, release, { portable: true }),
  build = buildWorkers,
  buildNotices = async ({ sourceRoot, output }) =>
    collectDependencyNotices({
      sourceRoot,
      output,
      npmPackages: await readWebLicenseInputs(sourceRoot),
    }),
} = {}) {
  if (process.platform === 'win32')
    throw Error(
      'Build the service package in Linux or macOS. On Windows, use a Linux environment such as WSL2.',
    );
  output = resolve(output);
  if (
    await lstat(output).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    )
  )
    throw Error('The package destination already exists; choose a new empty output path.');
  const stage = join(dirname(output), `.openbot-package-${randomUUID()}`);
  await mkdir(stage, { recursive: true });
  try {
    await compile('build', [
      '--bin',
      binaries[0],
      '--bin',
      binaries[1],
      ...(release ? ['--release'] : []),
    ]);
    for (const name of binaries) {
      const source = binaryPath(name, release);
      if (!(await lstat(source)).isFile())
        throw Error('A Rust executable is missing or is not a regular file.');
      const target = join(stage, name);
      await copyFile(source, target);
      await chmod(target, 0o755);
    }
    await build(join(stage, 'runtime'));
    await copyPublicWeb(join(sourceRoot, 'dist'), join(stage, 'runtime/dist'));
    await readFile(join(stage, 'runtime/dist/index.html'));
    await copyPublicWeb(
      join(sourceRoot, 'operations-dist'),
      join(stage, 'runtime/operations-dist'),
    );
    await readFile(join(stage, 'runtime/operations-dist/index.html'));
    await mkdir(join(stage, 'deployment'));
    await copyFile(
      join(sourceRoot, 'server/api/deployment/server.example.json'),
      join(stage, 'deployment/server.example.json'),
    );
    await copyFile(join(sourceRoot, 'server/api/deployment/README.md'), join(stage, 'README.md'));
    for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY.md'])
      await copyFile(join(sourceRoot, name), join(stage, name));
    await buildNotices({ sourceRoot, output: join(stage, 'third-party') });
    const manifest = {
      version: 1,
      application: 'openbot',
      profile: release ? 'release' : 'debug',
      platform: process.platform,
      architecture: process.arch,
      node: '>=22.19.0',
      dependencyInstallation: 'npm ci --omit=dev --ignore-scripts',
      files: await inventory(stage),
    };
    await writeFile(join(stage, 'package-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rename(stage, output);
    return {
      output,
      profile: manifest.profile,
      files: manifest.files.length,
      bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
      manifestSha256: digest(await readFile(join(output, 'package-manifest.json'))),
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let output,
    release = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--release') release = true;
    else if (args[i] === '--out' && args[i + 1]) output = args[++i];
    else throw Error('Usage: package-backend.mjs [--release] [--out directory]');
  }
  console.log(JSON.stringify(await packageBackend({ output, release })));
}
