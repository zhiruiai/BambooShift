import { type ChildProcess } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  failure,
  loadServicesConfig,
  parseServicesArguments,
  root,
  type Role,
  type ServiceDependencies,
  type ServicesConfig,
  type ServicesStatus,
} from './computerServices/config.js';
import { inspectServices } from './computerServices/inspect.js';
import { defaults } from './computerServices/system.js';
export {
  loadServicesConfig,
  parseServicesArguments,
  type ServiceDependencies,
  type ServicesConfig,
  type ServicesStatus,
} from './computerServices/config.js';
export { inspectServices } from './computerServices/inspect.js';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function sshInstructions(config: ServicesConfig) {
  const args = [
    '/usr/bin/ssh',
    '-N',
    '-T',
    '-M',
    '-S',
    config.ssh.controlPath,
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    ...(config.ssh.knownHostsPath ? ['-o', `UserKnownHostsFile=${config.ssh.knownHostsPath}`] : []),
    '-L',
    `127.0.0.1:${config.ports.cubeApi}:127.0.0.1:${config.ports.cubeApiTarget}`,
    '-L',
    `127.0.0.1:${config.ports.cubeProxy}:127.0.0.1:80`,
    '-p',
    String(config.ssh.port),
    `${config.ssh.user}@${config.ssh.host}`,
  ];
  return (
    '现有 SSH 隧道不可用。本工具不会自动认证或保存密码；请在自己的终端用系统 SSH 建立连接，再运行本命令：\n' +
    args.map(quote).join(' ')
  );
}
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

export async function runServices(
  config: ServicesConfig,
  options: {
    signal: AbortSignal;
    onStatus?: (state: ServicesStatus) => void;
    dependencies?: Partial<ServiceDependencies>;
    pollMs?: number;
    startupMs?: number;
  },
) {
  const deps = { ...defaults, ...options.dependencies };
  const owned: Array<{ role: Role; child: ChildProcess }> = [];
  let childFailed = false;
  const inspect = () => inspectServices(config, deps, options.signal);
  const assertNoConflict = (state: ServicesStatus) => {
    if ([state.api.state, state.bridge.state, state.tunnel.state].includes('conflict'))
      throw failure('PORT_CONFLICT', '固定端口已由不匹配的服务占用；没有停止或替换该进程。');
  };
  const cleanup = async () => {
    await Promise.all(
      owned.map(async ({ child }) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        const ended = new Promise<void>((done) => child.once('exit', () => done()));
        child.kill('SIGTERM');
        const force = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 15000);
        await ended;
        clearTimeout(force);
      }),
    );
  };
  try {
    let state = await inspect();
    if (options.signal.aborted) return;
    options.onStatus?.(state);
    assertNoConflict(state);
    if (state.tunnel.state !== 'ready') throw failure('TUNNEL_REQUIRED', sshInstructions(config));
    if (state.vm.state === 'unknown' || state.worker.state === 'identity_mismatch')
      throw failure('CUBE_UNAVAILABLE', '无法确认固定云实例身份；请检查隧道和私有配置。');
    for (const role of ['bridge', 'api'] as const) {
      if (options.signal.aborted) return;
      if (state[role].state === 'missing') {
        if (role === 'api') {
          try {
            if (!(await lstat(join(root, 'dist/index.html'))).isFile()) throw new Error();
          } catch {
            throw failure('BUILD_REQUIRED', '缺少前端构建，请先运行 npm run build。');
          }
        }
        const child = deps.spawn(role, config);
        owned.push({ role, child });
        child.once('error', () => {
          childFailed = true;
        });
        child.once('exit', () => {
          childFailed = true;
        });
      }
      const deadline = Date.now() + (options.startupMs ?? 60000);
      while (state[role].state !== 'ready' && !options.signal.aborted) {
        if (childFailed)
          throw failure('CHILD_EXITED', '由本工具启动的服务提前退出，请检查启动日志。');
        if (Date.now() >= deadline)
          throw failure('STARTUP_TIMEOUT', '服务未能及时启动；只清理本次启动的子进程。');
        await sleep(150, options.signal);
        state = await inspect();
        assertNoConflict(state);
      }
    }
    let previous = '';
    while (!options.signal.aborted) {
      if (childFailed)
        throw failure('CHILD_EXITED', '由本工具启动的服务已退出；正在清理本次子进程。');
      state = await inspect();
      const key = JSON.stringify({ ...state, checkedAt: undefined });
      if (key !== previous) {
        options.onStatus?.(state);
        previous = key;
      }
      // A transport outage is visible as degraded status, not permission to
      // restart borrowed services, wake a VM, renew its lifetime or replay work.
      await sleep(options.pollMs ?? 15000, options.signal);
    }
  } finally {
    await cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseServicesArguments(process.argv.slice(2));
    const config = await loadServicesConfig(args.configPath);
    if (args.mode === 'status') {
      const status = await inspectServices(config);
      console.log(JSON.stringify(status, null, 2));
      process.exitCode = status.ready ? 0 : 2;
    } else {
      const stop = new AbortController();
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
      await runServices(config, {
        signal: stop.signal,
        onStatus: (state) => console.log(JSON.stringify(state)),
      });
    }
  } catch (error: any) {
    console.error(
      `${error.code || 'SERVICE_CHECK_FAILED'}: ${error.code ? error.message : '无法验证服务状态，请检查固定配置与系统工具。'}`,
    );
    process.exitCode = 1;
  }
}
