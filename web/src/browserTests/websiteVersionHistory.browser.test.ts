import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { Message } from '../../../shared/types';

const origin = 'https://versions.example.test';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const api = `/api/workspaces/${workspaceId}`;
const workspacePath = `/w/${workspaceId}`;
const user = { id: 'fixture-owner', name: 'Fixture Owner', email: 'versions@example.test' };
const bot = { id: 'designer', name: 'Designer', role: 'Design', color: '#8b6cca', avatar: 'orb' };
const projectKey = 'a'.repeat(64);
const sync = { epoch: 'fixture', revision: 0 };
const createdAt = '2026-11-08T12:00:00Z';
const root: Message = {
  id: 'revision-thread',
  conversationId: 'chat',
  role: 'assistant',
  agentId: bot.id,
  content: 'Revise the site here.',
  createdAt,
  kind: 'text',
  status: 'done',
};

function version(
  digit: string,
  title: string,
  assets: Record<string, string>,
  entry = 'index.html',
) {
  const files = Object.entries(assets).map(([path, content]) => ({
    path,
    mime: path.endsWith('.html') ? 'text/html' : 'text/css',
    sha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
  }));
  const project = {
    id: digit.repeat(64),
    projectKey,
    title,
    entry,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  };
  const message: Message = {
    ...root,
    id: `delivery-${digit}`,
    content: title,
    kind: 'website_project',
    metadata: { websiteProject: project },
  };
  return { message, project, assets, files };
}

