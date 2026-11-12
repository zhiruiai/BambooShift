import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const origin = 'https://import.example.test';
const workspace = '11111111-1111-4111-8111-111111111111';
const routePath = `/w/${workspace}`;
const fixture = `
  import './web/src/styles.css';
  import './web/src/theme.css';
  import { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { initializeLanguage } from './web/src/i18n';
  import { AppsDialog } from './web/src/components/AppsDialog';
  initializeLanguage().setLanguage('en');
  function Fixture() {
    const [owner, setOwner] = useState(true);
    window.revokeOwner = () => setOwner(false);
    return <AppsDialog workspaceId="${workspace}" userId="fixture-owner" workspaceName="Import fixture"
      team={true} canManage={owner} computerConnected={false} modelLabel="Fixture"
      modelConfigured={false} onFiles={() => {}} onComputer={() => {}} onSettings={() => {}} onClose={() => {}} />;
  }
  createRoot(document.getElementById('root')).render(<Fixture />);
`;

test(
  'remote MCP import preserves drafts, omits secrets and waits for explicit reviewed connection',
  { timeout: 60_000 },
  async (t) => {
    const bundle = await build({
      stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true,
      write: false,
      outdir: 'fixture-dist',
      format: 'iife',
      jsx: 'automatic',
      platform: 'browser',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    });
    const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const executablePath = process.env.CHROME_EXECUTABLE;
    const browser = await chromium
      .launch({ headless: true, executablePath })
      .catch((error: Error) => {
        if (
          executablePath ||
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
    const page = await browser.newPage({ viewport: { width: 375, height: 720 } });
    page.setDefaultTimeout(8000);
    const errors: string[] = [],
      outbound: string[] = [];
    const writes: unknown[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        outbound.push(url.origin);
        return route.abort();
      }
      if (url.pathname === routePath)
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.pathname === `/api/workspaces/${workspace}/apps`) {
        if (request.method() === 'GET') return route.fulfill({ json: [] });
        assert.equal(request.method(), 'POST');
        writes.push(request.postDataJSON());
        return route.fulfill({ status: 400, json: { error: 'Synthetic connection refused' } });
      }
      return route.abort();
    });
    await page.goto(origin + routePath);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const name = page.getByLabel('App name', { exact: true });
    const address = page.getByLabel('Service address', { exact: true });
    const auth = page.getByLabel(/^Authentication/);
    const consent = page.locator('.apps-consent input');
    const config = JSON.stringify({
      mcpServers: {
        Docs: {
          type: 'http',
          url: 'https://docs.example.com/mcp',
          headers: { Authorization: 'PASTED_SECRET' },
          env: { KEY: 'ENV_SECRET' },
        },
        local: { command: 'npx', args: ['DO_NOT_RUN'] },
        private: { url: 'https://127.0.0.1/mcp' },
      },
      servers: { Other: { type: 'http', url: 'https://other.example.com/mcp' } },
    });
    async function inspect() {
      await page.getByRole('button', { name: 'Import MCP configuration', exact: true }).click();
      await page.getByLabel('MCP configuration JSON', { exact: true }).fill(config);
      await page.getByRole('button', { name: 'Find remote services', exact: true }).click();
      assert.equal(await page.getByLabel('MCP configuration JSON', { exact: true }).count(), 0);
      assert.equal(
        await page.getByLabel('Remote service', { exact: true }).locator('option').count(),
        3,
      );
      assert.doesNotMatch(
        await page.locator('body').innerText(),
        /PASTED_SECRET|ENV_SECRET|DO_NOT_RUN/,
      );
      assert.equal(writes.length, 0);
      await page
        .getByLabel('Remote service', { exact: true })
        .selectOption('https://docs.example.com/mcp');
    }
    await name.fill('Unsubmitted draft');
    await address.fill('https://previous.example.com/mcp');
    await auth.selectOption('bearer');
    await page.getByLabel(/^Access token/).fill('MANUALLY_ENTERED_TOKEN');
    await consent.check();
    await inspect();
    await page.getByRole('button', { name: 'Use name and address', exact: true }).click();
    await page.getByRole('button', { name: 'Replace current form', exact: true }).waitFor();
    assert.equal(await name.inputValue(), 'Unsubmitted draft');
    await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
    assert.equal(await name.inputValue(), 'Unsubmitted draft');
    assert.equal(await page.getByLabel(/^Access token/).inputValue(), 'MANUALLY_ENTERED_TOKEN');
    assert.equal(await consent.isChecked(), true);
    await inspect();
    await page.getByRole('button', { name: 'Use name and address', exact: true }).click();
    await page.getByRole('button', { name: 'Replace current form', exact: true }).click();
    assert.equal(await name.inputValue(), 'Docs');
    assert.equal(await address.inputValue(), 'https://docs.example.com/mcp');
    assert.equal(await auth.inputValue(), 'none');
    assert.equal(await consent.isChecked(), false);
    await auth.selectOption('bearer');
    assert.equal(await page.getByLabel(/^Access token/).inputValue(), '');
    await auth.selectOption('none');
    const submit = page.getByRole('button', { name: 'Connect apps', exact: true });
    assert.equal(await submit.isDisabled(), true);
    assert.deepEqual(writes, []);
    await name.fill('Edited docs');
    await address.fill('https://docs.example.com/reviewed-mcp');
    await consent.check();
    await submit.click();
    await page.getByText('Synthetic connection refused', { exact: true }).waitFor();
    assert.deepEqual(writes, [
      {
        name: 'Edited docs',
        url: 'https://docs.example.com/reviewed-mcp',
        authType: 'none',
        shared: true,
      },
    ]);
    assert.equal(await name.inputValue(), 'Edited docs');
    assert.equal(await address.inputValue(), 'https://docs.example.com/reviewed-mcp');
    await page.getByRole('button', { name: 'Import MCP configuration', exact: true }).click();
    const box = page.locator('.apps-mcp-import');
    const fits = await box.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1;
    });
    assert.equal(fits, true);
    await page.evaluate(() => (window as unknown as { revokeOwner(): void }).revokeOwner());
    await box.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 1);
    assert.deepEqual(outbound, []);
    assert.deepEqual(errors, []);
  },
);
