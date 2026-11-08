import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { sourceFiles } from './policy/files.mjs';
import { privateReleaseValues, releaseFiles, releaseFindings } from './source-release-policy.mjs';

const root = resolve(import.meta.dirname, '../..');
// Flutter regenerates these ignored machine-local toolchain settings on each build.
const localGenerated = new Set([
  'mobile/ios/Flutter/flutter_export_environment.sh',
  'mobile/ios/Flutter/Generated.xcconfig',
  'mobile/android/local.properties',
  'mobile/config/private.json',
]);
const files = (await sourceFiles(root)).filter((file) => !localGenerated.has(file.path));
const privateValues = await privateReleaseValues(root);
const publicDataExtensions = new Set([
  '.md',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.example',
  '.arb',
  '.xml',
  '.plist',
  '.svg',
  '.webmanifest',
  '.txt',
]);
const ignoredDirectories = new Set([
  'private',
  'node_modules',
  'target',
  'dist',
  'build',
  '.build',
  '.tools',
  '.dart_tool',
  '.gradle',
  'Pods',
  '.git',
  '.symlinks',
  '.idea',
  'ephemeral',
  'vendor',
]);
async function documents(directory) {
  let entries;
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (localGenerated.has(path)) continue;
    if (entry.isDirectory()) await documents(path);
    else if (publicDataExtensions.has(extname(path)))
      files.push({ path, text: await readFile(join(root, path), 'utf8') });
  }
}
for (const directory of [
  'docs',
  'config',
  'web',
  'operations',
  'mobile',
  'desktop',
  'server',
  'shared',
  'scripts',
  '.github',
  'legal',
])
  await documents(directory);
for (const path of releaseFiles) {
  try {
    files.push({ path, text: await readFile(join(root, path), 'utf8') });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const violations = files.flatMap(({ path, text }) =>
  releaseFindings(path, Buffer.from(text), privateValues).map((finding) => ({
    ...finding,
    rule: finding.rule === 'private-value' ? 'private-configuration' : 'credential-material',
  })),
);
// Reports contain locations only. Never echo a matched secret or personal value.
if (process.argv.includes('--json'))
  console.log(
    JSON.stringify({ files: files.length, violations, passed: !violations.length }, null, 2),
  );
else {
  for (const item of violations)
    console.log(
      `${item.path}:${item.line} [${item.rule}] Move the value to private configuration.`,
    );
  console.log(
    `${files.length} publishable files checked; ${violations.length} private-value findings.`,
  );
}
process.exitCode = violations.length ? 1 : 0;
