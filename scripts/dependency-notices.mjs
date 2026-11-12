import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  boundedBytes,
  declaredSpdx,
  guardedPath,
  licenseFiles,
  MAX_TOTAL_BYTES,
  realDirectory,
  safeRepository,
} from './dependency-notice-files.mjs';
import { readCargoNoticeMetadata } from './dependency-notice-cargo.mjs';
import { readNoticeSupplements, supplementFor } from './dependency-notice-supplements.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const packageName = (value) =>
  typeof value === 'string' &&
  /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(value) &&
  value.length < 200;
const packageVersion = (value) =>
  typeof value === 'string' &&
  /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(value) &&
  value.length < 200;

async function collectNpmPackages(sourceRoot, selected) {
  const bytes = await boundedBytes(
    sourceRoot,
    join(sourceRoot, 'package-lock.json'),
    16 * 1024 * 1024,
  );
  const lock = JSON.parse(bytes);
  if (lock.lockfileVersion !== 3 || !lock.packages?.[''])
    throw Error('Dependency notices require the checked-in npm v3 lock.');
  const requested = selected === undefined ? undefined : new Map();
  if (requested) {
    if (!Array.isArray(selected) || selected.length > 5000)
      throw Error('Bundled npm notice inputs must be an explicit package list.');
    for (const item of selected) {
      if (
        !item ||
        !packageName(item.name) ||
        !packageVersion(item.version) ||
        typeof item.packagePath !== 'string' ||
        !lock.packages[item.packagePath]
      )
        throw Error('A bundled npm notice input is not present in the current lock.');
      const previous = requested.get(item.packagePath);
      if (previous && (previous.name !== item.name || previous.version !== item.version))
        throw Error('Bundled npm notice inputs disagree about an installed package.');
      requested.set(item.packagePath, item);
    }
  }
  const packages = [],
    absentOptional = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (requested && !requested.has(path)) continue;
    if (
      !path.startsWith('node_modules/') ||
      path.split('/').some((p) => !p || p === '.' || p === '..') ||
      entry.link
    )
      throw Error('Linked or non-package npm dependencies require an explicit release review.');
    const directory = join(sourceRoot, path);
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (requested || (!entry.optional && !entry.devOptional))
        throw Error(
          `Required npm dependency is missing: ${path}. Run npm ci before collecting notices.`,
        );
      absentOptional.push({ name: path, version: entry.version });
      continue;
    }
    if (!info.isDirectory()) throw Error(`The npm dependency is not a real directory: ${path}.`);
    await guardedPath(sourceRoot, directory);
    const data = JSON.parse(
      await boundedBytes(directory, join(directory, 'package.json'), 1024 * 1024),
    );
    const expectedName = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 13);
    if (
      !packageName(data.name) ||
      data.name !== expectedName ||
      !packageVersion(data.version) ||
      data.version !== entry.version ||
      !entry.integrity
    )
      throw Error(`Installed npm dependency does not match the lock: ${path}. Run npm ci.`);
    if (
      requested &&
      (requested.get(path).name !== data.name || requested.get(path).version !== data.version)
    )
      throw Error(
        'A bundled npm notice input differs from the installed locked package. Rebuild both web applications.',
      );
    packages.push({
      ecosystem: 'npm',
      name: data.name,
      version: data.version,
      spdx: declaredSpdx(data.license),
      repository: safeRepository(data.repository),
      integrity: entry.integrity,
      directory,
      source: path,
    });
  }
  return { packages, absentOptional, lockSha256: hash(bytes) };
}

async function cargoPackages(metadata) {
  if (
    !metadata?.resolve?.nodes ||
    !Array.isArray(metadata.packages) ||
    !Array.isArray(metadata.workspace_members)
  )
    throw Error('Complete locked Cargo metadata is required; --no-deps metadata is insufficient.');
  const selected = new Set(metadata.resolve.nodes.map((node) => node.id));
  const own = new Set(metadata.workspace_members);
  const packages = [];
  for (const item of metadata.packages) {
    if (!selected.has(item.id) || own.has(item.id)) continue;
    if (
      !packageName(item.name) ||
      !packageVersion(item.version) ||
      !item.source?.startsWith('registry+https://')
    )
      throw Error('Non-registry Cargo dependencies require an explicit release review.');
    const directory = await realDirectory(dirname(item.manifest_path));
    await boundedBytes(directory, join(directory, basename(item.manifest_path)), 1024 * 1024);
    packages.push({
      ecosystem: 'cargo',
      name: item.name,
      version: item.version,
      spdx: declaredSpdx(item.license),
      repository: safeRepository(item.repository),
      directory,
      explicit: item.license_file,
    });
    selected.delete(item.id);
  }
  for (const id of own) selected.delete(id);
  if (selected.size)
    throw Error('Cargo metadata omitted resolved dependencies; refresh the locked host cache.');
  return packages;
}

