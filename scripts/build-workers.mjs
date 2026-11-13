import { build } from 'esbuild';
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { packageName, productionLock } from './worker-runtime-lock.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const entries = {
  'pi-worker': 'server/workers/pi-worker/index.ts',
  'mcp-worker': 'server/workers/mcp-worker/index.ts',
  'computer-worker': 'server/workers/computer-worker/local-entry.ts',
  'document-worker': 'server/workers/document-worker/index.ts',
};
const inventoryPath = (path) => path.replaceAll('\\', '/');
function assertPureInputs(inputs) {
  for (const input of inputs) {
    const name = input.replaceAll('\\', '/');
    if (/\.(?:test|fixture)\./.test(name) || name.includes('/fixtures.'))
      throw Error(`A test fixture was included in a released worker: ${name}`);
    if (name.startsWith('server/workers/') || name.startsWith('shared/')) continue;
    throw Error(`A business server dependency cannot be included in a released worker: ${name}`);
  }
}

async function previousPiFiles(output) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(output, 'workers.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = manifest.workers?.find((worker) => worker.worker === 'pi-worker')?.files ?? [];
  if (!Array.isArray(files)) throw Error('The previous Pi worker inventory is invalid.');
  const normalized = files.map((file) => ({ ...file, path: inventoryPath(file.path) }));
  for (const file of normalized) {
    if (
      !/^packages\/pi-worker\/[^/\\]+\.mjs$/.test(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw Error('A previous Pi worker file is outside its generated package directory.');
  }
  return normalized;
}

async function removeUnchangedPreviousPiFiles(output, previous, current) {
  const keep = new Set(current.map((file) => file.path));
  const packagePath = resolve(await realpath(output), 'packages/pi-worker');
  for (const file of previous) {
    if (keep.has(file.path)) continue;
    const path = resolve(output, file.path);
    const stat = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    // Keep unknown, replaced and linked files even if a stale inventory names them.
    if (!stat?.isFile()) continue;
    if (dirname(await realpath(path)) !== packagePath)
      throw Error('A previous Pi worker file resolves outside its generated package directory.');
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') === file.sha256) await unlink(path);
  }
}

export async function buildWorkers(output = resolve(root, '.build/runtime')) {
  output = resolve(output);
  if (output === root || output === resolve(root, 'server/workers'))
    throw Error('Choose a separate runtime output directory.');
  const previous = await previousPiFiles(output);
  const summaries = [];
  const imports = new Set();
  for (const [name, entry] of Object.entries(entries)) {
    const outfile = resolve(output, 'packages', name, 'index.mjs');
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      ...(name === 'pi-worker'
        ? {
            // Preserve the bootstrap's await import boundary for external SDK initializers.
            outdir: dirname(outfile),
            entryNames: 'index',
            chunkNames: '[name]-[hash]',
            outExtension: { '.js': '.mjs' },
            splitting: true,
          }
        : { outfile }),
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node22',
      legalComments: 'none',
      sourcemap: false,
      metafile: true,
      write: false,
      logLevel: 'silent',
    });
    assertPureInputs(Object.keys(result.metafile.inputs));
    for (const metadata of Object.values(result.metafile.outputs)) {
      for (const item of metadata.imports) {
        if (item.external) {
          const dependency = packageName(item.path);
          if (dependency) imports.add(dependency);
        }
      }
    }
    const file = result.outputFiles.find((file) => file.path === outfile);
    if (!file) throw Error(`The worker output is missing: ${name}`);
    await mkdir(dirname(outfile), { recursive: true });
    const files = [];
    for (const outputFile of result.outputFiles) {
      await writeFile(outputFile.path, outputFile.contents);
      files.push({
        path: inventoryPath(relative(output, outputFile.path)),
        bytes: outputFile.contents.length,
        sha256: createHash('sha256').update(outputFile.contents).digest('hex'),
      });
    }
    summaries.push({
      worker: name,
      entry: inventoryPath(relative(output, outfile)),
      bytes: file.contents.length,
      sha256: createHash('sha256').update(file.contents).digest('hex'),
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      inputs: Object.keys(result.metafile.inputs).sort(),
    });
  }
  const source = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  const { manifest, lock } = productionLock(source, [...imports]);
  // Keep the exact override policy used by the checked-in root lock.
  const project = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (project.overrides) manifest.overrides = project.overrides;
  await writeFile(resolve(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(resolve(output, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const summary = {
    version: 1,
    node: manifest.engines.node,
    dependencies: manifest.dependencies,
    workers: summaries,
  };
  await removeUnchangedPreviousPiFiles(
    output,
    previous,
    summaries.find((worker) => worker.worker === 'pi-worker').files,
  );
  await writeFile(resolve(output, 'workers.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out'))
    throw Error('Usage: build-workers.mjs [--out directory]');
  const output = args[1] ?? resolve(root, '.build/runtime');
  const result = await buildWorkers(output);
  console.log(
    JSON.stringify({
      output: resolve(output),
      workers: result.workers.map(({ worker, bytes, sha256 }) => ({ worker, bytes, sha256 })),
      dependencies: result.dependencies,
    }),
  );
}
