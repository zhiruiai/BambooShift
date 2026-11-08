import { spawn } from 'node:child_process';
import { access, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { ensureClientOutputDirectory } from './package-client.mjs';

// Keep model credentials loaded by the project launcher out of the thin client's process.
export function clientEnvironment(source) {
  const exact = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'DBUS_SESSION_BUS_ADDRESS',
    'LANG',
    'LANGUAGE',
    'TERM',
    'COLORTERM',
    'OPENBOT_CLIENT_DATA_DIR',
    'OPENBOT_CLIENT_URL',
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        typeof value === 'string' && (exact.has(key.toUpperCase()) || key.startsWith('LC_')),
    ),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(
      '用法：npm run client:dev\n启动独立连接窗口。服务需另行运行；不会自动启动服务或修改系统权限。',
    );
    return;
  }
  if (args.length) throw new Error('client:dev 不接受 Electron 启动参数；请在连接窗口配置服务。');
  const root = fileURLToPath(new URL('..', import.meta.url));
  await access(join(root, 'desktop/main.cjs'));
  const require = createRequire(import.meta.url);
  const cache = join(await ensureClientOutputDirectory(), '.electron-cache');
  try {
    if ((await lstat(cache)).isSymbolicLink()) throw new Error('Electron 缓存目录不能是符号链接。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Electron 45 lazily installs its development executable on first require.
  // Share Packager's project-local ZIP cache, rather than creating a global download cache.
  const priorCache = process.env.electron_config_cache;
  let executable;
  try {
    process.env.electron_config_cache = cache;
    executable = require('electron');
  } finally {
    if (priorCache === undefined) delete process.env.electron_config_cache;
    else process.env.electron_config_cache = priorCache;
  }
  if (typeof executable !== 'string')
    throw new Error('找不到项目 Electron 可执行文件，请安装锁定依赖。');
  const child = spawn(executable, [join(root, 'desktop')], {
    cwd: root,
    stdio: 'inherit',
    env: clientEnvironment(process.env),
  });
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