/** Copy only real upstream legal files; no generated license substitutes or source paths. */
export async function collectDependencyNotices({
  sourceRoot = root,
  output = join(root, '.build/notices'),
  cargoMetadata,
  npmPackages,
  npmScope = 'bundled-web',
  strict = true,
} = {}) {
  if (!['bundled-web', 'bundled-runtime'].includes(npmScope))
    throw Error('Unsupported bundled dependency notice scope.');
  sourceRoot = await realDirectory(resolve(sourceRoot));
  output = resolve(output);
  try {
    await lstat(output);
    throw Error('The dependency notice destination already exists. Choose an empty directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const npm = await collectNpmPackages(sourceRoot, npmPackages);
  const supplements = await readNoticeSupplements(sourceRoot);
  const cargoLock = await boundedBytes(
    sourceRoot,
    join(sourceRoot, 'server/api/Cargo.lock'),
    16 * 1024 * 1024,
  );
  const cargo = cargoMetadata ?? (await readCargoNoticeMetadata(sourceRoot));
  const inputs = [...npm.packages, ...(await cargoPackages(cargo.metadata))].sort((a, b) =>
    `${a.ecosystem}/${a.name}/${a.version}/${a.source ?? ''}`.localeCompare(
      `${b.ecosystem}/${b.name}/${b.version}/${b.source ?? ''}`,
    ),
  );
  const stage = join(dirname(output), `.openbot-notices-${randomUUID()}`);
  await mkdir(stage, { recursive: true });
  let total = 0,
    fileCount = 0;
  const packages = [],
    missing = [];
  try {
    for (const item of inputs) {
      const key = `${item.ecosystem}/${item.name.replaceAll('/', '__')}@${item.version}-${hash(item.source ?? `${item.name}@${item.version}`).slice(0, 10)}`;
      const files = [];
      const originals = (await licenseFiles(item.directory, item.explicit)).map((path) => ({
        root: item.directory,
        path,
      }));
      const extra = await supplementFor(item, supplements);
      for (const file of [...originals, ...extra]) {
        const bytes = await boundedBytes(file.root, file.path);
        if (file.sha256 && hash(bytes) !== file.sha256)
          throw Error('A supplement legal file changed during collection.');
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!bytes.length) continue;
        total += bytes.length;
        if (total > MAX_TOTAL_BYTES)
          throw Error('Dependency legal texts exceed the total collection byte limit.');
        const source = file.url
          ? `upstream/${basename(file.path)}`
          : relative(item.directory, file.path).replaceAll('\\', '/');
        const target = `${key}/${source}`;
        await mkdir(dirname(join(stage, target)), { recursive: true });
        await writeFile(join(stage, target), bytes, { flag: 'wx' });
        files.push({
          path: target,
          source,
          ...(file.url ? { upstream: file.url } : {}),
          bytes: bytes.length,
          sha256: hash(bytes),
        });
        fileCount++;
      }
      const record = {
        ecosystem: item.ecosystem,
        name: item.name,
        version: item.version,
        spdx: item.spdx,
        ...(item.repository ? { repository: item.repository } : {}),
        ...(item.integrity ? { integrity: item.integrity } : {}),
        files,
      };
      packages.push(record);
      if (!files.length)
        missing.push({
          ecosystem: item.ecosystem,
          name: item.name,
          version: item.version,
          reason:
            'No upstream license text was included in the installed dependency. Obtain the exact version upstream legal files before distribution.',
        });
    }
    if (
      hash(
        await boundedBytes(sourceRoot, join(sourceRoot, 'package-lock.json'), 16 * 1024 * 1024),
      ) !== npm.lockSha256 ||
      hash(
        await boundedBytes(sourceRoot, join(sourceRoot, 'server/api/Cargo.lock'), 16 * 1024 * 1024),
      ) !== hash(cargoLock)
    )
      throw Error(
        'A dependency lock changed during notice collection; retry with the frozen release inputs.',
      );
    const index = {
      version: 1,
      generatedAt: new Date().toISOString(),
      host: cargo.host,
      locks: { npm: npm.lockSha256, cargo: hash(cargoLock) },
      scope:
        npmPackages === undefined
          ? 'Audit of all installed npm packages and the locked Cargo host dependency graph, including development/build dependencies. Optional uninstalled npm packages are listed separately.'
          : `Exact supplied ${npmScope === 'bundled-runtime' ? 'worker runtime' : 'Web'} npm packages and the locked Cargo host dependency graph, including Rust development/build dependencies.`,
      npmScope: npmPackages === undefined ? 'all-installed-audit' : npmScope,
      externalRuntimeDependencies:
        npmScope === 'bundled-runtime'
          ? 'The desktop package includes the listed worker npm dependencies installed from runtime/package-lock.json. Node and optional native driver notices are carried separately.'
          : 'Worker npm dependencies remain external and are installed separately using runtime/package-lock.json. This notice index does not imply that node_modules are shipped in the service archive.',
      unchangedUpstreamTexts: true,
      packages,
      absentOptional: npm.absentOptional,
      missing,
    };
    await writeFile(join(stage, 'index.json'), JSON.stringify(index, null, 2) + '\n', {
      flag: 'wx',
    });
    await rename(stage, output);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  const summary = { packages: packages.length, files: fileCount, bytes: total, missing };
  if (strict && missing.length) {
    const error = Error(
      `Dependency notices are incomplete: ${missing.length} packages have no legal text. Review index.json and supply exact upstream notices before publishing.`,
    );
    error.summary = summary;
    throw error;
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--out'))
      throw Error('Usage: dependency-notices.mjs [--out directory]');
    console.log(JSON.stringify(await collectDependencyNotices({ output: args[1] })));
  } catch (error) {
    if (error.summary) console.error(JSON.stringify(error.summary));
    console.error(error.message);
    process.exitCode = 1;
  }
}
