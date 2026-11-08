import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { ConnectedApp } from '../../../shared/app-connections';
import type { Message } from '../../../shared/types';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = 'fixture-owner';
const origin = 'https://custom-mcp.example.test';
const workspacePath = `/w/${workspaceId}`;
const apiPath = `/api/workspaces/${workspaceId}`;
const endpoint = 'https://tools.example.com/team/mcp';
const host = new URL(endpoint).hostname;
const createdAt = '2026-11-08T09:00:00.000Z';
const proposal = {
  kind: 'custom_mcp',
  name: host,
  url: endpoint,
  reason: 'Check the product documentation.',
  requester: { userId, messageId: 'original-input' },
  runId: 'run-a',
  toolCallId: 'call-a',
};
const message: Message = {
  id: 'proposal-a',
  kind: 'app_connection_proposal',
  status: 'done',
  role: 'assistant',
  conversationId: 'chat-a',
  agentId: 'bot-a',
  createdAt,
  content: proposal.reason,
  metadata: { appConnectionProposal: proposal },
};
const input: Message = {
  id: proposal.requester.messageId,
  conversationId: message.conversationId,
  userId,
  role: 'user',
  content: `Connect ${endpoint}`,
  createdAt,
};
const connection: ConnectedApp = {
  id: 'existing-exact',
  name: 'Existing exact service',
  url: endpoint,
  revision: 'revision-a',
  authType: 'none',
  hasCredential: false,
  status: 'connected',
  toolCount: 1,
  createdAt,
};
const decoys: ConnectedApp[] = [
  { ...connection, id: 'with-slash', name: 'Trailing path', url: endpoint + '/' },
  { ...connection, id: 'same-name', name: host, url: 'https://different.example.com/mcp' },
];
const fixture = `
  import './web/src/styles.css';
  import './web/src/theme.css';
  import { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { initializeLanguage } from './web/src/i18n';
  import { ChatMessageBody } from './web/src/workspace/ChatMessageBody';
  import { createWorkspaceDialogs } from './web/src/workspace/createWorkspaceDialogs';
  import { createChatSendScope } from './web/src/chatSendScope';
  import { AppsDialog } from './web/src/components/AppsDialog';
  const params = new URLSearchParams(location.search);
  initializeLanguage().setLanguage(params.has('zh') ? 'zh-CN' : 'en');
  const workspaceId = '${workspaceId}';
  const userId = params.has('other') ? 'other-owner' : '${userId}';
  const team = params.has('team');
  const canManage = !params.has('member');
  const message = ${JSON.stringify(message)};
  const input = ${JSON.stringify(input)};
  const agent = { id: 'bot-a', name: 'Local Bot' };
  const chat = { id: 'chat-a', agentIds: ['bot-a'], isGroup: params.has('group') };
  const account = { workspace: { id: workspaceId, kind: team ? 'team' : 'personal' } };
  const sendScope = createChatSendScope({ workspaceId, userId, identity: () => ({ workspaceId, userId }) });
  function Fixture() {
    const [modal, setModal] = useState(null);
    const [apps, setApps] = useState(window.fixtureApps);
    const [initialProviderId, setAppsProviderId] = useState(undefined);
    const [initialCustomProposal, setAppsCustomProposal] = useState(undefined);
    const data = { agents: [agent], conversations: [chat], messages: [message, input], apps, files: [] };
    const { openAppProposal, openApps } = createWorkspaceDialogs(() => ({ sendScope, canManage, data, modal,
      setAppsShareId: () => {}, setAppsProviderId, setAppsCustomProposal, setModal,
      account, conversation: chat, currentUserId: userId,
    }));
    return <>
      <button onClick={() => openApps()}>Open ordinary catalog</button>
      <ChatMessageBody message={message} liveAgent={agent} streaming={false} current={() => !modal}
        actions={{ account, canManage, currentUserId: userId, conversation: chat, data, openAppProposal }} />
      {modal === 'apps' && <AppsDialog workspaceId={workspaceId} userId={userId} workspaceName="Fixture space"
        team={team} canManage={canManage} initialProviderId={initialProviderId} initialCustomProposal={initialCustomProposal}
        computerConnected={false} modelLabel="Fixture" modelConfigured={false} onFiles={() => {}}
        onSettings={() => {}} onComputer={() => {}} onClose={() => setModal(null)}
        onChanged={() => void sendScope.request('/apps').then(setApps)} />}
    </>;
  }
  createRoot(document.getElementById('root')).render(<Fixture />);
`;

