import { posix } from 'node:path';
import ts from 'typescript';

import { isTestTree } from './files.mjs';

export function misplacedTestFile(path) {
  const name = path.replaceAll('\\', '/');
  if (isTestTree(name)) return false;
  const segments = name.split('/');
  const basename = segments.pop();
  return (
    segments.some((part) =>
      /^(?:__tests__|tests?|testSupport|browserTests|__fixtures__|fixtures?|__mocks__|mocks|test-results)$/i.test(
        part,
      ),
    ) ||
    /[._-](?:tests?|spec|fixture|mock)\./i.test(basename) ||
    /(?:Tests?|Fixture)\.(?:swift|kt|java|tsx?|json)$/.test(basename) ||
    /^test_[^/]+\.(?:py|rs)$/.test(basename)
  );
}

export function testDependencies(file) {
  const path = file.path.replaceAll('\\', '/');
  if (isTestTree(path) || !/test/i.test(file.text)) return [];
  const testInput = (name) => isTestTree(posix.join(posix.dirname(path), name));
  if (path.startsWith('server/api/src/') && path.endsWith('.rs')) {
    const issues = /^\s*#\[(?:tokio::)?test[(\]]/m.test(file.text) ? ['inline Rust test'] : [];
    // Cargo attaches private unit modules only in a test build.
    const runtime = file.text.replace(/#\[cfg\(test\)\]\s*#\[path\s*=\s*"[^"]+"\]/g, '');
    for (const match of runtime.matchAll(
      /(?:#\[path\s*=\s*|\binclude(?:_str|_bytes)?!\(\s*)"([^"]+)"/g,
    )) {
      if (testInput(match[1])) issues.push(match[1]);
    }
    return issues;
  }
  if (!/^(?:web\/|operations\/|shared\/|desktop\/|server\/workers\/)/.test(path)) return [];
  if (path.endsWith('.css')) {
    const references = file.text.matchAll(/(?:url\(\s*|@import\s+)["']?([^\s)"';]+)/gi);
    return [...references].map((match) => match[1]).filter(testInput);
  }
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return [];
  const imports = ts
    .preProcessFile(file.text, true, true)
    .importedFiles.map(({ fileName }) => fileName);
  for (const match of file.text.matchAll(
    /\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g,
  ))
    imports.push(match[1]);
  return imports.filter((name) => name.startsWith('.') && testInput(name));
}
