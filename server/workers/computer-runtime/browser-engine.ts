import { mkdir } from 'node:fs/promises';
import type { BrowserContext, BrowserType, Page } from 'playwright-core';
import { browserEnvironment } from './browser-environment.js';

export interface BrowserScreenSession {
  peek(): { page: Page; context: BrowserContext } | undefined;
  open(): Promise<{ page: Page; context: BrowserContext }>;
  close(): Promise<void>;
  status?(): Promise<{ available: boolean; reason?: string }>;
  prepareDesktop?(options?: { signal?: AbortSignal }): Promise<void>;
  synchronize?(): Promise<void>;
}

type Proxy = { url: string; close(): Promise<void> };
type Launch = BrowserType['launchPersistentContext'];
export interface SharedBrowserEngineOptions {
  profileDir: string;
  createProxy: () => Promise<Proxy>;
  executablePath?: string;
  headless?: boolean;
  /** A headed Chrome process can exit when its last startup window is closed. */
  keepStartupPageUntilOwned?: boolean;
  /** Dedicated-process mode can safely assign native new tabs to its sole screen. */
  exclusiveScreen?: boolean;
  /** Controlled tests can delay a real launch. No caller-supplied Chrome arguments. */
  launchPersistentContext?: Launch;
}

type Screen = {
  epoch: number;
  pages: Set<Page>;
  active?: Page;
  opening?: { epoch: number; promise: Promise<{ page: Page; context: BrowserContext }> };
  closing?: Promise<void>;
  failed: boolean;
  session: BrowserScreenSession;
};
type Owner = { screen: Screen; epoch: number; runtime: Runtime };
type Runtime = {
  context: BrowserContext;
  alive: boolean;
  creations: Set<Promise<unknown>>;
  ownership: Set<Promise<unknown>>;
  ownershipByPage: WeakMap<Page, Promise<void>>;
  closeProxy(): Promise<void>;
  startupPages?: Page[];
};

const stopped = () => new Error('浏览器画面已关闭，请重新打开。');
const launchFailure = () =>
  new Error(
    '无法启动独立浏览器。请安装 Chrome，或设置 OPENBOT_BROWSER_EXECUTABLE。OpenBot 不会读取你现有的浏览器登录信息。',
  );

