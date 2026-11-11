import { mkdir, lstat, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  collectReleaseFiles,
  privateReleaseValues,
  regularBytes,
  releaseFindings,
} from './source-release-policy.mjs';

import { readDesktopProductName } from '../publishing/package-names.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function exportSource({ sourceRoot = root, output, privateValues } = {}) {
  sourceRoot = resolve(sourceRoot);
  const product = await readDesktopProductName(sourceRoot);
  output = resolve(output || join(sourceRoot, 'release', 'source', product));
  const relativeOutput = relative(sourceRoot, output);
  if (
    !relativeOutput.startsWith(
      `release${process.platform === 'win32' ? '\\' : '/'}source${process.platform === 'win32' ? '\\' : '/'}`,
    ) ||
    relativeOutput.split(/[\\/]/).includes('..') ||
    isAbsolute(relativeOutput)
  )
    throw Error('Choose a new directory under release/source/ for the source export.');
  // Validate each output component before creating a staging tree.
  let parent = sourceRoot;
  for (const part of relative(sourceRoot, dirname(output)).split(/[\\/]/)) {
    parent = join(parent, part);
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw Error('Release output cannot traverse a link.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(parent);
    }
  }
  if (
    await lstat(output).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    )
  )
    throw Error('The source export destination already exists. Choose a new directory.');
  const files = await collectReleaseFiles(sourceRoot);
  privateValues ??= await privateReleaseValues(sourceRoot);
  const stage = join(await realpath(parent), `.openbot-source-${randomUUID()}`);
  await mkdir(stage);
  try {
    const inventory = [],
      findings = [];
    for (const path of files) {
      const executable = ((await lstat(join(sourceRoot, path))).mode & 0o111) !== 0;
      const bytes = await regularBytes(join(sourceRoot, path));
      findings.push(...releaseFindings(path, bytes, privateValues));
      if (findings.length) continue;
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await writeFile(join(stage, path), bytes, { flag: 'wx', mode: executable ? 0o755 : 0o644 });
      inventory.push({
        path,
        bytes: bytes.length,
        sha256: digest(bytes),
        mode: executable ? '0755' : '0644',
      });
    }
    if (findings.length) {
      const error = Error(
        `Source export stopped: ${findings.length} private-value findings. No source release was published.`,
      );
      error.findings = findings;
      throw error;
    }
    const manifest = {
      version: 1,
      name: product,
      license: 'MIT',
      generatedAt: new Date().toISOString(),
      includesRuntimeData: false,
      includesPrivateConfiguration: false,
      historicalMediaExcluded: true,
      files: inventory,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(stage, 'source-manifest.json'), manifestBytes, { flag: 'wx' });
    await rename(stage, output);
    return {
      output,
      files: inventory.length,
      bytes: inventory.reduce((sum, file) => sum + file.bytes, 0),
      manifestSha256: digest(manifestBytes),
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--out'))
      throw Error('Usage: export-source.mjs [--out release/source/name]');
    console.log(JSON.stringify(await exportSource({ output: args[1] })));
  } catch (error) {
    if (error.findings) console.error(JSON.stringify(error.findings));
    console.error(error.message);
    process.exitCode = 1;
  }
}
