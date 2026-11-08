import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_NOTICE_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const licenseName =
  /^(?:licen[cs]e|copying|copyright|notice|authors|patents)(?:[._ -]|$)|^(?:third[-_ ]?party|thirdparty)[._ -].*(?:licen[cs]e|notice)/i;
const licenseDirectory =
  /^(?:licen[cs]es?|notices?|legal|third[-_ ]?party[-_ ]?(?:licen[cs]es?|notices?))$/i;
const skip = new Set(['node_modules', '.git', 'target', '__pycache__']);

export function inside(root, path) {
  const name = relative(root, path);
  return name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name);
}

export async function realDirectory(path) {
  if (!(await lstat(path)).isDirectory())
    throw Error('Dependency directory is not a real directory.');
  return realpath(path);
}

export async function guardedPath(root, path) {
  path = resolve(path);
  if (!inside(root, path)) throw Error('A dependency license escapes its package directory.');
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw Error('Dependency license paths cannot contain links.');
  }
  if (!inside(root, await realpath(path)))
    throw Error('A dependency path changed outside its package.');
  return path;
}

export async function boundedBytes(root, path, maximum = MAX_NOTICE_BYTES) {
  path = await guardedPath(root, path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maximum)
      throw Error('Dependency metadata or license exceeds its regular-file byte limit.');
    const bytes = await file.readFile();
    const after = await file.stat();
    const current = await lstat(await guardedPath(root, path));
    if (
      bytes.length > maximum ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== current.ino ||
      before.dev !== current.dev
    )
      throw Error('Dependency metadata or license changed during collection.');
    return bytes;
  } finally {
    await file.close();
  }
}

export async function licenseFiles(root, explicit) {
  const found = new Set();
  let visited = 0;
  async function walk(directory, depth = 0, legal = false) {
    if (depth > 24) throw Error('Dependency license nesting exceeds the collection limit.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 100000) throw Error('Dependency tree exceeds the collection limit.');
      const path = join(directory, entry.name);
      const selected = legal || licenseName.test(entry.name);
      if (entry.isSymbolicLink()) {
        if (selected || licenseDirectory.test(entry.name))
          throw Error('Dependency license files and directories cannot be symbolic links.');
        continue;
      }
      if (entry.isDirectory() && !skip.has(entry.name))
        await walk(path, depth + 1, legal || licenseDirectory.test(entry.name));
      else if (entry.isFile() && selected) found.add(path);
    }
  }
  await walk(root);
  if (explicit) found.add(await guardedPath(root, resolve(root, explicit)));
  // A few packages ship their complete MIT notice in README rather than LICENSE.
  // Preserve that whole document byte-for-byte, but never accept a license link alone.
  if (!found.size) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!/^readme(?:[._-]|$)/i.test(entry.name)) continue;
      if (!entry.isFile()) continue;
      const path = join(root, entry.name);
      const text = (await boundedBytes(root, path, 1024 * 1024))
        .toString('utf8')
        .replace(/\s+/g, ' ');
      if (
        /copyright/i.test(text) &&
        /permission is hereby granted,? free of charge/i.test(text) &&
        /use, copy, modify, merge, publish, distribute, sublicense, and\/or sell/i.test(text) &&
        /above copyright notice and this permission notice/i.test(text) &&
        /software is provided ["']as is["']/i.test(text) &&
        /fitness for a particular purpose and noninfringement/i.test(text) &&
        /liable for any claim, damages or other liability/i.test(text) &&
        /other dealings in the software\./i.test(text)
      )
        found.add(path);
    }
  }
  return [...found].sort();
}

export function safeRepository(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw.replace(/^git\+/, ''));
    if (
      !['https:', 'http:', 'git:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    if (url.hostname === 'localhost' || !url.hostname.includes('.')) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function declaredSpdx(value) {
  const text = typeof value === 'string' ? value : value?.type;
  return typeof text === 'string' &&
    text.length <= 256 &&
    !/^(?:SEE LICENSE|UNLICENSED)/i.test(text) &&
    /^[A-Za-z0-9.+() -]+$/.test(text)
    ? text
    : null;
}
