import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { COMMUNITY_AVATAR_PACKS } from '../avatarThemes';

const origin = 'https://community-avatars.example.test';
test(
  'community packs are selectable offline, persist, and animate only visible active tasks',
  { timeout: 90_000 },
  async (t) => {
    const built = await build({
      entryPoints: ['web/src/browserTests/communityAvatarFixture.tsx'],
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
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${style}</style><div id="fixture"></div><script>${script.replaceAll('</script', '<\\/script')}</script>`;
    const browser = await chromium.launch({ channel: 'chrome' });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    const errors: string[] = [],
      unexpected: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      if (route.request().url() === `${origin}/`)
        return route.fulfill({ contentType: 'text/html', body: html });
      unexpected.push(route.request().url());
      await route.abort();
    });
    await page.goto(origin);
    const chooseGroup = (name: string) =>
      page.locator('.avatar-theme-families button').filter({ hasText: name }).click();
    const choose = (id: string) => page.locator(`[data-theme-choice="${id}"]`).click();
    const state = (value: string) => page.getByRole('button', { name: value, exact: true }).click();
    const eyes = () =>
      page
        .locator('#selected-avatar [data-avatar-eye]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d')));
    assert.equal(await page.locator('[data-community-sample]').count(), 40);
    assert.equal(await page.locator('#selected-avatar [data-avatar-theme="classic"]').count(), 1);
    assert.equal(
      await page.locator('#selected-avatar .avatar-classic-body').getAttribute('fill'),
      '#1c1c1c',
    );
    assert.equal(
      await page.locator('[data-theme-choice="classic"]').getAttribute('aria-pressed'),
      'true',
    );
    const classicPoses = [];
    for (const value of ['idle', 'thinking', 'working', 'attention', 'done', 'error']) {
      await state(value);
      classicPoses.push((await eyes()).join(' '));
    }
    assert.equal(new Set(classicPoses).size, 6);
    for (const pack of COMMUNITY_AVATAR_PACKS) {
      await chooseGroup(pack.name);
      assert.equal(await page.locator('[data-theme-choice]').count(), pack.themes.length);
      assert.equal(
        await page.getByRole('link', { name: 'License', exact: true }).getAttribute('href'),
        `/licenses/${pack.id}.html`,
      );
      for (const theme of [pack.themes[0], pack.themes.at(-1)!]) {
        await choose(theme.id);
        assert.equal(
          await page.locator(`#selected-avatar [data-avatar-theme="${theme.id}"]`).count(),
          1,
        );
        await page.reload();
        assert.equal(
          await page.locator(`[data-theme-choice="${theme.id}"]`).getAttribute('aria-pressed'),
          'true',
        );
        assert.equal(
          await page.locator(`#selected-avatar [data-avatar-theme="${theme.id}"]`).count(),
          1,
        );
      }
    }
    await choose('grokbot-blob');
    const poses: string[] = [];
    for (const value of ['idle', 'thinking', 'working', 'attention', 'done', 'error']) {
      await state(value);
      await page.waitForTimeout(45);
      poses.push((await eyes()).join(' '));
    }
    assert.equal(new Set(poses).size, 6);
    const still = await eyes();
    await page.waitForTimeout(180);
    assert.deepEqual(await eyes(), still);
    assert.equal(await page.locator('#historical [data-avatar-motion]').count(), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await state('working');
    await page.waitForTimeout(170);
    const working = await eyes();
    await page.waitForTimeout(150);
    assert.notDeepEqual(await eyes(), working);
    await state('done');
    await page.waitForTimeout(120);
    const intermediate = (await eyes()).join(' ');
    assert.notEqual(intermediate, poses[4]);
    await page.waitForTimeout(650);
    assert.equal((await eyes()).join(' '), poses[4]);
    await state('working');
    await page.getByRole('button', { name: 'Wait for result', exact: true }).click();
    await page.locator('#selected-avatar').scrollIntoViewIfNeeded();
    assert.equal(
      await page.locator('#selected-avatar [data-avatar-expression="working"]').count(),
      1,
    );
    await state('error');
    await page.waitForTimeout(650);
    assert.equal((await eyes()).join(' '), poses[5]);
    await state('working');
    await page.locator('#page-end').scrollIntoViewIfNeeded();
    await page.waitForTimeout(140);
    const hidden = await eyes();
    await page.waitForTimeout(220);
    assert.deepEqual(await eyes(), hidden);
    await page.locator('#selected-avatar').scrollIntoViewIfNeeded();
    await page.waitForTimeout(160);
    assert.notDeepEqual(await eyes(), hidden);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(80);
    const reduced = await eyes();
    await page.waitForTimeout(170);
    assert.deepEqual(await eyes(), reduced);
    await page.setViewportSize({ width: 390, height: 844 });
    await chooseGroup('Open Bot Avatar');
    await choose('open-avatar-witch-hat');
    assert.equal(
      await page
        .locator('[data-theme-choice="open-avatar-witch-hat"]')
        .getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(
      await page
        .locator('.avatar-theme-catalog-grid')
        .evaluate(
          (node) =>
            node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === 'auto',
        ),
      false,
      'the avatar catalog grows within its page instead of trapping the wheel in a nested scroller',
    );
    await page.getByRole('button', { name: 'Language', exact: true }).click();
    await page.locator('[data-theme-choice="open-avatar-witch-hat"]').scrollIntoViewIfNeeded();
    assert.equal(
      await page.locator('[data-theme-choice="open-avatar-witch-hat"]').getAttribute('aria-label'),
      '巫师帽',
    );
    await page.getByRole('button', { name: 'Language', exact: true }).click();
    if (process.env.BAMBOOSHIFT_AVATAR_DEMO === '1') {
      const directory = '.local/avatar-research/community';
      await mkdir(directory, { recursive: true });
      const presentationStyle =
        '.community-test-controls,#historical,#page-end{display:none!important}';
      await writeFile(
        `${directory}/index.html`,
        html.replace('</style>', `${presentationStyle}</style>`),
      );
      await page.addStyleTag({ content: presentationStyle });
      await page.setViewportSize({ width: 1440, height: 1100 });
      await chooseGroup('Community GrokBot');
      await choose('grokbot-blob');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => scrollTo(0, 0));
      const frames: string[] = [];
      for (const value of ['idle', 'thinking', 'working', 'attention', 'done']) {
        await state(value);
        for (let i = 0; i < 14; i++) {
          frames.push((await page.screenshot()).toString('base64'));
          await page.waitForTimeout(65);
        }
      }
      await writeFile(`${directory}/frames.json`, JSON.stringify({ interval: 90, frames }));
      await page.screenshot({ path: `${directory}/community-collections.png` });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  },
);
