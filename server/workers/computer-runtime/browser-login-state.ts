import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserContext } from 'playwright-core';

type State = Awaited<ReturnType<BrowserContext['storageState']>>;
const empty = (): State => ({ cookies: [], origins: [] });
const cookieKey = (cookie: State['cookies'][number]) =>
  JSON.stringify([cookie.domain, cookie.path, cookie.name]);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const permittedOrigin = (origin: string) => {
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
  } catch {
    return false;
  }
};
function bounded(state: State): State {
  if (
    !state ||
    !Array.isArray(state.cookies) ||
    !Array.isArray(state.origins) ||
    state.cookies.length > 1000 ||
    state.origins.length > 100 ||
    Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024
  )
    throw new Error('浏览器共享登录资料超过限制或格式无效。');
  const cookies = state.cookies
    .filter((cookie) => !('partitionKey' in cookie))
    .map((cookie) => {
      if (
        !cookie ||
        ['name', 'value', 'domain', 'path'].some(
          (key) => typeof cookie[key as keyof typeof cookie] !== 'string',
        ) ||
        !Number.isFinite(cookie.expires) ||
        typeof cookie.httpOnly !== 'boolean' ||
        typeof cookie.secure !== 'boolean' ||
        !['Strict', 'Lax', 'None'].includes(cookie.sameSite)
      )
        throw new Error('浏览器登录资料格式无效。');
      const { name, value, domain, path, expires, httpOnly, secure, sameSite } = cookie;
      return { name, value, domain, path, expires, httpOnly, secure, sameSite };
    });
  const origins = state.origins.map((origin) => {
    if (
      !origin ||
      typeof origin.origin !== 'string' ||
      !permittedOrigin(origin.origin) ||
      !Array.isArray(origin.localStorage) ||
      origin.localStorage.length > 1000 ||
      origin.localStorage.some(
        (item) => !item || typeof item.name !== 'string' || typeof item.value !== 'string',
      )
    )
      throw new Error('浏览器登录资料格式无效。');
    return {
      origin: origin.origin,
      localStorage: origin.localStorage.map(({ name, value }) => ({ name, value })),
    };
  });
  return { cookies, origins };
}
async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('浏览器登录目录必须为服务账号私有目录。');
}

