import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { Message } from '../../../shared/types';
import type { WebResearch } from '../../../shared/web-research';

const origin = 'https://workspace.example.test';
const workspace = '11111111-1111-4111-8111-111111111111';
const path = `/w/${workspace}`;
const api = `/api/workspaces/${workspace}`;
const now = '2026-11-08T12:00:00Z';
const bot = {
  id: 'researcher',
  name: 'Researcher',
  role: 'Research',
  color: '#795bc0',
  avatar: 'orb',
};
const source = 'https://example.com/source';
const research: WebResearch = {
  version: 1,
  provider: 'Exa',
  searches: 3,
  cachedSearches: 2,
  emptySearches: 1,
  pagesRead: 1,
  issues: ['search_task_limit', 'upstream_rate_limit'],
  sources: [
    { title: 'Read source', url: source, kind: 'page' },
    { title: 'A'.repeat(240), url: 'https://example.org/related', kind: 'search' },
    { title: 'Blocked local address', url: 'http://127.0.0.1/secret', kind: 'page' },
  ],
};
function message(id: string, content: string, fields: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'chat',
    role: 'assistant',
    kind: 'text',
    status: 'done',
    content,
    createdAt: now,
    agentId: bot.id,
    ...fields,
  };
}
const receipt = message('research', '', {
  kind: 'web_research',
  metadata: { webResearch: research },
});
const snapshot = {
  sync: { epoch: 'fixture', revision: 0 },
  agents: [bot],
  conversations: [
    { id: 'chat', title: bot.name, agentIds: [bot.id], isGroup: false, unread: 0, updatedAt: now },
  ],
  messages: [
    message('root', 'Review the sources'),
    receipt,
    message('legacy', 'Older response'),
    message('invalid', '', { kind: 'web_research', metadata: {} }),
    message('thread-reply', 'Thread reply', { threadRootId: 'root' }),
    { ...receipt, id: 'thread-research', threadRootId: 'root' },
  ],
  routines: [],
  files: [],
  skills: [],
  memories: [],
  apps: [],
  settings: { configured: true, model: 'fixture' },
  computer: { status: 'disconnected' },
  runningConversationIds: [],
  runningRequests: [],
};

test(
  'research receipts render in normal and reply timelines, with safe opt-in sources',
  { timeout: 60_000 },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `
        import './web/src/styles.css';
        import './web/src/theme.css';
        import { createRoot } from 'react-dom/client';
        import { initializeLanguage } from './web/src/i18n';
        import { LocalizedRoot } from './web/src/i18n/LocalizedRoot';
        const params = new URLSearchParams(location.search);
        initializeLanguage().setLanguage(params.has('zh') ? 'zh-CN' : 'en');
        if (params.has('desktop')) document.documentElement.dataset.openbotDesktop = 'true';
        createRoot(document.getElementById('root')).render(<LocalizedRoot />);
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
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : undefined),
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 320, height: 600 },
      serviceWorkers: 'block',
    });
    const external: { url: string; referer?: string }[] = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        external.push({ url: url.href, referer: request.headers().referer });
        return route.fulfill({ contentType: 'text/html', body: 'Verified external destination' });
      }
      if (url.pathname === path)
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.pathname === '/api/account/session')
        return route.fulfill({
          json: {
            authenticated: true,
            user: { id: 'owner', name: 'Owner', email: 'owner@example.test' },
            workspaces: [
              {
                id: workspace,
                name: 'Fixture Space',
                kind: 'personal',
                role: 'owner',
                status: 'active',
              },
            ],
          },
        });
      if (url.pathname === `${api}/bootstrap`) return route.fulfill({ json: snapshot });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const go = (query = '') => page.goto(`${origin}${path}?conversation=chat${query}`);
    await go();
    const main = page.locator('#message-research');
    const summary = main.locator('summary');
    await main.getByText('Public web research', { exact: true }).waitFor();
    for (const text of [
      'Exa',
      'Searches 3',
      'Cached 2',
      'No results 1',
      'Pages read 1',
      'Search limit for this task reached',
    ])
      await main.getByText(text, { exact: true }).waitFor();
    await page.getByText('Older response', { exact: true }).waitFor();
    assert.equal(await page.locator('.conversation-preview').first().textContent(), 'Thread reply');
    assert.equal(await page.locator('#message-invalid, #message-thread-research').count(), 0);
    const link = main.getByRole('link', { name: /Read source/ });
    assert.equal(await link.isVisible(), false);
    await summary.press('Enter');
    await main.getByText('Search provider rate limited', { exact: true }).waitFor();
    assert.equal(await link.getAttribute('href'), source);
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await main.getByRole('link').count(), 2);
    assert.ok(await main.evaluate((el) => el.scrollWidth <= el.clientWidth));
    assert.ok(
      await main
        .locator('summary')
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize) >= 12),
    );
    assert.deepEqual(external, []);
    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await popup.waitForLoadState();
    assert.deepEqual(external, [{ url: source, referer: undefined }]);
    assert.equal(await popup.evaluate(() => window.opener === null), true);
    await popup.close();

    await page.getByRole('button', { name: '1 reply', exact: true }).click();
    await page.getByRole('heading', { name: 'Reply thread' }).waitFor();
    assert.equal(await main.count(), 0);
    const thread = page.locator('#message-thread-research');
    await thread.getByText('Public web research', { exact: true }).waitFor();
    assert.equal(await thread.getByRole('link', { name: /Read source/ }).isVisible(), false);

    await go('&zh&desktop');
    await main.getByText('公开网页检索', { exact: true }).waitFor();
    await main.getByText('缓存命中 2 次', { exact: true }).waitFor();
    await summary.click();
    await main.getByText('来源', { exact: true }).waitFor();
    await main.getByText('桌面客户端请右键此链接，选择在浏览器中打开并确认。').waitFor();
    assert.deepEqual(errors, []);
    assert.equal(external.length, 1);
  },
);
