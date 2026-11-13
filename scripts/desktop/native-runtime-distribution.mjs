import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readToolchainReport } from './native-codecs/toolchain.mjs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { boundedBytes, realDirectory } from '../dependency-notice-files.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const legal = 'legal/third-party/sharp-libvips-1.3.4';
export const nativeSourceSupportPaths = Object.freeze([
  'LICENSE',
  'scripts/desktop/native-codecs/build.mjs',
  'scripts/desktop/native-codecs/run.sh',
  'scripts/desktop/native-codecs/archive.py',
  'scripts/desktop/archive-cache.mjs',
  'scripts/desktop/native-runtime-distribution.mjs',
  'scripts/dependency-notice-files.mjs',
  ...[
    'SOURCE-INPUTS-CANDIDATE.json',
    'NATIVE-NOTICES.json',
    'candidate-recipe.patch',
    'REBUILD.md',
    'BUILD-TOOLS.txt',
    'DISTRIBUTING-CUSTOM.md',
  ].map((name) => `${legal}/${name}`),
]);

export function validateReviewedSourceSupport(value, { manifestSha256, sourceArchiveSha256 }) {
  if (value === undefined) return undefined;
  if (
    value?.schemaVersion !== 1 ||
    value.distributionManifestSha256 !== manifestSha256 ||
    value.sourceArchiveSha256 !== sourceArchiveSha256 ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    !Array.isArray(value.files) ||
    value.files.length !== nativeSourceSupportPaths.length ||
    new Set(value.files.map((file) => file.path)).size !== nativeSourceSupportPaths.length ||
    value.files.some(
      (file) =>
        !nativeSourceSupportPaths.includes(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256),
    )
  )
    throw Error(
      'Reviewed source support must bind this exact distribution and complete support inventory.',
    );
  return new Map(value.files.map((file) => [file.path, file.sha256]));
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safePath = (value) =>
  typeof value === 'string' &&
  value.length < 500 &&
  !/[:\\\x00-\x1f]/.test(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('-'));
const validFile = (file) =>
  safePath(file?.path) &&
  safePath(file?.archivePath) &&
  /^[a-f0-9]{64}$/.test(file.sha256) &&
  Number.isSafeInteger(file.bytes) &&
  file.bytes >= 0 &&
  file.bytes <= 2 * 1024 * 1024;

async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw Error('Native distribution output already exists; choose a fresh directory.');
}

function checkedCatalog(catalog, inputs) {
  const archives = inputs.inputs?.filter((item) => /\.tar\.(gz|xz)$/.test(item.filename));
  if (
    catalog.schemaVersion !== 1 ||
    inputs.schemaVersion !== 1 ||
    !Array.isArray(archives) ||
    !archives.length ||
    archives.length > 100 ||
    !Array.isArray(catalog.components) ||
    catalog.components.length !== archives.length
  )
    throw Error('Native legal catalog must cover the exact source archives.');
  const wanted = new Map(archives.map((item) => [item.component, item]));
  if (wanted.size !== archives.length) throw Error('Duplicate native source component.');
  for (const item of catalog.components) {
    const input = wanted.get(item?.component);
    if (
      !input ||
      !/^[a-z0-9-]+$/.test(item.component) ||
      !/^[a-zA-Z0-9._-]+$/.test(item.filename) ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes <= 0 ||
      item.bytes > 256 * 1024 * 1024 ||
      ['filename', 'sha256', 'bytes', 'url'].some((field) => item[field] !== input[field]) ||
      !Array.isArray(item.files) ||
      !item.files.length ||
      item.files.length > 500 ||
      item.files.some((file) => !validFile(file)) ||
      !item.files.some((file) => file.bytes > 0) ||
      new Set(item.files.map((file) => file.path)).size !== item.files.length ||
      new Set(item.files.map((file) => file.archivePath)).size !== item.files.length
    )
      throw Error('Native legal files must bind exact archives, safe paths, sizes and hashes.');
    wanted.delete(item.component);
  }
  if (wanted.size) throw Error('Native legal catalog omitted a source component.');
  return catalog.components;
}

