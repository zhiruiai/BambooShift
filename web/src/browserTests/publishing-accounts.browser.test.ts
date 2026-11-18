import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import defaults from '../../../shared/publishing-sites.json';

const origin = 'https://publishing-accounts.example.test';
const wid = '11111111-1111-4111-8111-111111111111';
const home = `${origin}/w/${wid}`;

test(
  'an owner saves a creator editor and opens the selected Bot; members can reuse its address',
  {
    skip: process.env.OPENBOT_BROWSER_TEST !== '1',
    timeout: 90_000,
  },
  async (t) => {
    const result = await build({
      stdin: {
        contents: `
        import './web/src/styles.css';
        import './web/src/theme.css';
        import {createRoot} from 'react-dom/client';
        import {AppsDialog} from './web/src/components/AppsDialog';
        import {initializeLanguage} from './web/src/i18n';
        initializeLanguage().setLanguage('en');
        const owner = location.search !== '?member', bots = [{id:'a',name:'Reporter'}, {id:'b',name:'Editor'}];
        createRoot(document.getElementById('root')).render(<AppsDialog workspaceId="${wid}" userId={owner?'owner':'member'}
          workspaceName="Local fixture" team canManage={owner} computerConnected modelLabel="" modelConfigured
          onFiles={()=>{}} onComputer={()=>{}} onSettings={()=>{}} onClose={()=>{}}
          publishingAccounts={{bots, onOpen: (site,agentId)=>globalThis.selectedPublishingBrowser={site,agentId}}} />);
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
    const js = result.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
    const css = result.outputFiles.find((f) => f.path.endsWith('.css'))!.text;
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      ...(process.env.OPENBOT_BROWSER_EXECUTABLE
        ? { executablePath: process.env.OPENBOT_BROWSER_EXECUTABLE }
        : {}),
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    let sites = [...defaults];
    let saves = 0;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      assert.equal(url.origin, origin);
      if (req.isNavigationRequest())
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.pathname.endsWith('/apps')) return route.fulfill({ json: [] });
      assert.equal(url.pathname, `/api/workspaces/${wid}/publishing-sites`);
      if (req.method() === 'POST') {
        assert.equal(req.headers()['x-openbot-expected-user'], 'owner');
        saves++;
        sites.push(req.postDataJSON());
      } else if (req.method() === 'DELETE') {
        assert.equal(req.headers()['x-openbot-expected-user'], 'owner');
        sites = sites.filter((v) => v.url !== req.postDataJSON().url);
      }
      return route.fulfill({ json: sites });
    });
    async function open(member = false) {
      await page.goto(home + (member ? '?member' : ''));
      await page.getByRole('button', { name: 'Publishing accounts' }).click();
    }
    const platform = page.getByRole('combobox', { name: 'Platform', exact: true });
    const custom = { name: 'Engineering journal', url: 'https://journal.example.com/compose' };
    const openBrowser = page.getByRole('button', { name: 'Open the selected Bot’s computer' });
    await open();
    await page.getByText(/workspace members who can take it over/).waitFor();
    const platformField = await platform.boundingBox();
    assert.ok(platformField && platformField.height >= 36, 'The platform field remains easy to tap');
    for (const preset of defaults) {
      assert.equal(
        await platform
          .locator('option')
          .evaluateAll(
            (options, url) => options.some((o) => (o as HTMLOptionElement).value === url),
            preset.url,
          ),
        true,
      );
    }
    await platform.selectOption('custom');
    await page.getByLabel('Platform name').fill(custom.name);
    const input = page.getByLabel('Creator page URL');
    await input.fill('https://localhost/private?access_token=private');
    const save = page.getByRole('button', { name: 'Save to workspace' });
    assert.equal(await save.isDisabled(), true);
    await input.fill(custom.url);
    await save.click();
    await page.waitForFunction(
      (dest) =>
        document.querySelector<HTMLSelectElement>('.publishing-accounts select')?.value === dest,
      custom.url,
    );
    assert.equal(saves, 1);
    assert.equal(await openBrowser.isDisabled(), true);
    await page.getByLabel('Bot using this work browser').selectOption('b');
    await openBrowser.click();
    assert.deepEqual(await page.evaluate(() => (globalThis as any).selectedPublishingBrowser), {
      site: custom,
      agentId: 'b',
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await open(true);
    await platform.selectOption(custom.url);
    assert.equal(await page.getByRole('option', { name: 'Add a custom platform…' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Remove address' }).count(), 0);
    await open();
    await platform.selectOption(custom.url);
    await page.getByRole('button', { name: 'Remove address' }).click();
    await page.getByRole('option', { name: custom.name }).waitFor({ state: 'detached' });
    assert.deepEqual(sites, defaults);
    assert.deepEqual(errors, []);
  },
);
