import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const origin = 'https://search.example.test';
const fixture = `
  import './web/src/styles.css';
  import './web/src/theme.css';
  import { createRoot } from 'react-dom/client';
  import { ConversationSearch } from './web/src/components/ConversationSearch';
  import { initializeLanguage } from './web/src/i18n';
  initializeLanguage().setLanguage(location.search === '?zh' ? 'zh-CN' : 'en');
  const conversations = [
    ...Array.from({ length: 11 }, (_, i) => ({ id: 'bot-' + i, title: 'Archive Bot ' + i,
      agentIds: ['assistant'], isGroup: false, updatedAt: '2026-11-08T10:00:00Z' })),
    { id: 'group', title: 'Archive group', agentIds: ['assistant', 'other'], isGroup: true,
      updatedAt: '2026-11-08T11:00:00Z' },
  ];
  const now = '2026-11-08T09:00:00Z';
  const messages = Array.from({ length: 100 }, (_, i) => ({
    id: 'message-' + String(i).padStart(3, '0'),
    conversationId: i === 0 ? 'bot-0' : 'group', role: 'assistant', agentId: 'assistant',
    content: 'Archive note ' + String(i).padStart(3, '0'), createdAt: now,
  }));
  messages.push({ id: 'link-source', conversationId: 'bot-0', role: 'user',
    content: '[Archive source](https://example.com/archive)', createdAt: now });
  messages.push({ id: 'website-source', conversationId: 'bot-0', role: 'assistant', agentId: 'assistant',
    kind: 'website_project', status: 'done', content: '', createdAt: now, metadata: { websiteProject: {
      id: 'a'.repeat(64), projectKey: 'b'.repeat(64), title: 'Archive website', entry: 'index.html', fileCount: 1, totalBytes: 1024,
    } } });
  messages.push({ id: 'orphan', conversationId: 'other-workspace', role: 'user',
    content: 'Archive forbidden', createdAt: now });
  const data = {
    conversations, messages, agents: [{ id: 'assistant', name: 'Assistant' }, { id: 'other', name: 'Researcher' }],
    files: [{ id: 'report', conversationId: 'bot-0', name: 'Archive report.md', size: 123, createdAt: now }],
    routines: [{ id: 'digest', conversationId: 'bot-0', agentId: 'assistant', title: 'Archive digest' }],
  };
  const select = (...destination) => { document.body.dataset.destination = JSON.stringify(destination); };
  createRoot(document.getElementById('root')).render(<ConversationSearch data={data} currentConversationId="bot-0"
    onClose={() => { document.body.dataset.closed = 'true'; }} onJump={select}
    onOpenFile={(file) => select('file', file.id)} onOpenRoutine={(routine) => select('routine', routine.id)}
    onOpenWebsite={(message) => select('website', message.id)}
    commands={[{ id: 'archive-settings', title: 'Archive settings', description: 'Open settings', run: () => select('settings') }]}
  />);
`;

