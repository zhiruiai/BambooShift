import { spawn } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { constants, openSync, fstatSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { launchBackend } from '../backend-launch.mjs';

import {
  exec,
  failure,
  root,
  type ServiceDependencies,
  type ServicesConfig,
  type Role,
} from './config.js';
async function command(executable: string, args: string[]) {
  try {
    const result = await exec(executable, args, { timeout: 4000, maxBuffer: 65536 });
    return { ok: true, code: 0 as number | string, ...result };
  } catch (error: any) {
    return {
      ok: false,
      code: error.code as number | string,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || ''),
    };
  }
}
const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
export const defaults: ServiceDependencies = {
  async listener(port) {
    const result = await command(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']);
    if (!result.ok && !result.stdout) {
      // A missing utility is an inability to establish ownership, not an empty port.
      if (result.code !== 1 || (result.stderr && !/no files|no such process/i.test(result.stderr)))
        throw failure('INSPECTION_UNAVAILABLE', '无法检查本机端口归属，请确认系统 lsof 可用。');
      return null;
    }
    const ids = [...result.stdout.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1]));
    const names = [...result.stdout.matchAll(/^n(.+)$/gm)].map((m) => m[1]);
    return {
      pid: ids.length === 1 ? ids[0] : -1,
      loopback:
        ids.length === 1 && names.length > 0 && names.every((name) => name === `127.0.0.1:${port}`),
    };
  },
  async ownsApi(pid, config) {
    const database = join(config.dataDir, 'platform/identity.sqlite');
    const result = await command(lsof, ['-a', '-p', String(pid), '-Fn', '--', database]);
    return result.ok && result.stdout.split('\n').includes('n' + database);
  },
  async ownsBridge(pid, config) {
    const cwd = await command(lsof, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    if (!cwd.ok || !cwd.stdout.split('\n').includes('n' + root.replace(/\/$/, ''))) return false;
    const args = await command('/bin/ps', ['-p', String(pid), '-o', 'args=']);
    // Read command metadata only to compare this fixed entrypoint and fixed config;
    // never print the command line or use it as an executable instruction.
    return (
      args.ok &&
      /(?:^|\s)(?:\S*\/)?scripts\/cube-worker-bridge\.ts(?:\s|$)/.test(args.stdout) &&
      [config.cubeConfigPath, relative(root, config.cubeConfigPath)].some((path) =>
        args.stdout.trimEnd().endsWith('--config ' + path),
      )
    );
  },
  async master(config) {
    const result = await command('/usr/bin/ssh', [
      '-S',
      config.ssh.controlPath,
      '-O',
      'check',
      '-p',
      String(config.ssh.port),
      `${config.ssh.user}@${config.ssh.host}`,
    ]);
    const match = result.stderr.match(/Master running \(pid=(\d+)\)/);
    return result.ok && match ? Number(match[1]) : undefined;
  },
  fetch: (input, init) => fetch(input, init),
  spawn: spawnService,
};

export function serviceApiConfig(
  config: ServicesConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = resolve(
    root,
    config.serverConfigPath || env.OPENBOT_SERVER_CONFIG || 'config/private/server.private.json',
  );
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.size > 16384 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error('Invalid private configuration');
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      typeof value.dataDir !== 'string' ||
      value.bind !== `127.0.0.1:${config.ports.api}` ||
      realpathSync(resolve(root, value.dataDir)) !== realpathSync(config.dataDir)
    )
      throw new Error('Deployment configuration does not match service ownership');
    return path;
  } catch {
    throw failure(
      'SERVER_CONFIG_MISMATCH',
      '请配置有效的 Rust 私有 serverConfigPath（或 OPENBOT_SERVER_CONFIG），dataDir 必须匹配且 bind 必须匹配私有配置的本机 API 端口；不会启动旧 Node 后端。',
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function spawnService(
  role: Role,
  config: ServicesConfig,
  { env = process.env, launch = spawn }: { env?: NodeJS.ProcessEnv; launch?: typeof spawn } = {},
) {
  if (role === 'api') {
    const path = serviceApiConfig(config, env);
    return launchBackend(['--config', path], {
      env,
      launch,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
  const privateEnvironment = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG'].flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
  );
  return launch(
    process.execPath,
    ['--import', 'tsx', 'scripts/cube-worker-bridge.ts', '--config', config.cubeConfigPath],
    {
      cwd: root,
      env: privateEnvironment,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
}