/** Extract reviewed legal members without unpacking or executing upstream source trees. */
export async function collectNativeNotices({ sourceRoot = root, archivesDirectory, output } = {}) {
  sourceRoot = await realDirectory(resolve(sourceRoot));
  archivesDirectory = await realDirectory(resolve(archivesDirectory));
  output = resolve(output);
  await absent(output);
  const catalogBytes = await boundedBytes(
    sourceRoot,
    join(sourceRoot, legal, 'NATIVE-NOTICES.json'),
  );
  const inputBytes = await boundedBytes(
    sourceRoot,
    join(sourceRoot, legal, 'SOURCE-INPUTS-CANDIDATE.json'),
  );
  const components = checkedCatalog(JSON.parse(catalogBytes), JSON.parse(inputBytes));
  const stage = join(dirname(output), `.native-notices-${randomUUID()}`);
  await mkdir(stage, { recursive: true });
  const records = [];
  let count = 0,
    total = 0;
  try {
    for (const item of components) {
      const archive = await boundedBytes(
        archivesDirectory,
        join(archivesDirectory, item.filename),
        item.bytes,
      );
      if (archive.length !== item.bytes || digest(archive) !== item.sha256)
        throw Error('A native source archive does not match its reviewed identity.');
      // Read a private verified copy so a changing cache cannot alter tar's input.
      const temporary = join(stage, '.verified-source');
      await writeFile(temporary, archive, { flag: 'wx', mode: 0o600 });
      const listing = await execute('tar', ['-tf', temporary], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60000,
      });
      const members = listing.stdout.split('\n');
      const files = [];
      for (const file of item.files) {
        if (members.filter((member) => member === file.archivePath).length !== 1)
          throw Error('A reviewed native legal member is missing or ambiguous.');
        const { stdout: bytes } = await execute(
          'tar',
          ['-xOf', temporary, '--', file.archivePath],
          {
            encoding: 'buffer',
            maxBuffer: 2 * 1024 * 1024,
            timeout: 60000,
          },
        );
        if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
          throw Error('A native legal member does not match its reviewed bytes.');
        total += bytes.length;
        if (total > 32 * 1024 * 1024)
          throw Error('Native legal collection exceeds its byte limit.');
        const path = `${item.component}/${file.path}`;
        await mkdir(dirname(join(stage, path)), { recursive: true });
        await writeFile(join(stage, path), bytes, { flag: 'wx' });
        files.push({ path, source: file.archivePath, bytes: bytes.length, sha256: file.sha256 });
        count++;
      }
      await rm(temporary);
      records.push({
        component: item.component,
        archive: { filename: item.filename, url: item.url, sha256: item.sha256, bytes: item.bytes },
        files,
      });
    }
    const index = {
      schemaVersion: 1,
      identity: 'bambooshift-source-built-native-image-codecs',
      scope:
        'Original legal texts and referenced source notices; full per-file copyrights remain in the accompanying original source archives. This is not the official npm publication or a release approval.',
      sourceCatalogSha256: digest(inputBytes),
      noticeCatalogSha256: digest(catalogBytes),
      unchangedUpstreamTexts: true,
      components: records,
    };
    const bytes = Buffer.from(JSON.stringify(index, null, 2) + '\n');
    await writeFile(join(stage, 'index.json'), bytes, { flag: 'wx' });
    await rename(stage, output);
    return { components: records.length, files: count, bytes: total, indexSha256: digest(bytes) };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inventoryFile = (file) =>
  safePath(file?.path) &&
  sha(file.sha256) &&
  Number.isSafeInteger(file.bytes) &&
  file.bytes >= 0 &&
  file.bytes <= 256 * 1024 * 1024;

async function tarMember(archive, path, maxBuffer = 4 * 1024 * 1024) {
  return (
    await execute('tar', ['-xOf', archive, '--', path], {
      encoding: 'buffer',
      maxBuffer,
      timeout: 120000,
    })
  ).stdout;
}

async function tarListing(archive) {
  const { stdout } = await execute('tar', ['-tf', archive], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120000,
  });
  const members = stdout.split('\n').filter(Boolean);
  if (
    members.length > 10000 ||
    new Set(members).size !== members.length ||
    members.some((member) => !safePath(member.replace(/\/$/, '')))
  )
    throw Error('Native archive contains unsafe or ambiguous member names.');
  return members;
}

