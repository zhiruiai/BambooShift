import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { ChatQuestion } from '../../../shared/chat-questions';
import type { Message } from '../../../shared/types';

const workspace = '11111111-1111-4111-8111-111111111111';
const origin = 'https://question.example.test';
const path = `/w/${workspace}`;
const api = `/api/workspaces/${workspace}`;
const now = '2026-11-08T09:00:00.000Z';
const requester = 'original-member';
const question: ChatQuestion = {
  version: 1,
  question: 'Which formats should I include?',
  mode: 'multiple',
  options: [
    { id: 'slides', label: 'Slides', description: 'For the review meeting' },
    { id: 'pdf', label: 'PDF', description: 'For sharing afterward' },
  ],
  status: 'pending',
  requester: { userId: requester, messageId: 'original-message' },
  runId: 'question-run',
};
const card: Message = {
  id: 'question-card',
  role: 'assistant',
  kind: 'question',
  status: 'done',
  agentId: 'asking-bot',
  conversationId: 'group-chat',
  threadRootId: 'original-thread',
  content: question.question,
  createdAt: now,
  metadata: { question },
};
const answered = (optionIds: string[], pending: Message) => {
  const q = pending.metadata!.question as ChatQuestion;
  const message: Message = {
    id: 'answer-message',
    role: 'user',
    kind: 'text',
    createdAt: now,
    content: 'Formats confirmed.',
    userId: requester,
    conversationId: pending.conversationId,
    threadRootId: pending.threadRootId,
    delivery: {
      state: 'queued',
      mode: 'followUp',
      agentId: pending.agentId,
      explicitAgentId: pending.agentId,
    },
    replyTo: {
      id: pending.id,
      author: 'Asking Bot',
      agentId: pending.agentId,
      content: pending.content,
    },
    metadata: { questionAnswer: { questionId: pending.id, optionIds } },
  };
  return {
    question: {
      ...pending,
      metadata: {
        question: {
          ...q,
          status: 'answered',
          answer: { optionIds, messageId: message.id, submittedAt: now },
        },
      },
    },
    message,
  };
};
const fixture = `
  import './web/src/styles.css';
  import './web/src/theme.css';
  import { createRoot } from 'react-dom/client';
  import { createChatSendScope } from './web/src/chatSendScope';
  import { initializeLanguage } from './web/src/i18n';
  import { ChatMessageBody } from './web/src/workspace/ChatMessageBody';
  const params = new URLSearchParams(location.search);
  initializeLanguage().setLanguage(params.has('zh') ? 'zh-CN' : 'en');
  const message = window.fixtureCard;
  const workspaceId = '${workspace}';
  const userId = params.has('viewer') ? 'another-owner' : '${requester}';
  const sendScope = createChatSendScope({ workspaceId, userId, identity: () => ({ workspaceId, userId }) });
  const agent = { id: message.agentId, name: 'Asking Bot', ...(params.has('shared') ? { sharedBot: {} } : {}) };
  const conversation = { id: message.conversationId, isGroup: true, agentIds: ['asking-bot', 'other-bot'] };
  const body = <ChatMessageBody message={message} liveAgent={agent} streaming={false} current={() => true}
    actions={{ account: { workspace: { id: workspaceId } }, conversation, data: { files: [] },
      canManage: params.has('viewer'), currentUserId: userId, navigationScope: workspaceId, sendScope,
      sync: { written: () => { document.body.dataset.written = 'yes'; } },
      refresh: async () => { document.body.dataset.refreshed = 'yes'; },
    }} />;
  createRoot(document.getElementById('root')).render(<>
    <main className="message-row"><div className="message-content">{body}</div></main>
    <textarea aria-label="Existing draft" defaultValue="Keep my draft in this thread" />
  </>);
`;

