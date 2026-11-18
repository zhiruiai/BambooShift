import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

test(
  'conversation Library filters, expands date groups and recovers after a failed pin',
  { timeout: 45_000 },
  async (t) => {
    const origin = 'https://conversation-library.example.test';
    const bundle = await build({
      entryPoints: ['tests/web/fixtures/browser/conversationLibraryFixture.tsx'],
      bundle: true,
      write: false,
      outdir: 'fixture-dist',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
      logLevel: 'silent',
    });
    const script = bundle.outputFiles.find(({ path }) => path.endsWith('.js'))!.text;
    const css = bundle.outputFiles.find(({ path }) => path.endsWith('.css'))!.text;
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : undefined),
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 320, height: 720 },
      timezoneId: 'UTC',
    });
    page.setDefaultTimeout(5000);
    await page.clock.setFixedTime('2026-11-11T12:00:00Z');
    const writes: unknown[] = [];
    let releasePin!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePin = resolve;
    });
    t.after(releasePin);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(`${origin}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>${css}</style><div id="fixture" style="width:260px;margin:auto"></div>
            <script src="/fixture.js"></script>`,
        });
      if (path === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path === '/fixture-pin') {
        writes.push(route.request().postDataJSON());
        if (writes.length === 1) {
          await blocked;
          return route.fulfill({ status: 500 });
        }
        return route.fulfill({ json: {} });
      }
      return route.abort();
    });
    await page.goto(origin);
    const filters = page.getByRole('group', { name: 'Filter library' });
    const filter = (name: string) => filters.getByRole('button', { name, exact: true });
    const heading = (name: string) => page.getByRole('heading', { name, exact: true });
    const item = (name: string) => page.getByRole('button', { name, exact: true });
    const group = (name: string) => page.locator('section').filter({ has: heading(name) });

    await heading('Today').waitFor();
    assert.equal(await filter('All').getAttribute('aria-pressed'), 'true');
    assert.equal(await group('Today').getByRole('listitem').count(), 5);
    assert.equal(await group('This week').getByRole('listitem').count(), 1);
    assert.equal(await group('Older').getByRole('listitem').count(), 1);
    assert.equal(await item('Manual 1.pdf').count(), 0);
    await group('Today').getByRole('button', { name: 'Show more' }).click();
    assert.equal(await group('Today').getByRole('listitem').count(), 7);
    await item('Manual 1.pdf').waitFor();

    await filter('Files').click();
    await item('Upload file').waitFor();
    assert.equal(await item('Screenshot.png').count(), 0);
    assert.equal(await group('Today').getByRole('listitem').count(), 5);
    await filter('Media').click();
    await item('Screenshot.png').waitFor();
    assert.equal(await page.getByRole('listitem').count(), 1);
    assert.equal(await item('Upload file').count(), 0);
    await filter('Websites').click();
    await item('Earlier website').waitFor();
    assert.equal(await heading('Today').count(), 0);
    await filter('Links').click();
    await item('Weekly reference').waitFor();
    assert.equal(await page.getByRole('listitem').count(), 1);

    const pin = item('Pin Weekly reference');
    await pin.press('Enter');
    await page.locator('button[aria-busy="true"]').waitFor();
    assert.ok(await pin.isDisabled());
    releasePin();
    assert.equal(await page.getByRole('alert').textContent(), 'Could not sync pinned items.');
    assert.ok(await pin.isDisabled());
    await filter('Pinned').click();
    assert.equal(await page.getByText('No pinned items yet.').count(), 0);
    await item('Try again').click();
    await page.getByText('No pinned items yet.').waitFor();

    await filter('All').click();
    await pin.press('Enter');
    const unpin = group('Pinned').getByRole('button', { name: 'Unpin Weekly reference' });
    await unpin.waitFor();
    assert.equal(await heading('This week').count(), 0);
    assert.ok(await unpin.evaluate((button) => button === document.activeElement));
    await filter('Pinned').click();
    await item('Unpin Weekly reference').press('Enter');
    await page.getByText('No pinned items yet.').waitFor();
    assert.ok(await filter('Pinned').evaluate((button) => button === document.activeElement));
    assert.deepEqual(
      writes,
      [true, true, false].map((pinned) => ({
        kind: 'link',
        target: 'https://example.test/reference',
        pinned,
      })),
    );

    await page.goto(`${origin}/?zh`);
    await heading('今天').waitFor();
    await heading('本周').waitFor();
    await item('置顶「Weekly reference」').waitFor();
    assert.deepEqual(errors, []);
  },
);
