import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { createLinuxBrowserEngine } from '../linux-browser.js';
import { createBrowserNetworkProxy } from '../../computer-worker/index.js';

test(
  'real independent Chrome contexts share bounded login state, preserve native tabs and isolate origins',
  {
    skip: process.env.OPENBOT_BROWSER_TEST !== '1',
    timeout: 90_000,
  },
  async () => {
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Owned login fixture</title><p>synthetic</p>');
    });
    const other = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Other origin</title>');
    });
    await Promise.all(
      [server, other].map(
        (item) => new Promise<void>((resolve) => item.listen(0, '127.0.0.1', resolve)),
      ),
    );
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const secondOrigin = `http://127.0.0.1:${(other.address() as any).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'openbot-linux-browser-chrome-'));
    const oldOrigins = process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
    process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = `${origin},${secondOrigin}`;
    let launches = 0,
      cleanups = 0;
    const engine = createLinuxBrowserEngine({
      interpreterPath: '/controlled-test/python',
      launcherPath: '/controlled-test/browser.py',
      workspaceScopeId: randomUUID(),
      stateDirectory: directory,
      // This test covers real Chromium/login ownership, not Linux kernel isolation.
      probe: async () => {},
      cleanup: async () => {
        cleanups++;
      },
      createProxy: () => createBrowserNetworkProxy(),
      launchPersistentContext: async (profile, settings) => {
        launches++;
        return chromium.launchPersistentContext(profile, {
          channel: 'chrome',
          headless: true,
          proxy: settings?.proxy,
          acceptDownloads: false,
          serviceWorkers: 'block',
          viewport: { width: 1440, height: 900 },
          args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        });
      },
    });
    const screen = () => {
      const id = randomUUID();
      return engine.screen({
        id,
        manifestPath: `/controlled-test/${id}`,
        session: { id, generation: randomUUID() },
      });
    };
    const first = screen(),
      second = screen();
    try {
      const [a, b] = await Promise.all([first.open(), second.open()]);
      assert.equal(launches, 2);
      assert.notEqual(a.context, b.context);
      await a.page.goto(origin);
      await b.page.goto(origin);
      await a.context.addCookies([
        {
          name: 'synthetic_session',
          value: 'owned-login',
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
      await a.page.evaluate(() => localStorage.setItem('synthetic_login', 'origin-only'));
      await first.synchronize!();
      assert.equal(
        (await b.context.cookies()).find((cookie) => cookie.name === 'synthetic_session')?.value,
        'owned-login',
      );
      assert.equal(
        await b.page.evaluate(() => localStorage.getItem('synthetic_login')),
        'origin-only',
      );
      const nativeTab = await b.context.newPage();
      await nativeTab.goto(secondOrigin);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(nativeTab.isClosed(), false);
      assert.equal(second.peek()?.page, nativeTab);
      assert.deepEqual(
        await nativeTab.evaluate(async () =>
          (globalThis as any).__openbotLoginState('http://127.0.0.1'),
        ),
        [],
      );
      await a.context.clearCookies();
      await a.page.evaluate(() => localStorage.removeItem('synthetic_login'));
      await first.synchronize!();
      assert.equal(
        (await b.context.cookies()).some((cookie) => cookie.name === 'synthetic_session'),
        false,
      );
      assert.equal(await b.page.evaluate(() => localStorage.getItem('synthetic_login')), null);
      await first.close();
      assert.equal(nativeTab.isClosed(), false);
      await engine.close();
      assert.equal(cleanups, 2);
    } finally {
      await engine.close().catch(() => {});
      if (oldOrigins === undefined) delete process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS;
      else process.env.OPENBOT_BROWSER_ALLOWED_ORIGINS = oldOrigins;
      await Promise.all(
        [server, other].map((item) => new Promise<void>((resolve) => item.close(() => resolve()))),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
