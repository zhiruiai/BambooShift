import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeMacLocalizations } from './client-localizations.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const platforms = new Set(['darwin', 'win32', 'linux']);
const architectures = new Set(['arm64', 'x64']);
const clientName = (platform) => (platform === 'win32' ? 'PandaMate' : 'OpenBot');
const licenseFiles = ['LICENSE', 'NOTICE', 'THIRD_PARTY.md'];
const entryFiles = [
  'package.json',
  'main.cjs',
  'preload.cjs',
  'remote-preload.cjs',
  'security.cjs',
  'session-policy.cjs',
  'input-permissions.cjs',
  'authorization.cjs',
  'shared-download.cjs',
  'notifications.cjs',
  'menus.cjs',
  'language.cjs',
];
const uiExtensions = new Set([
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
]);

export function parseClientArguments(
  argv,
  host = { platform: process.platform, arch: process.arch },
) {
  const options = { platform: host.platform, arch: host.arch, help: false, dryRun: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const [flag, ...rest] = argv[index].split('=');
    if (seen.has(flag)) throw new Error(`参数重复：${flag}`);
    seen.add(flag);
    if (flag === '--help' || flag === '-h' || flag === '--dry-run') {
      if (rest.length) throw new Error(`${flag} 不接受参数值。`);
      options[flag === '--dry-run' ? 'dryRun' : 'help'] = true;
    } else if (flag === '--platform' || flag === '--arch') {
      const value = rest.length ? rest.join('=') : argv[++index];
      if (!value || value.startsWith('-')) throw new Error(`${flag} 缺少参数值。`);
      options[flag.slice(2)] = value;
    } else throw new Error(`未知参数：${argv[index]}。运行 --help 查看用法。`);
  }
  if (!options.help && !platforms.has(options.platform))
    throw new Error('--platform 只支持 darwin、win32、linux。');
  if (!options.help && !architectures.has(options.arch))
    throw new Error('--arch 只支持 arm64、x64。');
  return options;
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19))
    throw new Error(
      '客户端构建需要 Node.js 22.19+；请使用 npm run client:package，由项目启动器选择兼容的 Node。',
    );
}

/** Only explicit client entrypoints and ordinary UI assets may enter the app archive. */
export async function collectClientFiles(source) {
  if ((await lstat(source)).isSymbolicLink()) throw new Error('desktop 目录不能是符号链接。');
  const root = await realpath(source);
  const selected = [];
  let totalBytes = 0;
  async function accept(path) {
    const full = join(root, path),
      stat = await lstat(full);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`客户端素材必须是普通文件：${path}`);
    totalBytes += stat.size;
    if (stat.size > 10 * 1024 * 1024 || totalBytes > 30 * 1024 * 1024 || selected.length >= 300)
      throw new Error('客户端静态文件超出打包上限，请检查是否混入服务数据。');
    selected.push(path);
  }
  for (const file of entryFiles) await accept(file);
  async function walk(path) {
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`客户端素材目录无效：${path}`);
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (
        entry.name.startsWith('.') ||
        ['node_modules', 'data', 'server', 'tests', 'test', '__tests__'].includes(entry.name) ||
        /\.(test|spec)\./i.test(entry.name)
      )
        continue;
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`客户端素材不允许符号链接：${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (uiExtensions.has(extname(entry.name).toLowerCase())) await accept(child);
      else throw new Error(`不支持的客户端素材类型：${child}`);
    }
  }
  await walk('ui');
  if (!selected.includes(join('ui', 'index.html'))) throw new Error('缺少 desktop/ui/index.html。');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (
    manifest.main !== 'main.cjs' ||
    manifest.name !== 'openbot-client' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version ?? '')
  )
    throw new Error('desktop/package.json 的入口、应用名或版本无效。');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (manifest[field] && Object.keys(manifest[field]).length)
      throw new Error('薄客户端不能包含服务端 npm 依赖，请先明确客户端依赖的打包方案。');
  }
  return { files: selected.map((file) => file.replaceAll('\\', '/')).sort(), manifest };
}

export async function ensureClientOutputDirectory() {
  // Reject a redirected output root before any mkdir, copy, cleanup, or packager overwrite.
  let current = projectRoot;
  for (const part of ['release', 'client']) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(`打包输出路径不是普通目录：${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
  return current;
}

function command(executable, args) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.on('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolveCommand()
        : reject(new Error(`${executable} 失败（${code}）：${stderr.trim()}`)),
    );
  });
}

