import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('Usage: node scripts/sync-app-catalog.mjs [--check]');
}
const check = args[0] === '--check';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('shared/app-providers.json', root), 'utf8');
const catalog = source.replaceAll('\r\n', '\n');
const providers = JSON.parse(catalog);
if (!Array.isArray(providers) || providers.length === 0) {
  throw new Error('The app provider catalog must be a nonempty array.');
}
const ids = providers.map((provider) => provider?.id);
if (
  ids.some((id) => typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) ||
  new Set(ids).size !== ids.length
) {
  throw new Error('The app provider catalog must use unique lowercase provider IDs.');
}
const dartIds = [
  '// Generated from shared/app-providers.json. Run npm run sync:app-catalog.',
  '',
  'const appProviderIds = {',
  ...ids.map((id) => `  '${id}',`),
  '};',
  '',
].join('\n');
const outputs = [
  ['mobile/assets/apps/providers.json', catalog],
  ['mobile/lib/features/apps/app_catalog_ids.g.dart', dartIds],
];
for (const [path, content] of outputs) {
  const destination = new URL(path, root);
  const previous = await readFile(destination, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (previous.replaceAll('\r\n', '\n') === content) continue;
  if (check) {
    console.error(`${path} is out of date. Run npm run sync:app-catalog.`);
    process.exitCode = 1;
  } else {
    await writeFile(destination, content, 'utf8');
  }
}
