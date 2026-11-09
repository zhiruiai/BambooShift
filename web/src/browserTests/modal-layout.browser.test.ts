import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { appProviders } from '../appProviders';

test(
  'synthetic apps and avatar dialogs keep controls reachable within compact viewports',
  { timeout: 75_000 },
  async () => {
    const origin = 'https://modal-layout.example.test';
    const wid = '11111111-1111-4111-8111-111111111111';
    const input = `
    import './web/src/styles.css'; import './web/src/theme.css';
    import { useState } from 'react'; import { createRoot } from 'react-dom/client';
    import { AppsDialog } from './web/src/components/AppsDialog';
    import { Dialog } from './web/src/components/UI';
    import { BotProfileFields } from './web/src/components/BotProfileFields';
    import { botProfileDraft } from './web/src/botProfiles';
    function Fixture() {
      const [mode, setMode] = useState('apps');
      const [draft, setDraft] = useState(botProfileDraft);
      window.openAvatarFixture = () => setMode('avatar');
      const invoke = (name) => () => { document.body.dataset.action = name; };
      return mode === 'apps' ? <AppsDialog workspaceId="${wid}" userId="synthetic-user"
        workspaceName="Synthetic workspace" canManage team={false} computerConnected={false}
        modelConfigured={false} modelLabel="" onFiles={invoke('files')} onComputer={invoke('computer')}
        onSettings={invoke('settings')} onTemplates={invoke('templates')} onClose={invoke('close')} />
        : <Dialog title="Synthetic avatar" className="bot-settings" onClose={invoke('avatar-close')}>
          <form className="dialog-form"><BotProfileFields draft={draft} onChange={setDraft} />
            {Array.from({length:12}, (_,i) => <p key={i}>Synthetic settings row {i}</p>)}
          </form>
        </Dialog>;
    }
    createRoot(document.getElementById('fixture')).render(<Fixture />);`;
    const bundle = await build({
      stdin: {
        contents: input,
        resolveDir: process.cwd(),
        sourcefile: 'modal-fixture.tsx',
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outdir: 'fixture-dist',
      format: 'iife',
      jsx: 'automatic',
      platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    const script = bundle.outputFiles.find((item) => item.path.endsWith('.js'))!.text;
    const style = bundle.outputFiles.find((item) => item.path.endsWith('.css'))!.text;
    const browser = await chromium.launch({
      headless: true,
      timeout: 10_000,
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
      page.setDefaultTimeout(8000);
      let appCount = 0;
      const unexpected: string[] = [];
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === origin && url.pathname === `/w/${wid}`) {
          await route.fulfill({
            contentType: 'text/html',
            body: `<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${style}</style><div id="fixture"></div><script src="/fixture.js"></script>`,
          });
        } else if (url.origin === origin && url.pathname === '/fixture.js') {
          await route.fulfill({ contentType: 'text/javascript', body: script });
        } else if (
          url.origin === origin &&
          url.pathname === `/api/workspaces/${wid}/apps` &&
          request.method() === 'GET'
        ) {
          await route.fulfill({
            json: Array.from({ length: appCount }, (_, i) => ({
              id: `app-${i}`,
              name: `Synthetic app ${i}`,
              url: `https://external.example/app-${i}`,
              revision: `revision-${i}`,
              authType: 'none',
              status: 'connected',
              hasCredential: false,
              toolCount: 0,
              createdAt: '2026-11-07T00:00:00.000Z',
            })),
          });
        } else {
          unexpected.push(request.method());
          await route.abort();
        }
      });
      const apps = page.locator('.apps-list-dialog');
      const body = apps.locator('.apps-scroll');
      await page.goto(`${origin}/w/${wid}`);
      await apps.locator('.apps-connections-empty').getByText('尚未连接应用').waitFor();
      const desktop = await apps.boundingBox();
      const desktopParts = await apps.evaluate((modal) =>
        [
          ...modal.querySelectorAll(
            '.modal-header, .apps-list-toolbar, .apps-scroll, .provider-grid, .provider-card, .apps-environment',
          ),
        ].map((part) => ({
          name: part.className,
          height: Math.round(part.getBoundingClientRect().height),
          top: Math.round(part.getBoundingClientRect().top),
        })),
      );
      assert.ok(
        desktop && desktop.width >= 800 && desktop.y >= 48 && desktop.height <= 724,
        JSON.stringify({ desktop, desktopParts }),
      );
      assert.equal(await apps.locator('.provider-card').count(), appProviders.length);
      const providerRows = await apps
        .locator('.provider-card')
        .evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().top)));
      assert.ok(new Set(providerRows).size <= 2);
      assert.equal(await body.evaluate((el) => el.scrollHeight > el.clientHeight), false);

      appCount = 24;
      await page.setViewportSize({ width: 360, height: 550 });
      await page.reload();
      await apps.locator('.integration').last().waitFor({ state: 'attached' });
      const mobileScroll = await body.evaluate((el) => ({
        height: el.clientHeight,
        scrollHeight: el.scrollHeight,
        width: el.clientWidth,
        scrollWidth: el.scrollWidth,
      }));
      assert.ok(mobileScroll.scrollHeight > mobileScroll.height, JSON.stringify(mobileScroll));
      assert.ok(mobileScroll.scrollWidth <= mobileScroll.width, JSON.stringify(mobileScroll));
      const header = apps.locator('.modal-header');
      const search = apps.getByRole('searchbox');
      const footer = apps.locator('.apps-environment');
      const anchored = await Promise.all([
        header.boundingBox(),
        search.boundingBox(),
        footer.boundingBox(),
      ]);
      await body.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      assert.ok(await body.evaluate((el) => el.scrollTop > 0));
      assert.deepEqual(
        await Promise.all([header.boundingBox(), search.boundingBox(), footer.boundingBox()]),
        anchored,
      );
      await apps.getByRole('button', { name: '代码', exact: true }).click();
      assert.equal(await body.evaluate((el) => el.scrollTop), 0);
      assert.equal(
        await apps.locator('.provider-card').count(),
        appProviders.filter((provider) => provider.category === 'code').length,
      );
      await search.fill('GitHub');
      assert.deepEqual(await apps.locator('.provider-title').allTextContents(), [
        'GitHub',
        'DeepWiki',
      ]);
      await footer.locator('.apps-environment-link').nth(1).click();
      assert.equal(await page.locator('body').getAttribute('data-action'), 'files');

      await search.fill('Microsoft Learn');
      await apps.getByRole('button', { name: '配置 Microsoft Learn' }).click();
      const add = page.locator('.apps-add-form');
      assert.equal(
        await add.locator('input[type=url]').inputValue(),
        'https://learn.microsoft.com/api/mcp',
      );
      assert.equal(await add.locator('select').inputValue(), 'none');
      assert.equal(await add.getByRole('checkbox').isChecked(), false);
      assert.equal(await add.locator('.primary-button').isDisabled(), true);

      await page.setViewportSize({ width: 320, height: 560 });
      await page.evaluate(() =>
        (window as typeof window & { openAvatarFixture: () => void }).openAvatarFixture(),
      );
      const avatar = page.locator('.bot-settings');
      const options = avatar.locator('.avatar-picker-options button');
      await options.last().waitFor();
      assert.equal(await options.count(), 12);
      assert.equal(await avatar.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
      await options.last().click();
      assert.equal(await options.last().getAttribute('aria-pressed'), 'true');
      await avatar.locator(':scope > .modal-body').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await avatar.locator('.modal-header button').click();
      assert.equal(await page.locator('body').getAttribute('data-action'), 'avatar-close');
      assert.deepEqual(unexpected, []);
    } finally {
      await browser.close();
    }
  },
);
