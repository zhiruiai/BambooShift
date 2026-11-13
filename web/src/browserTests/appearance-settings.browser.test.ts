import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';

test(
  'workspace settings shows every avatar theme and all artwork at narrow and desktop widths',
  { timeout: 60_000 },
  async (t) => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const path = `/w/${workspaceId}`;
    const customName = 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';
    const input = `
    import './web/src/styles.css'; import './web/src/theme.css';
    import { flushSync } from 'react-dom';
    import { createRoot } from 'react-dom/client';
    import { initializeAppearance } from './web/src/appearance';
    import { initializeLanguage } from './web/src/i18n';
    import { WorkspaceSettingsDialog } from './web/src/components/WorkspaceSettingsDialog';
    initializeLanguage().setLanguage('en');
    initializeAppearance().update({customAvatarTheme:{name:'${customName}',motif:'elephants',
      colors:['#443388','#226655','#ccaa55'],badge:'moon',backdrop:'halo'},useCustomAvatarTheme:true});
    const noop = () => {};
    const root = createRoot(document.getElementById('fixture'));
    flushSync(() => root.render(<WorkspaceSettingsDialog workspaceId="${workspaceId}"
      userId="synthetic-owner" canManage team={false} data={{agents:[],settings:{configured:true}}}
      onClose={noop} onSettingsChanged={noop} onPrimaryChanged={noop}
      onImported={noop} onTimeZoneChanged={noop} />));`;
    const bundle = await build({
      stdin: {
        contents: input,
        resolveDir: process.cwd(),
        sourcefile: 'appearance-fixture.tsx',
        loader: 'tsx',
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
    const script = bundle.outputFiles.find((item) => item.path.endsWith('.js'))!.text;
    const style = bundle.outputFiles.find((item) => item.path.endsWith('.css'))!.text;
    const unexpected: string[] = [];
    const errors: string[] = [];
    const fixture = createServer((request, response) => {
      if (request.url === path) {
        response
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(
            `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${style}</style><div id="fixture"></div><script src="/fixture.js"></script>`,
          );
      } else if (request.url === '/fixture.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(script);
      } else {
        unexpected.push(request.url || '');
        response.writeHead(404).end();
      }
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const address = fixture.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        timeout: 15_000,
        ignoreDefaultArgs: ['--hide-scrollbars'],
        args: ['--disable-smooth-scrolling'],
        executablePath:
          process.env.CHROME_EXECUTABLE ||
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });
      const page = await browser.newPage({
        viewport: { width: 1200, height: 820 },
        serviceWorkers: 'block',
      });
      page.setDefaultTimeout(8_000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.context().route('**/*', async (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        unexpected.push(route.request().url());
        return route.abort();
      });
      await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      const main = dialog.locator('.workspace-settings-main');
      const themes = dialog.getByRole('group', { name: 'Avatar theme' });
      const cards = themes.locator('.appearance-avatar-option');
      await themes.getByRole('button', { name: new RegExp(customName), pressed: true }).waitFor();
      await page.setViewportSize({ width: 1440, height: 900 });
      const header = dialog.locator('.modal-header');
      const headerStart = await header.boundingBox();
      const scrollBox = await main.boundingBox();
      assert.ok(headerStart && scrollBox);
      const point = { x: scrollBox.x + 50, y: scrollBox.y + scrollBox.height / 2 };
      const initial = await main.evaluate((node) => ({
        top: node.scrollTop,
        total: node.scrollHeight,
        viewport: node.clientHeight,
        insideDialog:
          node.getBoundingClientRect().bottom <=
          (node.closest('.workspace-settings')?.getBoundingClientRect().bottom || 0),
      }));
      t.diagnostic(`1440px before wheel: ${JSON.stringify(initial)}`);
      assert.ok(initial.insideDialog && initial.total > initial.viewport);
      const hitMain = await page.evaluate(
        ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.workspace-settings-main'),
        point,
      );
      assert.ok(hitMain, 'the actual wheel target is inside settings');
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, 1600);
      await page.waitForFunction((start) => {
        const node = document.querySelector('.workspace-settings-main');
        return (
          node &&
          node.scrollTop > start &&
          node.scrollHeight - node.clientHeight - node.scrollTop <= 1
        );
      }, initial.top);
      const elephants = themes.getByRole('button', { name: 'Elephants', exact: true });
      const hitElephants = await elephants.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const point = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        return { ...point, reached: node.contains(document.elementFromPoint(point.x, point.y)) };
      });
      const scrollMetrics = await main.evaluate((node) => ({
        viewport: node.clientHeight,
        total: node.scrollHeight,
        top: node.scrollTop,
        reserved: node.getBoundingClientRect().width - node.clientWidth,
        track: getComputedStyle(node, '::-webkit-scrollbar').width,
        thumb: getComputedStyle(node, '::-webkit-scrollbar-thumb').backgroundColor,
      }));
      t.diagnostic(`1440px after wheel: ${JSON.stringify({ scrollMetrics, hitElephants })}`);
      assert.equal(
        hitElephants.reached,
        true,
        'second-row option is clickable after ordinary wheel scrolling',
      );
      assert.deepEqual(await header.boundingBox(), headerStart, 'dialog header stays pinned');
      assert.ok(scrollMetrics.reserved >= 8 && parseFloat(scrollMetrics.track) >= 8);
      assert.notEqual(scrollMetrics.thumb, 'rgba(0, 0, 0, 0)');
      await page.mouse.click(hitElephants.x, hitElephants.y);
      assert.equal(await elephants.getAttribute('aria-pressed'), 'true');
      await main.focus();
      assert.ok(await main.evaluate((node) => document.activeElement === node));
      await page.keyboard.press('Home');
      await page.waitForFunction(
        () => document.querySelector('.workspace-settings-main')?.scrollTop === 0,
      );
      await page.keyboard.press('PageDown');
      await page.waitForFunction(
        () => (document.querySelector('.workspace-settings-main')?.scrollTop || 0) > 0,
      );
      assert.deepEqual(await header.boundingBox(), headerStart);
      await page.keyboard.press('Home');
      await page.waitForFunction(
        () => document.querySelector('.workspace-settings-main')?.scrollTop === 0,
      );
      const trackX = scrollBox.x + scrollBox.width - scrollMetrics.reserved / 2;
      await page.mouse.move(trackX, scrollBox.y + 30);
      await page.mouse.down();
      await page.mouse.move(trackX, scrollBox.y + scrollBox.height - 30, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(
        () => (document.querySelector('.workspace-settings-main')?.scrollTop || 0) > 100,
      );
      t.diagnostic('1440px: wheel, keyboard and native scrollbar drag work with fixed header');
      for (const [width, height, columns] of [
        [1200, 820, 4],
        [768, 660, 3],
        [375, 660, 3],
        [320, 560, 2],
      ]) {
        await page.setViewportSize({ width, height });
        const actual = await cards.evaluateAll((nodes) =>
          nodes.map((node) => {
            const box = node.getBoundingClientRect();
            const items = Array.from(
              node.querySelectorAll(
                ':scope > span:not([aria-hidden]), :scope > small, :scope .appearance-avatar-preview > svg',
              ),
            );
            const clipped = items.some((item) => {
              const range = document.createRange();
              range.selectNodeContents(item);
              const rects =
                item instanceof SVGElement
                  ? [item.getBoundingClientRect()]
                  : [...range.getClientRects()];
              const outside =
                !rects.length ||
                rects.some(
                  (rect) =>
                    rect.width < 1 ||
                    rect.left < box.left - 1 ||
                    rect.right > box.right + 1 ||
                    rect.top < box.top - 1 ||
                    rect.bottom > box.bottom + 1,
                );
              return outside;
            });
            const artwork = Array.from(
              node.querySelectorAll<SVGElement>('.appearance-avatar-preview > svg'),
            );
            const nested = artwork.flatMap((image) => {
              const detail = image.querySelector('svg');
              return detail ? [detail.width.baseVal.value] : [];
            });
            const sized = artwork.every((image) => image.getBoundingClientRect().width >= 20);
            return { left: Math.round(box.left), clipped, samples: artwork.length, sized, nested };
          }),
        );
        assert.equal(actual.length, 6);
        assert.deepEqual(
          actual.flatMap((card) => card.nested),
          [64, 64, 64],
        );
        assert.equal(
          new Set(actual.slice(0, 5).map((card) => card.left)).size,
          columns,
          `columns at ${width}`,
        );
        assert.ok(
          actual.every((card) => !card.clipped && card.samples === 3 && card.sized),
          `card layout at ${width}: ${JSON.stringify(actual)}`,
        );
        assert.equal(
          await main.evaluate((el) => el.scrollWidth <= el.clientWidth),
          true,
          `main width at ${width}`,
        );
        for (const name of [
          'Companions',
          'Pandas',
          'Dinosaurs',
          'Chicks',
          'Elephants',
          customName,
        ]) {
          const option = themes.getByRole('button', { name: new RegExp(`^${name}( |$)`) });
          await option.click();
          assert.equal(await option.getAttribute('aria-pressed'), 'true');
        }
        await themes.getByRole('button', { name: 'Design an avatar theme' }).click();
        await themes.getByRole('textbox', { name: 'What should the avatars look like?' }).waitFor();
        await themes.getByRole('button', { name: 'Design an avatar theme' }).click();
        t.diagnostic(`${width}px: all six themes and generation controls reached`);
      }
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      const closed = once(fixture, 'close');
      fixture.close();
      fixture.closeAllConnections();
      await closed;
    }
  },
);
