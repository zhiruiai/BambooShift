import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserContext, BrowserType } from 'playwright-core';
import type { ComputerScreenConfiguration } from '../../../shared/computer-screens.js';
import { sameDesktopSession } from '../../../shared/linux-desktop.js';
import { createSharedBrowserEngine, type BrowserScreenSession } from './browser-engine.js';
import type { BrowserTabOptions } from './browser-tabs.js';
import { createBrowserLoginState } from './browser-login-state.js';
import { browserLeaseJournal } from './linux-browser-leases.js';

const execute = promisify(execFile);
const failure = () => new Error('受管 Linux 浏览器不可用，请检查专用桌面、Chrome 和隔离配置。');
const cleanupFailure = () =>
  Object.assign(new Error('无法确认浏览器进程已停止，当前画面需要维护。'), {
    cleanupConfirmed: false,
  });
export interface LinuxBrowserOptions {
  interpreterPath: string;
  launcherPath: string;
  workspaceScopeId: string;
  stateDirectory: string;
  createProxy(): Promise<{ url: string; close(): Promise<void> }>;
  /** Controlled tests provide protocol functions; HTTP and environment cannot select these. */
  launchPersistentContext?: BrowserType['launchPersistentContext'];
  probe?: (screen: ComputerScreenConfiguration) => Promise<void>;
  cleanup?: (screen: ComputerScreenConfiguration, lease: string) => Promise<void>;
}
async function trustedProgram(path: string) {
  if (!isAbsolute(path) || path.includes('\0')) throw failure();
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022)
    throw failure();
  let parent = dirname(path);
  while (parent !== '/') {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022)
      throw failure();
    parent = dirname(parent);
  }
}
function argumentsFor(options: LinuxBrowserOptions, screen: ComputerScreenConfiguration) {
  return [
    options.launcherPath,
    '--manifest',
    screen.manifestPath,
    '--session',
    screen.session.id,
    '--generation',
    screen.session.generation,
    '--scope',
    options.workspaceScopeId,
  ];
}
async function probe(options: LinuxBrowserOptions, screen: ComputerScreenConfiguration) {
  if (process.platform !== 'linux') throw failure();
  await trustedProgram(options.interpreterPath);
  await trustedProgram(options.launcherPath);
  const reply = await execute(
    options.interpreterPath,
    [...argumentsFor(options, screen), '--probe'],
    {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      timeout: 5000,
      maxBuffer: 32768,
    },
  );
  const value = JSON.parse(reply.stdout);
  if (
    value.available !== true ||
    value.network !== 'browser-proxy-only' ||
    value.workspaceScopeId !== options.workspaceScopeId ||
    !sameDesktopSession(value.session, screen.session)
  )
    throw failure();
}
async function cleanup(
  options: LinuxBrowserOptions,
  screen: ComputerScreenConfiguration,
  lease: string,
) {
  const path = `/opt/openbot/desktop/browser-leases/${lease}.json`,
    until = Date.now() + 15000;
  do {
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.uid !== 0 ||
          info.gid !== 0 ||
          info.nlink !== 1 ||
          (info.mode & 0o777) !== 0o600 ||
          info.size > 4096
        )
          throw cleanupFailure();
        const value = JSON.parse(await file.readFile('utf8'));
        if (
          value.version !== 1 ||
          value.cleanupConfirmed !== true ||
          value.leaseId !== lease ||
          value.workspaceScopeId !== options.workspaceScopeId ||
          !sameDesktopSession(value.session, screen.session)
        )
          throw cleanupFailure();
      } finally {
        await file.close();
      }
      await unlink(path);
      return;
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw cleanupFailure();
    }
    await new Promise((done) => setTimeout(done, 50));
  } while (Date.now() < until);
  throw cleanupFailure();
}

