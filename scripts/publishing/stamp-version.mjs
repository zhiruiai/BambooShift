import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '../..');
const stableVersion = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

function replaceField(contents, field, value, path) {
  const [match, duplicate] = contents.matchAll(field);
  if (!match || duplicate) throw new Error(`Expected one version field in ${path}.`);
  const [old, prefix, suffix = ''] = match;
  return (
    contents.slice(0, match.index) +
    prefix +
    value +
    suffix +
    contents.slice(match.index + old.length)
  );
}

export async function stampVersion(version, root = projectRoot) {
  const build = /^0\.0\.([1-9][0-9]{0,8})$/.exec(version)?.[1];
  if (!build) throw new Error('The release version must be 0.0.N with a positive patch number.');

  const updates = [];
  async function update(path, transform) {
    const original = await readFile(join(root, path), 'utf8');
    const contents = transform(original);
    if (contents !== original) updates.push({ path, contents });
  }

  const setVersion = (manifest, path) => {
    if (!stableVersion.test(manifest?.version ?? ''))
      throw new Error(`Missing or invalid project version in ${path}.`);
    manifest.version = version;
  };
  for (const path of ['package.json', 'package-lock.json', 'desktop/package.json']) {
    await update(path, (contents) => {
      const manifest = JSON.parse(contents);
      setVersion(manifest, path);
      if (path === 'package-lock.json') setVersion(manifest.packages?.[''], path);
      return JSON.stringify(manifest, null, 2) + '\n';
    });
  }

  const rustManifest = 'server/api/Cargo.toml';
  await update(rustManifest, (contents) =>
    replaceField(
      contents,
      /^(version = ")[0-9]+\.[0-9]+\.[0-9]+(")(?=\r?$)/gm,
      version,
      rustManifest,
    ),
  );
  const rustLock = 'server/api/Cargo.lock';
  await update(rustLock, (contents) =>
    replaceField(
      contents,
      /(\[\[package\]\]\r?\nname = "openbot-backend"\r?\nversion = ")[0-9]+\.[0-9]+\.[0-9]+(")/g,
      version,
      rustLock,
    ),
  );
  const mobileManifest = 'mobile/pubspec.yaml';
  await update(mobileManifest, (contents) =>
    replaceField(
      contents,
      /^(version: )[0-9]+\.[0-9]+\.[0-9]+\+[0-9]+(?=\r?$)/gm,
      `${version}+${build}`,
      mobileManifest,
    ),
  );

  // Validate every version source before writing. Reapplying the stamp is safe after a failed run.
  for (const { path, contents } of updates) await writeFile(join(root, path), contents);
  return updates.map(({ path }) => path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node scripts/publishing/stamp-version.mjs 0.0.N');
  const version = process.argv[2];
  await stampVersion(version);
  console.log(`Release version: ${version}`);
}
