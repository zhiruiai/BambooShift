import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

test(
  'work computer locations are visible first and switch only on explicit owner actions',
  { timeout: 60_000 },
  async (t) => {
    const origin = 'https://computer-location.example.test';
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const root = `/api/workspaces/${workspaceId}`;
    const bundle = await build({
      entryPoints: ['tests/web/fixtures/browser/dialogScrollFixture.tsx'],
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
      let paired = false;
      let managedMac = false;
      let nativePermission: 'denied' | 'granted' = 'denied';
      let surface = 'browser';
      let accessibilityCaptures = 0;
      let cloudStatusFails = false;
      const machine = () => ({
        connected: localConnected || paired,
        name: 'Synthetic computer',
        executionLocation: paired ? 'remote' : localConnected ? 'server' : 'none',
        mode: paired ? 'remote' : 'local',
        platform: 'test',
        status: localConnected || paired ? 'Connected' : 'Disconnected',
        surface,
        capabilities: paired
          ? ['macos-accessibility-v1', 'workspace-host-desktop-v1']
          : managedMac
            ? ['macos-accessibility-v1', 'macos-app-launch-v1']
            : [],
        desktop:
          paired || managedMac
            ? {
                kind: 'host',
                available: paired,
                authorized: false,
                accessibilityAvailable: true,
                accessibilityPermission: paired ? 'granted' : nativePermission,
                accessibilityReady: paired || nativePermission === 'granted',
                enabled: false,
                width: 1440,
                height: 900,
                permissions: { screenRecording: 'denied', accessibility: 'granted' },
              }
            : undefined,
        targetRevision: localConnected || paired ? 'synthetic-target' : undefined,
        savedRemote: paired
          ? { name: 'Synthetic paired computer', url: 'https://paired.example.test' }
          : undefined,
      });
      const botComputer = () => ({
        ...machine(),
        botScreen: {
          agentId: 'fixture-bot',
          status: paired || managedMac ? 'ready' : 'unavailable',
          shared: paired || managedMac,
        },
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
        if (url.pathname === '/api/account/sessions')
          return route.fulfill({ json: { userId: 'fixture-user', sessions: [] } });
        if (request.method() === 'POST') {
          assert.equal(request.headers()['x-openbot-expected-user'], 'fixture-user');
          const data = request.postDataJSON();
          posts.push({ path: url.pathname, data });
          if (url.pathname === `${root}/computer/connect`) {
            localConnected = data.mode === 'local';
            paired = data.mode === 'remote';
            return route.fulfill({ json: machine() });
          }
          if (url.pathname === `${root}/computer/permissions/refresh`)
            return route.fulfill({ json: machine() });
          if (url.pathname === `${root}/computer/connect/check`) {
            if (data.token !== 'fixture-token') {
              return route.fulfill({ json: { error: 'Connection rejected' }, status: 502 });
            }
            return route.fulfill({
              json: {
                topology: 'shared',
                browser: 'supported',
                desktop: 'notReady',
                accessibility: 'ready',
              },
            });
          }
          if (url.pathname === `${root}/computer/bots/fixture-bot/surface`) {
            surface = data.surface;
            return route.fulfill({ json: botComputer() });
          }
          if (url.pathname === `${root}/cloud-computer/start`) {
            return route.fulfill({ json: cloud(true) });
          }
        }
        if (url.pathname === `${root}/cloud-computer`)
          return cloudStatusFails
            ? route.fulfill({ json: { error: 'Cloud status unavailable' }, status: 502 })
            : route.fulfill({ json: cloud() });
        if (url.pathname === `${root}/computer/status`) return route.fulfill({ json: machine() });
        if (url.pathname === `${root}/computer/authorization`)
          return route.fulfill({
            json: {
              mode: 'confirm',
              targetRevision: machine().targetRevision,
              targetName: machine().name,
              canManage: !new URL(page.url()).searchParams.has('role'),
              scope: 'current-user-current-computer',
            },
          });
        if (url.pathname === `${root}/computer/bots`) {
          return route.fulfill({
            json: { capacity: { max: 1, configured: 1, ready: 0, assigned: 0 }, bots: [] },
          });
        }
        if (url.pathname === `${root}/computer/bots/fixture-bot/status`) {
          return route.fulfill({ json: botComputer() });
        }
        if (url.pathname === `${root}/computer/bots/fixture-bot/takeover/status`)
          return route.fulfill({ json: { active: false, width: 1440, height: 900, surface } });
        if (url.pathname === `${root}/computer/bots/fixture-bot/actions`)
          return route.fulfill({ json: [] });
        if (url.pathname === `${root}/computer/bots/fixture-bot/screenshot`) {
          if (surface === 'accessibility') accessibilityCaptures++;
          return route.fulfill({ json: {}, status: 409 });
        }
        unexpected.push(url.pathname);
        return route.fulfill({ json: {}, status: 404 });
      });
      async function open(extra = '') {
        await page.goto(`${origin}/w/${workspaceId}?unconnected${extra}`);
        await page.locator('#open-computer').click();
        const dialog = page.getByRole('dialog');
        const panel = dialog.getByRole('region', { name: 'Bot’s computer' });
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
      assert.equal(await page.getByLabel('Computer connection token').inputValue(), '');
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
      const refreshCloud = managed.getByRole('button', { name: 'Refresh cloud computer status' });
      cloudStatusFails = true;
      await refreshCloud.click();
      await managed.getByText('Cloud status unavailable').waitFor();
      assert.equal(await resume.isDisabled(), true);
      await managed.getByText('Refresh the status before retrying.', { exact: false }).waitFor();
      assert.equal(posts.length, 1);
      cloudStatusFails = false;
      await refreshCloud.click();
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
      assert.equal(await page.getByLabel('Computer connection token').count(), 0);
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

      await page.setViewportSize({ width: 360, height: 640 });
      await page.goto(`${origin}/w/${workspaceId}?unconnected`);
      await page.locator('#open-workspace-settings').click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      const computer = settings.getByRole('button', { name: 'Computer', exact: true });
      await computer.click();
      assert.equal(await computer.getAttribute('aria-current'), 'page');
      await settings.getByRole('heading', { name: 'Bot’s computer', exact: true }).waitFor();
      const pairing = settings.getByRole('region', { name: 'Your computer' });
      await pairing.getByRole('button', { name: 'Pair a computer' }).click();
      assert.equal(await pairing.evaluate((element) => element === document.activeElement), true);
      await pairing.getByText('Set up a Mac, Linux computer, or your own cloud server').click();
      await pairing.getByRole('checkbox', { name: 'Include Mac app control' }).check();
      await pairing
        .getByText(`npm run computer:pair -- --workspace ${workspaceId} --desktop`)
        .waitFor();
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      await pairing.getByRole('button', { name: 'Copy command' }).click();
      await pairing.getByRole('button', { name: 'Copied' }).waitFor();
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        `npm run computer:pair -- --workspace ${workspaceId} --desktop`,
      );
      const address = pairing.getByLabel('Computer address');
      const token = pairing.getByLabel('Computer connection token');
      const check = pairing.getByRole('button', { name: 'Check connection' });
      const connect = pairing.getByRole('button', { name: 'Connect this computer' });
      await address.fill('http://paired.example.test');
      await token.fill('fixture-rejected-token');
      assert.equal(await check.isDisabled(), true);
      assert.equal(await connect.isDisabled(), true);
      assert.equal(posts.length, 2);
      await address.fill('https://paired.example.test');
      await check.click();
      await pairing.getByRole('alert').getByText('Could not verify this computer').waitFor();
      await token.fill('fixture-token');
      await check.click();
      await pairing.getByText('Computer reached and workspace verified').waitFor();
      await pairing.getByText('Browser support advertised · Mac app control is ready').waitFor();
      assert.deepEqual(posts.slice(2), [
        {
          path: `${root}/computer/connect/check`,
          data: { url: 'https://paired.example.test', token: 'fixture-rejected-token' },
        },
        {
          path: `${root}/computer/connect/check`,
          data: { url: 'https://paired.example.test', token: 'fixture-token' },
        },
      ]);
      await connect.click();
      await pairing.getByText('Remembered computer · Synthetic paired computer').waitFor();
      assert.deepEqual(posts[4], {
        path: `${root}/computer/connect`,
        data: { mode: 'remote', url: 'https://paired.example.test', token: 'fixture-token' },
      });
      assert.equal(await token.inputValue(), '');
      await settings.getByRole('button', { name: 'Watch Bot’s screen' }).click();
      const computerDialog = page.getByRole('dialog', { name: "Fixture Bot's computer" });
      await computerDialog.waitFor();
      await computerDialog.getByRole('button', { name: 'Mac apps', exact: true }).click();
      const useMacApps = computerDialog.getByRole('button', { name: 'Use Mac apps' });
      assert.equal(await useMacApps.isEnabled(), true);
      assert.equal(posts.length, 5, 'selection alone never changes the control surface');
      await useMacApps.click();
      await computerDialog.getByText(/ask it to click Clear in Calculator/).waitFor();
      assert.equal(await computerDialog.getByText(/App launches require approval/).count(), 0);
      assert.deepEqual(posts[5], {
        path: `${root}/computer/bots/fixture-bot/surface`,
        data: { surface: 'accessibility', confirm: true },
      });
      assert.equal(await computerDialog.locator('.computer-screen').count(), 0);
      assert.equal(accessibilityCaptures, 0);

      await t.test(
        'managed Mac shows its own Accessibility permission before it is granted',
        async () => {
          paired = false;
          localConnected = true;
          managedMac = true;
          surface = 'browser';
          const before = posts.length;
          await page.goto(`${origin}/w/${workspaceId}?managed-mac`);
          await page.locator('#open-computer').click();
          const dialog = page.getByRole('dialog', { name: "Fixture Bot's computer" });
          await dialog.getByText(/Execution on this Mac/).waitFor();
          await dialog.getByText('Mac app control needs Accessibility permission').waitFor();
          assert.equal(await dialog.getByRole('button', { name: 'Use local browser' }).count(), 0);
          assert.equal(await dialog.getByLabel('Computer connection token').count(), 0);
          await dialog.getByRole('button', { name: 'Mac apps', exact: true }).click();
          await dialog.locator('.desktop-permissions').getByText('Not allowed yet').waitFor();
          await dialog.getByText(/Enable BambooShift/).waitFor();
          const selectMacApps = dialog.getByRole('button', { name: 'Use Mac apps' });
          assert.equal(await selectMacApps.isDisabled(), true);
          assert.equal(posts.length, before);

          nativePermission = 'granted';
          await dialog.getByRole('button', { name: 'Check permissions again' }).click();
          await dialog
            .locator('.desktop-permissions')
            .getByText('Allowed', { exact: true })
            .waitFor();
          await selectMacApps.click();
          await dialog.getByText(/Open Calculator.*Full access lets it proceed directly/).waitFor();
          assert.deepEqual(posts.slice(before), [
            {
              path: `${root}/computer/permissions/refresh`,
              data: { expectedTargetRevision: 'synthetic-target' },
            },
            {
              path: `${root}/computer/bots/fixture-bot/surface`,
              data: { surface: 'accessibility', confirm: true },
            },
          ]);
          assert.equal(accessibilityCaptures, 0);
        },
      );
      await t.test(
        'saved local connection restores authorization from a disconnected bootstrap',
        async () => {
          paired = false;
          localConnected = true;
          managedMac = true;
          nativePermission = 'granted';
          surface = 'browser';
          const before = posts.length;
          await page.goto(`${origin}/w/${workspaceId}?unconnected&managed-mac`);
          await page.locator('#open-computer').click();
          let dialog = page.getByRole('dialog', { name: "Fixture Bot's computer" });
          await dialog.getByText(/Execution on this Mac/).waitFor();
          await dialog
            .getByRole('region', { name: 'Default computer permissions' })
            .getByText('Changes require confirmation', { exact: true })
            .waitFor();
          assert.equal(
            await dialog.getByRole('button', { name: /^Full access/ }).isEnabled(),
            true,
          );
          assert.equal(await dialog.getByRole('button', { name: 'Use local browser' }).count(), 0);
          await page.goto(`${origin}/w/${workspaceId}?unconnected&managed-mac`);
          await page.locator('#open-workspace-settings').click();
          dialog = page.getByRole('dialog', { name: 'Settings' });
          await dialog.getByRole('button', { name: 'Computer', exact: true }).click();
          await dialog.getByText(/Execution on this Mac/).waitFor();
          await dialog
            .getByRole('region', { name: 'Default computer permissions' })
            .getByText('Changes require confirmation', { exact: true })
            .waitFor();
          assert.equal(
            await dialog.getByRole('button', { name: /^Full access/ }).isEnabled(),
            true,
          );
          assert.equal(posts.length, before, 'restoring the connection never grants authorization');
        },
      );
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
