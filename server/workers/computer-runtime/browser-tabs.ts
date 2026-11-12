import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';

export interface BrowserTabOptions {
  signal?: AbortSignal;
  authorize?: () => void;
}
export interface BrowserTabList {
  tabs: { tabId: string; url: string; title: string; active: boolean }[];
  truncated: boolean;
}
export interface BrowserTabs {
  list(options?: BrowserTabOptions): Promise<BrowserTabList>;
  select(tabId: string, options?: BrowserTabOptions): Promise<BrowserTabList>;
  close(tabId: string, options?: BrowserTabOptions): Promise<BrowserTabList>;
}

/** IDs name live pages within one screen. Listing never opens a browser or page. */
export function createBrowserTabs(owner: {
  pages(): Page[];
  active(): Page | undefined;
  select(page: Page | undefined): void;
}): BrowserTabs {
  const ids = new WeakMap<Page, string>();
  const pages = () => owner.pages().filter((page) => !page.isClosed());
  const check = (options: BrowserTabOptions) => {
    options.signal?.throwIfAborted();
    options.authorize?.();
  };
  const id = (page: Page) => {
    let value = ids.get(page);
    if (!value) ids.set(page, (value = randomUUID()));
    return value;
  };
  const find = (tabId: string) => {
    const page = pages().find((page) => ids.get(page) === tabId);
    if (!page) throw new Error('标签页已关闭或不属于当前 Bot，请重新查看标签页列表。');
    return page;
  };
  const tabs: BrowserTabs = {
    async list(options = {}) {
      check(options);
      const owned = pages();
      const active = owner.active();
      // Keep the selected page visible even when many popups exceed the response budget.
      const ordered =
        active && owned.includes(active)
          ? [active, ...owned.filter((page) => page !== active)]
          : owned;
      const entries = await Promise.all(
        ordered.slice(0, 100).map(async (page) => ({
          page,
          tabId: id(page),
          title: (await page.title().catch(() => '')).slice(0, 300),
        })),
      );
      check(options);
      const current = new Set(pages());
      return {
        tabs: entries
          .filter(({ page }) => current.has(page))
          .map(({ page, tabId, title }) => ({
            tabId,
            title,
            url: page.url().slice(0, 2048),
            active: page === owner.active(),
          })),
        truncated: owned.length > 100,
      };
    },
    async select(tabId, options = {}) {
      check(options);
      const page = find(tabId);
      await page.bringToFront();
      check(options);
      if (find(tabId) !== page) throw new Error('标签页已失效，请重新查看标签页列表。');
      owner.select(page);
      return tabs.list(options);
    },
    async close(tabId, options = {}) {
      check(options);
      const page = find(tabId);
      await page.close({ runBeforeUnload: false });
      check(options);
      // Closing the final tab leaves the screen empty; it must not launch a replacement.
      if (owner.active() === page) owner.select(pages().at(-1));
      return tabs.list(options);
    },
  };
  return tabs;
}
