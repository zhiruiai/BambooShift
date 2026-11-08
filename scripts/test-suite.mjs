import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv[2];
const roots = {
  web: ['web/src'],
  runtime: ['server/workers', 'scripts', 'shared'],
  browser: ['web/src/browserTests', 'server/workers/computer-runtime/tests'],
};
if (!Object.hasOwn(roots, mode)) throw Error('Usage: test-suite.mjs web|runtime|browser');

async function collect(directory) {
  const tests = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (
      entry.isSymbolicLink() ||
      ['node_modules', 'target', 'build', '.build'].includes(entry.name)
    )
      continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...(await collect(file)));
    else if (/\.test\.(?:ts|tsx|mjs|cjs|js)$/.test(entry.name)) {
      const browser = /(?:^|\/)(?:browserTests\/|[^/]*\.browser\.test\.)/.test(file);
      const browserRelated =
        browser || /\/(?:browser-engine|browser-download)\.test\.ts$/.test(file);
      if (mode === 'browser' ? browserRelated : !browser) tests.push(file);
    }
  }
  return tests;
}

const files = (await Promise.all(roots[mode].map(collect))).flat().sort();
if (!files.length) throw Error('No tests found for the selected suite.');
const child = spawn(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=4',
    ...files.map((file) => resolve(root, file)),
  ],
  {
    cwd: root,
    env: { ...process.env, ...(mode === 'browser' ? { OPENBOT_BROWSER_TEST: '1' } : {}) },
    stdio: 'inherit',
  },
);
const signals = ['SIGINT', 'SIGTERM'];
const handlers = signals.map((signal) => {
  const handler = () => child.kill(signal);
  process.on(signal, handler);
  return handler;
});
try {
  process.exitCode = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code) => done(code ?? 1));
  });
} finally {
  signals.forEach((signal, index) => process.off(signal, handlers[index]));
}
