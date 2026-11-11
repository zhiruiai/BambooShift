import { open, readdir, readFile, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, extname } from 'node:path';
import { userInfo, homedir } from 'node:os';
import { isIP } from 'node:net';

export const releaseFiles = [
  'README.md',
  'README.en.md',
  'README.zh-CN.md',
  'LICENSE',
  'NOTICE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'THIRD_PARTY.md',
  '.gitignore',
  '.npmrc',
  '.env.example',
  '.prettierignore',
  '.prettierrc.json',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];
export const releaseRoots = [
  '.github',
  'web',
  'operations',
  'shared',
  'server',
  'scripts',
  'desktop',
  'mobile',
  'docs',
  'legal',
];
const ignored = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  '.build',
  '.local',
  '.tools',
  'data',
  'private',
  '.git',
  '.idea',
  '.DS_Store',
  '.dart_tool',
  '.gradle',
  'Pods',
  '.symlinks',
  'ephemeral',
  '__pycache__',
  'vendor',
  'xcuserdata',
  '.flutter-plugins',
  '.flutter-plugins-dependencies',
]);
const generated = new Set([
  'mobile/android/local.properties',
  'mobile/config/private.json',
  'mobile/android/key.properties',
  'mobile/android/gradlew',
  'mobile/android/gradlew.bat',
  'mobile/android/gradle/wrapper/gradle-wrapper.jar',
  'mobile/ios/Flutter/Generated.xcconfig',
  'mobile/ios/Flutter/flutter_export_environment.sh',
  'mobile/android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java',
  'mobile/ios/Runner/GeneratedPluginRegistrant.h',
  'mobile/ios/Runner/GeneratedPluginRegistrant.m',
]);
export const reviewedShowcaseFiles = new Set([
  'docs/showcase/index.html',
  'docs/showcase/zh.html',
  'docs/showcase/showcase.css',
  'docs/showcase/panda.svg',
  ...['en', 'zh'].flatMap((language) =>
    ['index.html', 'assets/flight.css', 'assets/ship.svg', 'src/flight.mjs', 'src/physics.mjs'].map(
      (path) => 'docs/showcase/' + language + '/' + path,
    ),
  ),
]);
const documentationText = new Set(['.md', '.json']);
const reviewedDocumentationMedia = new Set([
  'docs/demo/avatar-states.en.gif',
  'docs/demo/avatar-states.gif',
  'docs/demo/avatar-themes.en.gif',
  'docs/demo/avatar-themes.gif',
  'docs/demo/chat-choices.en.gif',
  'docs/demo/chat-choices.gif',
  'docs/demo/founder-debate.en.gif',
  'docs/demo/founder-debate.gif',
  'docs/demo/group-chat.en.gif',
  'docs/demo/group-chat.gif',
  'docs/demo/meeting-actions.en.gif',
  'docs/demo/meeting-actions.gif',
  'docs/demo/orbital-landing.en.gif',
  'docs/demo/orbital-landing.gif',
  'docs/demo/pizza-fractions.en.gif',
  'docs/demo/pizza-fractions.gif',
  'docs/demo/scheduled-brief.en.gif',
  'docs/demo/scheduled-brief.gif',
  'docs/demo/short-video-storyboard.en.gif',
  'docs/demo/short-video-storyboard.gif',
  'docs/demo/skill-library.en.gif',
  'docs/demo/skill-library.gif',
  'docs/demo/smart-bot.en.gif',
  'docs/demo/smart-bot.gif',
  'docs/demo/smart-theme.en.gif',
  'docs/demo/smart-theme.gif',
  'docs/demo/team-templates.en.gif',
  'docs/demo/team-templates.gif',
  'docs/demo/web-research.en.gif',
  'docs/demo/web-research.gif',
  'docs/demo/website-preview.en.gif',
  'docs/demo/website-preview.gif',
  'docs/evidence/gui/bot-team-workspace.jpg',
  'docs/evidence/gui/independent-operations-users.jpg',
  'docs/evidence/gui/pi-team-proposal.jpg',
  'docs/evidence/gui/platform-user-management.jpg',
  'docs/evidence/gui/reference-created-template-bot.png',
  'docs/evidence/gui/reference-html-preview.png',
  'docs/evidence/gui/reference-new-chat.png',
  'docs/evidence/gui/reference-notifications.png',
  'docs/evidence/gui/reference-routine-transfer.png',
  'docs/evidence/gui/reference-settings-en.png',
  'docs/evidence/gui/reference-settings-zh-dark.png',
  'docs/evidence/gui/reference-starter-templates.png',
  'docs/evidence/gui/reference-updates.png',
  'docs/evidence/gui/settings-en-pandas.jpg',
  'docs/evidence/gui/settings-zh-dinosaurs-dark.jpg',
]);
export async function regularBytes(path, maximum = 32 * 1024 * 1024) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > maximum)
      throw Error('Release input is not a bounded regular file.');
    const bytes = await fd.readFile();
    const after = await fd.stat();
    if (bytes.length > maximum || info.size !== after.size || info.mtimeMs !== after.mtimeMs)
      throw Error('Release input changed while being read.');
    return bytes;
  } finally {
    await fd.close();
  }
}
export async function collectReleaseFiles(root) {
  const files = [];
  async function walk(path) {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw Error(`Release input cannot be a symbolic link: ${path}`);
    if (info.isDirectory()) {
      for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
        const child = `${path}/${entry.name}`;
        if (
          ignored.has(entry.name) ||
          generated.has(child) ||
          child === 'docs/screenshots' ||
          entry.name.endsWith('.log') ||
          entry.name.endsWith('.iml') ||
          entry.name.endsWith('.tsbuildinfo') ||
          entry.name.endsWith('.private.json') ||
          /\.(?:jks|keystore|p12|pfx|mobileprovision)$/i.test(entry.name) ||
          (entry.name.startsWith('.env') && entry.name !== '.env.example')
        )
          continue;
        if (child.startsWith('docs/showcase/') && !entry.isDirectory()) {
          if (!reviewedShowcaseFiles.has(child)) continue;
        } else if (
          child.startsWith('docs/') &&
          !entry.isDirectory() &&
          !documentationText.has(extname(child).toLowerCase()) &&
          !reviewedDocumentationMedia.has(child)
        )
          continue;
        await walk(child);
      }
    } else if (info.isFile()) files.push(path);
    else throw Error(`Release input has an unsupported file type: ${path}`);
  }
  for (const path of releaseFiles) await walk(path);
  for (const path of releaseRoots) await walk(path);
  return files.sort();
}
export async function privateReleaseValues(root) {
  const values = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.length >= 6) values.add(value);
  };
  add(homedir());
  function endpoint(key, item) {
    if (!/(?:host|domain|url|origin|endpoint|bind|address|listen)$/i.test(key) || /\s/.test(item)) return;
    let url;
    try {
      url = new URL(item.includes('://') ? item : 'http://' + item);
    } catch {
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host || /(?:^|\.)(?:example\.(?:com|net|org)|localhost|test|invalid|example)$/.test(host))
      return;
    if (/^(?:127\.|0\.0\.0\.0$|::1$|::$)/.test(host)) {
      if (url.port && !['3000', '3001', '3002', '5173', '5174'].includes(url.port)) add(url.host);
      return;
    }
    if (isIP(host) || /^(?:host|domain|sandboxAddress|webOrigin|controlOrigin)$/i.test(key)) add(host);
    if (url.port) add(url.host);
  }
  function privateFields(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== 'string') {
        privateFields(item);
      } else if (
        /^(?:apiKey|accessToken|refreshToken|trafficAccessToken|envdAccessToken|clientSecret|password|token|secret)$/i.test(
          key,
        ) ||
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)
      ) {
        add(item);
      } else {
        endpoint(key, item);
      }
    }
  }
  try {
    const redaction = JSON.parse(
      await regularBytes(join(root, 'config/private/redaction.private.json'), 256 * 1024),
    );
    // A local redaction profile opts into checking the owner's name; CI usernames are often generic.
    add(userInfo().username.length >= 6 ? userInfo().username : undefined);
    for (const value of redaction.privateValues || []) add(value);
  } catch (error) {
    if (error.code !== 'ENOENT') throw Error('Private redaction settings could not be read.');
  }
  async function privateConfigs(path, depth = 0) {
    if (depth > 5) throw Error('Private configuration nesting exceeds the release-check limit.');
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw Error('Private configuration cannot contain links.');
      const child = join(path, entry.name);
      if (entry.isDirectory()) await privateConfigs(child, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.json'))
        privateFields(JSON.parse(await regularBytes(child, 256 * 1024)));
    }
  }
  await privateConfigs(join(root, 'config/private'));
  for (const file of ['services.json', 'cube-sandbox.json', 'cloud.json', 'connection.json']) {
    try {
      privateFields(JSON.parse(await regularBytes(join(root, 'data/computer', file), 256 * 1024)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('Private computer settings could not be checked.');
    }
  }
  // Read model credentials only from their documented config files, never account codes or databases.
  try {
    for (const entry of await readdir(join(root, 'data/spaces'), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9-]{36}$/.test(entry.name))
        continue;
      try {
        privateFields(
          JSON.parse(
            await regularBytes(
              join(root, 'data/spaces', entry.name, 'config/models.private.json'),
              256 * 1024,
            ),
          ),
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw Error('Private model settings could not be checked.');
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return [...values];
}
export function releaseFindings(path, bytes, privateValues) {
  const text = bytes.toString('utf8');
  const findings = [];
  for (const [index, line] of text.split('\n').entries()) {
    const privateValue = privateValues.some((value) => line.includes(value));
    if (
      privateValue ||
      /\bsk-[A-Za-z0-9]{24,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)
    )
      findings.push({ path, line: index + 1, rule: privateValue ? 'private-value' : 'credential' });
  }
  return findings;
}