async function verifyMembers(archive, members, files) {
  const expected = new Map(files.map((file) => [file.path, file]));
  if (!files.length || files.some((file) => !inventoryFile(file)) || expected.size !== files.length)
    throw Error('Native source inventory requires unique bounded file identities.');
  const ordered = members.filter((member) => expected.has(member));
  if (ordered.length !== files.length) throw Error('Native archive is missing required materials.');
  const size = files.reduce((total, file) => total + file.bytes, 0);
  if (size > 512 * 1024 * 1024) throw Error('Native material inventory exceeds its byte limit.');
  // tar emits selected members in archive order. Hash each original segment, not a decoded string.
  const { stdout } = await execute('tar', ['-xOf', archive, '--', ...ordered], {
    encoding: 'buffer',
    maxBuffer: size + 1,
    timeout: 120000,
  });
  let offset = 0;
  for (const path of ordered) {
    const file = expected.get(path),
      bytes = stdout.subarray(offset, offset + file.bytes);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw Error('Native archive material bytes differ from the reviewed inventory.');
    offset += file.bytes;
  }
  if (offset !== stdout.length) throw Error('Native archive contains unexpected material bytes.');
}

/** Verify an independently pinned custom distribution; this never approves publication. */
export async function verifyNativeDistribution({
  manifestPath,
  artifactsDirectory = dirname(manifestPath),
  expectedManifestSha256,
  reviewedSourceSupport,
  sourceRoot = root,
} = {}) {
  sourceRoot = await realDirectory(resolve(sourceRoot));
  const manifestRelativePath = relative(resolve(artifactsDirectory), resolve(manifestPath));
  artifactsDirectory = await realDirectory(resolve(artifactsDirectory));
  const manifestBytes = await boundedBytes(
    artifactsDirectory,
    resolve(artifactsDirectory, manifestRelativePath),
    4 * 1024 * 1024,
  );
  if (!sha(expectedManifestSha256) || digest(manifestBytes) !== expectedManifestSha256)
    throw Error('Custom native distribution requires an independently reviewed manifest hash.');
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.identity !== 'bambooshift-native-image-codecs' ||
    manifest.target?.platform !== 'darwin' ||
    manifest.target?.arch !== 'arm64' ||
    !sha(manifest.buildRecipeSha256) ||
    !sha(manifest.recipePatchSha256) ||
    manifest.binary?.library?.path !== 'lib/libvips-cpp.8.18.7.dylib' ||
    !sha(manifest.binary.library.sha256) ||
    manifest.binary?.versions?.path !== 'versions.json' ||
    !sha(manifest.binary.versions.sha256) ||
    !sha(manifest.source?.inventorySha256) ||
    manifest.notices?.path !== 'LICENSES/index.json' ||
    !sha(manifest.notices.sha256)
  )
    throw Error('Unsupported custom native distribution identity.');
  const inputBytes = await boundedBytes(
    sourceRoot,
    join(sourceRoot, legal, 'SOURCE-INPUTS-CANDIDATE.json'),
  );
  const catalogBytes = await boundedBytes(
    sourceRoot,
    join(sourceRoot, legal, 'NATIVE-NOTICES.json'),
  );
  const inputs = JSON.parse(inputBytes),
    catalog = JSON.parse(catalogBytes);
  checkedCatalog(catalog, inputs);
  if (
    digest(inputBytes) !== manifest.notices.sourceCatalogSha256 ||
    digest(catalogBytes) !== manifest.notices.noticeCatalogSha256 ||
    inputs.upstreamRevision !== manifest.upstreamRevision ||
    inputs.recipePatchSha256 !== manifest.recipePatchSha256
  )
    throw Error('Custom native distribution does not match the reviewed source catalogs.');
  const temporary = await mkdtemp(join(tmpdir(), 'bambooshift-native-verification-'));
  try {
    const archives = {};
    for (const type of ['binary', 'source']) {
      const item = manifest[type];
      if (
        !/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(item.filename) ||
        !sha(item.sha256) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes <= 0 ||
        item.bytes > 512 * 1024 * 1024
      )
        throw Error('Custom native archives require bounded names, sizes and hashes.');
      const bytes = await boundedBytes(
        artifactsDirectory,
        join(artifactsDirectory, item.filename),
        item.bytes,
      );
      if (bytes.length !== item.bytes || digest(bytes) !== item.sha256)
        throw Error('Custom native archive checksum differs from the reviewed distribution.');
      archives[type] = join(temporary, type + '.tar.gz');
      await writeFile(archives[type], bytes, { flag: 'wx', mode: 0o600 });
    }
    const sourceMembers = await tarListing(archives.source);
    const { stdout: sourceTypes } = await execute('tar', ['-tvf', archives.source], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120000,
    });
    if (
      sourceTypes
        .split('\n')
        .filter(Boolean)
        .some((line) => !['-', 'd'].includes(line[0]))
    )
      throw Error('Corresponding source cannot contain links or special files.');
    const inventoryBytes = await tarMember(archives.source, 'SOURCE-MANIFEST.json');
    if (digest(inventoryBytes) !== manifest.source.inventorySha256)
      throw Error('Corresponding source inventory checksum differs.');
    const inventory = JSON.parse(inventoryBytes);
    if (inventory.version !== 1 || !Array.isArray(inventory.files))
      throw Error('Invalid corresponding source inventory.');
    const actualFiles = sourceMembers.filter(
      (path) => !path.endsWith('/') && path !== 'SOURCE-MANIFEST.json',
    );
    if (
      actualFiles.length !== inventory.files.length ||
      actualFiles.some((path) => !inventory.files.some((file) => file.path === path))
    )
      throw Error('Corresponding source inventory does not cover every file.');
    await verifyMembers(archives.source, sourceMembers, inventory.files);
    const sourceFiles = new Map(inventory.files.map((file) => [file.path, file]));
    const requireSource = (path, sha256, bytes) => {
      const file = sourceFiles.get(path);
      if (!file || file.sha256 !== sha256 || (bytes !== undefined && file.bytes !== bytes))
        throw Error('Corresponding source is missing or changed a required build input.');
    };
    for (const item of [...inputs.inputs, ...(inputs.buildInputs ?? [])])
      requireSource(`source-cache/${item.filename}`, item.sha256, item.bytes);
    for (const item of inputs.additionalLocalPatches ?? [])
      requireSource(`${legal}/${item.file}`, item.sha256);
    const reviewedSupport = validateReviewedSourceSupport(reviewedSourceSupport, {
      manifestSha256: expectedManifestSha256,
      sourceArchiveSha256: manifest.source.sha256,
    });
    for (const path of nativeSourceSupportPaths)
      requireSource(
        path,
        reviewedSupport?.get(path) ??
          digest(await boundedBytes(sourceRoot, join(sourceRoot, path))),
      );
    const binaryMembers = await tarListing(archives.binary);
    for (const item of [manifest.binary.library, manifest.binary.versions]) {
      if (
        binaryMembers.filter((path) => path === item.path).length !== 1 ||
        digest(await tarMember(archives.binary, item.path, 128 * 1024 * 1024)) !== item.sha256
      )
        throw Error('Custom library or version metadata does not match the distribution.');
    }
    const versions = JSON.parse(await tarMember(archives.binary, manifest.binary.versions.path));
    if (versions.vips !== '8.18.7' || Object.hasOwn(versions, 'rsvg'))
      throw Error('Custom version metadata must identify the no-rsvg build.');
    const buildInfo = JSON.parse(await tarMember(archives.binary, 'BUILD-INFO.json'));
    if (
      buildInfo.identity !== manifest.identity ||
      buildInfo.target?.platform !== manifest.target.platform ||
      buildInfo.target?.arch !== manifest.target.arch ||
      buildInfo.buildRecipeSha256 !== manifest.buildRecipeSha256 ||
      buildInfo.sourceCatalogSha256 !== manifest.notices.sourceCatalogSha256 ||
      buildInfo.recipePatchSha256 !== manifest.recipePatchSha256 ||
      buildInfo.svgLoading !== false ||
      buildInfo.originalNpmArtifact !== false
    )
      throw Error('Native build provenance differs from the custom distribution.');
    if (manifest.toolchain !== undefined || buildInfo.toolchain !== undefined) {
      const toolchain = readToolchainReport(manifest.toolchain);
      if (JSON.stringify(toolchain) !== JSON.stringify(readToolchainReport(buildInfo.toolchain)))
        throw Error('Build and distribution toolchain provenance differs.');
      const helper = 'scripts/desktop/native-codecs/toolchain.mjs';
      requireSource(helper, digest(await boundedBytes(sourceRoot, join(sourceRoot, helper))));
    }
    const legalBytes = await tarMember(archives.binary, manifest.notices.path);
    if (digest(legalBytes) !== manifest.notices.sha256)
      throw Error('Native notice index checksum differs.');
    requireSource(manifest.notices.path, digest(legalBytes), legalBytes.length);
    const notices = JSON.parse(legalBytes);
    if (
      notices.schemaVersion !== 1 ||
      notices.identity !== 'bambooshift-source-built-native-image-codecs' ||
      notices.unchangedUpstreamTexts !== true ||
      !Array.isArray(notices.components) ||
      notices.components.length !== catalog.components.length ||
      notices.sourceCatalogSha256 !== digest(inputBytes) ||
      notices.noticeCatalogSha256 !== digest(catalogBytes)
    )
      throw Error('Native notices refer to different source inputs.');
    const files = catalog.components.flatMap((item) =>
      item.files.map((file) => ({
        path: `LICENSES/${item.component}/${file.path}`,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
    );
    const indexed = notices.components.flatMap((item) => item.files ?? []);
    if (
      indexed.length !== files.length ||
      new Set(indexed.map((file) => file.path)).size !== files.length ||
      files.some(
        (file) =>
          !indexed.some(
            (entry) =>
              `LICENSES/${entry.path}` === file.path &&
              entry.bytes === file.bytes &&
              entry.sha256 === file.sha256,
          ),
      )
    )
      throw Error('Native notice index does not describe the complete reviewed collection.');
    for (const file of files) requireSource(file.path, file.sha256, file.bytes);
    await verifyMembers(archives.binary, binaryMembers, files);
    const attribution = `${legal}/DISTRIBUTING-CUSTOM.md`;
    const attributionBytes = await boundedBytes(sourceRoot, join(sourceRoot, attribution));
    if (
      digest(await tarMember(archives.binary, 'THIRD-PARTY-NOTICES.md')) !==
      digest(attributionBytes)
    )
      throw Error('Custom binary must include its actual component and attribution notice.');
    return {
      identity: manifest.identity,
      target: manifest.target,
      manifestSha256: expectedManifestSha256,
      librarySha256: manifest.binary.library.sha256,
      sourceFiles: inventory.files.length,
      sourceInputs: inputs.inputs.length + (inputs.buildInputs?.length ?? 0),
      legalFiles: files.length,
      releaseApproval: false,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archivesDirectory, output, ...extra] = process.argv.slice(2);
  if (!archivesDirectory || !output || extra.length)
    throw Error(
      'Usage: native-runtime-distribution.mjs <verified-archive-cache> <new-notices-directory>',
    );
  console.log(JSON.stringify(await collectNativeNotices({ archivesDirectory, output })));
}