test(
  'custom MCP chat suggestion reviews exact endpoint, confirms sharing, and reuses a concurrent connection',
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
    const page = await browser.newPage({ viewport: { width: 320, height: 560 } });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    const outbound: string[] = [];
    const operations: Array<{ method: string; path: string; body: unknown }> = [];
    let listed = decoys;
    let fresh = message;
    let retainedInput = true;
    let conflict = true;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        outbound.push(url.origin);
        return route.abort();
      }
      if (url.pathname === workspacePath)
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.fixtureApps=${JSON.stringify(listed)}</script><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (!url.pathname.startsWith('/api/')) return route.abort();
      assert.equal(request.headers()['x-openbot-expected-user'], userId);
      operations.push({
        method: request.method(),
        path: url.pathname,
        body: request.postDataJSON(),
      });
      if (url.pathname === '/api/account/session')
        return route.fulfill({
          json: {
            authenticated: true,
            user: { id: userId, status: 'active' },
            workspaces: [{ id: workspaceId, role: 'owner', kind: 'personal', status: 'active' }],
          },
        });
      if (url.pathname === `${apiPath}/bootstrap`)
        return route.fulfill({
          json: {
            agents: [{ id: 'bot-a' }],
            conversations: [{ id: 'chat-a', agentIds: ['bot-a'], isGroup: false }],
            messages: retainedInput ? [fresh, input] : [fresh],
          },
        });
      if (url.pathname === `${apiPath}/apps`) {
        if (request.method() === 'GET') return route.fulfill({ json: listed });
        listed = [...decoys, connection];
        return conflict
          ? route.fulfill({ status: 409, json: { error: 'Connection already exists' } })
          : route.fulfill({ json: connection });
      }
      if (url.pathname === `${apiPath}/apps/${connection.id}/tools`)
        return route.fulfill({ json: [] });
      return route.abort();
    });
    const goto = (query = '') => page.goto(`${origin}${workspacePath}${query}`);
    const card = page.getByRole('region', { name: `Suggested connection: ${host}` });
    const review = card.getByRole('button', { name: 'Review and connect' });
    const dialog = page.getByRole('dialog', { name: 'Add app' });
    const form = dialog.locator('form.apps-add-form');
    const address = form.getByRole('textbox', { name: 'Service address' });
    const auth = form.getByRole('combobox', { name: 'Authentication' });
    const consent = form.getByRole('checkbox');
    const submit = form.getByRole('button', { name: 'Connect apps' });
    const writes = () => operations.filter((entry) => entry.method !== 'GET');
    for (const context of ['?team', '?group', '?other', '?member']) {
      await goto(context);
      await review.waitFor();
      assert.equal(await review.isDisabled(), true, context);
      assert.equal(await card.locator('a').count(), 0);
    }
    assert.deepEqual(operations, []);

    await goto();
    await card.getByText(endpoint, { exact: true }).waitFor();
    fresh = {
      ...message,
      metadata: { appConnectionProposal: { ...proposal, url: endpoint + '/' } },
    };
    await review.click();
    await card.getByRole('alert').waitFor();
    assert.equal(await dialog.count(), 0);
    assert.deepEqual(writes(), []);
    fresh = message;
    retainedInput = false;
    await card.getByRole('button', { name: 'Retry review' }).click();
    await card.getByRole('alert').waitFor();
    assert.equal(await dialog.count(), 0);
    retainedInput = true;
    await card.getByRole('button', { name: 'Retry review' }).click();
    await form.waitFor();
    assert.equal(await address.inputValue(), endpoint);
    assert.equal(await address.isEditable(), false);
    assert.equal(await auth.inputValue(), 'none');
    assert.equal(await consent.isChecked(), false);
    assert.equal(await submit.isDisabled(), true);
    assert.deepEqual(writes(), []);
    await consent.check();
    await auth.selectOption('oauth');
    assert.equal(await consent.isChecked(), false);
    await auth.selectOption('none');
    await consent.check();
    await submit.click();
    const detail = page.getByRole('dialog', { name: connection.name });
    await detail.waitFor();
    assert.deepEqual(
      writes().map((entry) => entry.body),
      [{ name: host, url: endpoint, authType: 'none', shared: true }],
    );
    assert.equal(await form.count(), 0);
    await detail.getByRole('button', { name: 'Close' }).click();
    await card
      .getByRole('status')
      .filter({ hasText: /^Connected$/ })
      .waitFor();
    await card.getByRole('button', { name: 'Open connection' }).click();
    await detail.waitFor();
    assert.equal(writes().length, 1);
    await detail.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Open ordinary catalog' }).click();
    assert.equal(await page.locator('.apps-add-form').count(), 0);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

    conflict = false;
    listed = [];
    await goto('?zh');
    const zhCard = page.getByRole('region', { name: `建议连接 ${host}` });
    await zhCard.getByRole('button', { name: '核对并连接' }).click();
    const zhForm = page.getByRole('dialog', { name: '添加应用' }).locator('form.apps-add-form');
    await zhForm.getByRole('textbox', { name: '服务地址' }).waitFor();
    assert.ok(await zhForm.evaluate((node) => node.scrollWidth <= node.clientWidth));
    await zhForm.getByRole('checkbox').check();
    await zhForm.getByRole('button', { name: '连接应用' }).click();
    await detail.waitFor();
    assert.equal(writes().length, 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(outbound, []);
  },
);
