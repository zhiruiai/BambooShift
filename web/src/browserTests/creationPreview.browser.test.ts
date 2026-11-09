import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { basename } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { APPEARANCE_STORAGE_KEY } from '../appearance';

const profile = {
  name: 'Synthetic research Bot',
  role: 'Researcher',
  description: 'Compare sources.',
  instructions: 'Verify citations and dates.',
  avatar: 'spark',
  color: '#556677',
  avatarImageId: null,
};
const theme = {
  name: 'Night canopy',
  motif: 'elephants',
  colors: ['#443388', '#226655', '#ccaa55'],
  badge: 'moon',
  backdrop: 'halo',
};

async function storedAppearance(page: Page) {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) || 'null'),
    APPEARANCE_STORAGE_KEY,
  );
}

test(
  'synthetic browser reviews Bot and avatar drafts and keeps chat handoffs stable',
  { timeout: 105000 },
  async (t) => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const pagePath = `/w/${workspaceId}`;
    const apiPath = `/api/workspaces/${workspaceId}/creation-preview`;
    const bundle = await build({
      entryPoints: ['web/src/browserTests/creationPreviewFixture.tsx'],
      bundle: true,
      minify: true,
      splitting: true,
      write: false,
      outdir: 'fixture-dist',
      format: 'esm',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    const scripts = new Map(
      bundle.outputFiles
        .filter((file) => file.path.endsWith('.js'))
        .map((file) => [`/${basename(file.path)}`, file.text]),
    );
    const style = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const requested: { actor?: string; language?: string; body: unknown }[] = [];
    const unexpected: string[] = [];
    const pageErrors: string[] = [];
    const served: string[] = [];
    const requestFailures: string[] = [];
    const fixture = createServer(async (request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const path = url.pathname;
      served.push(`${request.method} ${path}`);
      const script = scripts.get(path);
      if (path === pagePath && request.method === 'GET') {
        const scene = url.searchParams.get('surface');
        const surface = scene && ['bot', 'theme', 'chat'].includes(scene) ? scene : '';
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${style}</style><div id="fixture" data-surface="${surface}"></div><script type="module" src="/creationPreviewFixture.js"></script>`,
        );
      } else if (script && request.method === 'GET') {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(script);
      } else if (path === apiPath && request.method === 'POST') {
        let source = '';
        try {
          for await (const chunk of request) {
            source += chunk.toString();
            if (source.length > 65536) throw new Error('Oversized fixture request');
          }
          const body = JSON.parse(source);
          const actor = request.headers['x-openbot-expected-user'];
          requested.push({
            actor: typeof actor === 'string' ? actor : undefined,
            language: request.headers['accept-language'],
            body,
          });
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify(
              body.kind === 'bot' ? { kind: 'bot', profile } : { kind: 'theme', theme },
            ),
          );
        } catch {
          response.writeHead(400).end();
        }
      } else {
        unexpected.push(`${request.method} ${path}`);
        response.writeHead(404).end();
      }
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const address = fixture.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    let browser: Browser | undefined;
    let page: Page | undefined;
    const cancelled = () => {
      void browser?.close().catch(() => {});
    };
    t.signal.addEventListener('abort', cancelled, { once: true });
    try {
      browser = await chromium.launch({
        headless: true,
        timeout: 30000,
        executablePath:
          process.env.CHROME_EXECUTABLE ||
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });
      t.signal.throwIfAborted();
      page = await browser.newPage({
        viewport: { width: 1100, height: 850 },
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      page.setDefaultTimeout(18000);
      page.setDefaultNavigationTimeout(25000);
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('requestfailed', (request) => {
        requestFailures.push(`${new URL(request.url()).pathname} ${request.failure()?.errorText}`);
      });
      await page.context().route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === origin) return route.continue();
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        return route.abort();
      });

      await page.goto(`${origin}${pagePath}?surface=bot`, { waitUntil: 'domcontentloaded' });
      const dialog = page.getByRole('dialog');
      const botName = dialog.getByLabel('Bot name', { exact: true });
      await dialog.waitFor();
      t.diagnostic('Creation dialog rendered from the synthetic origin.');
      await dialog.getByRole('button', { name: 'Design a Bot with AI' }).press('Enter');
      const botBrief = dialog.getByLabel('What should this Bot do?');
      await botBrief.fill('  Build a Bot to verify evidence.  ');
      await dialog.getByRole('button', { name: 'Generate draft' }).press('Enter');
      await dialog.getByText(profile.name, { exact: true }).waitFor();
      assert.equal(await botName.inputValue(), '');
      await dialog.getByRole('button', { name: 'Review and edit Bot' }).press('Enter');
      assert.equal(await botName.inputValue(), profile.name);
      assert.equal(
        await dialog.getByLabel('Work role', { exact: true }).inputValue(),
        profile.role,
      );
      assert.equal(
        await dialog.getByLabel('Persistent instructions').inputValue(),
        profile.instructions,
      );
      await botName.fill('Edited research Bot');
      assert.equal(await botName.inputValue(), 'Edited research Bot');
      t.diagnostic('Bot draft reached the editable profile.');

      await page.goto(`${origin}${pagePath}?surface=theme`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Design an avatar theme' }).press('Enter');
      await page
        .getByLabel('What should the avatars look like?')
        .fill('A nighttime elephant theme.');
      await page.getByRole('button', { name: 'Generate draft' }).press('Enter');
      await page.getByText(theme.name, { exact: true }).waitFor();
      assert.equal(await page.locator('.creation-theme-samples > svg').count(), 3);
      assert.equal((await storedAppearance(page))?.customAvatarTheme, undefined);
      await page.getByRole('button', { name: 'Apply on this device' }).press('Enter');
      const generatedOption = page.getByRole('button', { name: /Night canopy/, pressed: true });
      await generatedOption.waitFor();
      assert.deepEqual((await storedAppearance(page)).customAvatarTheme, theme);
      assert.equal((await storedAppearance(page)).useCustomAvatarTheme, true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await generatedOption.waitFor();
      t.diagnostic('Applied avatar theme persisted after reload.');

      await page.goto(`${origin}${pagePath}?surface=chat`, { waitUntil: 'domcontentloaded' });
      const botCard = page.locator('#message-bot-draft');
      const themeCard = page.locator('#message-theme-draft');
      await botCard.getByText('Bot profile draft').waitFor();
      await themeCard.getByText('Avatar theme draft').waitFor();
      assert.equal(await page.getByText('Bot profile draft', { exact: true }).count(), 1);
      assert.equal(await page.getByText('Avatar theme draft', { exact: true }).count(), 1);
      assert.equal(await page.locator('.typing-cursor').count(), 0);
      assert.equal(await page.locator('#message-tail').count(), 0);
      const worker = page.locator('.working-line .avatar > svg');
      const headerAvatar = page.locator('.chat-header [data-avatar-motion="idle"] .avatar-eyes');
      const avatarAnimation = (element: Element) => getComputedStyle(element).animationName;
      await worker.waitFor();
      assert.equal(await worker.evaluate(avatarAnimation), 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      assert.equal(await worker.evaluate(avatarAnimation), 'avatar-breathe');
      assert.equal(await headerAvatar.count(), 0, 'working does not animate the header');
      const advance = page.getByRole('button', { name: 'Advance synthetic run' });
      await advance.press('Enter');
      await page.locator('#message-tail .typing-cursor').waitFor();
      assert.equal(await page.locator('.typing-cursor').count(), 1);
      const activeAvatar = page.locator('#message-tail .avatar > svg');
      assert.equal(await activeAvatar.evaluate(avatarAnimation), 'avatar-breathe');
      await advance.press('Enter');
      await page.locator('#message-tail .typing-cursor').waitFor({ state: 'detached' });
      const completion = page.locator('#message-tail [data-avatar-motion="done"]');
      await completion.waitFor();
      assert.equal(await activeAvatar.evaluate(avatarAnimation), 'avatar-settle');
      assert.equal(await headerAvatar.evaluate(avatarAnimation), 'avatar-idle-blink');
      assert.equal(
        await headerAvatar.evaluate((eyes) => getComputedStyle(eyes).animationIterationCount),
        '1',
      );
      await completion.waitFor({ state: 'detached' });
      assert.equal(await activeAvatar.evaluate(avatarAnimation), 'none');
      await page.waitForFunction(
        () =>
          document
            .querySelector('.chat-header [data-avatar-motion="idle"] .avatar-eyes')
            ?.getAnimations().length === 0,
      );
      const toggleGroupHeader = page.getByRole('button', { name: 'Toggle group header' });
      await toggleGroupHeader.press('Enter');
      assert.equal(await page.locator('.chat-header .group-avatar .avatar').count(), 2);
      assert.equal(await headerAvatar.count(), 1, 'only the group lead blinks');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await headerAvatar.evaluate(avatarAnimation), 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await toggleGroupHeader.press('Enter');
      await advance.press('Enter');
      const questionAvatar = page.locator('#message-follow-up-question .avatar > svg');
      await questionAvatar.waitFor();
      assert.equal(await questionAvatar.evaluate(avatarAnimation), 'avatar-attention');
      assert.equal(await headerAvatar.count(), 0, 'needs input has a static header');
      assert.equal(await page.getByText('Bot profile draft', { exact: true }).count(), 1);
      assert.equal(await page.getByText('Avatar theme draft', { exact: true }).count(), 1);

      await page.getByRole('button', { name: 'View as member' }).press('Enter');
      assert.equal(await questionAvatar.evaluate(avatarAnimation), 'none');
      assert.equal(await page.getByRole('button', { name: 'Review and edit Bot' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Apply on this device' }).count(), 0);
      await page.getByRole('button', { name: 'View as owner' }).press('Enter');
      await botCard.getByRole('button', { name: 'Review and edit Bot' }).press('Enter');
      await botName.waitFor();
      assert.equal(await botName.inputValue(), 'Chat planning Bot');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
      await dialog.getByRole('button', { name: 'Discard changes and continue' }).press('Enter');
      await dialog.waitFor({ state: 'detached' });
      assert.deepEqual((await storedAppearance(page)).customAvatarTheme, theme);
      await themeCard.getByRole('button', { name: 'Apply on this device' }).press('Enter');
      await themeCard.getByRole('status').filter({ hasText: 'Applied on this device' }).waitFor();
      assert.equal((await storedAppearance(page)).customAvatarTheme.name, 'Chat comet theme');

      assert.deepEqual(requested, [
        {
          actor: 'synthetic-owner',
          language: 'en',
          body: { kind: 'bot', brief: 'Build a Bot to verify evidence.', language: 'en' },
        },
        {
          actor: 'synthetic-owner',
          language: 'en',
          body: { kind: 'theme', brief: 'A nighttime elephant theme.', language: 'en' },
        },
      ]);
      assert.deepEqual(unexpected, []);
      assert.deepEqual(pageErrors, []);
    } catch (error) {
      const dom = await page
        ?.evaluate(() => ({
          scene: document.getElementById('fixture')?.dataset.surface,
          mounted: !!document.querySelector('#fixture main'),
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          search: location.search,
        }))
        .catch(() => undefined);
      t.diagnostic(JSON.stringify({ served, requestFailures, pageErrors, unexpected, dom }));
      throw error;
    } finally {
      t.signal.removeEventListener('abort', cancelled);
      try {
        await browser?.close();
      } finally {
        const closed = once(fixture, 'close');
        fixture.close();
        fixture.closeAllConnections();
        await closed;
      }
    }
  },
);