async function makeIcon(platform, working) {
  const { default: sharp } = await import('sharp');
  const source = join(projectRoot, 'web', 'public', 'favicon.svg');
  const render = (size) => sharp(source, { density: 1152 }).resize(size, size).png().toBuffer();
  if (platform === 'darwin') {
    if (process.platform !== 'darwin')
      throw new Error('macOS 图标需要系统 iconutil，请在 macOS 上生成 macOS 客户端。');
    const iconset = join(working, 'OpenBot.iconset');
    await mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      await writeFile(join(iconset, `icon_${size}x${size}.png`), await render(size));
      await writeFile(join(iconset, `icon_${size}x${size}@2x.png`), await render(size * 2));
    }
    const icon = join(working, 'OpenBot.icns');
    await command('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon]);
    return icon;
  }
  if (platform === 'win32') {
    // Modern Windows ICO resources accept PNG payloads, including a 256px image.
    const sizes = [16, 32, 48, 64, 128, 256];
    const images = await Promise.all(sizes.map(render));
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach((image, index) => {
      const position = 6 + index * 16;
      header[position] = sizes[index] === 256 ? 0 : sizes[index];
      header[position + 1] = header[position];
      header.writeUInt16LE(1, position + 4);
      header.writeUInt16LE(32, position + 6);
      header.writeUInt32LE(image.length, position + 8);
      header.writeUInt32LE(offset, position + 12);
      offset += image.length;
    });
    const icon = join(working, 'OpenBot.ico');
    await writeFile(icon, Buffer.concat([header, ...images]));
    return icon;
  }
  return undefined; // Linux window icons belong to BrowserWindow, not Packager's icon option.
}

