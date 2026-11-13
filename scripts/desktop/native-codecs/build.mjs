import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  statfs,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifiedArchive } from '../archive-cache.mjs';
import { copyDesktopRuntime } from '../runtime-copy.mjs';
import { defaultProfile, inspectToolchain, readToolchainReport } from './toolchain.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const legal = join(root, 'legal/third-party/sharp-libvips-1.3.4');
const script = fileURLToPath(import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

export function validateInputs(inputs) {
  const names = new Set(),
    urls = new Set();
  for (const input of inputs) {
    const url = new URL(input.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      !/^[a-zA-Z0-9._-]+$/.test(input.filename) ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > 64 * 1024 * 1024 ||
      names.has(input.filename) ||
      urls.has(input.url) ||
      (input.output &&
        (isAbsolute(input.output) ||
          /[\\\0]/.test(input.output) ||
          input.output.split('/').includes('..')))
    )
      throw Error('Invalid fixed source identity.');
    names.add(input.filename);
    urls.add(input.url);
  }
  return inputs;
}

export async function sourceBytes(input, cache, fetchMissing = false) {
  const bytes = await verifiedArchive({
    directory: cache,
    name: input.filename,
    sha256: input.sha256,
    maxBytes: input.bytes,
    download: async () => {
      if (!fetchMissing)
        throw Error(`Missing verified input: ${input.filename}. Use --fetch explicitly.`);
      const response = await fetch(input.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.url.startsWith('https:'))
        throw Error('Public source download failed.');
      const parts = [];
      let size = 0;
      for await (const part of response.body) {
        size += part.length;
        if (size > input.bytes) throw Error('Public source exceeds its pinned size.');
        parts.push(part);
      }
      return Buffer.concat(parts);
    },
  });
  if (bytes.length !== input.bytes) throw Error('Fixed source size does not match.');
  return bytes;
}

export async function prepareCandidate({ output, cache, fetchMissing = false }) {
  output = resolve(output);
  cache = resolve(cache);
  if (/\s/.test(output))
    throw Error('The upstream POSIX recipe requires an output path without whitespace.');
  const catalog = await json(join(legal, 'SOURCE-INPUTS-CANDIDATE.json'));
  const inputs = validateInputs([...catalog.inputs, ...catalog.buildInputs]);
  // No deletion, replacement or continuation of an earlier partially built prefix.
  await mkdir(output, { recursive: false, mode: 0o700 });
  for (const name of [
    'build',
    'logs',
    'bin',
    'patches',
    'tmp',
    'cache',
    'platforms/darwin-arm64v8',
  ])
    await mkdir(join(output, name), { recursive: true });
  for (const input of inputs) {
    const bytes = await sourceBytes(input, cache, fetchMissing);
    if (input.output) {
      await mkdir(dirname(join(output, input.output)), { recursive: true });
      await writeFile(join(output, input.output), bytes);
    }
  }
  for (const patch of catalog.additionalLocalPatches) {
    const bytes = await readFile(join(legal, patch.file));
    if (hash(bytes) !== patch.sha256) throw Error('Local source patch checksum mismatch.');
    await writeFile(join(output, 'patches', basename(patch.file)), bytes);
  }
  const recipe = await readFile(join(legal, 'candidate-recipe.patch'));
  if (hash(recipe) !== catalog.recipePatchSha256) throw Error('Recipe patch checksum mismatch.');
  execFileSync('/usr/bin/patch', ['--batch', '-p1', '-i', join(legal, 'candidate-recipe.patch')], {
    cwd: output,
  });
  await writeFile(
    join(output, 'bin/pinned-fetch'),
    '#!/usr/bin/env bash\nset -e\nexec "$BAMBOOSHIFT_NODE" "$BAMBOOSHIFT_BUILD_ENTRY" fetch "$@"\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(output, 'bin/ninja'),
    '#!/usr/bin/env bash\nset -e\nexec "$BAMBOOSHIFT_BUILD_TOOLS/bin/ninja" -j"$BAMBOOSHIFT_BUILD_JOBS" "$@"\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(output, 'bin/clang++'),
    '#!/usr/bin/env bash\nset -e\nexec "$BAMBOOSHIFT_NATIVE_CXX" -isystem "$SDKROOT/usr/include/c++/v1" "$@"\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(output, 'inputs.json'),
    JSON.stringify({ inputs, recipePatchSha256: catalog.recipePatchSha256 }, null, 2) + '\n',
  );
  return output;
}

async function offlineFetch(url) {
  const output = process.env.BAMBOOSHIFT_BUILD_OUTPUT;
  const catalog = await json(join(output, 'inputs.json'));
  const input = catalog.inputs.find((item) => item.url === url);
  if (!input) throw Error('Upstream recipe requested an unpinned input.');
  const space = await statfs(output);
  if (space.bavail * space.bsize < 1024 ** 3)
    throw Error('Less than 1 GiB free; source extraction stopped.');
  const bytes = await sourceBytes(input, process.env.BAMBOOSHIFT_NATIVE_SOURCE_CACHE);
  await appendFile(
    join(output, 'logs/source-access.jsonl'),
    JSON.stringify({ component: input.component, sha256: input.sha256 }) + '\n',
  );
  await new Promise((done, reject) =>
    process.stdout.write(bytes, (error) => (error ? reject(error) : done())),
  );
}

function buildEnvironment(output, cache, tools, jobs) {
  if (![1, 2].includes(jobs)) throw Error('Build jobs must be 1 or 2.');
  const env = {};
  // Do not forward model/API tokens or unrelated application configuration.
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'DEVELOPER_DIR'])
    if (process.env[name]) env[name] = process.env[name];
  return {
    ...env,
    LC_ALL: 'C',
    LANG: 'C',
    BAMBOOSHIFT_NODE: process.execPath,
    BAMBOOSHIFT_BUILD_ENTRY: script,
    BAMBOOSHIFT_ARCHIVER: join(dirname(script), 'archive.py'),
    BAMBOOSHIFT_BUILD_OUTPUT: output,
    BAMBOOSHIFT_NATIVE_SOURCE_CACHE: cache,
    BAMBOOSHIFT_BUILD_TOOLS: tools,
    BAMBOOSHIFT_BUILD_JOBS: String(jobs),
  };
}

