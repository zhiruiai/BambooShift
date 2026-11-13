import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright-core';

const origin = 'https://avatar-expression.example.test';
const capture = process.env.BAMBOOSHIFT_AVATAR_DEMO === '1';
const states = ['Idle', 'Thinking', 'Working', 'Needs approval', 'Completed', 'Failed'];

async function completionFrames(page: Page, outcome: 'done' | 'error') {
  // Keep this observer in the browser realm without TypeScript's function-name helpers.
  return page.evaluate<{
    from: string;
    to: string;
    final: string;
    between: boolean;
  }>(`(async (outcome) => {
    const live = document.querySelector('#live-avatar');
    const read = () => live.querySelector('[data-avatar-eye]')?.getAttribute('d');
    const from = read();
    const reference = outcome === 'done' ? '#historical' : '#historical-error';
    const to = document.querySelector(reference + ' [data-avatar-eye]').getAttribute('d');
    const frames = new Set();
    await new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const current = read();
        if (current) frames.add(current);
        if (current === to) finish();
      });
      const timeout = setTimeout(finish, 2500);
      function finish() {
        clearTimeout(timeout);
        observer.disconnect();
        resolve();
      }
      observer.observe(live, { subtree: true, attributes: true, childList: true });
      const done = document.querySelector(
        '.fixture-controls button:nth-child(' + (outcome === 'done' ? 5 : 6) + ')',
      );
      done.click();
    });
    return { from, to, final: read(), between: [...frames].some((d) => d !== from && d !== to) };
  })(${JSON.stringify(outcome)})`);
}

async function recordPreview(page: Page) {
  const directory = '.local/avatar-research/production';
  await mkdir(directory, { recursive: true });
  await page.setViewportSize({ width: 1200, height: 500 });
  await page.evaluate(() => scrollTo(0, 0));
  const frames: string[] = [];
  const hold = [700, 1050, 1330, 980, 1190, 1400];
  for (const [index, state] of states.entries()) {
    await page.getByRole('button', { name: state, exact: true }).click();
    for (let elapsed = 0; elapsed < hold[index]; elapsed += 70) {
      const start = performance.now();
      frames.push((await page.screenshot()).toString('base64'));
      await page.waitForTimeout(Math.max(0, 70 - (performance.now() - start)));
    }
    if (state === 'Completed' || state === 'Failed') {
      await page.screenshot({ path: `${directory}/${state.toLowerCase()}.png` });
    }
  }
  await writeFile(`${directory}/frames.json`, JSON.stringify({ interval: 70, frames }));
}