/** One browser process per pinned desktop; shared login data stays within one Worker workspace. */
export function createLinuxBrowserEngine(options: LinuxBrowserOptions) {
  const login = createBrowserLoginState(
    resolve(options.stateDirectory, 'login.json'),
    options.workspaceScopeId,
  );
  const journal = browserLeaseJournal(
    resolve(options.stateDirectory, 'leases'),
    options.workspaceScopeId,
  );
  const screens = new Map<string, { session: BrowserScreenSession; close(): Promise<void> }>();
  const active = new Map<BrowserContext, () => void>();
  let closed = false,
    synchronizing = false;
  const timer = setInterval(() => {
    if (closed || synchronizing || !active.size) return;
    synchronizing = true;
    void login
      .synchronize()
      .catch(() => {
        for (const failed of active.values()) failed();
      })
      .finally(() => {
        synchronizing = false;
      });
  }, 1000);
  timer.unref();
  async function recover(configuration: ComputerScreenConfiguration, revision = 'initial') {
    const previous = await journal.read(configuration, revision);
    if (!previous) return;
    await (options.cleanup
      ? options.cleanup(configuration, previous)
      : cleanup(options, configuration, previous));
    await journal.clear(configuration, revision);
  }
  function screen(
    configuration: ComputerScreenConfiguration,
    revision = 'initial',
  ): BrowserScreenSession {
    const key = `${configuration.id}:${revision}:${configuration.session.generation}`;
    if (screens.has(key)) return screens.get(key)!.session;
    let failed = false,
      registered: BrowserContext | undefined,
      proxy: { url: string; close(): Promise<void> } | undefined;
    let lease: string | undefined;
    const assertAvailable = async () => {
      if (closed || failed) throw failure();
      await (options.probe ? options.probe(configuration) : probe(options, configuration));
    };
    const engine = createSharedBrowserEngine({
      profileDir: resolve(options.stateDirectory, 'launch', configuration.id),
      headless: false,
      keepStartupPageUntilOwned: true,
      exclusiveScreen: true,
      createProxy: async () => {
        await assertAvailable();
        await recover(configuration, revision);
        proxy = await options.createProxy();
        const url = new URL(proxy.url);
        if (
          url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          !url.port ||
          url.username ||
          url.password
        ) {
          await proxy.close();
          throw failure();
        }
        const fixed = proxy;
        return {
          url: fixed.url,
          close: async () => {
            try {
              if (lease) {
                await recover(configuration, revision);
                lease = undefined;
              }
            } catch (error) {
              failed = true;
              throw error;
            } finally {
              await fixed.close();
            }
          },
        };
      },
      launchPersistentContext: async (profile, settings) => {
        await assertAvailable();
        if (!proxy) throw failure();
        lease = randomUUID();
        await journal.write(configuration, revision, lease);
        const launch =
          options.launchPersistentContext ??
          ((path, settings) =>
            import('playwright-core').then(({ chromium }) =>
              chromium.launchPersistentContext(path, settings),
            ));
        let context: BrowserContext;
        try {
          context = await launch(profile, {
            ...settings,
            executablePath: options.interpreterPath,
            channel: undefined,
            ignoreDefaultArgs: true,
            headless: false,
            chromiumSandbox: true,
            env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
            args: [
              ...argumentsFor(options, configuration),
              '--lease',
              lease,
              '--proxy-port',
              new URL(proxy.url).port,
            ],
          });
        } catch (error) {
          failed = true;
          throw error;
        }
        try {
          await login.register(context);
        } catch (error) {
          await context.close();
          throw error;
        }
        registered = context;
        active.set(context, () => {
          failed = true;
        });
        context.once('close', () => {
          active.delete(context);
          void login.detach(context);
        });
        return context;
      },
    });
    const base = engine.screen(key);
    const synchronize = async () => {
      await assertAvailable();
      await login.synchronize();
    };
    const tabGuard = (options: BrowserTabOptions = {}): BrowserTabOptions => ({
      ...options,
      authorize() {
        if (closed || failed) throw failure();
        options.authorize?.();
      },
    });
    const session: BrowserScreenSession = {
      tabs: {
        async list(options) {
          await assertAvailable();
          return base.tabs!.list(tabGuard(options));
        },
        async select(tabId, options) {
          await assertAvailable();
          return base.tabs!.select(tabId, tabGuard(options));
        },
        async close(tabId, options) {
          await assertAvailable();
          return base.tabs!.close(tabId, tabGuard(options));
        },
      },
      peek: () => (failed ? undefined : base.peek()),
      async status() {
        if (failed) throw cleanupFailure();
        try {
          await assertAvailable();
          return { available: true };
        } catch {
          return { available: false, reason: failure().message };
        }
      },
      async open() {
        await assertAvailable();
        const value = await base.open();
        await synchronize();
        return value;
      },
      async prepareDesktop({ signal } = {}) {
        signal?.throwIfAborted();
        let stopping: Promise<void> | undefined;
        const abort = () => {
          stopping ??= engine.close();
          void stopping.catch(() => {});
        };
        signal?.addEventListener('abort', abort, { once: true });
        try {
          await session.open();
          signal?.throwIfAborted();
        } finally {
          signal?.removeEventListener('abort', abort);
          if (stopping) {
            failed = true;
            await stopping;
          }
        }
      },
      synchronize,
      async close() {
        try {
          if (registered) {
            await login.unregister(registered);
            active.delete(registered);
            registered = undefined;
          }
        } finally {
          await engine.close();
        }
      },
    };
    screens.set(key, { session, close: session.close });
    return session;
  }
  return {
    screen,
    recover,
    async close() {
      closed = true;
      clearInterval(timer);
      const results = await Promise.allSettled([...screens.values()].map((s) => s.close()));
      await login.close();
      const rejected = results.find((r) => r.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    },
  };
}
