import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { Bootstrap, Message } from '../../../shared/types';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const api = `/api/workspaces/${workspaceId}`;
const path = `/w/${workspaceId}`;
const createdAt = '2026-11-08T12:00:00Z';
const user = { id: 'fixture-owner', name: 'Fixture Owner', email: 'thread@example.test' };
const bot = { id: 'reviewer', name: 'Reviewer', role: 'Review', color: '#8b6cca', avatar: 'orb' };

function message(id: string, content: string, fields: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'chat',
    role: 'assistant',
    kind: 'text',
    status: 'done',
    content,
    createdAt,
    agentId: bot.id,
    ...fields,
  };
}

test(
  'narrow chat threads keep drafts and retries separate and open deep links',
  { timeout: 60_000 },
  async (t) => {
    const files = await build({
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
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
      logLevel: 'silent',
    });
    const script = files.outputFiles.find((item) => item.path.endsWith('.js'))!.text;
    const style = files.outputFiles.find((item) => item.path.endsWith('.css'))!.text;
    const server = createServer((request, response) => {
      if (request.url === '/fixture.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script);
      } else {
        response
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end(
            `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${style}</style><div id="root"></div><script src="/fixture.js"></script>`,
          );
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block',
    });
    page.setDefaultTimeout(8000);
    const root = message('root', 'Review the sources');
    const quote = { id: root.id, author: bot.name, content: root.content };
    const snapshot = {
      sync: { epoch: 'fixture', revision: 0 },
      agents: [bot],
      conversations: [
        {
          id: 'chat',
          title: bot.name,
          agentIds: [bot.id],
          isGroup: false,
          unread: 0,
          updatedAt: createdAt,
        },
      ],
      messages: [
        root,
        message('main-quote', 'Main timeline quote', { replyTo: quote }),
        message('existing-thread', 'Existing thread reply', {
          threadRootId: root.id,
          replyTo: quote,
        }),
      ],
      routines: [],
      files: [],
      skills: [],
      memories: [],
      apps: [],
      settings: { configured: true, model: 'fixture', language: 'en' },
      computer: { status: 'disconnected' },
      runningConversationIds: [] as string[],
      runningRequests: [] as NonNullable<Bootstrap['runningRequests']>,
    };
    await page.addInitScript((sync) => {
      window.EventSource = class extends EventTarget {
        onopen?: () => void;
        constructor() {
          super();
          setTimeout(() => {
            this.onopen?.();
            this.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(sync) }));
          }, 0);
        }
        close() {}
      } as unknown as typeof EventSource;
    }, snapshot.sync);
    const submitted: Array<{
      threadRootId: string;
      replyToMessageId: string;
      clientId: string;
      content: string;
      mode: 'steer';
    }> = [];
    const stopped: URLSearchParams[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const { pathname, origin: target, searchParams } = new URL(request.url());
      if (target !== origin) return route.abort();
      if (pathname === '/api/account/session')
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
      if (pathname === `${api}/bootstrap`) return route.fulfill({ json: snapshot });
      if (request.method() === 'POST' && pathname === `${api}/conversations/chat/messages`) {
        const body = request.postDataJSON();
        submitted.push(body);
        if (submitted.length === 1)
          return route.fulfill({ status: 503, json: { error: 'Try again' } });
        const value = message('new-thread', body.content, {
          role: 'user',
          userId: user.id,
          threadRootId: body.threadRootId,
          replyTo: quote,
          delivery: { clientId: body.clientId, state: 'delivered', mode: body.mode },
        });
        snapshot.messages.push(value);
        snapshot.runningConversationIds = ['chat'];
        snapshot.runningRequests = [
          {
            conversationId: 'chat',
            threadRootId: root.id,
            requester: { userId: user.id, messageId: value.id },
          },
        ];
        snapshot.sync.revision++;
        return route.fulfill({ status: 202, json: { message: value } });
      }
      if (request.method() === 'POST' && pathname === `${api}/conversations/chat/stop`) {
        stopped.push(searchParams);
        snapshot.runningRequests = [];
        snapshot.runningConversationIds = [];
        snapshot.sync.revision++;
        return route.fulfill({ json: { ok: true } });
      }
      if (pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: {} });
      return route.continue();
    });

    await page.goto(`${origin}${path}?conversation=chat`);
    const input = page.locator('.composer textarea');
    const reply = page.getByRole('button', { name: '1 reply', exact: true });
    await input.fill('Main draft');
    assert.equal(await page.locator('#message-existing-thread').count(), 0);
    await page.locator('#message-main-quote').waitFor();
    await reply.focus();
    await reply.press('Enter');
    await page.getByRole('heading', { name: 'Reply thread' }).waitFor();
    await page.locator('#message-existing-thread').waitFor();
    assert.equal(await page.locator('#message-main-quote').count(), 0);
    await input.fill('Thread draft');
    await input.press('Escape');
    await page.locator('#message-main-quote').waitFor();
    assert.equal(await input.inputValue(), 'Main draft');

    await page
      .locator('#message-root')
      .getByRole('button', { name: 'More message actions' })
      .click();
    await page.getByRole('button', { name: 'Reply in thread' }).click();
    await page.getByRole('heading', { name: 'Reply thread' }).waitFor();
    assert.equal(await input.inputValue(), 'Thread draft');
    await input.press('Enter');
    await page.getByRole('button', { name: 'Retry original message', exact: true }).click();
    await page.locator('#message-new-thread').waitFor();
    assert.equal(submitted.length, 2);
    assert.equal(submitted[0].threadRootId, root.id);
    assert.equal(submitted[0].replyToMessageId, root.id);
    assert.deepEqual(submitted[0], submitted[1]);
    await page.getByRole('button', { name: 'Back to conversation' }).click();
    assert.equal(await input.inputValue(), 'Main draft');
    assert.equal(await page.locator('#message-new-thread').count(), 0);
    const stop = page.getByRole('button', { name: 'Stop my current task' });
    assert.equal(await stop.count(), 0);
    await page.getByRole('button', { name: '2 replies', exact: true }).click();
    await stop.click();
    await stop.waitFor({ state: 'detached' });
    assert.deepEqual(
      stopped.map((query) => query.toString()),
      [`threadRootId=${root.id}`],
    );

    await page.goto(`${origin}${path}?conversation=chat&message=existing-thread`);
    await page.locator('#message-existing-thread.message-highlighted').waitFor();
    assert.deepEqual(errors, []);
  },
);
