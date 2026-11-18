import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { ConnectedApp, ManagedAppTool } from '../../../shared/app-connections';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = 'fixture-owner';
const origin = 'https://tool-access.example.test';
const base = `/api/workspaces/${workspaceId}`;
const app: ConnectedApp = {
  id: 'fixture-app',
  name: 'Issue tracker',
  url: 'https://mcp.example.test/mcp',
  revision: 'connection-1',
  authType: 'none',
  hasCredential: false,
  status: 'connected',
  toolCount: 2,
  toolAccessSupported: true,
  createdAt: '2026-11-08T08:00:00Z',
};
const tool: ManagedAppTool = {
  name: 'issue_read',
  description: 'Read issue details.',
  inputSchema: { type: 'object' },
  access: { enabled: true, revision: 'read-1' },
};
const sibling: ManagedAppTool = {
  ...tool,
  name: 'issue_comment_with_long_connector_tool_name_that_requires_wrapping',
  description: 'Add a comment.',
  access: { enabled: true, revision: 'comment-1' },
};

test(
  'per-tool access requires an owner, preserves the sibling and reconciles stale and unknown writes',
  { timeout: 60_000 },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `
          import './web/src/styles.css';
          import './web/src/theme.css';
          import { createRoot } from 'react-dom/client';
          import { initializeLanguage } from './web/src/i18n';
          import { AppsDialog } from './web/src/components/AppsDialog';
          const member = location.search === '?member';
          initializeLanguage().setLanguage(location.search === '?zh' ? 'zh-CN' : 'en');
          createRoot(document.getElementById('root')).render(
            <AppsDialog workspaceId={${JSON.stringify(workspaceId)}} userId={member ? 'fixture-member' : ${JSON.stringify(userId)}}
              workspaceName="Fixture space" team={location.search === '?team'} canManage={!member} computerConnected={false}
              modelLabel="Fixture" modelConfigured onFiles={() => {}} onComputer={() => {}} onSettings={() => {}} onClose={() => {}} />,
          );
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
    const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const chrome = process.env.CHROME_EXECUTABLE;
    const browser = await chromium
      .launch({ headless: true, executablePath: chrome })
      .catch((error: Error) => {
        if (
          chrome ||
          process.platform !== 'darwin' ||
          !error.message.includes("Executable doesn't exist")
        )
          throw error;
        return chromium.launch({
          headless: true,
          executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        });
      });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 320, height: 560 } });
    page.setDefaultTimeout(8_000);
    const errors: string[] = [];
    const writes: unknown[] = [];
    let legacy = false;
    let liveApp = { ...app };
    let liveTool = { ...tool };
    let toolReads = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === `/w/${workspaceId}`)
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.pathname === `${base}/apps`)
        return route.fulfill({
          json: [{ ...liveApp, toolAccessSupported: legacy ? undefined : true }],
        });
      if (url.pathname === `${base}/apps/${app.id}/tools`) {
        toolReads++;
        return route.fulfill({ json: [liveTool, sibling] });
      }
      if (url.pathname === `${base}/apps/${app.id}/tools/access`) {
        assert.equal(request.method(), 'PUT');
        assert.equal(request.headers()['x-openbot-expected-user'], userId);
        writes.push(request.postDataJSON());
        if (writes.length === 1) {
          liveApp = { ...app, revision: 'connection-2' };
          liveTool = { ...tool, access: { enabled: false, revision: 'read-2' } };
          return route.fulfill({ status: 409, json: { code: 'APP_TOOL_ACCESS_CHANGED' } });
        }
        if (writes.length === 2) {
          liveTool = { ...tool, access: { enabled: true, revision: 'read-3' } };
          return route.fulfill({ json: liveTool });
        }
        liveTool = { ...tool, access: { enabled: false, revision: 'read-4' } };
        return route.fulfill({ status: 502, json: {} });
      }
      if (url.pathname.endsWith('/policies/options'))
        return route.fulfill({ json: { routines: [], tools: [] } });
      return route.fulfill({ json: [] });
    });

    const url = `${origin}/w/${workspaceId}`;
    const details = page.getByRole('dialog', { name: app.name, exact: true });
    const access = details.getByRole('switch', { name: 'Tool access for issue_read' });
    const other = details.getByRole('switch', { name: 'Tool access for ' + sibling.name });
    const refresh = details.getByRole('button', { name: 'Refresh tool access' });
    async function open(query = '') {
      await page.goto(url + query);
      await page.getByRole('button', { name: new RegExp(app.name) }).click();
      await details.getByText(tool.name, { exact: true }).waitFor();
    }
    await open('?team');
    assert.equal(await access.getAttribute('aria-checked'), 'true');
    assert.equal(await other.getAttribute('aria-checked'), 'true');
    assert.ok(
      await details.locator('.apps-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    await details.getByText(tool.name, { exact: true }).click();
    await details.getByText(tool.description).waitFor();
    await access.click();
    await details
      .getByRole('alert')
      .getByText(/Tool access changed/)
      .waitFor();
    assert.equal(await access.getAttribute('aria-checked'), 'true');
    assert.equal(await access.isDisabled(), true);
    assert.equal(writes.length, 1);
    await refresh.click();
    await details
      .getByRole('switch', { name: 'Tool access for issue_read', checked: false })
      .waitFor();
    await access.click();
    await details.getByText('Tool enabled.', { exact: true }).waitFor();
    assert.equal(await access.getAttribute('aria-checked'), 'true');
    assert.equal(await other.getAttribute('aria-checked'), 'true');
    await access.click();
    await details
      .getByRole('alert')
      .getByText(/change could not be confirmed/)
      .waitFor();
    assert.equal(await access.getAttribute('aria-checked'), 'true');
    assert.equal(await access.isDisabled(), true);
    assert.equal(writes.length, 3);
    await refresh.click();
    await details
      .getByRole('switch', { name: 'Tool access for issue_read', checked: false })
      .waitFor();
    assert.equal(await other.getAttribute('aria-checked'), 'true');
    assert.equal(toolReads, 3);
    assert.deepEqual(writes, [
      {
        toolName: tool.name,
        enabled: false,
        expectedConnectionRevision: 'connection-1',
        expectedToolRevision: 'read-1',
      },
      {
        toolName: tool.name,
        enabled: true,
        expectedConnectionRevision: 'connection-2',
        expectedToolRevision: 'read-2',
      },
      {
        toolName: tool.name,
        enabled: false,
        expectedConnectionRevision: 'connection-2',
        expectedToolRevision: 'read-3',
      },
    ]);

    await open('?member');
    assert.equal(await details.getByRole('switch').count(), 0);
    await details.getByText('Disabled', { exact: true }).waitFor();
    legacy = true;
    await open();
    assert.equal(await details.getByRole('switch').count(), 0);
    assert.equal(await refresh.count(), 0);
    legacy = false;
    await open('?zh');
    await details.getByRole('switch', { name: 'issue_read 的工具权限', checked: false }).waitFor();
    await details.getByRole('button', { name: '刷新工具权限' }).waitFor();
    assert.equal(writes.length, 3);
    assert.deepEqual(errors, []);
  },
);