test(
  'history search categories, pagination and keyboard work on desktop and in a short narrow window',
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
    const page = await browser.newPage({ viewport: { width: 1140, height: 720 } });
    page.setDefaultTimeout(8_000);
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.origin === origin && url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.pathname !== '/favicon.ico') unexpected.push(url.href);
      return route.abort();
    });
    await page.goto(origin);
    const field = page.getByRole('combobox');
    const types = page.getByRole('group', { name: 'Result type' });
    const options = page.getByRole('listbox').getByRole('option');
    const status = page.getByRole('status');
    const more = page.getByRole('button', { name: 'Show more results' });
    await field.fill('archive');
    await options.first().getByText('Archive settings').waitFor();
    await types.getByRole('button', { name: 'Messages' }).click();
    await status.getByText('Showing 48 of 101 results').waitFor();
    assert.equal(await options.count(), 48);
    assert.equal(await options.filter({ hasText: /settings|forbidden/i }).count(), 0);
    await more.focus();
    await more.press('Enter');
    await status.getByText('Showing 96 of 101 results').waitFor();
    assert.equal(await field.evaluate((node) => document.activeElement === node), true);
    const firstNew = await field.getAttribute('aria-activedescendant');
    assert.equal(firstNew, await options.nth(48).getAttribute('id'));
    await more.click();
    await status.getByText('101 results').waitFor();
    assert.equal(await options.count(), 101);
    assert.equal(await more.count(), 0);
    await field.fill('Archive note 099');
    await status.getByText('1 result', { exact: true }).waitFor();
    await field.press('Enter');
    assert.deepEqual(JSON.parse((await page.locator('body').getAttribute('data-destination'))!), [
      'group',
      'message-099',
    ]);

    await page.reload();
    await field.fill('archive');
    await types.getByRole('button', { name: 'Group chats' }).click();
    await options.getByText('Archive group', { exact: true }).waitFor();
    assert.equal(await options.count(), 1);
    await types.getByRole('button', { name: 'Bots' }).click();
    await status.getByText('11 results').waitFor();
    assert.equal(await options.count(), 11);
    await types.getByRole('button', { name: 'All', exact: true }).click();
    await status.getByText('Showing 49 of 118 results').waitFor();
    await more.click();
    await more.click();
    await status.getByText('118 results').waitFor();
    assert.equal(await options.getByText('Bot chat', { exact: true }).count(), 11);
    await page.getByRole('button', { name: 'Current conversation' }).click();
    await types.getByRole('button', { name: 'Messages' }).click();
    await status.getByText('2 results').waitFor();
    assert.equal(await options.count(), 2);
    assert.equal(await options.filter({ hasText: 'Archive group' }).count(), 0);
    await types.getByRole('button', { name: 'Routines' }).click();
    await options.getByText('Archive digest', { exact: true }).click();
    assert.deepEqual(JSON.parse((await page.locator('body').getAttribute('data-destination'))!), [
      'routine',
      'digest',
    ]);

    await page.reload();
    await field.fill('archive');
    await types.getByRole('button', { name: 'Links' }).click();
    await status.getByText('1 result', { exact: true }).waitFor();
    await options.getByText('Archive source', { exact: true }).click();
    assert.deepEqual(JSON.parse((await page.locator('body').getAttribute('data-destination'))!), [
      'bot-0',
      'link-source',
    ]);
    await page.reload();
    await field.fill('archive');
    await types.getByRole('button', { name: 'Websites' }).click();
    await status.getByText('1 result', { exact: true }).waitFor();
    await options.getByText('Archive website', { exact: true }).click();
    assert.deepEqual(JSON.parse((await page.locator('body').getAttribute('data-destination'))!), [
      'website',
      'website-source',
    ]);

    await page.setViewportSize({ width: 320, height: 330 });
    await page.goto(`${origin}/?zh`);
    const category = page.getByRole('combobox', { name: '结果类型', exact: true });
    const narrowField = page.getByRole('combobox').filter({ hasNot: page.locator('option') });
    await narrowField.fill('archive');
    await category.selectOption({ label: '消息' });
    const dialog = page.getByRole('dialog');
    const list = page.getByRole('listbox');
    await page.getByRole('button', { name: '显示更多结果' }).waitFor();
    const bounds = (await dialog.boundingBox())!;
    const controls = (await category.boundingBox())!;
    const results = (await list.boundingBox())!;
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 330);
    assert.ok(controls.y >= bounds.y && controls.y + controls.height <= bounds.y + bounds.height);
    assert.ok(results.height >= 35, `Results have only ${results.height} pixels to scroll`);
    assert.ok(await list.evaluate((node) => node.scrollHeight > node.clientHeight));
    await category.selectOption({ label: '文件' });
    await options.getByText('Archive report.md', { exact: true }).click();
    assert.deepEqual(JSON.parse((await page.locator('body').getAttribute('data-destination'))!), [
      'file',
      'report',
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  },
);
