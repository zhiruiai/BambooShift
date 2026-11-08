import { execFile, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const exec = promisify(execFile);
export type Port = number;
export type Role = 'api' | 'bridge';
export interface ServicesConfig {
  version: 1;
  dataDir: string;
  serverConfigPath?: string;
  cubeConfigPath: string;
  connectionPath: string;
  ports: { api: number; cubeApi: number; cubeProxy: number; bridge: number; cubeApiTarget: number };
  ssh: { host: string; user: string; port: number; controlPath: string; knownHostsPath?: string };
}
export type Listener = { pid: number; loopback: boolean } | null;
export interface ServicesStatus {
  checkedAt: string;
  api: { state: 'ready' | 'missing' | 'conflict' | 'unavailable'; pid?: number };
  bridge: { state: 'ready' | 'missing' | 'conflict'; pid?: number };
  tunnel: { state: 'ready' | 'missing' | 'conflict'; pid?: number };
  vm: { state: 'running' | 'paused' | 'pausing' | 'unknown'; expiresAt?: string };
  worker: { state: 'ready' | 'paused' | 'unavailable' | 'identity_mismatch' | 'not_checked' };
  ready: boolean;
}
export interface ServiceDependencies {
  listener: (port: Port) => Promise<Listener>;
  ownsApi: (pid: number, config: ServicesConfig) => Promise<boolean>;
  ownsBridge: (pid: number, config: ServicesConfig) => Promise<boolean>;
  master: (config: ServicesConfig) => Promise<number | undefined>;
  fetch: typeof fetch;
  spawn: (role: Role, config: ServicesConfig) => ChildProcess;
}
export const failure = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
export const absolute = (v: unknown): v is string =>
  typeof v === 'string' && isAbsolute(v) && v.length <= 4096 && !/[\0\r\n]/.test(v);
export const exactKeys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((key) => allowed.includes(key));
export const validPort = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
export const servicePorts = (config: ServicesConfig) => [
  config.ports.api,
  config.ports.cubeApi,
  config.ports.cubeProxy,
  config.ports.bridge,
];

export async function privateJson(path: string): Promise<Record<string, any>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('invalid private file');
    const data = Buffer.alloc(65537);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(data, length, data.length - length, null);
      length += bytesRead;
      if (length > 65536) throw new Error('oversized private file');
      if (!bytesRead) break;
    }
    const value = JSON.parse(data.subarray(0, length).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid JSON');
    return value;
  } finally {
    await handle.close();
  }
}

export async function loadServicesConfig(path: string): Promise<ServicesConfig> {
  try {
    const value = await privateJson(resolve(path));
    const ssh = value.ssh;
    if (
      value.version !== 1 ||
      !exactKeys(value, [
        'version',
        'dataDir',
        'serverConfigPath',
        'cubeConfigPath',
        'connectionPath',
        'ports',
        'ssh',
      ]) ||
      !absolute(value.dataDir) ||
      (value.serverConfigPath !== undefined && !absolute(value.serverConfigPath)) ||
      !absolute(value.cubeConfigPath) ||
      !absolute(value.connectionPath) ||
      !value.ports ||
      typeof value.ports !== 'object' ||
      Array.isArray(value.ports) ||
      !exactKeys(value.ports, ['api', 'cubeApi', 'cubeProxy', 'bridge', 'cubeApiTarget']) ||
      !['api', 'cubeApi', 'cubeProxy', 'bridge', 'cubeApiTarget'].every((key) =>
        validPort(value.ports[key]),
      ) ||
      new Set(servicePorts(value as ServicesConfig)).size !== 4 ||
      !ssh ||
      typeof ssh !== 'object' ||
      Array.isArray(ssh) ||
      !exactKeys(ssh, ['host', 'user', 'port', 'controlPath', 'knownHostsPath']) ||
      typeof ssh.host !== 'string' ||
      ssh.host.length > 253 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(ssh.host) ||
      ssh.host.includes('..') ||
      typeof ssh.user !== 'string' ||
      !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(ssh.user) ||
      !Number.isInteger(ssh.port) ||
      ssh.port < 1 ||
      ssh.port > 65535 ||
      !absolute(ssh.controlPath) ||
      (ssh.knownHostsPath !== undefined && !absolute(ssh.knownHostsPath))
    )
      throw new Error('invalid configuration');
    const directory = await lstat(value.dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('invalid data directory');
    return { ...value, ssh: { ...ssh } } as ServicesConfig;
  } catch {
    throw failure('CONFIG_INVALID', '服务配置必须是当前用户所有、权限 0600 的有效固定配置。');
  }
}

export function parseServicesArguments(args: string[]) {
  if (
    args.length !== 3 ||
    !['status', 'run'].includes(args[0]) ||
    args[1] !== '--config' ||
    !args[2] ||
    args[2].startsWith('-')
  )
    throw failure(
      'ARGUMENTS_INVALID',
      '用法：node scripts/run.mjs scripts/computer-services.ts status|run --config <私有配置文件>',
    );
  return { mode: args[0] as 'status' | 'run', configPath: resolve(args[2]) };
}
