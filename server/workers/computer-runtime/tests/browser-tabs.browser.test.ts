import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createSharedBrowserEngine } from '../browser-engine.js';
import type { BrowserTabList } from '../browser-tabs.js';
import { LocalComputer } from '../../computer-worker/local.js';

test(
  'real browser tab operations preserve screen ownership, takeover privacy and retired IDs',
  {
    skip: process.env.OPENBOT_BROWSER_TEST !== '1',
    timeout: 150_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bamboo-tabs-browser-'));
    const engine = createSharedBrowserEngine({
      profileDir: join(directory, 'profile'),
      // Synthetic about:blank pages need no network access.
      createProxy: async () => ({ url: 'http://127.0.0.1:9', close: async () => {} }),
      headless: true,
      // Allow a slow cold start on test hosts without changing the product's timeout.
      launchPersistentContext: (profile, settings) =>
        chromium.launchPersistentContext(profile, { ...settings, timeout: 90_000 }),
    });
    const a = engine.screen('alpha'),
      b = engine.screen('beta');
    const computer = new LocalComputer(join(directory, 'workspace'), undefined, {
      browserSession: a,
    });
    const list = async () => (await computer.execute({ type: 'browser_tabs' })) as BrowserTabList;
    try {
      assert.deepEqual(await list(), { tabs: [], truncated: false });
      assert.equal(a.peek(), undefined);
      const first = await a.open(),
        second = await b.open();
      await first.page.setContent('<title>First tab</title><button>First</button>');
      await second.page.setContent('<title>Other Bot tab</title>');
      const firstTab = (await list()).tabs[0];
      const foreign = (await b.tabs!.list()).tabs[0];
      for (const type of ['browser_select_tab', 'browser_close_tab'])
        await assert.rejects(computer.execute({ type, tabId: foreign.tabId }), /不属于当前 Bot/);
      const opened = first.page.waitForEvent('popup');
      await first.page.evaluate(() => {
        window.open('about:blank');
      });
      const popup = await opened;
      await popup.setContent('<title>Owned popup</title>');
      const tabs = await list();
      assert.equal(tabs.tabs.length, 2);
      const popupTab = tabs.tabs.find((tab) => tab.title === 'Owned popup')!;
      assert.equal(popupTab.active, true);
      await computer.execute({ type: 'browser_select_tab', tabId: firstTab.tabId });
      assert.ok(a.peek()?.page === first.page);
      assert.ok(b.peek()?.page === second.page);
      const lease = await computer.startTakeover();
      for (const type of ['browser_tabs', 'browser_select_tab', 'browser_close_tab'])
        await assert.rejects(computer.execute({ type, tabId: firstTab.tabId }), /人工接管/);
      await computer.endTakeover(lease.leaseId);
      await assert.rejects(
        computer.execute(
          { type: 'browser_close_tab', tabId: popupTab.tabId },
          { signal: AbortSignal.abort() },
        ),
      );
      assert.equal(popup.isClosed(), false);
      await computer.execute({ type: 'browser_close_tab', tabId: popupTab.tabId });
      assert.equal(popup.isClosed(), true);
      await assert.rejects(
        computer.execute({ type: 'browser_select_tab', tabId: popupTab.tabId }),
        /已关闭/,
      );
      assert.deepEqual(
        await computer.execute({ type: 'browser_close_tab', tabId: firstTab.tabId }),
        { tabs: [], truncated: false },
      );
      assert.equal(a.peek(), undefined);
      assert.equal(second.page.isClosed(), false);
      const replacement = await a.open();
      assert.ok(replacement.page !== first.page);
      await assert.rejects(
        computer.execute({ type: 'browser_select_tab', tabId: firstTab.tabId }),
        /已关闭/,
      );
    } finally {
      await computer.close();
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