/** One workspace profile/cookie jar, with explicitly owned pages per Bot screen. */
export function createSharedBrowserEngine(options: SharedBrowserEngineOptions): {
  screen(id: string): BrowserScreenSession;
  close(): Promise<void>;
} {
  const screens = new Map<string, Screen>();
  const owners = new WeakMap<Page, Owner>();
  const proxyClosures = new Set<Promise<void>>();
  let proxyCloseError: unknown;
  let runtime: Runtime | undefined;
  let launching: Promise<Runtime> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  function live(owner: Owner) {
    return (
      !closed && owner.runtime.alive && !owner.screen.failed && owner.screen.epoch === owner.epoch
    );
  }
  async function closePage(page: Page) {
    if (page.isClosed()) return;
    try {
      await page.close({ runBeforeUnload: false });
    } catch (error) {
      if (!page.isClosed()) throw error;
    }
  }
  function track(rt: Runtime, promise: Promise<unknown>) {
    rt.ownership.add(promise);
    void promise
      .catch(() => {
        // An unowned page that cannot be closed must not remain an accessible screen.
        rt.alive = false;
        void rt.context.close().catch(() => {});
      })
      .finally(() => rt.ownership.delete(promise));
    return promise;
  }
  function adopt(page: Page, owner: Owner) {
    if (owners.has(page)) return;
    if (!live(owner) || page.isClosed()) {
      track(owner.runtime, closePage(page));
      return;
    }
    owners.set(page, owner);
    owner.screen.pages.add(page);
    owner.screen.active = page;
    page.on('download', (download) => void download.cancel().catch(() => {}));
    page.on('popup', (popup) => adopt(popup, owner));
    page.once('close', () => {
      owner.screen.pages.delete(page);
      if (owner.screen.active === page) {
        owner.screen.active = [...owner.screen.pages].reverse().find((candidate) => {
          const entry = owners.get(candidate);
          return !!entry && live(entry) && !candidate.isClosed();
        });
      }
    });
  }
  function discover(rt: Runtime, page: Page): Promise<void> {
    const existing = rt.ownershipByPage.get(page);
    if (existing) return existing;
    const work = Promise.resolve().then(async () => {
      if (owners.has(page) || page.isClosed()) return;
      const opener = await page.opener().catch(() => null);
      if (opener) {
        if (!owners.has(opener)) await rt.ownershipByPage.get(opener);
        const owner = owners.get(opener);
        if (owner) {
          adopt(page, owner);
          return;
        }
      }
      // newPage emits its event before its promise resolves. Only that exact
      // promise result may claim an opener-less page; never infer a pending owner.
      await Promise.allSettled([...rt.creations]);
      if (!owners.has(page) && options.exclusiveScreen && screens.size === 1) {
        const screen = screens.values().next().value!;
        const owner = { screen, epoch: screen.epoch, runtime: rt };
        if (!screen.closing && live(owner)) adopt(page, owner);
      }
      if (!owners.has(page)) await closePage(page);
    });
    rt.ownershipByPage.set(page, work);
    track(rt, work);
    return work;
  }
  async function drain(rt: Runtime) {
    while (rt.ownership.size) await Promise.allSettled([...rt.ownership]);
  }
  function ensureRuntime(): Promise<Runtime> {
    if (closed) return Promise.reject(stopped());
    if (runtime?.alive) return Promise.resolve(runtime);
    if (launching) return launching;
    const work = (async () => {
      let proxy: Proxy | undefined;
      let context: BrowserContext | undefined;
      let proxyClose: Promise<void> | undefined;
      const closeProxy = () => {
        if (!proxyClose) {
          proxyClose = Promise.resolve().then(async () => {
            await proxy?.close();
          });
          proxyClosures.add(proxyClose);
          void proxyClose
            .catch((error) => {
              proxyCloseError ??= error;
            })
            .finally(() => proxyClosures.delete(proxyClose!));
        }
        return proxyClose;
      };
      try {
        await Promise.allSettled([...proxyClosures]);
        if (proxyCloseError) throw stopped();
        await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
        if (closed) throw stopped();
        proxy = await options.createProxy();
        if (closed) throw stopped();
        const launch =
          options.launchPersistentContext ??
          ((profile, settings) =>
            import('playwright-core').then(({ chromium }) =>
              chromium.launchPersistentContext(profile, settings),
            ));
        const executablePath = options.executablePath ?? process.env.OPENBOT_BROWSER_EXECUTABLE;
        context = await launch(options.profileDir, {
          ...(executablePath ? { executablePath } : { channel: 'chrome' }),
          headless: options.headless ?? process.env.OPENBOT_BROWSER_HEADLESS !== 'false',
          env: browserEnvironment(options.profileDir),
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: 1,
          acceptDownloads: false,
          serviceWorkers: 'block',
          timeout: 30_000,
          proxy: { server: proxy.url, bypass: '<-loopback>' },
          args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        });
        if (closed) throw stopped();
        const current: Runtime = {
          context,
          alive: true,
          creations: new Set(),
          ownership: new Set(),
          ownershipByPage: new WeakMap(),
          closeProxy,
        };
        await context.route('**/*', (route) => {
          let allowed = false;
          try {
            allowed = ['http:', 'https:'].includes(new URL(route.request().url()).protocol);
          } catch {
            /* Malformed and non-network URLs never receive an exception. */
          }
          return allowed ? route.continue() : route.abort('blockedbyclient');
        });
        context.on('page', (page) => void discover(current, page));
        context.once('close', () => {
          current.alive = false;
          if (runtime === current) runtime = undefined;
          void closeProxy().catch(() => {});
        });
        // Startup/restored pages have no Bot owner. They cannot become another
        // screen's active page or inherit its control lease.
        if (options.keepStartupPageUntilOwned) current.startupPages = context.pages();
        else await Promise.all(context.pages().map(closePage));
        if (closed || !current.alive) throw stopped();
        runtime = current;
        return current;
      } catch (error) {
        try {
          await context?.close();
        } finally {
          await closeProxy();
        }
        if (closed) throw stopped();
        throw launchFailure();
      }
    })();
    launching = work;
    void work
      .finally(() => {
        if (launching === work) launching = undefined;
      })
      .catch(() => {});
    return work;
  }
  function screen(id: string): BrowserScreenSession {
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || id.includes('\0'))
      throw new Error('浏览器画面标识无效。');
    if (closed) throw stopped();
    const prior = screens.get(id);
    if (prior) return prior.session;
    if (options.exclusiveScreen && screens.size) throw new Error('独立浏览器只能绑定一个画面。');
    const state: Screen = { epoch: 0, pages: new Set(), failed: false, session: undefined! };
    const peek = () => {
      const page = state.active;
      const owner = page && owners.get(page);
      return page && owner && live(owner) && !page.isClosed()
        ? { page, context: owner.runtime.context }
        : undefined;
    };
    const session: BrowserScreenSession = {
      peek,
      async open() {
        if (state.closing) await state.closing;
        if (closed || state.failed) throw stopped();
        const current = peek();
        if (current) return current;
        if (state.opening?.epoch === state.epoch) return state.opening.promise;
        const epoch = state.epoch;
        const work = (async () => {
          const rt = await ensureRuntime();
          const owner = { screen: state, epoch, runtime: rt };
          if (!live(owner)) throw stopped();
          const creation = Promise.resolve().then(async () => {
            const page = await rt.context.newPage();
            if (!live(owner)) {
              await closePage(page);
              throw stopped();
            }
            adopt(page, owner);
            if (rt.startupPages) {
              const startup = rt.startupPages;
              rt.startupPages = undefined;
              await Promise.all(startup.map(closePage));
            }
            return { page, context: rt.context };
          });
          rt.creations.add(creation);
          try {
            return await creation;
          } finally {
            rt.creations.delete(creation);
          }
        })();
        state.opening = { epoch, promise: work };
        try {
          return await work;
        } finally {
          if (state.opening?.promise === work) state.opening = undefined;
        }
      },
      close() {
        if (state.closing) return state.closing;
        state.epoch++;
        state.active = undefined;
        const pending = state.opening?.promise;
        const work = (async () => {
          await pending?.catch(() => {});
          try {
            await Promise.all([...state.pages].map(closePage));
            if (runtime) await drain(runtime);
          } catch (error) {
            state.failed = true;
            throw error;
          }
        })();
        state.closing = work;
        void work
          .finally(() => {
            if (state.closing === work) state.closing = undefined;
          })
          .catch(() => {});
        return work;
      },
    };
    state.session = session;
    screens.set(id, state);
    return session;
  }
  return {
    screen,
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const results = await Promise.allSettled(
          [...screens.values()].map((entry) => entry.session.close()),
        );
        await launching?.catch(() => {});
        const current = runtime;
        runtime = undefined;
        if (current) {
          current.alive = false;
          try {
            await current.context.close();
          } finally {
            await drain(current);
            await current.closeProxy();
          }
        }
        // A browser can close itself before engine.close captures its runtime.
        // Still await the proxy cleanup started by that context's close event.
        while (proxyClosures.size) await Promise.allSettled([...proxyClosures]);
        if (proxyCloseError) throw proxyCloseError;
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return closing;
    },
  };
}