/** Only cookies and localStorage cross screens. Profiles, pages and control leases never do. */
export function createBrowserLoginState(path: string, workspaceScopeId: string) {
  const contexts = new Map<BrowserContext, State>();
  const detached = new WeakSet<BrowserContext>();
  let state = empty(),
    initialized = false,
    loaded = false,
    closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }
  async function load() {
    if (loaded) return;
    await directory(dirname(path));
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.mode & 0o077 ||
          info.size > 2 * 1024 * 1024 ||
          (process.getuid && info.uid !== process.getuid())
        )
          throw new Error('浏览器共享登录文件无效。');
        const value = JSON.parse(await file.readFile('utf8'));
        if (value.version !== 1 || value.workspaceScopeId !== workspaceScopeId)
          throw new Error('浏览器登录资料不属于此工作空间。');
        state = bounded(value.state);
        initialized = true;
      } finally {
        await file.close();
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    loaded = true;
  }
  async function save() {
    bounded(state);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify({ version: 1, workspaceScopeId, state }));
      await file.sync();
      await rename(temporary, path);
      const parent = await open(
        dirname(path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await file.close();
      await unlink(temporary).catch(() => {});
    }
  }
  function merge(previous: State, current: State) {
    const before = new Map(previous.cookies.map((c) => [cookieKey(c), c]));
    const after = new Map(current.cookies.map((c) => [cookieKey(c), c]));
    const combined = new Map(state.cookies.map((c) => [cookieKey(c), c]));
    for (const [key, value] of after) if (!equal(before.get(key), value)) combined.set(key, value);
    for (const [key, value] of before)
      if (!after.has(key) && equal(combined.get(key), value)) combined.delete(key);
    state.cookies = [...combined.values()];
    const origins = new Map(
      state.origins.map((o) => [o.origin, new Map(o.localStorage.map((v) => [v.name, v.value]))]),
    );
    const observedOrigins = new Set(
      [...previous.origins, ...current.origins].map((origin) => origin.origin),
    );
    for (const origin of observedOrigins) {
      const old = new Map(
        previous.origins
          .find((o) => o.origin === origin)
          ?.localStorage.map((v) => [v.name, v.value]) ?? [],
      );
      const next = new Map(
        current.origins
          .find((value) => value.origin === origin)
          ?.localStorage.map((v) => [v.name, v.value]) ?? [],
      );
      const target = origins.get(origin) ?? new Map<string, string>();
      for (const [name, value] of next) if (old.get(name) !== value) target.set(name, value);
      for (const [name, value] of old)
        if (!next.has(name) && target.get(name) === value) target.delete(name);
      origins.set(origin, target);
    }
    state.origins = [...origins].map(([origin, values]) => ({
      origin,
      localStorage: [...values].map(([name, value]) => ({ name, value })),
    }));
    bounded(state);
  }
  async function apply(context: BrowserContext, previous: State) {
    const baseline = structuredClone(previous);
    const next = new Map(state.cookies.map((c) => [cookieKey(c), c]));
    for (const cookie of previous.cookies)
      if (!next.has(cookieKey(cookie)))
        await context.addCookies([{ ...cookie, value: '', expires: 1 }]);
    const changed = state.cookies.filter(
      (c) =>
        !equal(
          previous.cookies.find((p) => cookieKey(c) === cookieKey(p)),
          c,
        ),
    );
    if (changed.length) await context.addCookies(changed);
    baseline.cookies = structuredClone(state.cookies);
    for (const page of context.pages()) {
      const origin = (() => {
        try {
          return new URL(page.url()).origin;
        } catch {
          return '';
        }
      })();
      const values = state.origins.find((o) => o.origin === origin)?.localStorage;
      const old = previous.origins.find((o) => o.origin === origin)?.localStorage ?? [];
      if (!values || equal(old, values)) continue;
      const applied = await page.evaluate(
        ({ expectedOrigin, values, old }) => {
          if (location.origin !== expectedOrigin) return undefined;
          const before = new Map(old.map((item) => [item.name, item.value]));
          const baseline = new Map(before);
          const next = new Map(values.map((v) => [v.name, v.value]));
          for (const item of old)
            if (!next.has(item.name) && localStorage.getItem(item.name) === item.value) {
              localStorage.removeItem(item.name);
              baseline.delete(item.name);
            }
          for (const item of values)
            if (localStorage.getItem(item.name) === (before.get(item.name) ?? null)) {
              localStorage.setItem(item.name, item.value);
              baseline.set(item.name, item.value);
            }
          return [...baseline].map(([name, value]) => ({ name, value }));
        },
        { expectedOrigin: origin, values, old },
      );
      if (applied) {
        baseline.origins = baseline.origins.filter((item) => item.origin !== origin);
        baseline.origins.push({ origin, localStorage: applied });
      }
    }
    if (!detached.has(context)) contexts.set(context, baseline);
  }
  async function synchronize() {
    await load();
    const observed = new Map<BrowserContext, State>();
    for (const [context, previous] of contexts) {
      try {
        const current = bounded(await context.storageState());
        if (!detached.has(context)) {
          merge(previous, current);
          observed.set(context, current);
        }
      } catch (error) {
        if (!detached.has(context)) throw error;
      }
    }
    if (contexts.size) await save();
    for (const [context, current] of observed) {
      try {
        if (!detached.has(context)) await apply(context, current);
      } catch (error) {
        if (!detached.has(context)) throw error;
      }
    }
  }
  return {
    register(context: BrowserContext) {
      return serial(async () => {
        if (closed) throw new Error('浏览器登录同步已关闭。');
        await load();
        const current = bounded(await context.storageState());
        if (!initialized) {
          state = current;
          initialized = true;
          await save();
        }
        context.once('close', () => {
          detached.add(context);
          contexts.delete(context);
        });
        // Only the caller frame's actual origin can read its own localStorage.
        await context.exposeBinding('__openbotLoginState', ({ frame }) => {
          let origin = '';
          try {
            origin = new URL(frame.url()).origin;
          } catch {
            return [];
          }
          if (!permittedOrigin(origin)) return [];
          return structuredClone(
            state.origins.find((o) => o.origin === origin)?.localStorage ?? [],
          );
        });
        await context.addInitScript(async () => {
          const value = await (globalThis as any).__openbotLoginState();
          for (const item of value) localStorage.setItem(item.name, item.value);
        });
        contexts.set(context, current);
        await apply(context, current);
      });
    },
    synchronize() {
      return serial(async () => {
        if (!closed) await synchronize();
      });
    },
    unregister(context: BrowserContext) {
      return serial(async () => {
        if (contexts.has(context)) {
          await synchronize();
          contexts.delete(context);
        }
      });
    },
    detach(context: BrowserContext) {
      detached.add(context);
      contexts.delete(context);
      return Promise.resolve();
    },
    close() {
      return serial(async () => {
        await synchronize();
        contexts.clear();
        closed = true;
      });
    },
  };
}
