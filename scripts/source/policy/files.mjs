import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import testDirectories from './test-directories.json' with { type: 'json' };

export const SOURCE_ROOTS = [
  'web',
  'operations',
  'shared',
  'scripts',
  'desktop',
  'server',
  'mobile',
  'tests',
  'examples',
];
const extensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.py',
  '.sh',
  '.swift',
  '.rs',
  '.sql',
  '.dart',
  '.kt',
  '.java',
]);
export function isSourceFile(path) {
  return extensions.has(extname(path));
}

export function isTestTree(path) {
  const normalized = path.replaceAll('\\', '/');
  return testDirectories.some((directory) => normalized.startsWith(directory + '/'));
}

const ignored = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  '.build',
  '__pycache__',
  'vendor',
  '.dart_tool',
  '.gradle',
  'Pods',
  '.symlinks',
]);

export async function sourceFiles(root, inspectPath) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        inspectPath?.(relative(root, path));
        if (!isSourceFile(entry.name)) continue;
        const text = await readFile(path, 'utf8');
        files.push({
          path: relative(root, path),
          text,
          lines: text.split('\n').length - Number(text.endsWith('\n')),
        });
      }
    }
  }
  for (const directory of SOURCE_ROOTS) await walk(join(root, directory));
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
