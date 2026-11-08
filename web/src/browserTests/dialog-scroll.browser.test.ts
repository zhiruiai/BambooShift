import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Locator, type Page } from 'playwright-core';

async function verifyFrameGone(page: Page, image: Locator, source: string) {
  await image.waitFor({ state: 'detached' });
  assert.equal(
    await page.evaluate(
      (url) =>
        fetch(url).then(
          () => true,
          () => false,
        ),
      source,
    ),
    false,
  );
}

async function verifyScroll(dialog: Locator, page: Page) {
  const body = dialog.locator(':scope > .modal-body');
  const header = dialog.locator(':scope > .modal-header');
  const before = await header.boundingBox();
  assert.ok(before);
  const geometry = await dialog.evaluate((el) => {
    const body = el.querySelector(':scope > .modal-body')!;
    const header = el.querySelector(':scope > .modal-header')!;
    return {
      outerScroll: el.scrollHeight - el.clientHeight,
      overflow: el.scrollWidth - el.clientWidth,
      bodyOverflow: body.scrollWidth - body.clientWidth,
      bodyScroll: body.scrollHeight - body.clientHeight,
      bodyTop: body.getBoundingClientRect().top,
      headerBottom: header.getBoundingClientRect().bottom,
      top: el.getBoundingClientRect().top,
      bottom: el.getBoundingClientRect().bottom,
    };
  });
  assert.equal(geometry.outerScroll, 0, JSON.stringify(geometry));
  if (page.viewportSize()!.width < 760)
    assert.ok(geometry.bodyScroll > 0, JSON.stringify(geometry));
  assert.ok(geometry.overflow <= 1 && geometry.bodyOverflow <= 1, JSON.stringify(geometry));
  assert.ok(geometry.bodyTop >= geometry.headerBottom, JSON.stringify(geometry));
  assert.ok(geometry.top >= 0 && geometry.bottom <= page.viewportSize()!.height);
  for (const offset of [170, Number.MAX_SAFE_INTEGER]) {
    await body.evaluate((el, top) => {
      el.scrollTop = top;
    }, offset);
    assert.equal(await body.evaluate((el) => el.scrollTop > 0), geometry.bodyScroll > 0);
    assert.deepEqual(await header.boundingBox(), before);
    const hits = await dialog.evaluate((el) => {
      const header = el.querySelector(':scope > .modal-header')!;
      const rect = header.getBoundingClientRect();
      const gap = document.elementFromPoint(rect.left + 15, rect.top - 7);
      const title = document.elementFromPoint(rect.left + 15, rect.top + 15);
      const close = header.querySelector('button')!;
      const button = close.getBoundingClientRect();
      return {
        noBleed: !gap?.closest('.modal-body'),
        title: !!title?.closest('.modal-header'),
        close: close.contains(
          document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2),
        ),
      };
    });
    assert.deepEqual(hits, { noBleed: true, title: true, close: true });
  }
  const last = dialog
    .locator(
      'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]',
    )
    .last();
  await last.focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await header.locator('button').evaluate((el) => document.activeElement === el),
    true,
  );
  await page.keyboard.press('Shift+Tab');
  assert.equal(await last.evaluate((el) => document.activeElement === el), true);
  assert.deepEqual(await header.boundingBox(), before);
}