async function signLocalMacClient(app, electronVersion, working) {
  const { sign } = await import('@electron/osx-sign');
  // Ad-hoc code has no Apple Team ID. Permit its bundled Electron libraries while
  // retaining hardened runtime and V8 JIT. These are app entitlements, not TCC grants.
  const entitlements = join(working, 'client-entitlements.plist');
  const pluginEntitlements = join(working, 'client-plugin-entitlements.plist');
  const plist = (plugin) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
  ${plugin ? '<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>' : ''}
</dict></plist>
`;
  await writeFile(entitlements, plist(false));
  await writeFile(pluginEntitlements, plist(true));
  console.log('正在为本机测试签名并校验 macOS 客户端（ad-hoc）。');
  // osx-sign signs nested code before its containing bundle. Do not use --deep to sign.
  await sign({
    app,
    platform: 'darwin',
    version: electronVersion,
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    optionsForFile: (path) => ({
      entitlements: path.includes('(Plugin).app') ? pluginEntitlements : entitlements,
      hardenedRuntime: true,
      timestamp: 'none',
    }),
  });
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}

/** Publish only a completed bundle; a failed publication restores the previous one. */
export async function publishClientPackage(
  staged,
  destination,
  manifestFile,
  manifestDestination,
  backup,
) {
  let previous = false;
  let published = false;
  try {
    try {
      const stat = await lstat(destination);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('目标产物路径不是普通目录。');
      await rename(destination, backup);
      previous = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(staged, destination);
    published = true;
    await rename(manifestFile, manifestDestination);
  } catch (error) {
    try {
      if (published) await rename(destination, staged);
      if (previous) await rename(backup, destination);
    } catch (rollbackError) {
      const failure = new AggregateError(
        [error, rollbackError],
        `客户端发布回滚未完成，保留恢复文件：${dirname(backup)}`,
      );
      failure.recoveryDirectory = dirname(backup);
      throw failure;
    }
    throw error;
  }
}

export async function packageClient(options) {
  assertNodeVersion();
  const target = parseClientArguments(['--platform', options.platform, '--arch', options.arch]);
  const source = join(projectRoot, 'desktop');
  const { files, manifest } = await collectClientFiles(source);
  const electron = JSON.parse(
    await readFile(join(projectRoot, 'node_modules/electron/package.json'), 'utf8'),
  );
  const checksums = JSON.parse(
    await readFile(join(projectRoot, 'node_modules/electron/checksums.json'), 'utf8'),
  );
  const artifact = `electron-v${electron.version}-${target.platform}-${target.arch}.zip`;
  if (!/^[a-f0-9]{64}$/i.test(checksums[artifact] ?? ''))
    throw new Error('已安装的官方 Electron 包缺少此目标的校验值，无法验证运行框架。');
  const { packager } = await import('@electron/packager');
  if (typeof packager !== 'function')
    throw new Error('需要官方 @electron/packager 20+。请先安装项目锁定的依赖。');
  const output = await ensureClientOutputDirectory();
  const name = clientName(target.platform);
  const bundle = `${name}-${target.platform}-${target.arch}`;
  const destination = join(output, bundle);
  try {
    if ((await lstat(destination)).isSymbolicLink())
      throw new Error('目标产物目录不能是符号链接。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const working = await mkdtemp(join(output, '.build-'));
  let preserveWorking = false;
  try {
    const stage = join(working, 'desktop');
    await mkdir(stage);
    for (const file of files) {
      const targetPath = join(stage, file);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(join(source, file), targetPath);
    }
    for (const file of licenseFiles) await copyFile(join(projectRoot, file), join(stage, file));
    const icon = await makeIcon(target.platform, working);
    const cache = join(output, '.electron-cache');
    try {
      if ((await lstat(cache)).isSymbolicLink())
        throw new Error('Electron 缓存目录不能是符号链接。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    console.log(
      `正在准备 Electron ${electron.version}（${target.platform}/${target.arch}）；首次构建需要下载官方运行框架。`,
    );
    let reportedProgress = -1;
    const stagedOutput = join(working, 'artifacts');
    const paths = await packager({
      dir: stage,
      name,
      appBundleId: 'com.openbot.client',
      appVersion: manifest.version,
      electronVersion: electron.version,
      platform: target.platform,
      arch: target.arch,
      out: stagedOutput,
      tmpdir: join(working, 'tmp'),
      download: {
        cacheRoot: cache,
        checksums,
        downloadOptions: {
          quiet: true,
          getProgressCallback({ transferred, total }) {
            if (!total || total < 1024 * 1024) return;
            const step = Math.floor((transferred / total) * 10);
            if (step <= reportedProgress) return;
            reportedProgress = step;
            console.log(`运行框架下载：${Math.min(100, step * 10)}%`);
          },
        },
      },
      asar: true,
      prune: false,
      derefSymlinks: false,
      overwrite: true,
      ...(icon ? { icon } : {}),
      ...(target.platform === 'win32' ? {
        win32metadata: {
          CompanyName: manifest.productName,
          FileDescription: manifest.productName,
          ProductName: manifest.productName,
        },
      } : {}),
      appCategoryType: 'public.app-category.productivity',
      darwinDarkModeSupport: true,
      extendInfo: {
        NSMicrophoneUsageDescription:
          'Turn the audio you choose to record into text. You review the text before sending.',
        CFBundleDevelopmentRegion: 'en',
        CFBundleLocalizations: ['en', 'zh-Hans'],
      },
    });
    for (const path of paths) {
      const rel = relative(stagedOutput, resolve(path));
      if (!rel || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('打包器返回了输出目录以外的路径。');
    }
    if (paths.length !== 1 || resolve(paths[0]) !== join(stagedOutput, bundle))
      throw new Error('打包器未返回预期的单一客户端产物。');
    if (target.platform === 'darwin') {
      for (const path of paths) {
        const app = join(path, 'OpenBot.app');
        await command('/usr/libexec/PlistBuddy', [
          '-c',
          `Set :CFBundleDisplayName ${manifest.productName}`,
          join(app, 'Contents', 'Info.plist'),
        ]);
        await writeMacLocalizations(app);
        await signLocalMacClient(app, electron.version, working);
      }
    }
    const manifestFile = join(working, 'manifest.json');
    await writeFile(
      manifestFile,
      JSON.stringify(
        {
          name: manifest.productName,
          bundleId: 'com.openbot.client',
          version: manifest.version,
          electronVersion: electron.version,
          platform: target.platform,
          arch: target.arch,
          packagedAt: new Date().toISOString(),
          sourceFiles: [...files, ...licenseFiles],
          bundles: [relative(output, destination)],
          localSignature: target.platform === 'darwin' ? 'ad-hoc' : null,
          signedForDistribution: false,
          serviceIncluded: false,
        },
        null,
        2,
      ) + '\n',
    );
    await publishClientPackage(
      paths[0],
      destination,
      manifestFile,
      join(output, `manifest-${target.platform}-${target.arch}.json`),
      join(working, 'previous'),
    );
    console.log(
      `客户端已生成：\n${destination}\n服务需单独运行或连接远程服务。本产物未做发行签名/公证。`,
    );
    if (target.platform !== process.platform || target.arch !== process.arch)
      console.log('该跨平台/架构产物尚未在目标系统运行验证。');
    return [destination];
  } catch (error) {
    preserveWorking = error.recoveryDirectory === working;
    throw error;
  } finally {
    if (!preserveWorking) await rm(working, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseClientArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      '用法：npm run client:package -- [--platform darwin|win32|linux] [--arch arm64|x64] [--dry-run]\n默认当前系统/架构，输出到 release/client。仅打包桌面客户端，会替换同目标的旧产物。\n--dry-run 仅显示计划，不创建文件、不下载或启动客户端。',
    );
    return;
  }
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          platform: options.platform,
          arch: options.arch,
          source: 'desktop/',
          output: `release/client/${clientName(options.platform)}-${options.platform}-${options.arch}`,
          includesService: false,
          startsClient: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  await packageClient(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
