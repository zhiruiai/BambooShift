import { lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { boundedBytes, guardedPath, realDirectory } from './dependency-notice-files.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const key = (item) => `${item.ecosystem}:${item.name}@${item.version}`;

export async function readNoticeSupplements(sourceRoot) {
  const directory = join(sourceRoot, 'legal/third-party');
  const path = join(directory, 'manifest.json');
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  await guardedPath(sourceRoot, directory);
  const root = await realDirectory(directory);
  const manifest = JSON.parse(await boundedBytes(root, path, 1024 * 1024));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length > 1000
  )
    throw Error('Unsupported dependency legal supplement manifest.');
  const records = new Map();
  for (const item of manifest.packages) {
    if (
      !['cargo', 'npm'].includes(item.ecosystem) ||
      (item.ecosystem === 'npm' && !/^sha512-[A-Za-z0-9+/]+=*$/.test(item.integrity ?? '')) ||
      typeof item.name !== 'string' ||
      typeof item.version !== 'string' ||
      !/^[a-f0-9]{40}$/.test(item.revision) ||
      !Array.isArray(item.files) ||
      !item.files.length ||
      item.files.length > 64 ||
      records.has(key(item))
    )
      throw Error('Dependency legal supplements must bind an exact package version and commit.');
    const repo = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(
      item.repository,
    );
    if (!repo)
      throw Error('Supplement repository must be an explicit public upstream GitHub repository.');
    const files = [];
    for (const file of item.files) {
      if (
        typeof file.path !== 'string' ||
        file.path.split(/[\\/]/).some((p) => !p || p === '.' || p === '..') ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        typeof file.url !== 'string'
      )
        throw Error('Supplement legal file paths and hashes must be explicit.');
      const url = new URL(file.url);
      const prefix = `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/${item.revision}/`;
      if (
        !url.href.startsWith(prefix) ||
        url.href !== file.url ||
        url.search ||
        url.hash ||
        !/^(?:(?:licen[cs]e|copying|notice|copyright)(?:[._-]|$)|third[-_]party[-_]notices?(?:[._-]|$))/i.test(basename(url.pathname))
      )
        throw Error('Supplement legal source must point to a fixed-commit upstream license file.');
      const path = await guardedPath(root, resolve(root, file.path));
      const bytes = await boundedBytes(root, path);
      if (digest(bytes) !== file.sha256)
        throw Error('A supplement legal file does not match its reviewed SHA-256.');
      files.push({ root, path, sha256: file.sha256, url: file.url });
    }
    records.set(key(item), { revision: item.revision, integrity: item.integrity, files });
  }
  return records;
}

export async function supplementFor(item, records) {
  const record = records.get(key(item));
  if (!record) return [];
  if (item.ecosystem === 'npm') {
    if (item.integrity !== record.integrity)
      throw Error('Supplement integrity differs from the locked npm publication.');
    return record.files;
  }
  const vcs = JSON.parse(
    await boundedBytes(item.directory, join(item.directory, '.cargo_vcs_info.json'), 16384),
  );
  if (vcs.git?.sha1 !== record.revision)
    throw Error('Supplement upstream revision differs from the locked crate publication.');
  return record.files;
}
