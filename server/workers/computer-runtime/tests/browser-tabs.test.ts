import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { createBrowserTabs } from '../browser-tabs.js';
import { LocalComputer } from '../../computer-worker/local.js';
import { validateComputerAction } from '../../computer-worker/protocol.js';

test('closing the last tab never creates a page, and a new page cannot reuse its ID', async () => {
  let closed = false;
  const page = {
    isClosed: () => closed,
    url: () => 'https://example.test/',
    title: async () => 'Example',
    close: async (options: unknown) => {
      assert.deepEqual(options, { runBeforeUnload: false });
      closed = true;
    },
  } as unknown as Page;
  let owned = [page],
    active: Page | undefined = page;
  const tabs = createBrowserTabs({
    pages: () => owned,
    active: () => active,
    select: (page) => {
      active = page;
    },
  });
  const old = (await tabs.list()).tabs[0].tabId;
  assert.deepEqual(await tabs.close(old), { tabs: [], truncated: false });
  assert.equal(active, undefined);
  await assert.rejects(tabs.close(old), /已关闭/);
  owned = [{ ...page, isClosed: () => false } as Page];
  assert.notEqual((await tabs.list()).tabs[0].tabId, old);
  await assert.rejects(tabs.select(old), /已关闭/);
});

test('a tab list does not return pages retired while titles were loading', async () => {
  let finish!: (value: string) => void;
  const page = {
    isClosed: () => false,
    url: () => 'https://example.test/',
    title: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  } as unknown as Page;
  let owned = [page];
  const tabs = createBrowserTabs({ pages: () => owned, active: () => page, select() {} });
  const listing = tabs.list();
  owned = [];
  finish('Retired page title');
  assert.deepEqual(await listing, { tabs: [], truncated: false });
});

test('listing checks authority again before disclosing titles', async () => {
  let finish!: (value: string) => void;
  let allowed = true;
  const page = {
    isClosed: () => false,
    url: () => 'https://example.test/',
    title: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  } as unknown as Page;
  const tabs = createBrowserTabs({ pages: () => [page], active: () => page, select() {} });
  const listing = tabs.list({
    authorize() {
      if (!allowed) throw new Error('takeover');
    },
  });
  allowed = false;
  finish('Private takeover page');
  await assert.rejects(listing, /takeover/);
});

test('tab action validation keeps only IDs and refuses malformed targets', async () => {
  const tabId = '12345678-1234-1234-1234-123456789abc';
  assert.deepEqual(
    validateComputerAction({ type: 'browser_tabs', url: 'https://untrusted.test/' }),
    { type: 'browser_tabs' },
  );
  for (const type of ['browser_select_tab', 'browser_close_tab']) {
    for (const invalid of [undefined, '', 1, 't1', tabId.toUpperCase(), '../page'])
      assert.throws(() => validateComputerAction({ type, tabId: invalid }));
    assert.deepEqual(validateComputerAction({ type, tabId, title: 'fake', status: 'approved' }), {
      type,
      tabId,
    });
  }
  const computer = new LocalComputer('/unused-tab-list-fixture');
  assert.deepEqual(await computer.execute({ type: 'browser_tabs' }), {
    tabs: [],
    truncated: false,
  });
  await computer.close();
});
