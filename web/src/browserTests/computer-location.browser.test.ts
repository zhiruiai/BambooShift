import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

test(
  'work computer locations are visible first and switch only on explicit owner actions',
  { timeout: 60_000 },
  async () => {
    const origin = 'https://computer-location.example.test';
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const root = `/api/workspaces/${workspaceId}`;
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
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
      const posts: { path: string; data: unknown }[] = [];
      const unexpected: string[] = [];
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let configured = false;
      let localConnected = false;
      const machine = () => ({
        connected: localConnected,
        name: 'Synthetic computer',
        executionLocation: localConnected ? 'server' : 'none',
        mode: 'local',
        platform: 'test',
        status: localConnected ? 'Connected' : 'Disconnected',
        surface: 'browser',
        capabilities: [],
        targetRevision: localConnected ? 'synthetic-target' : undefined,
      });
      const cloud = (running = false) => ({
        configured,
        name: 'Synthetic managed cloud',
        state: configured ? (running ? 'running' : 'paused') : 'unconfigured',
        expiresAt: null,
        observedAt: '2026-11-07T00:00:00Z',
        worker: { connected: running, reconnectRequired: !running },
        canStart: configured && !running,
      });
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) {
          unexpected.push('external request');
          return route.abort();
        }
        if (url.pathname === `/w/${workspaceId}`) {
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${style}</style><div id="fixture"></div><script src="/fixture.js"></script>`,
          });
        }
        if (url.pathname === '/fixture.js')
          return route.fulfill({ contentType: 'text/javascript', body: script });
        if (request.method() === 'POST') {
          posts.push({ path: url.pathname, data: request.postDataJSON() });
          if (url.pathname === `${root}/computer/connect`) {
            localConnected = true;
            return route.fulfill({ json: machine() });
          }
          if (url.pathname === `${root}/cloud-computer/start`) {
            return route.fulfill({ json: cloud(true) });
          }
        }
        if (url.pathname === `${root}/cloud-computer`) return route.fulfill({ json: cloud() });
        if (url.pathname === `${root}/computer/bots`) {
          return route.fulfill({
            json: { capacity: { max: 1, configured: 1, ready: 0, assigned: 0 }, bots: [] },
          });
        }
        if (url.pathname === `${root}/computer/bots/fixture-bot/status`) {
          return route.fulfill({
            json: { ...machine(), botScreen: { agentId: 'fixture-bot', status: 'unavailable' } },
          });
        }
        unexpected.push(url.pathname);
        return route.fulfill({ json: {}, status: 404 });
      });
      async function open(extra = '') {
        await page.goto(`${origin}/w/${workspaceId}?unconnected${extra}`);
        await page.locator('#open-computer').click();
        const dialog = page.getByRole('dialog');
        const panel = dialog.getByRole('region', { name: 'Choose where to run' });
        await panel.waitFor();
        const screen = await dialog.locator('.computer-screen').boundingBox();
        const choices = await panel
          .getByRole('group', { name: 'Choose where to run' })
          .boundingBox();
        assert.ok(screen && choices);
        assert.ok(
          choices.y + choices.height < screen.y &&
            choices.y + choices.height < page.viewportSize()!.height,
        );
        return panel;
      }
      const owner = await open();
      const local = owner.getByRole('button', { name: 'Local', exact: true });
      const cloudChoice = owner.getByRole('button', { name: 'Cloud computer', exact: true });
      const remote = owner.getByRole('button', { name: 'Other computer', exact: true });
      assert.equal(await local.getAttribute('aria-pressed'), 'true');
      await cloudChoice.click();
      await owner
        .getByText('This workspace has no managed cloud computer yet.', { exact: false })
        .waitFor();
      await owner.getByRole('button', { name: 'Connect your own cloud server' }).click();
      assert.equal(await remote.getAttribute('aria-pressed'), 'true');
      assert.equal(await owner.getByLabel('Computer connection token').inputValue(), '');
      assert.deepEqual(posts, []);
      await local.click();
      await owner.getByRole('button', { name: 'Use local browser' }).click();
      assert.deepEqual(posts, [{ path: `${root}/computer/connect`, data: { mode: 'local' } }]);

      configured = true;
      localConnected = false;
      await page.setViewportSize({ width: 1260, height: 860 });
      const managed = await open();
      await managed.getByRole('button', { name: 'Cloud computer', exact: true }).click();
      const resume = managed.getByRole('button', {
        name: 'Resume and connect (2 hours)',
        exact: true,
      });
      await resume.waitFor();
      assert.equal(posts.length, 1);
      await resume.click();
      assert.deepEqual(posts[1], { path: `${root}/cloud-computer/start`, data: {} });

      const member = await open('&role=member');
      await member.getByRole('button', { name: 'Cloud computer', exact: true }).click();
      await member.getByText('Synthetic managed cloud').waitFor();
      assert.equal(
        await member
          .getByRole('button', { name: 'Resume and connect (2 hours)', exact: true })
          .count(),
        0,
      );
      await member.getByRole('button', { name: 'Other computer', exact: true }).click();
      assert.equal(await member.getByLabel('Computer connection token').count(), 0);
      await member.getByRole('button', { name: 'Local', exact: true }).click();
      assert.equal(await member.getByRole('button', { name: 'Use local browser' }).count(), 0);

      const busy = await open('&busy');
      assert.equal(
        await busy.getByRole('button', { name: 'Use local browser' }).isDisabled(),
        true,
      );
      await busy.getByRole('button', { name: 'Cloud computer', exact: true }).click();
      const busyResume = busy.getByRole('button', {
        name: 'Resume and connect (2 hours)',
        exact: true,
      });
      await busyResume.waitFor();
      assert.equal(await busyResume.isDisabled(), true);
      assert.equal(posts.length, 2);
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