test(
  'original avatar themes render six task expressions and stop updating when hidden',
  {
    timeout: 60_000,
  },
  async (t) => {
    assert.deepEqual(
      await readFile('shared/avatar-face-motion.json'),
      await readFile('mobile/assets/avatars/avatar-face-motion.json'),
    );
    const built = await build({
      entryPoints: ['web/src/browserTests/avatarFaceFixture.tsx'],
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      write: false,
      outdir: 'fixture-dist',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    });
    const script = built.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const style = built.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const browser = await chromium
      .launch({ executablePath: process.env.CHROME_EXECUTABLE })
      .catch((error: Error) => {
        if (process.env.CHROME_EXECUTABLE || !error.message.includes("Executable doesn't exist"))
          throw error;
        return chromium.launch({ channel: 'chrome' });
      });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1200, height: 570 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) {
        if (url.pathname === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style><div id="fixture"></div><script src="/fixture.js"></script>`,
          });
        if (url.pathname === '/fixture.js')
          return route.fulfill({ contentType: 'text/javascript', body: script });
        if (url.pathname === '/api/bot-avatars/11111111-1111-4111-8111-111111111111')
          return route.fulfill({
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#347466"/></svg>',
          });
      }
      unexpected.push(url.pathname);
      await route.abort();
    });
    await page.goto(origin);
    const select = (state: string) =>
      page.getByRole('button', { name: state, exact: true }).click();
    const shapes = () =>
      page
        .locator('.fixture-hero [data-avatar-eye]')
        .evaluateAll((paths) => paths.map((path) => path.getAttribute('d')));
    const seen = [];
    for (const [index, label] of states.entries()) {
      await select(label);
      const state = ['idle', 'thinking', 'working', 'attention', 'done', 'error'][index];
      assert.equal(await page.locator(`#faces [data-avatar-expression="${state}"]`).count(), 15);
      const current = await shapes();
      assert.equal(current.length, 10);
      seen.push(current);
    }
    for (let theme = 0; theme < 5; theme++) {
      assert.equal(
        new Set(seen.map((frame) => frame.slice(2 * theme, 2 * theme + 2).join(' '))).size,
        6,
      );
    }
    const reduced = await shapes();
    await page.waitForTimeout(180);
    assert.deepEqual(await shapes(), reduced);
    assert.equal(await page.locator('#uploaded img').count(), 1);
    assert.equal(await page.locator('#uploaded [data-avatar-expression]').count(), 0);
    const historical = page.locator('#historical .avatar');
    assert.equal(await historical.getAttribute('data-avatar-motion'), null);
    assert.equal(await historical.locator('[data-avatar-expression="done"]').count(), 1);
    assert.equal(await historical.locator('[data-avatar-pupil][opacity="0"]').count(), 2);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await select('Working');
    const pupil = '.fixture-hero [data-avatar-pupil]';
    const firstX = await page.locator(pupil).first().getAttribute('x');
    await page.waitForFunction(
      ({ pupil, firstX }) => document.querySelector(pupil)?.getAttribute('x') !== firstX,
      { pupil, firstX },
    );
    const moving = () =>
      page
        .locator('#faces [data-avatar-pupil]')
        .evaluateAll((pupils) => pupils.map((pupil) => pupil.getAttribute('x')));
    await page.addStyleTag({ content: '#faces { transform: translateX(-200vw) }' });
    await page.waitForTimeout(200);
    const hidden = await moving();
    await page.waitForTimeout(240);
    assert.deepEqual(await moving(), hidden);
    await page.evaluate(() => document.querySelector('style:last-of-type')!.remove());
    await page.waitForFunction(
      ({ pupil, x }) => document.querySelector(pupil)?.getAttribute('x') !== x,
      {
        pupil,
        x: hidden[0],
      },
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(80);
    const stopped = await moving();
    await page.waitForTimeout(220);
    assert.deepEqual(await moving(), stopped);

    for (const wait of [false, true]) {
      for (const outcome of ['done', 'error'] as const) {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await select('Working');
        if (wait) await page.getByRole('button', { name: 'Wait for result' }).click();
        await page.locator('#live-avatar').scrollIntoViewIfNeeded();
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        const completion = await completionFrames(page, outcome);
        assert.ok(completion.from && completion.from !== completion.to);
        assert.equal(completion.final, completion.to);
        assert.ok(completion.between, `the live eye must interpolate into the ${outcome} pose`);
      }
    }

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await select('Working');
    await select('Completed');
    assert.equal(
      await page.locator('#live-avatar .avatar').getAttribute('data-avatar-motion'),
      null,
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator('#live-avatar .avatar').getAttribute('data-avatar-motion'),
      null,
    );

    await page.getByRole('button', { name: 'Add test avatars' }).click();
    assert.equal(await page.locator('#stress [data-avatar-expression]').count(), 50);
    const ids = await page
      .locator('[data-avatar-eye][id], clipPath[id]')
      .evaluateAll((eyes) => eyes.map((eye) => eye.id));
    assert.equal(new Set(ids).size, ids.length);
    await page.getByRole('button', { name: 'Remove test avatars' }).click();
    assert.equal(await page.locator('#stress [data-avatar-expression]').count(), 0);
    await page.setViewportSize({ width: 360, height: 720 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    t.diagnostic(
      'Six expressions, offscreen pause, reduced motion, historical results and uploads verified.',
    );

    if (capture) {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await recordPreview(page);
      const body = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Task expressions · BambooShift</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style><div id="fixture" data-preview="true"></div><script>${script.replaceAll('</script', '<\\/script')}</script>`;
      await writeFile('.local/avatar-research/production/index.html', body);
      const preview = await browser.newPage();
      const previewRequests: string[] = [];
      preview.on('request', (request) => previewRequests.push(request.url()));
      await preview.setContent(body);
      await preview.getByRole('button', { name: 'Thinking', exact: true }).click();
      assert.equal(await preview.locator('#faces [data-avatar-expression="thinking"]').count(), 15);
      assert.equal(await preview.locator('.fixture-test-extras').count(), 0);
      assert.deepEqual(previewRequests, []);
      await preview.close();
    }
  },
);
