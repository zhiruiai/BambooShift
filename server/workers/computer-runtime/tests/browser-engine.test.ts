import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type BrowserContext } from 'playwright-core';
import { createSharedBrowserEngine } from '../browser-engine.js';
import { createBrowserNetworkProxy } from '../../computer-worker/index.js';

const realBrowser = { skip: process.env.OPENBOT_BROWSER_TEST !== '1', timeout: 90_000 };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Owned browser fixture deadline exceeded');
    await delay(10);
  }
}
async function fixture() {
  let forbiddenHits = 0;
  const forbidden = createServer((_req, res) => {
    forbiddenHits++;
    res.end('NOT A PRODUCT SERVER');
  });
  forbidden.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => forbidden.once('listening', resolve));
  const forbiddenUrl = `http://127.0.0.1:${(forbidden.address() as any).port}`;
  const server = createServer((req, res) => {
    if (req.url === '/redirect-private') {
      res.writeHead(302, { Location: forbiddenUrl });
      res.end();
      return;
    }
    if (req.url === '/download') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="fixture.txt"',
      });
      res.end('synthetic download');
      return;
    }
    if (req.url === '/service-worker.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end('self.addEventListener("fetch",()=>{});');
      return;
    }
    if (req.url === '/login')
      res.setHeader(
        'Set-Cookie',
        'fixtureSession=shared-synthetic; Path=/; HttpOnly; SameSite=Lax',
      );
    const label = (req.url || '/').replace(/[<>&"']/g, '');
    const color = req.url?.includes('alpha') ? '#6037b5' : '#19735b';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      `<!doctype html><title>Owned screen ${label}</title><body style="background:${color};color:white;font:32px sans-serif"><h1>${label}</h1><p id="cookie">${req.headers.cookie || ''}</p><input id="note"><output></output><button id="save" onclick="document.querySelector('output').textContent=document.querySelector('input').value">Save</button><button id="popup" onclick="window.open('/popup${label}')">Owned popup</button><a id="download" href="/download">Download</a></body>`,
    );
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const directory = await mkdtemp(join(tmpdir(), 'openbot-shared-browser-'));
  const previous = process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
  process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = origin;
  let proxies = 0,
    proxyCloses = 0;
  return {
    origin,
    directory,
    get forbiddenHits() {
      return forbiddenHits;
    },
    get proxies() {
      return proxies;
    },
    get proxyCloses() {
      return proxyCloses;
    },
    async createProxy() {
      proxies++;
      const proxy = await createBrowserNetworkProxy();
      return {
        url: proxy.url,
        async close() {
          proxyCloses++;
          await proxy.close();
        },
      };
    },
    async close() {
      if (previous === undefined) delete process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
      else process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = previous;
      server.closeAllConnections();
      forbidden.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => forbidden.close(() => resolve())),
      ]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('screen lookup and peek are read-only, and engine shutdown forbids late opens', async () => {
  let calls = 0;
  const engine = createSharedBrowserEngine({
    profileDir: '/unused-read-only-fixture',
    createProxy: async () => {
      calls++;
      throw new Error('must not launch');
    },
  });
  const screen = engine.screen('bot-alpha');
  assert.equal(screen, engine.screen('bot-alpha'));
  assert.equal(screen.peek(), undefined);
  await screen.close();
  assert.equal(calls, 0);
  for (const id of ['', ' ', 'x'.repeat(201), 'bad\0id']) assert.throws(() => engine.screen(id));
  await engine.close();
  await assert.rejects(screen.open(), /已关闭/);
  assert.throws(() => engine.screen('new'));
  assert.equal(calls, 0);
});

test(
  'real shared Chrome keeps independent screens, inherits popups only from their opener, and shares login cookies',
  realBrowser,
  async (t) => {
    const f = await fixture();
    let launches = 0;
    let delayProxyClose = false;
    const releaseProxy = latch();
    const engine = createSharedBrowserEngine({
      profileDir: join(f.directory, 'profile'),
      createProxy: async () => {
        const proxy = await f.createProxy();
        return {
          url: proxy.url,
          async close() {
            if (delayProxyClose) await releaseProxy.promise;
            await proxy.close();
          },
        };
      },
      headless: true,
      launchPersistentContext: async (profile, settings) => {
        launches++;
        assert.equal(settings?.acceptDownloads, false);
        assert.equal(settings?.serviceWorkers, 'block');
        assert.equal(settings?.proxy?.bypass, '<-loopback>');
        assert.equal(settings?.env?.NODE_OPTIONS, undefined);
        t.diagnostic('Launching a fresh owned headless Chrome profile');
        try {
          return await chromium.launchPersistentContext(profile, settings);
        } catch (error) {
          t.diagnostic(String(error).slice(0, 1000));
          throw error;
        }
      },
    });
    const a = engine.screen('alpha'),
      b = engine.screen('beta');
    try {
      const [first, second] = await Promise.all([a.open(), b.open()]);
      t.diagnostic('Two pages opened; verifying parallel input, screenshots and shared cookies');
      assert.equal(launches, 1);
      assert.equal(f.proxies, 1);
      assert.equal(first.context, second.context);
      assert.notEqual(first.page, second.page);
      await Promise.all([
        first.page.goto(f.origin + '/alpha'),
        second.page.goto(f.origin + '/beta'),
      ]);
      await Promise.all([
        first.page.locator('#note').fill('alpha-only'),
        second.page.locator('#note').fill('beta-only'),
      ]);
      await Promise.all([
        first.page.locator('#save').click(),
        second.page.locator('#save').click(),
      ]);
      assert.equal(await first.page.locator('output').innerText(), 'alpha-only');
      assert.equal(await second.page.locator('output').innerText(), 'beta-only');
      const shots = await Promise.all([first.page.screenshot(), second.page.screenshot()]);
      assert.notEqual(
        ...(shots.map((bytes) => createHash('sha256').update(bytes).digest('hex')) as [
          string,
          string,
        ]),
      );
      await first.page.goto(f.origin + '/login');
      await second.page.reload();
      assert.match(
        await second.page.locator('#cookie').innerText(),
        /fixtureSession=shared-synthetic/,
      );
      const popupPromise = first.page.waitForEvent('popup');
      await first.page.locator('#popup').click();
      const popup = await popupPromise;
      t.diagnostic('Checking popup ownership and close isolation');
      await until(() => a.peek()?.page === popup);
      assert.equal(b.peek()?.page, second.page);
      const nestedPromise = popup.waitForEvent('popup');
      await popup.locator('#popup').click();
      const nested = await nestedPromise;
      await until(() => a.peek()?.page === nested);
      assert.equal(b.peek()?.page, second.page);
      await nested.close();
      await until(() => a.peek()?.page === popup);
      const unknown = await first.context.newPage();
      await until(() => unknown.isClosed());
      assert.equal(a.peek()?.page, popup);
      assert.equal(b.peek()?.page, second.page);
      await a.close();
      assert.equal(a.peek(), undefined);
      assert.equal(first.page.isClosed(), true);
      assert.equal(popup.isClosed(), true);
      assert.equal(second.page.isClosed(), false);
      await second.page.locator('#note').fill('beta survives');
      assert.equal(await second.page.locator('#note').inputValue(), 'beta survives');
      // A retired slot gets a new revision key. A late close of its old handle
      // must not close the replacement or erase the account-wide login.
      const replacement = engine.screen('alpha-next-revision');
      const reopened = await replacement.open();
      assert.notEqual(reopened.page, first.page);
      assert.equal(reopened.context, second.context);
      await reopened.page.goto(f.origin + '/alpha-reopened');
      assert.match(await reopened.page.locator('#cookie').innerText(), /shared-synthetic/);
      await a.close();
      assert.equal(reopened.page.isClosed(), false);
      assert.equal(second.page.isClosed(), false);
      await second.page.reload();
      assert.match(await second.page.locator('#cookie').innerText(), /shared-synthetic/);
      await second.page.goto(f.origin + '/redirect-private').catch(() => {});
      assert.equal(f.forbiddenHits, 0);
      await reopened.page.evaluate(() => {
        void navigator.serviceWorker.register('/service-worker.js').catch(() => null);
      });
      assert.equal(reopened.context.serviceWorkers().length, 0);
      const downloadPromise = reopened.page.waitForEvent('download');
      await reopened.page.locator('#download').click();
      const download = await downloadPromise;
      assert.ok(await download.failure());
      delayProxyClose = true;
      await reopened.context.close();
      let shutdownDone = false;
      const shutdown = engine.close().then(() => {
        shutdownDone = true;
      });
      await delay(30);
      assert.equal(
        shutdownDone,
        false,
        'a spontaneous browser close must still wait for its proxy',
      );
      releaseProxy.resolve();
      await shutdown;
    } finally {
      releaseProxy.resolve();
      await engine.close();
      assert.equal(f.proxyCloses, f.proxies);
      await f.close();
    }
  },
);

test(
  'closing one screen during a delayed real Chrome launch cancels only that screen',
  realBrowser,
  async () => {
    const f = await fixture(),
      launched = latch<BrowserContext>(),
      release = latch();
    const engine = createSharedBrowserEngine({
      profileDir: join(f.directory, 'profile'),
      createProxy: f.createProxy,
      headless: true,
      launchPersistentContext: async (profile, settings) => {
        const context = await chromium.launchPersistentContext(profile, settings);
        launched.resolve(context);
        await release.promise;
        return context;
      },
    });
    const a = engine.screen('alpha'),
      b = engine.screen('beta');
    try {
      const openingA = a.open(),
        openingB = b.open();
      const rejectedA = assert.rejects(openingA, /已关闭/);
      await launched.promise;
      const closeA = a.close();
      release.resolve();
      await rejectedA;
      await closeA;
      const live = await openingB;
      assert.equal(a.peek(), undefined);
      assert.equal(b.peek()?.page, live.page);
      assert.equal(live.context.pages().filter((page) => !page.isClosed()).length, 1);
      await live.page.goto(f.origin + '/beta');
      assert.match(await live.page.title(), /beta/);
      assert.equal(f.proxyCloses, 0);
    } finally {
      release.resolve();
      await engine.close();
      await f.close();
    }
  },
);

test(
  'engine close waits for a late real Chrome result and closes its context and proxy exactly once',
  realBrowser,
  async () => {
    const f = await fixture(),
      launched = latch<BrowserContext>(),
      release = latch();
    const engine = createSharedBrowserEngine({
      profileDir: join(f.directory, 'profile'),
      createProxy: f.createProxy,
      headless: true,
      launchPersistentContext: async (profile, settings) => {
        const context = await chromium.launchPersistentContext(profile, settings);
        launched.resolve(context);
        await release.promise;
        return context;
      },
    });
    try {
      const session = engine.screen('alpha');
      const rejected = assert.rejects(session.open(), /已关闭/);
      const context = await launched.promise;
      let contextClosed = false,
        settled = false;
      context.once('close', () => {
        contextClosed = true;
      });
      const close = engine.close().then(() => {
        settled = true;
      });
      await delay(30);
      assert.equal(settled, false);
      release.resolve();
      await rejected;
      await close;
      assert.equal(contextClosed, true);
      assert.equal(session.peek(), undefined);
      assert.equal(f.proxyCloses, 1);
      await engine.close();
      assert.equal(f.proxyCloses, 1);
      await assert.rejects(session.open(), /已关闭/);
    } finally {
      release.resolve();
      await engine.close();
      await f.close();
    }
  },
);