test(
  'template, skills, model and computer dialogs isolate body scrolling from their fixed header',
  { timeout: 120_000 },
  async () => {
    const origin = 'https://dialog-scroll.example.test';
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const bundle = await build({
      entryPoints: ['web/src/browserTests/dialogScrollFixture.tsx'],
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
      timeout: 15_000,
      args: ['--disable-smooth-scrolling'],
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    let releaseFrame: (() => void) | undefined;
    let releaseEnd: (() => void) | undefined;
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(8000);
      const unexpected: string[] = [],
        errors: string[] = [];
      let controlling = false,
        holdFrame = false,
        holdEnd = false,
        privateCaptures = 0,
        expiresAt = '';
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
        'base64',
      );
      const screen = {
        agentId: 'fixture-bot',
        shared: true,
        status: 'ready',
        lifecycle: { state: 'ready', releaseAllowed: false, resetAllowed: false },
      };
      const computerPath = `/api/workspaces/${workspaceId}/computer`;
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin === origin && url.pathname === `/w/${workspaceId}`)
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${style}</style><div id="fixture"></div><script src="/fixture.js"></script>`,
          });
        if (url.origin === origin && url.pathname === '/fixture.js')
          return route.fulfill({ contentType: 'text/javascript', body: script });
        if (
          url.origin === origin &&
          request.method() === 'GET' &&
          url.pathname === `/api/workspaces/${workspaceId}/model-profiles`
        )
          return route.fulfill({
            json: {
              activeProfileId: 'fixture',
              profiles: [
                {
                  id: 'fixture',
                  name: 'Synthetic model',
                  provider: 'deepseek',
                  model: 'deepseek-flash',
                  baseUrl: '',
                  vision: false,
                  hasApiKey: false,
                  configured: false,
                  credentialSource: 'none',
                },
              ],
            },
          });
        if (
          url.origin === origin &&
          url.pathname === `/api/workspaces/${workspaceId}/cloud-computer` &&
          request.method() === 'GET'
        )
          return route.fulfill({ json: { configured: false } });
        if (
          url.origin === origin &&
          url.pathname === `${computerPath}/bots` &&
          request.method() === 'GET'
        )
          return route.fulfill({
            json: {
              capacity: { max: 1, configured: 1, ready: 1, assigned: 0 },
              shared: true,
              bots: [screen],
            },
          });
        const botPath = `${computerPath}/bots/fixture-bot`;
        if (
          url.origin === origin &&
          url.pathname === `${botPath}/status` &&
          request.method() === 'GET'
        )
          return route.fulfill({
            json: {
              connected: true,
              name: 'Synthetic computer',
              mode: 'local',
              surface: 'browser',
              platform: 'test',
              status: 'Connected',
              capabilities: ['private-takeover-frames-v1'],
              targetRevision: 'fixture-target',
              botScreen: screen,
            },
          });
        if (
          url.origin === origin &&
          url.pathname === `${botPath}/actions` &&
          request.method() === 'GET'
        )
          return route.fulfill({
            json: Array.from({ length: 12 }, (_, i) => ({
              id: `action-${i}`,
              type: 'browser_navigate',
              payload: { url: 'https://example.test' },
              status: 'done',
              createdAt: '2026-11-07T00:00:00Z',
              result: { title: 'Synthetic page' },
            })),
          });
        if (
          url.origin === origin &&
          url.pathname === `${botPath}/screenshot` &&
          request.method() === 'GET'
        ) {
          assert.equal(request.headers()['x-openbot-computer-lease'], undefined);
          return controlling
            ? route.fulfill({ status: 409, json: { code: 'COMPUTER_PRIVATE_TAKEOVER' } })
            : route.fulfill({
                body: png,
                headers: { 'Content-Type': 'image/png', 'X-OpenBot-Frame-Visibility': 'shared' },
              });
        }
        if (url.origin === origin && url.pathname === `${botPath}/takeover/screenshot`) {
          assert.equal(request.method(), 'POST');
          assert.equal(url.search, '');
          assert.deepEqual(request.postDataJSON(), {});
          assert.equal(request.headers()['x-openbot-computer-lease'], 'synthetic-only');
          assert.equal(request.headers()['x-openbot-expected-user'], 'fixture-user');
          assert.equal(controlling, true);
          privateCaptures++;
          if (holdFrame) {
            holdFrame = false;
            await new Promise<void>((resolve) => {
              releaseFrame = resolve;
            });
          }
          return route
            .fulfill({
              body: png,
              headers: {
                'Content-Type': 'image/png',
                'Cache-Control': 'private, no-store',
                'X-OpenBot-Frame-Visibility': 'takeover',
              },
            })
            .catch(() => {});
        }
        if (
          url.origin === origin &&
          url.pathname === `${botPath}/takeover/status` &&
          request.method() === 'GET'
        )
          return route.fulfill({
            json: {
              active: controlling,
              width: 1440,
              height: 900,
              ...(controlling ? { expiresAt } : {}),
            },
          });
        if (
          url.origin === origin &&
          url.pathname === `${botPath}/takeover/start` &&
          request.method() === 'POST'
        ) {
          controlling = true;
          expiresAt = new Date(Date.now() + 300000).toISOString();
          return route.fulfill({
            json: {
              leaseId: 'synthetic-only',
              width: 1440,
              height: 900,
              expiresAt,
            },
          });
        }
        if (
          url.origin === origin &&
          url.pathname === `${botPath}/takeover/end` &&
          request.method() === 'POST'
        ) {
          if (holdEnd) {
            holdEnd = false;
            await new Promise<void>((resolve) => {
              releaseEnd = resolve;
            });
          }
          controlling = false;
          return route.fulfill({ json: { active: false } });
        }
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.abort();
      });
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 640 },
        { width: 320, height: 560 },
      ]) {
        await page.setViewportSize(viewport);
        if (viewport.width === 320) await page.clock.install();
        await page.goto(`${origin}/w/${workspaceId}`);
        for (const mode of ['templates', 'skills', 'settings', 'computer']) {
          await page.locator(`#open-${mode}`).click();
          const dialog = page.getByRole('dialog');
          await dialog.waitFor();
          if (mode === 'templates') {
            await dialog.locator('.starter-card').last().waitFor();
            await dialog.getByRole('tablist').waitFor({ state: 'visible' });
            const input = dialog.locator('input[type="search"]');
            assert.equal(await input.isVisible(), true);
            const original = await dialog.locator('.modal-header').boundingBox();
            await dialog.locator('.starter-card').last().click();
            await dialog.locator('.starter-selected').waitFor();
            assert.deepEqual(await dialog.locator('.modal-header').boundingBox(), original);
            await input.fill('research');
            assert.equal(
              await input.evaluate(
                (el) =>
                  document.elementFromPoint(
                    el.getBoundingClientRect().x + 10,
                    el.getBoundingClientRect().y + 10,
                  ) === el,
              ),
              true,
            );
            await input.fill('');
          }
          if (mode === 'settings') await dialog.locator('.model-profile-choice select').waitFor();
          if (mode === 'computer') {
            const image = dialog.locator('.computer-screen img');
            await image.waitFor();
            const publicSource = await image.getAttribute('src');
            const previousCaptures = privateCaptures;
            await dialog.getByRole('button', { name: 'Take over computer', exact: true }).click();
            await dialog.locator('.takeover-bar.active').waitFor();
            await image.waitFor();
            const privateSource = await image.getAttribute('src');
            assert.ok(privateSource?.startsWith('blob:'));
            assert.notEqual(privateSource, publicSource);
            assert.ok(privateCaptures > previousCaptures);
            const bar = dialog.locator('.takeover-bar.active');
            if (viewport.width < 760) {
              await dialog.locator('.modal-body').evaluate((el) => {
                const bar = el.querySelector('.takeover-bar.active')!;
                el.scrollTop +=
                  bar.getBoundingClientRect().top - el.getBoundingClientRect().top + 30;
              });
              const bodyBox = await dialog.locator('.modal-body').boundingBox();
              const barBox = await bar.boundingBox();
              const inset = await dialog
                .locator('.modal-body')
                .evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
              assert.ok(
                bodyBox && barBox && Math.abs(bodyBox.y + inset - barBox.y) <= 1,
                JSON.stringify({ bodyBox, barBox, inset, viewport }),
              );
              assert.ok((await bar.getByRole('button').boundingBox())!.height >= 44);
            }
          }
          await verifyScroll(dialog, page);
          if (mode === 'computer' && viewport.width === 1440) {
            const image = dialog.locator('.computer-screen img');
            const privateSource = await image.getAttribute('src');
            assert.ok(privateSource);
            holdFrame = true;
            const refresh = page.waitForRequest((request) =>
              request.url().endsWith('/takeover/screenshot'),
            );
            await dialog.getByRole('button', { name: 'Refresh screen' }).click();
            await refresh;
            holdEnd = true;
            const ending = page.waitForRequest((request) =>
              request.url().endsWith('/takeover/end'),
            );
            await dialog.getByRole('button', { name: 'End takeover' }).click();
            await ending;
            await verifyFrameGone(page, image, privateSource);
            releaseFrame?.();
            releaseEnd?.();
            await dialog
              .getByRole('button', { name: 'End takeover' })
              .waitFor({ state: 'detached' });
          } else if (mode === 'computer') {
            const image = dialog.locator('.computer-screen img');
            const privateSource = await image.getAttribute('src');
            assert.ok(privateSource);
            if (viewport.width === 390) {
              const ending = page.waitForRequest((request) =>
                request.url().endsWith('/takeover/end'),
              );
              await page.evaluate(() => window.dispatchEvent(new Event('openbot:revalidate')));
              await ending;
            } else {
              await page.clock.fastForward(310_000);
            }
            await verifyFrameGone(page, image, privateSource);
            await dialog
              .getByRole('button', { name: 'End takeover' })
              .waitFor({ state: 'detached' });
          }
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
          assert.equal(
            await page.locator(`#open-${mode}`).evaluate((el) => document.activeElement === el),
            true,
          );
        }
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
    } finally {
      releaseFrame?.();
      releaseEnd?.();
      await browser.close();
    }
  },
);