test(
  'website history opens distinct versions across threads and compares manifests',
  { timeout: 60_000 },
  async (t) => {
    const initial = version('1', 'Initial site', { 'index.html': '<h1>Original page</h1>' });
    const previous = version('2', 'First revision', {
      'index.html': '<h1>First revision</h1>',
      'style.css': 'h1 { color: green }',
      'removed.css': 'h1 { color: red }',
    });
    const latest = version(
      '3',
      'Second revision',
      {
        'index.html': '<h1>First revision</h1>',
        'next.html': '<h1>New landing page</h1>',
        'style.css': 'h1 { color: blue }',
      },
      'next.html',
    );
    latest.message.threadRootId = root.id;
    const incoming = version('5', 'Newly delivered site', {
      'index.html': '<h1>Fresh delivery arrived</h1>',
    });
    const unrelated = version('4', 'Different conversation', { 'index.html': '<h1>Other</h1>' });
    unrelated.message.conversationId = 'other';
    const snapshot = {
      sync,
      agents: [bot],
      conversations: ['chat', 'other'].map((id) => ({
        id,
        title: id === 'chat' ? bot.name : 'Other chat',
        agentIds: [bot.id],
        isGroup: false,
        unread: 0,
        updatedAt: createdAt,
      })),
      messages: [
        initial.message,
        previous.message,
        { ...previous.message, id: 'repeated-version' },
        root,
        latest.message,
        unrelated.message,
      ],
      routines: [],
      files: [],
      skills: [],
      memories: [],
      apps: [],
      settings: { configured: true, model: 'fixture', language: 'en' },
      computer: { status: 'disconnected' },
      runningConversationIds: [],
      runningRequests: [],
    };
    const { outputFiles } = await build({
      stdin: {
        contents: `
        import './web/src/styles.css'; import './web/src/theme.css';
        import { createRoot } from 'react-dom/client';
        import { initializeLanguage } from './web/src/i18n';
        import { LocalizedRoot } from './web/src/i18n/LocalizedRoot';
        initializeLanguage().setLanguage('en');
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
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    });
    const script = outputFiles.find(({ path }) => path.endsWith('.js'))!.text;
    const css = outputFiles.find(({ path }) => path.endsWith('.css'))!.text;
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : undefined),
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1200, height: 760 },
      serviceWorkers: 'block',
    });
    page.setDefaultTimeout(8000);
    await page.addInitScript((sync) => {
      window.EventSource = class extends EventTarget {
        onopen?: () => void;
        constructor() {
          super();
          Object.assign(window, { websiteFixtureStream: this });
          setTimeout(() => {
            this.onopen?.();
            this.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(sync) }));
          }, 0);
        }
        close() {}
      } as unknown as typeof EventSource;
    }, sync);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const requests: string[] = [];
    let failPrevious = false;
    let submitted: unknown;
    await page.route('**/*', (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === workspacePath)
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/api/account/session')
        return route.fulfill({
          json: {
            authenticated: true,
            user,
            workspaces: [
              {
                id: workspaceId,
                name: 'Test Space',
                kind: 'personal',
                role: 'owner',
                status: 'active',
              },
            ],
          },
        });
      if (url.pathname === `${api}/bootstrap`) return route.fulfill({ json: snapshot });
      if (url.pathname === `${api}/conversations/chat/messages` && request.method() === 'POST') {
        submitted = request.postDataJSON();
        return route.fulfill({ status: 503, json: { error: 'Fixture recorded the reply' } });
      }
      const assetRequest = url.pathname.match(
        /\/website-projects\/([a-f0-9]{64})(?:\/files\/(.+))?$/,
      );
      if (assetRequest) {
        requests.push(url.pathname);
        assert.equal(request.headers()['x-openbot-expected-user'], user.id);
        const selected = [initial, previous, latest, incoming].find(
          ({ project }) => project.id === assetRequest[1],
        );
        assert.ok(selected);
        if (!assetRequest[2]) {
          if (selected === previous && failPrevious) {
            failPrevious = false;
            return route.fulfill({ status: 503 });
          }
          return route.fulfill({ json: { ...selected.project, files: selected.files } });
        }
        return route.fulfill({
          contentType: 'application/octet-stream',
          headers: { 'Content-Disposition': 'attachment' },
          body: selected.assets[assetRequest[2]],
        });
      }
      return route.fulfill({ status: 404, json: {} });
    });

    await page.goto(`${origin}${workspacePath}?conversation=chat`);
    const input = page.locator('.composer textarea');
    await input.fill('A draft in the main chat.');
    await page.getByRole('button', { name: 'Open website Initial site' }).click();
    await page.getByRole('combobox', { name: 'Message about Initial site' }).waitFor();
    await page
      .locator('.website-project-latest')
      .getByText('A newer delivery is available · Version 3')
      .waitFor();
    assert.equal(await input.inputValue(), 'A draft in the main chat.');
    await input.press('Enter');
    const retry = page.getByRole('button', { name: 'Retry original message' });
    await retry.waitFor();
    const originalAttempt = submitted as { replyToMessageId: string; clientId: string };
    assert.equal(originalAttempt.replyToMessageId, initial.message.id);

    const history = page.getByRole('button', { name: 'Version history' });
    await history.press('Enter');
    const list = page.getByRole('list', { name: 'Version history' });
    assert.deepEqual(await list.locator('strong').allTextContents(), [
      'Second revision',
      'First revision',
      'Initial site',
    ]);
    await list.getByRole('button', { name: /First revision/ }).click();
    await page.getByRole('combobox', { name: 'Message about First revision' }).waitFor();
    const repeated = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === `${api}/conversations/chat/messages`,
    );
    await retry.click();
    assert.deepEqual((await repeated).postDataJSON(), originalAttempt);
    await page.getByRole('button', { name: 'Remove website from this message' }).click();
    await page
      .getByRole('combobox', { name: 'Message about First revision' })
      .waitFor({ state: 'detached' });
    assert.equal(await input.inputValue(), 'A draft in the main chat.');
    await page.getByRole('button', { name: 'Edit this version' }).click();
    await page.getByRole('combobox', { name: 'Message about First revision' }).waitFor();

    await history.click();
    await list.getByRole('button', { name: /Second revision.*Latest delivery/ }).click();
    await page.frameLocator('iframe').getByRole('heading', { name: 'New landing page' }).waitFor();
    await page.getByRole('heading', { name: 'Reply thread' }).waitFor();
    await page.getByRole('combobox', { name: 'Message about Second revision' }).waitFor();
    assert.equal(await input.inputValue(), '');
    failPrevious = true;
    const comparisonStart = requests.length;
    const source = page.getByRole('tab', { name: 'Source' });
    await source.click();
    await source.press('ArrowRight');
    const changes = page.getByRole('tabpanel', { name: 'Changes' });
    await changes.getByRole('alert').getByText('Could not compare the two versions.').waitFor();
    await changes.getByRole('button', { name: 'Reload' }).click();
    await changes.getByText('Added (1)', { exact: true }).waitFor();
    for (const [label, file] of [
      ['Added (1)', 'next.html'],
      ['Modified (1)', 'style.css'],
      ['Removed (1)', 'removed.css'],
    ]) {
      await changes
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: label, exact: true }) })
        .getByText(file, { exact: true })
        .waitFor();
    }
    await changes.getByText('Start page changed from index.html to next.html.').waitFor();
    const comparison = requests.slice(comparisonStart);
    assert.ok(comparison.some((path) => path.endsWith(previous.project.id)));
    assert.ok(!comparison.some((path) => path.includes(`/${previous.project.id}/files/`)));

    await page.getByRole('button', { name: 'Back to conversation' }).click();
    assert.equal(await input.inputValue(), 'A draft in the main chat.');
    assert.equal(
      await page.getByRole('combobox', { name: 'Message about Second revision' }).count(),
      0,
    );
    await page.setViewportSize({ width: 390, height: 740 });
    const panel = page.getByRole('dialog', { name: 'Second revision' });
    await panel.getByRole('button', { name: 'Version history' }).click();
    await panel.getByRole('list', { name: 'Version history' }).getByText('Viewing now').waitFor();
    await panel.getByRole('button', { name: /Initial site/ }).click();
    const originalPanel = page.getByRole('dialog', { name: 'Initial site' });
    await originalPanel
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Original page' })
      .waitFor();
    assert.equal(await originalPanel.getByRole('tab', { name: 'Changes' }).count(), 0);
    await originalPanel.getByRole('button', { name: 'Version history' }).click();
    await originalPanel.getByRole('button', { name: /Second revision.*Latest delivery/ }).click();
    await panel.getByRole('button', { name: 'Edit this version' }).click();
    await page.getByRole('heading', { name: 'Reply thread' }).waitFor();
    await page.getByRole('combobox', { name: 'Message about Second revision' }).waitFor();
    await input.fill('Please keep the new landing page.');
    await input.press('Enter');
    await page.getByRole('button', { name: 'Retry original message' }).waitFor();
    assert.deepEqual(
      [
        (submitted as { threadRootId: string }).threadRootId,
        (submitted as { replyToMessageId: string }).replyToMessageId,
      ],
      [root.id, latest.message.id],
    );
    await page.setViewportSize({ width: 1200, height: 760 });
    await page.getByRole('button', { name: 'Back to conversation' }).click();
    await page
      .locator(`#message-${initial.message.id}`)
      .getByRole('button', { name: 'Updated · Open latest' })
      .click();
    await page.frameLocator('iframe').getByRole('heading', { name: 'New landing page' }).waitFor();
    await page.getByRole('combobox', { name: 'Message about Second revision' }).waitFor();
    assert.equal(await page.locator('.website-project-latest').count(), 0);
    snapshot.messages.push(incoming.message);
    snapshot.sync.revision = 1;
    await page.evaluate(() => {
      const fixture = window as unknown as { websiteFixtureStream: EventTarget };
      fixture.websiteFixtureStream.dispatchEvent(
        new MessageEvent('update', { lastEventId: 'fixture:1', data: '{}' }),
      );
    });
    const newDelivery = page.locator('.website-project-latest');
    await newDelivery.getByText('A newer delivery is available · Version 4').waitFor();
    await page.frameLocator('iframe').getByRole('heading', { name: 'New landing page' }).waitFor();
    await page.getByRole('combobox', { name: 'Message about Second revision' }).waitFor();
    await newDelivery.getByRole('button', { name: 'View latest delivery' }).click();
    await page
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Fresh delivery arrived' })
      .waitFor();
    await page.getByRole('heading', { name: 'Reply thread' }).waitFor({ state: 'detached' });
    await page.getByRole('combobox', { name: 'Message about Newly delivered site' }).waitFor();
    assert.equal(await input.inputValue(), 'A draft in the main chat.');
    assert.equal(await page.locator('.website-project-latest').count(), 0);
    assert.deepEqual(errors, []);
  },
);
