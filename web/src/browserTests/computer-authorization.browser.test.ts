import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

test(
  'full computer authorization persists, revokes and does not follow a changed computer',
  { timeout: 60_000 },
  async (t) => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const origin = 'https://computer-authorization.example.test';
    const base = `/api/workspaces/${workspaceId}/computer`;
    const bundle = await build({
      stdin: {
        contents: `
        import './web/src/styles.css';
        import './web/src/theme.css';
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { createComputerScope } from './web/src/computerScope';
        import { ComputerAuthorizationSettings } from './web/src/components/computer/ComputerAuthorizationSettings';
        import { initializeLanguage } from './web/src/i18n';
        initializeLanguage().setLanguage('zh-CN');
        const scope = createComputerScope({workspaceId: '${workspaceId}', userId:'fixture-user', ...(location.search ? {agentId: 'fixture-bot'} : {})});
        function Fixture() {
          const [target, setTarget] = useState('target-a');
          const [busy, setBusy] = useState(false);
          const [runningCommand, setRunningCommand] = useState(false);
          return <main style={{maxWidth: 640, padding: 16, margin: 'auto'}}>
            <ComputerAuthorizationSettings key={target} scope={scope} targetRevision={target}
              targetName="当前电脑" disabled={busy || runningCommand} onBusyChange={setBusy} />
            <button onClick={() => setTarget('target-b')}>Switch computer</button>
            <button onClick={() => setRunningCommand(value => !value)}>{runningCommand ? 'Stop simulated command' : 'Simulate running command'}</button>
          </main>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outdir: 'fixture-dist',
      format: 'iife',
      jsx: 'automatic',
      platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
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
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
    page.setDefaultTimeout(8000);
    let mode = 'confirm',
      target = 'target-a',
      owner = true,
      loseReply = false,
      failRead = false;
    let rejectWrite = false;
    const errors: string[] = [],
      unexpected: string[] = [],
      writes: unknown[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const state = () => ({
      mode,
      targetRevision: target,
      targetName: '这台 Mac',
      canManage: owner,
      scope: 'current-user-current-computer',
      ...(mode === 'full' ? { grantedAt: '2026-11-16T00:00:00Z' } : {}),
    });
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push('external');
        return route.abort();
      }
      if (request.isNavigationRequest())
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === `${base}/authorization`) {
        assert.equal(request.headers()['x-openbot-expected-user'], 'fixture-user');
        if (request.method() === 'POST') {
          const value = request.postDataJSON();
          writes.push(value);
          assert.equal(value.expectedTargetRevision, target);
          if (rejectWrite) return route.fulfill({ status: 503, json: { error: '授权暂未保存' } });
          mode = value.mode;
          if (loseReply) {
            loseReply = false;
            return route.abort();
          }
        } else if (failRead)
          return route.fulfill({ status: 503, json: { error: '授权状态暂不可用' } });
        return route.fulfill({ json: state() });
      }
      unexpected.push(url.pathname);
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto(`${origin}/w/${workspaceId}`);
    const section = page.getByRole('region', { name: '电脑默认权限' });
    const full = section.getByRole('button', { name: /^完全授权/ });
    const confirm = section.getByRole('button', { name: /^每次确认/ });
    await section.getByText('修改操作需确认', { exact: true }).waitFor();
    assert.deepEqual(writes, [], 'loading never grants authorization');
    assert.equal(await confirm.getAttribute('aria-pressed'), 'true');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const button = await full.boundingBox();
    assert.ok(button && button.y + button.height < 700, 'authorization action is visible at 320px');
    await full.click();
    await section.getByText('已完全授权', { exact: true }).waitFor();
    assert.deepEqual(writes, [{ mode: 'full', expectedTargetRevision: 'target-a' }]);
    if (process.env.BAMBOOSHIFT_COMPUTER_AUTH_SCREENSHOT_DIR) {
      const directory = process.env.BAMBOOSHIFT_COMPUTER_AUTH_SCREENSHOT_DIR;
      await page.screenshot({
        path: `${directory}/computer-authorization-320.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 820 });
      await page.screenshot({
        path: `${directory}/computer-authorization-1280.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 320, height: 700 });
    }
    await page.reload();
    await section.getByText('已完全授权', { exact: true }).waitFor();
    assert.equal(writes.length, 1, 'restoring persisted choice never re-grants');
    await page.getByRole('button', { name: 'Simulate running command' }).click();
    assert.equal(await full.isDisabled(), true, 'a running operation blocks new full grants');
    assert.equal(await confirm.isEnabled(), true, 'revocation stays available during execution');
    await confirm.click();
    await section.getByText('修改操作需确认', { exact: true }).waitFor();
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1], { mode: 'confirm', expectedTargetRevision: 'target-a' });
    await page.getByRole('button', { name: 'Stop simulated command' }).click();

    loseReply = true;
    await full.click();
    await section.getByText('已完全授权', { exact: true }).waitFor();
    assert.equal(writes.length, 3, 'ambiguous writes are read back without replay');
    target = 'target-b';
    mode = 'confirm';
    await page.getByRole('button', { name: 'Switch computer' }).click();
    await section.getByText('修改操作需确认', { exact: true }).waitFor();
    assert.equal(await full.getAttribute('aria-pressed'), 'false');
    assert.equal(writes.length, 3, 'grant does not follow a changed target');

    rejectWrite = true;
    await full.click();
    await section.getByRole('alert').getByText('授权暂未保存').waitFor();
    await section.getByText('修改操作需确认', { exact: true }).waitFor();
    assert.equal(await full.getAttribute('aria-pressed'), 'false');
    assert.equal(writes.length, 4);
    failRead = true;
    await section.getByRole('button', { name: '刷新授权状态' }).click();
    await section.getByRole('alert').getByText('授权状态暂不可用').waitFor();
    assert.equal(await full.isDisabled(), true);
    failRead = false;
    rejectWrite = false;
    owner = false;
    await section.getByRole('button', { name: '刷新授权状态' }).click();
    await section.getByText('只有空间拥有者可以设置完全授权。').waitFor();
    assert.equal(await full.isDisabled(), true);
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(writes.length, 4);
    owner = true;
    mode = 'full';
    target = 'target-a';
    await page.goto(`${origin}/w/${workspaceId}?bot`);
    await section.getByText('已完全授权', { exact: true }).waitFor();
    await section.getByText(/所有 Bot 沿用此电脑的默认权限/).waitFor();
    assert.equal(
      await full.isVisible(),
      false,
      'Bot inherits saved default without another grant prompt',
    );
    assert.equal(writes.length, 4, 'inheriting never writes a new grant');
    await section.getByText('管理默认权限', { exact: true }).click();
    assert.equal(await confirm.isVisible(), true, 'revocation remains accessible from a Bot');
    await confirm.click();
    await section.getByText('修改操作需确认', { exact: true }).waitFor();
    assert.equal(writes.length, 5);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  },
);
