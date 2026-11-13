import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

test(
  'chat picker keeps search, close and creation actions reachable in short windows',
  { timeout: 60_000 },
  async () => {
    const origin = 'https://chat-picker.example.test';
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
      import './web/src/styles.css'; import './web/src/theme.css';
      import { createRoot } from 'react-dom/client';
      import { NewChatPicker } from './web/src/components/NewChatPicker';
      import { initializeLanguage } from './web/src/i18n';
      initializeLanguage().setLanguage(location.search === '?en' ? 'en' : 'zh-CN');
      const agents = Array.from({length:24}, (_, i) => ({ id:'a'+i, name:'Synthetic '+i,
        role:'Research', description:'', instructions:'', avatar:'orb', color:'#2e7268', status:'idle' }));
      const data = { agents, conversations: agents.map(a => ({ id:'c'+a.id, title:a.name,
        agentIds:[a.id], isGroup:false, updatedAt:'2026-11-14T00:00:00Z', unread:0, pinned:false })),
        sidebarRoster:{ revision:'one', sections:[], entries:[] } };
      createRoot(document.getElementById('fixture')).render(<NewChatPicker data={data} canCreateBot
        isCurrent={() => true} onOpen={chat => { document.body.dataset.opened = chat.id; }}
        onCreate={mode => { document.body.dataset.created = mode; }}
        onClose={() => { document.body.dataset.closed = 'true'; }} />);
    `,
      },
      bundle: true,
      write: false,
      outdir: 'fixture-dist',
      format: 'iife',
      jsx: 'automatic',
      platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    const script = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const style = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    try {
      const page = await browser.newPage();
      const unexpected: string[] = [];
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/') {
          await route.fulfill({
            contentType: 'text/html',
            body: `<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${style}</style><div id="fixture"></div><script src="/fixture.js"></script>`,
          });
        } else if (url.origin === origin && url.pathname === '/fixture.js') {
          await route.fulfill({ contentType: 'text/javascript', body: script });
        } else {
          unexpected.push(url.pathname);
          await route.abort();
        }
      });
      for (const locale of ['en', 'zh']) {
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 390, height: 640 },
          { width: 740, height: 420 },
          { width: 568, height: 320 },
          { width: 320, height: 330 },
        ]) {
          await page.setViewportSize(viewport);
          await page.goto(`${origin}/?${locale}`);
          const panel = page.locator('.new-chat-picker');
          const results = page.locator('.new-chat-results');
          const search = page.getByRole('combobox');
          const actions = page.locator('.new-chat-actions button');
          await actions.last().waitFor();
          const metrics = await panel.evaluate((el) => ({
            width: el.clientWidth,
            scrollWidth: el.scrollWidth,
            height: el.clientHeight,
            scrollHeight: el.scrollHeight,
          }));
          assert.ok(
            metrics.scrollHeight <= metrics.height + 1 && metrics.scrollWidth <= metrics.width + 1,
            JSON.stringify({ locale, viewport, metrics }),
          );
          assert.ok(
            await results.evaluate(
              (el) => el.clientHeight >= 44 && el.scrollHeight > el.clientHeight,
            ),
          );
          const anchors = await Promise.all([
            panel.locator('header').boundingBox(),
            search.boundingBox(),
            page.locator('.new-chat-actions').boundingBox(),
          ]);
          for (const rect of anchors)
            assert.ok(
              rect && rect.y >= 0 && rect.y + rect.height <= viewport.height,
              JSON.stringify({ locale, viewport, anchors }),
            );
          await search.press('ArrowUp');
          assert.ok(await results.evaluate((el) => el.scrollTop > 0));
          assert.deepEqual(
            await Promise.all([
              panel.locator('header').boundingBox(),
              search.boundingBox(),
              page.locator('.new-chat-actions').boundingBox(),
            ]),
            anchors,
          );
          assert.equal(await panel.evaluate((el) => el.scrollTop), 0);
          await actions.last().focus();
          await page.keyboard.press('Tab');
          assert.equal(
            await panel.locator('.new-chat-close').evaluate((el) => el === document.activeElement),
            true,
          );
          await search.fill('No matching synthetic entry');
          await panel.getByRole('status').waitFor();
          assert.ok(await panel.evaluate((el) => el.scrollHeight <= el.clientHeight + 1));
          await actions.nth(2).click();
          assert.equal(await page.locator('body').getAttribute('data-created'), 'team');
        }
      }
      for (const [index, mode] of ['bot', 'group', 'team'].entries()) {
        await page.goto(`${origin}/?en`);
        await page.locator('.new-chat-actions button').nth(index).click();
        assert.equal(await page.locator('body').getAttribute('data-created'), mode);
      }
      await page.goto(`${origin}/?en`);
      await page.locator('.new-chat-close').click();
      assert.equal(await page.locator('body').getAttribute('data-closed'), 'true');
      assert.deepEqual(unexpected, []);
    } finally {
      await browser.close();
    }
  },
);
