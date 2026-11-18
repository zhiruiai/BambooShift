import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright-core';

async function eyes(page: Page, selector: string) {
  return page
    .locator(`${selector} [data-avatar-eye]`)
    .evaluateAll((paths) => paths.map((p) => p.getAttribute('d')).join('|'));
}
test(
  'sidebar and chat sustain actual execution, distinguish approval, and settle with task outcomes',
  { timeout: 45000 },
  async (t) => {
    const built = await build({
      entryPoints: ['tests/web/fixtures/browser/avatarWorkStateFixture.tsx'],
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      write: false,
      outdir: 'fixture',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    });
    const script = built.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const style = built.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1000, height: 900 },
      reducedMotion: 'no-preference',
    });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><style>${style}main{padding:24px}section{padding:12px}#sidebar{width:360px}.group-avatar{position:relative;display:block}.group-avatar>.avatar{position:absolute}</style><div id="fixture"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: script });
      return route.abort();
    });
    await page.goto('https://avatar-work.example.test');
    await page.locator('#indicator [data-avatar-sustained]').waitFor();
    assert.equal(
      await page.locator('#sidebar .avatar').getAttribute('data-avatar-motion'),
      'thinking',
    );
    assert.equal(
      await page.locator('#sidebar .avatar').evaluate((el) => el.getBoundingClientRect().width),
      44,
    );
    assert.equal(
      await page.locator('#message .avatar').evaluate((el) => el.getBoundingClientRect().width),
      32,
    );
    await page.getByRole('button', { name: 'working', exact: true }).click();
    await page.locator('#message [data-avatar-sustained]').waitFor();
    assert.equal(
      await page.locator('#indicator .avatar').count(),
      0,
      'active tool message owns the visible avatar',
    );
    await page.waitForTimeout(3500);
    const live = [await eyes(page, '#sidebar'), await eyes(page, '#message')];
    await page.waitForTimeout(340);
    assert.notEqual(
      await eyes(page, '#sidebar'),
      live[0],
      'sidebar keeps moving beyond the old finite cycle',
    );
    assert.notEqual(
      await eyes(page, '#message'),
      live[1],
      'tool receipt keeps moving until it finishes',
    );
    assert.equal(await page.locator('#group .avatar[data-avatar-sustained]').count(), 1);
    assert.equal(
      await page.locator('#group .group-avatar-2').getAttribute('data-avatar-motion'),
      'working',
      'fourth actual worker is visible and moves, not first member',
    );
    assert.equal(
      await page.locator('#group .group-avatar-0').getAttribute('data-avatar-motion'),
      null,
    );
    await page.getByRole('button', { name: 'finishing', exact: true }).click();
    await page.locator('#message [data-avatar-motion="thinking"][data-avatar-sustained]').waitFor();
    assert.equal(
      await page.locator('#indicator .avatar').count(),
      0,
      'finishing text retains one active avatar',
    );
    const finishing = await eyes(page, '#message');
    await page.waitForTimeout(340);
    assert.notEqual(await eyes(page, '#message'), finishing);
    await page.getByRole('button', { name: 'new-run', exact: true }).click();
    await page.locator('#sidebar [data-avatar-motion="thinking"][data-avatar-sustained]').waitFor();
    assert.equal(
      await page.locator('output').innerText(),
      'four:thinking',
      'old pending requests cannot override a new task gap',
    );
    assert.equal(await page.locator('#history .avatar').getAttribute('data-avatar-motion'), null);
    assert.equal(await page.locator('#history [data-avatar-sustained]').count(), 0);
    await page.getByRole('button', { name: 'queued-followup', exact: true }).click();
    await page.locator('#message [data-avatar-motion="working"][data-avatar-sustained]').waitFor();
    assert.equal(
      await page.locator('output').innerText(),
      'four:working',
      'queued followup does not replace the current run or its actual worker',
    );
    assert.equal(await page.locator('#history .avatar').getAttribute('data-avatar-motion'), null);
    assert.equal(await page.locator('#history [data-avatar-sustained]').count(), 0);
    await page.getByRole('button', { name: 'approval', exact: true }).click();
    await page.locator('#sidebar [data-avatar-motion="attention"]').waitFor();
    assert.equal(await page.locator('#sidebar [data-avatar-sustained]').count(), 0);
    assert.equal(await page.locator('#message [data-avatar-sustained]').count(), 0);
    assert.match(
      await page.locator('#sidebar .conversation-preview').innerText(),
      /Waiting for a response|等待回应/,
    );
    await page.getByRole('button', { name: 'automatic', exact: true }).click();
    await page.locator('#message [data-avatar-motion="working"][data-avatar-sustained]').waitFor();
    for (const scene of ['completed', 'failed', 'history']) {
      await page.getByRole('button', { name: scene, exact: true }).click();
      await page.waitForTimeout(850);
      assert.equal(
        await page.locator('[data-avatar-sustained]').count(),
        0,
        `${scene} must not look busy`,
      );
      assert.equal(await page.locator('#indicator .avatar').count(), 0);
      const settled = [await eyes(page, '#sidebar'), await eyes(page, '#message')];
      await page.waitForTimeout(340);
      assert.deepEqual([await eyes(page, '#sidebar'), await eyes(page, '#message')], settled);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'working', exact: true }).click();
    await page.waitForTimeout(100);
    const reduced = await eyes(page, '#message');
    await page.waitForTimeout(340);
    assert.equal(await eyes(page, '#message'), reduced);
    assert.deepEqual(errors, []);
  },
);
