import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { settingsLayoutResponse } from './settingsLayoutResponses';

test(
  'workspace settings shows every avatar theme and all artwork at narrow and desktop widths',
  { timeout: 120_000 },
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
    import { useLanguage } from './web/src/i18n/useLanguage';
    import { WorkspaceSettingsDialog } from './web/src/components/WorkspaceSettingsDialog';
    initializeLanguage().setLanguage('en');
    initializeAppearance().update({customAvatarTheme:{name:'${customName}',motif:'elephants',
      colors:['#443388','#226655','#ccaa55'],badge:'moon',backdrop:'halo'},useCustomAvatarTheme:true});
    const noop = () => {};
    const root = createRoot(document.getElementById('fixture'));
    function Fixture() { useLanguage(); return <WorkspaceSettingsDialog workspaceId="${workspaceId}"
      userId="synthetic-owner" canManage team={false} data={{agents:[],settings:{configured:true}}}
      onClose={noop} onSettingsChanged={noop} onPrimaryChanged={noop}
      onImported={noop} onTimeZoneChanged={noop} />; }
    flushSync(() => root.render(<Fixture />));`;
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
      } else if (
        request.method === 'GET' &&
        settingsLayoutResponse(request.url || '', workspaceId)
      ) {
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(settingsLayoutResponse(request.url || '', workspaceId)));
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
      const footer = dialog.locator('.workspace-settings-footer');
      const footerStart = await footer.boundingBox();
      const headerStart = await header.boundingBox();
      assert.ok(footerStart, 'Done remains outside the scrolling settings content');
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
      assert.deepEqual(await footer.boundingBox(), footerStart, 'Done stays pinned');
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
      const trackX =
        scrollBox.x +
        scrollBox.width -
        Math.max(scrollMetrics.reserved, parseFloat(scrollMetrics.track)) / 2;
      await page.mouse.move(trackX, scrollBox.y + 30);
      await page.mouse.down();
      await page.mouse.move(trackX, scrollBox.y + scrollBox.height - 30, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(
        () => (document.querySelector('.workspace-settings-main')?.scrollTop || 0) > 100,
      );
      t.diagnostic('1440px: wheel, keyboard and native scrollbar drag work with fixed header');
      const navigation = dialog.locator('.workspace-settings-navigation');
      for (const [width, height] of [
        [1440, 900],
        [1200, 820],
        [768, 660],
        [390, 660],
        [320, 560],
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
        assert.equal(actual.length, 7);
        assert.deepEqual(
          actual.flatMap((card) => card.nested),
          [64, 64, 64],
        );
        assert.ok(
          new Set(actual.slice(0, 6).map((card) => card.left)).size >= 2,
          `builtin choices remain arranged as a compact grid at ${width}`,
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
          'Classic black',
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
        const fixed = await Promise.all([header.boundingBox(), footer.boundingBox()]);
        await themes.getByRole('button', { name: 'Community GrokBot 18', exact: true }).click();
        const gallery = themes.locator('.avatar-theme-catalog-grid');
        assert.equal(await gallery.locator('button').count(), 18);
        assert.deepEqual(
          await gallery.evaluate((node) => ({
            verticalOverflow: node.scrollHeight - node.clientHeight,
            horizontalOverflow: node.scrollWidth - node.clientWidth,
          })),
          { verticalOverflow: 0, horizontalOverflow: 0 },
          'gallery shares the main scroll area',
        );
        await gallery.locator('button').last().click();
        assert.equal(await gallery.locator('button').last().getAttribute('aria-pressed'), 'true');
        const scrollOwners = await main.evaluate((node) =>
          [...node.querySelectorAll('*')]
            .filter(
              (child) =>
                child.clientHeight > 0 &&
                child.scrollHeight > child.clientHeight + 1 &&
                /^(auto|scroll)$/.test(getComputedStyle(child).overflowY),
            )
            .map((child) => child.className),
        );
        assert.deepEqual(scrollOwners, [], `no nested settings scrollbar at ${width}`);
        assert.deepEqual(await Promise.all([header.boundingBox(), footer.boundingBox()]), fixed);
        for (const [label, section, ready] of [
          ['Bot work', 'work', '.time-zone-settings select:enabled'],
          ['Import memory', 'memory', '.memory-import-panel'],
          ['Usage', 'usage', '.usage-panel[aria-busy="false"]'],
          ['Notifications', 'notifications', '.notifications-panel'],
          ['Signed-in devices', 'devices', '#settings-section-devices'],
          ['Updates', 'updates', '.updates-panel[aria-busy="false"]'],
        ]) {
          await navigation.getByRole('button', { name: label, exact: true }).click();
          await main.locator(ready).waitFor();
          assert.equal(
            await main.evaluate((node) => node.scrollTop),
            0,
            `${section} starts at top`,
          );
          assert.equal(
            await main.evaluate((node) => node.scrollWidth <= node.clientWidth),
            true,
            `${section} has no horizontal overflow at ${width}`,
          );
          assert.equal(
            await dialog.evaluate((node) => node.scrollHeight <= node.clientHeight),
            true,
          );
          if (section === 'devices') {
            assert.equal(
              await main.evaluate((node) => node.scrollHeight > node.clientHeight),
              false,
              'a short settings category does not create a scrollbar',
            );
          }
          await main.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
          });
          assert.deepEqual(await Promise.all([header.boundingBox(), footer.boundingBox()]), fixed);
          const footerReachable = await footer.getByRole('button').evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return node.contains(
              document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
            );
          });
          assert.equal(footerReachable, true, `${section} Done is not covered at ${width}`);
        }
        await navigation.getByRole('button', { name: 'General', exact: true }).click();
        assert.equal(await main.evaluate((node) => node.scrollTop), 0);
        await themes.getByRole('button', { name: 'Built-in themes 6', exact: true }).click();
        t.diagnostic(
          `${width}px: themes, long/short categories, pinned controls and scrolling verified`,
        );
      }
      await dialog.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
      const chinese = page.getByRole('dialog', { name: '设置', exact: true });
      for (const viewport of [
        { width: 1200, height: 820 },
        { width: 320, height: 560 },
      ]) {
        await page.setViewportSize(viewport);
        for (const name of ['经典黑', '新版伙伴', '大熊猫', '小恐龙', '小鸡', '大象']) {
          const choice = chinese.getByRole('button', { name, exact: true });
          await choice.click();
          assert.equal(await choice.getAttribute('aria-pressed'), 'true');
        }
        const chineseMain = chinese.locator('.workspace-settings-main');
        assert.equal(
          await chineseMain.evaluate((node) => node.scrollWidth <= node.clientWidth),
          true,
        );
        assert.equal(
          await chinese
            .locator('.workspace-settings-footer')
            .getByRole('button', { name: '完成' })
            .isVisible(),
          true,
        );
      }
      t.diagnostic(
        'Chinese desktop and narrow layouts: all six built-in choices and Done remain reachable',
      );
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