async function build({ output, cache, tools, jobs, fetchMissing, profile = defaultProfile }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('This candidate is qualified only for native macOS arm64 builds.');
  tools = resolve(tools);
  output = resolve(output);
  cache = resolve(cache);
  const toolchain = inspectToolchain({ profile, tools });
  const env = { ...buildEnvironment(output, cache, tools, jobs), ...toolchain.environment };
  await prepareCandidate({ output, cache, fetchMissing });
  await writeFile(
    join(output, 'TOOLCHAIN.json'),
    JSON.stringify(toolchain.report, null, 2) + '\n',
    { flag: 'wx' },
  );
  const log = createWriteStream(join(output, 'logs/build.log'), { flags: 'wx', mode: 0o600 });
  const child = spawn('/bin/bash', [join(dirname(script), 'run.sh')], {
    cwd: output,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  await new Promise((done) => log.end(done));
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (code !== 0) throw Error('Native build failed; inspect the private output logs.');
  console.log(
    'Native candidate built. Production dependencies and release gates remain unchanged.',
  );
}

export async function sourceInventory(directory) {
  const files = [];
  async function walk(path = '') {
    for (const name of (await readdir(join(directory, path))).sort()) {
      const member = path ? `${path}/${name}` : name;
      const stat = await lstat(join(directory, member));
      if (stat.isDirectory()) await walk(member);
      else if (stat.isFile()) {
        const bytes = await readFile(join(directory, member));
        files.push({ path: member, bytes: bytes.length, sha256: hash(bytes) });
      } else throw Error('Corresponding source must contain regular files and directories only.');
    }
  }
  await walk();
  return { version: 1, files };
}

async function packageCandidate({ output, cache, tools, profile = defaultProfile }) {
  output = resolve(output);
  cache = resolve(cache);
  tools = resolve(tools);
  const toolchain = readToolchainReport(await json(join(output, 'TOOLCHAIN.json')));
  if (JSON.stringify(inspectToolchain({ profile, tools }).report) !== JSON.stringify(toolchain))
    throw Error('Packaging must use the same checked toolchain as compilation.');
  const catalogBytes = await readFile(join(legal, 'SOURCE-INPUTS-CANDIDATE.json'));
  const catalog = JSON.parse(catalogBytes);
  const built = await json(join(output, 'inputs.json'));
  if (
    JSON.stringify(built.inputs) !==
      JSON.stringify(validateInputs([...catalog.inputs, ...catalog.buildInputs])) ||
    built.recipePatchSha256 !== catalog.recipePatchSha256
  )
    throw Error('The completed build does not match the current source catalog.');
  const directory = join(output, 'distribution');
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const binary = join(directory, 'binary'),
    source = join(directory, 'source');
  await mkdir(binary);
  await mkdir(source);
  for (const name of ['include', 'lib'])
    await copyDesktopRuntime(join(output, 'target', name), join(binary, name));
  for (const name of ['versions.json', 'THIRD-PARTY-NOTICES.md'])
    await copyFile(join(output, 'target', name), join(binary, name));
  // The official summary lists librsvg; preserve it with upstream source only.
  await copyFile(join(legal, 'DISTRIBUTING-CUSTOM.md'), join(binary, 'THIRD-PARTY-NOTICES.md'));
  const library = 'lib/libvips-cpp.8.18.7.dylib';
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', join(binary, library)], {
      stdio: 'pipe',
    });
  } catch {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', join(binary, library)], {
      stdio: 'pipe',
    });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', join(binary, library)], {
      stdio: 'pipe',
    });
  }
  const { collectNativeNotices } = await import('../native-runtime-distribution.mjs');
  const notices = await collectNativeNotices({
    sourceRoot: root,
    archivesDirectory: cache,
    output: join(binary, 'LICENSES'),
  });
  const recipeHash = hash(await readFile(join(output, 'build/posix.sh')));
  const buildInfo = {
    schemaVersion: 1,
    identity: 'bambooshift-native-image-codecs',
    status: 'candidate-only',
    target: { platform: 'darwin', arch: 'arm64' },
    toolchain,
    upstreamRevision: catalog.upstreamRevision,
    buildRecipeSha256: recipeHash,
    recipePatchSha256: catalog.recipePatchSha256,
    sourceCatalogSha256: hash(catalogBytes),
    svgLoading: false,
    originalNpmArtifact: false,
    productionDependenciesChanged: false,
    releaseApproval: false,
  };
  await writeFile(join(binary, 'BUILD-INFO.json'), JSON.stringify(buildInfo, null, 2) + '\n');
  const sourceFiles = [
    'LICENSE',
    'scripts/desktop/native-codecs/build.mjs',
    'scripts/desktop/native-codecs/toolchain.mjs',
    'docs/native-codecs-ci.md',
    'scripts/desktop/native-codecs/run.sh',
    'scripts/desktop/native-codecs/archive.py',
    'scripts/desktop/archive-cache.mjs',
    'scripts/desktop/runtime-copy.mjs',
    'scripts/desktop/native-runtime-distribution.mjs',
    'scripts/dependency-notice-files.mjs',
    ...[
      'SOURCE-INPUTS-CANDIDATE.json',
      'NATIVE-NOTICES.json',
      'candidate-recipe.patch',
      'REBUILD.md',
      'BUILD-TOOLS.txt',
      'DISTRIBUTING-CUSTOM.md',
      'THIRD-PARTY-NOTICES.md',
      ...catalog.additionalLocalPatches.map((item) => item.file),
    ].map((name) => `legal/third-party/sharp-libvips-1.3.4/${name}`),
  ];
  for (const path of sourceFiles) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await copyFile(join(root, path), join(source, path));
  }
  await mkdir(join(source, 'source-cache'));
  for (const input of built.inputs)
    await writeFile(join(source, 'source-cache', input.filename), await sourceBytes(input, cache), {
      flag: 'wx',
    });
  await cp(join(binary, 'LICENSES'), join(source, 'LICENSES'), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const inventoryBytes = Buffer.from(JSON.stringify(await sourceInventory(source), null, 2) + '\n');
  await writeFile(join(source, 'SOURCE-MANIFEST.json'), inventoryBytes, { flag: 'wx' });
  const archive = (stage, filename) =>
    JSON.parse(
      execFileSync(
        join(tools, 'bin/python'),
        [
          join(dirname(script), 'archive.py'),
          stage,
          join(directory, filename),
          ...execFileSync('/bin/ls', ['-1', stage], { encoding: 'utf8' }).trim().split('\n'),
        ],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      ),
    );
  const binaryName = 'bambooshift-native-image-codecs-darwin-arm64-norsvg-candidate.tar.gz';
  const sourceName = 'bambooshift-native-image-codecs-corresponding-source.tar.gz';
  const native = archive(binary, binaryName),
    sources = archive(source, sourceName);
  const manifest = {
    schemaVersion: 1,
    identity: buildInfo.identity,
    target: buildInfo.target,
    toolchain,
    upstreamRevision: catalog.upstreamRevision,
    buildRecipeSha256: recipeHash,
    recipePatchSha256: catalog.recipePatchSha256,
    binary: {
      filename: binaryName,
      ...native,
      library: { path: library, sha256: hash(await readFile(join(binary, library))) },
      versions: {
        path: 'versions.json',
        sha256: hash(await readFile(join(binary, 'versions.json'))),
      },
    },
    source: { filename: sourceName, ...sources, inventorySha256: hash(inventoryBytes) },
    notices: {
      path: 'LICENSES/index.json',
      sha256: notices.indexSha256,
      sourceCatalogSha256: hash(catalogBytes),
      noticeCatalogSha256: hash(await readFile(join(legal, 'NATIVE-NOTICES.json'))),
    },
    releaseApproval: false,
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(directory, 'distribution.json'), bytes, { flag: 'wx' });
  console.log(
    JSON.stringify({ distributionManifestSha256: hash(bytes), native, sources, notices }),
  );
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'fetch') return offlineFetch(args[0]);
  const options = { jobs: 2, fetchMissing: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--fetch') options.fetchMissing = true;
    else if (['--output', '--cache', '--tools', '--jobs', '--profile'].includes(arg)) {
      if (!args[index + 1]) throw Error('Missing option value.');
      options[arg.slice(2)] = arg === '--jobs' ? Number(args[++index]) : args[++index];
    } else throw Error('Unknown build option.');
  }
  if (!options.output || !options.cache || (['build', 'package'].includes(mode) && !options.tools))
    throw Error(
      'Use prepare|build|package --output <build-path> --cache <verified-cache> [--tools <isolated-tools>] [--jobs 1|2] [--profile <reviewed-profile>] [--fetch].',
    );
  if (mode === 'prepare') return prepareCandidate(options);
  if (mode === 'build') return build(options);
  if (mode === 'package') return packageCandidate(options);
  throw Error('Unknown command.');
}

if (process.argv[1] && resolve(process.argv[1]) === script)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