test(
  'thread question sends exact option IDs, handles conflicts and ambiguity, and preserves draft on narrow Web',
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
    const page = await browser.newPage({ viewport: { width: 320, height: 500 } });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    const writes: unknown[] = [];
    let checks = 0;
    let current = card;
    let outcome: 'success' | 'drop' | 'badReceipt' | 'conflict' | 'threadGone' = 'success';
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      assert.equal(url.origin, origin);
      if (url.pathname === path)
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.fixtureCard=${JSON.stringify(current)}</script><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.pathname === `${api}/bootstrap`) {
        assert.equal(req.method(), 'GET');
        assert.equal(req.headers()['x-openbot-expected-user'], requester);
        checks++;
        return route.fulfill({ json: { messages: [current] } });
      }
      if (url.pathname === `${api}/messages/${card.id}/answer`) {
        assert.equal(req.method(), 'POST');
        assert.equal(req.headers()['x-openbot-expected-user'], requester);
        const body = req.postDataJSON();
        writes.push(body);
        const receipt = answered(body.optionIds, current);
        if (outcome === 'badReceipt')
          return route.fulfill({
            status: 202,
            json: { ...receipt, message: { ...receipt.message, threadRootId: 'wrong-thread' } },
          });
        if (outcome === 'threadGone')
          return route.fulfill({ status: 409, json: { code: 'THREAD_CONTEXT_UNAVAILABLE' } });
        if (outcome === 'conflict') {
          current = answered(['slides'], current).question;
          return route.fulfill({ status: 409, json: { code: 'QUESTION_ALREADY_ANSWERED' } });
        }
        current = receipt.question;
        return outcome === 'drop'
          ? route.abort('failed')
          : route.fulfill({ status: 202, json: receipt });
      }
      return route.abort();
    });
    const goto = (query = '') => page.goto(`${origin}${path}${query}`);
    const form = page.getByRole('form', { name: question.question });
    const submit = form.getByRole('button', { name: 'Submit answer' });
    const check = form.getByRole('button', { name: 'Check answer status' });
    const select = (name: string) => form.getByRole('checkbox', { name: new RegExp(name) });
    const chooseBoth = async () => {
      await select('PDF').check();
      await select('Slides').check();
    };
    const keepDraft = async () =>
      assert.equal(
        await page.getByRole('textbox', { name: 'Existing draft' }).inputValue(),
        'Keep my draft in this thread',
      );
    await goto('?viewer');
    await form.getByText('The person who started the task can answer.').waitFor();
    assert.equal(await select('Slides').isDisabled(), true);
    assert.equal(await submit.count(), 0);
    await goto('?shared');
    assert.equal(await select('PDF').isDisabled(), true);
    await form.getByText('This question is no longer available to answer.').waitFor();
    assert.deepEqual(writes, []);

    outcome = 'drop';
    await goto();
    await form.waitFor();
    assert.equal(await submit.isDisabled(), true);
    await chooseBoth();
    await submit.press('Enter');
    await check.waitFor();
    assert.equal(await select('Slides').isDisabled(), true);
    assert.deepEqual(writes, [{ optionIds: ['slides', 'pdf'] }]);
    await check.click();
    await form.getByText('Answer submitted').waitFor();
    assert.equal(checks, 1);
    assert.equal(writes.length, 1);
    assert.equal(await page.locator('body').getAttribute('data-refreshed'), 'yes');
    await keepDraft();
    await goto('?zh');
    await form.getByText('已提交答案').waitFor();
    assert.equal(await select('Slides').isChecked(), true);
    assert.ok(await form.evaluate((node) => node.scrollWidth <= node.clientWidth));

    current = card;
    outcome = 'badReceipt';
    await goto();
    await chooseBoth();
    await submit.click();
    await check.click();
    const retry = form.getByRole('button', { name: 'Retry same answer' });
    await retry.waitFor();
    assert.equal(await select('Slides').isDisabled(), true);
    outcome = 'success';
    await retry.click();
    await form.getByText('Answer submitted').waitFor();
    assert.deepEqual(writes.slice(1), [
      { optionIds: ['slides', 'pdf'] },
      { optionIds: ['slides', 'pdf'] },
    ]);
    assert.equal(checks, 2);

    current = { ...card, metadata: { question: { ...question, mode: 'single' } } };
    outcome = 'conflict';
    await goto();
    const slides = form.getByRole('radio', { name: /Slides/ });
    const pdf = form.getByRole('radio', { name: /PDF/ });
    await slides.check();
    await pdf.check();
    assert.equal(await slides.isChecked(), false);
    await submit.click();
    await check.click();
    await form.getByText('Answer submitted').waitFor();
    assert.equal(await slides.isChecked(), true);
    assert.deepEqual(writes.at(-1), { optionIds: ['pdf'] });
    assert.equal(writes.length, 4);
    await keepDraft();

    current = card;
    outcome = 'threadGone';
    await goto();
    await select('Slides').check();
    await submit.click();
    await form.getByText('This question is no longer available to answer.').waitFor();
    assert.equal(await check.count(), 0);
    assert.equal(checks, 3);
    assert.deepEqual(errors, []);
  },
);
