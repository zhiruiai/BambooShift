import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { packageBackend } from '../package-backend.mjs';
import { root } from '../rust-toolchain.mjs';
import { stageNodeRuntime } from './node-runtime.mjs';
import { stageCuaDriver } from './cua-driver.mjs';
import { collectRuntimeNotices } from './runtime-notices.mjs';
import { validateNativeBinary } from './native-binary.mjs';
import { prepareDesktopDependencies } from './runtime-dependencies.mjs';

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
      },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Runtime build failed (${code ?? signal}).`)),
    );
  });
}

/** Build only public release inputs; no deployment settings or user directories are copied. */
export async function stageDesktopRuntime({
  output,
  platform = process.platform,
  arch = process.arch,
  buildBackend = packageBackend,
  command = run,
  stageNode = stageNodeRuntime,
  stageDriver = stageCuaDriver,
  buildRuntimeNotices = collectRuntimeNotices,
  prepareDependencies = prepareDesktopDependencies,
  nodeVersion = process.versions.node,
  sourceRoot = root,
} = {}) {
  if (
    !['darwin', 'linux'].includes(platform) ||
    platform !== process.platform ||
    arch !== process.arch
  )
    throw Error('Build the bundled runtime on its target macOS or Linux architecture.');
  await command('npm', ['run', 'build:web'], sourceRoot);
  await buildBackend({ output, release: true, sourceRoot });
  for (const name of ['openbot-backend', 'openbot-image-worker'])
    await validateNativeBinary(join(output, name), { platform, arch });
  // Backend inventory predates dependency installation and nested code signing.
  // Keep its provenance explicit instead of presenting it as shipped-byte hashes.
  const inventoryPath = join(output, 'package-manifest.json');
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  if (
    inventory.version !== 1 ||
    inventory.platform !== platform ||
    inventory.architecture !== arch ||
    !Array.isArray(inventory.files)
  )
    throw Error('The backend package inventory does not match the desktop target.');
  await writeFile(
    inventoryPath,
    JSON.stringify(
      {
        ...inventory,
        inventoryScope: 'backend-inputs-before-desktop-dependencies-and-signing',
        dependencyInstallation: 'bundled-by-desktop-packager',
      },
      null,
      2,
    ) + '\n',
  );
  const runtime = join(output, 'runtime');
  await prepareDependencies(runtime, { platform, arch });
  // Install from the generated production lock, never copy the developer's node_modules.
  await command(
    'npm',
    ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
    runtime,
  );
  const node = await stageNode({ output, version: nodeVersion, platform, arch, command });
  const driver = await stageDriver({ output, platform, sourceRoot, command });
  await buildRuntimeNotices({ sourceRoot, output });
  await command(join(output, 'bin/node'), ['--version'], output);
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const manifest = {
    version: 1,
    platform,
    architecture: arch,
    server: 'openbot-backend',
    node: 'bin/node',
    runtime: 'runtime',
    ...node,
    ...driver,
    dependencyLockSha256: sha256(await readFile(join(runtime, 'package-lock.json'))),
  };
  await writeFile(join(output, 'desktop-runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
