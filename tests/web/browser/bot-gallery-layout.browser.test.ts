import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Locator } from 'playwright-core';

const origin = 'https://bot-gallery-layout.example.test';

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  assert.ok(box);
  return box;
}

test(
  'Bot gallery pages and preview actions stay reachable without overlapping cards at desktop and mobile sizes',
  { skip: process.env.OPENBOT_BROWSER_TEST !== '1', timeout: 60000 },
  async (t) => {
    const { outputFiles } = await build({
      stdin: {
        contents: `
          import './web/src/styles.css';
          import './web/src/theme.css';
          import { createRoot } from 'react-dom/client';
          import { TemplateLibrary } from './web/src/components/templates/TemplateLibrary';
          import { initializeLanguage } from './web/src/i18n';
          initializeLanguage().setLanguage('zh-CN');
          const scope = {ticket: () => 1, current: () => true, request: async () => []};
          createRoot(document.getElementById('root')).render(
            <TemplateLibrary owner scope={scope} onClose={() => {}} />
          );
        `,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outdir: 'fixture',
      format: 'iife',
      jsx: 'automatic',
      platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
      logLevel: 'silent',
    });
    const script = outputFiles.find(({ path }) => path.endsWith('.js'))!.text;
    const style = outputFiles.find(({ path }) => path.endsWith('.css'))!.text;
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_EXECUTABLE,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: 'zh-CN' });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin);
      if (url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      assert.equal(url.pathname, '/fixture.js');
      return route.fulfill({ contentType: 'text/javascript', body: script });
    });
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 960, height: 720 },
      { width: 390, height: 844 },
      { width: 320, height: 560 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(origin);
      const dialog = page.getByRole('dialog', { name: 'Bot 广场' });
      const cards = dialog.locator('.starter-card');
      await cards.first().waitFor();
      const header = await bounds(dialog.locator('.modal-header'));
      const seen = new Set<string>();
      for (let index = 0; index < 4; index++) {
        assert.equal(await cards.count(), 4);
        for (const name of await cards.locator('strong').allTextContents()) seen.add(name);
        await cards.last().click();
        const preview = dialog.locator('.starter-selected');
        await preview.waitFor();
        const pagination = await bounds(dialog.locator('.starter-pagination'));
        const lastCard = await bounds(cards.last());
        assert.ok(lastCard.y + lastCard.height <= pagination.y + 1, 'cards stop before pagination');
        if (viewport.width > 760) {
          const notice = await bounds(dialog.locator('.starter-notice'));
          assert.ok(pagination.y + pagination.height <= notice.y, 'pagination stops before footer');
          assert.ok(
            await dialog
              .locator('.starter-grid')
              .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
            'four desktop cards fit without a list scrollbar',
          );
        } else {
          const panel = await bounds(preview);
          assert.ok(
            panel.y >= pagination.y + pagination.height,
            'mobile preview follows pagination',
          );
          assert.equal(
            await preview
              .locator('.starter-selected-scroll')
              .evaluate((el) => getComputedStyle(el).overflowY),
            'visible',
            'mobile content uses the catalog scroll region',
          );
        }
        await dialog.getByRole('button', { name: '直接使用', exact: true }).click({ trial: true });
        await dialog
          .getByRole('button', { name: '使用模板并编辑', exact: true })
          .click({ trial: true });
        assert.deepEqual(await bounds(dialog.locator('.modal-header')), header);
        const next = dialog.getByRole('button', { name: '下一页 Bot', exact: true });
        if (index < 3) await next.click();
        else assert.equal(await next.isDisabled(), true);
      }
      assert.equal(seen.size, 16, 'all sixteen distinct Bots are reachable through real clicks');
      await dialog.getByRole('button', { name: '上一页 Bot', exact: true }).click();
      await dialog.getByRole('searchbox').fill('研究员');
      assert.equal(await cards.count(), 1);
      await cards.first().click();
      await dialog.locator('.starter-selected .template-detail').first().locator('summary').click();
      await dialog.getByRole('button', { name: '直接使用', exact: true }).click({ trial: true });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    }
    assert.deepEqual(errors, []);
  },
);
