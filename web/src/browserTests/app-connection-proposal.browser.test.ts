import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { ConnectedApp } from '../../../shared/app-connections';
import type { Message } from '../../../shared/types';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const flowId = '33333333-3333-4333-8333-333333333333';
const userId = 'fixture-owner';
const origin = 'http://127.0.0.1:31340';
const base = `/api/workspaces/${workspaceId}`;
const home = `${origin}/w/${workspaceId}`;
const launchPath = `/app-authorize/${workspaceId}/${connectionId}/${flowId}`;
const message: Message = {
  id: 'proposal-a',
  conversationId: 'chat-a',
  agentId: 'bot-a',
  role: 'assistant',
  kind: 'app_connection_proposal',
  status: 'done',
  createdAt: '2026-11-08T00:00:00Z',
  content: 'Find the source material.',
  metadata: {
    appConnectionProposal: {
      providerId: 'notion',
      reason: 'Find the source material.',
      runId: 'run-a',
      toolCallId: 'call-a',
      requester: { userId, messageId: 'input-a' },
    },
  },
};
const installed: ConnectedApp = {
  id: connectionId,
  name: 'Workspace Notion',
  url: 'https://mcp.notion.com/mcp/',
  revision: 'revision-a',
  authType: 'oauth',
  hasCredential: false,
  status: 'needs_auth',
  toolCount: 0,
  createdAt: message.createdAt,
};
const decoy: ConnectedApp = {
  ...installed,
  id: 'different-provider',
  name: 'Notion',
  url: 'https://outside.example/mcp',
  status: 'connected',
};
const connected: ConnectedApp = {
  ...installed,
  status: 'connected',
  hasCredential: true,
  toolCount: 1,
};
const flow = {
  id: flowId,
  connectionId,
  connectionRevision: installed.revision,
  appName: installed.name,
  status: 'pending',
  expiresAt: '2031-11-08T01:00:00Z',
  scopes: [],
  launchPath,
};

test(
  'a chat card rechecks the workspace, resumes exact pending authorization, and avoids duplicate add',
  {
    skip: process.env.OPENBOT_BROWSER_TEST !== '1',
    timeout: 55_000,
  },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `
        import './web/src/styles.css';
        import './web/src/theme.css';
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { initializeLanguage } from './web/src/i18n';
        import { AppConnectionProposalCard } from './web/src/components/AppConnectionProposalCard';
        import { AppsDialog } from './web/src/components/AppsDialog';
        initializeLanguage().setLanguage('en');
        const member = location.search === '?member';
        const workspaceId = '${workspaceId}';
        const userId = member ? 'member-b' : '${userId}';
        const message = ${JSON.stringify(message)};
        function Fixture() {
          const [provider, setProvider] = useState();
          const [apps, setApps] = useState(window.fixtureApps);
          window.replaceAppSnapshot = setApps;
          return <>
            <AppConnectionProposalCard message={message} workspaceId={workspaceId} userId={userId}
              owner={!member} localBotAvailable apps={apps} current={() => !provider} onOpen={setProvider} />
            {provider && <AppsDialog workspaceId={workspaceId} userId={userId} workspaceName="Fixture space"
              team canManage={!member} initialProviderId={provider} computerConnected={false} modelLabel="Fixture"
              modelConfigured={false} onFiles={() => {}} onSettings={() => {}} onComputer={() => {}} onClose={() => setProvider(undefined)} />}
          </>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
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
      timeout: 15_000,
      executablePath: process.env.CHROME_EXECUTABLE,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 320, height: 560 } });
    page.setDefaultTimeout(8000);
    const errors: string[] = [],
      requests: string[] = [],
      writes: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let registry: ConnectedApp[] = [decoy, installed];
    let firstSession = true,
      firstApps = true;
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      assert.equal(url.origin, origin);
      if (request.isNavigationRequest()) {
        assert.equal(url.pathname, `/w/${workspaceId}`);
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.fixtureApps=${JSON.stringify(url.search ? registry : [])}</script><script src="/fixture.js"></script>`,
        });
      }
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      assert.equal(request.headers()['x-openbot-expected-user'], userId);
      requests.push(`${request.method()} ${url.pathname}`);
      if (request.method() !== 'GET') {
        writes.push(`${request.method()} ${url.pathname}`);
        assert.equal(url.pathname, `${base}/apps`);
        assert.equal(request.method(), 'POST');
        assert.equal(request.postDataJSON().url, 'https://mcp.notion.com/mcp');
        assert.equal(request.postDataJSON().shared, true);
        registry = [installed];
        return route.fulfill({ status: 409, json: { error: 'Connection already exists' } });
      }
      if (url.pathname === '/api/account/session') {
        if (firstSession) {
          firstSession = false;
          return route.fulfill({ status: 503, json: {} });
        }
        return route.fulfill({
          json: {
            authenticated: true,
            user: { id: userId, status: 'active' },
            workspaces: [{ id: workspaceId, role: 'owner', status: 'active' }],
          },
        });
      }
      if (url.pathname === `${base}/bootstrap`)
        return route.fulfill({
          json: {
            messages: [message],
            agents: [{ id: message.agentId }],
            conversations: [{ id: message.conversationId, agentIds: [message.agentId] }],
            apps: registry,
          },
        });
      if (url.pathname === `${base}/apps`) {
        if (firstApps) {
          firstApps = false;
          return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
        }
        return route.fulfill({ json: registry });
      }
      if (url.pathname === `${base}/apps/${connectionId}/oauth`)
        return route.fulfill({ json: flow });
      if (url.pathname === `${base}/apps/${connectionId}/tools`) return route.fulfill({ json: [] });
      if (url.pathname === `${base}/apps/${connectionId}/policies`)
        return route.fulfill({ json: [] });
      if (url.pathname === `${base}/apps/${connectionId}/policies/options`)
        return route.fulfill({
          json: {
            connectionId,
            connectionRevision: installed.revision,
            catalogRevision: 'fixture',
            routines: [],
            tools: [],
          },
        });
      throw Error(`Unexpected fixture request ${url.pathname}`);
    });
    const updateSnapshot = (value: ConnectedApp[]) =>
      page.evaluate((value) => {
        const fixture: Window & { replaceAppSnapshot?: (value: ConnectedApp[]) => void } = window;
        if (typeof fixture.replaceAppSnapshot !== 'function')
          throw Error('App snapshot fixture is unavailable');
        fixture.replaceAppSnapshot(value);
      }, value);

    await page.goto(home);
    const card = page.getByRole('region', { name: 'Suggested connection: Notion' });
    const dialog = page.getByRole('dialog');
    const close = dialog.getByRole('button', { name: 'Close' });
    await card.getByRole('status').filter({ hasText: 'Not connected' }).waitFor();
    assert.deepEqual(requests, []);
    await card.getByRole('button', { name: 'Review and connect' }).click();
    await card.getByRole('alert').waitFor();
    await card.getByRole('button', { name: 'Retry review' }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Unavailable' }).waitFor();
    assert.equal(await dialog.locator('form').count(), 0);
    await dialog.getByRole('button', { name: 'Retry review' }).click();
    await dialog.getByRole('heading', { name: installed.name, exact: true }).waitFor();
    const authorize = dialog.getByRole('link', { name: 'Authorize in browser' });
    assert.equal(await authorize.getAttribute('href'), launchPath);
    assert.equal(
      await dialog.getByRole('button', { name: 'Start browser authorization' }).count(),
      0,
    );
    assert.deepEqual(writes, []);
    assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await close.click();

    registry = [connected];
    await updateSnapshot(registry);
    await card.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
    await card.getByRole('button', { name: 'Open connection' }).click();
    await dialog.getByRole('heading', { name: installed.name, exact: true }).waitFor();
    await close.click();

    registry = [];
    await updateSnapshot(registry);
    await card.getByRole('button', { name: 'Review and connect' }).click();
    await dialog.getByRole('heading', { name: 'Add app', exact: true }).waitFor();
    const consent = dialog.getByRole('checkbox');
    assert.equal(await consent.isChecked(), false);
    assert.equal(
      await dialog.locator('input[type=url]').inputValue(),
      'https://mcp.notion.com/mcp',
    );
    assert.deepEqual(writes, []);
    await consent.check();
    await dialog.getByRole('button', { name: 'Connect apps', exact: true }).click();
    await dialog.getByText('This service already has a connection in this workspace.').waitFor();
    await dialog.getByRole('heading', { name: installed.name, exact: true }).waitFor();
    assert.equal(await authorize.getAttribute('href'), launchPath);
    assert.deepEqual(writes, [`POST ${base}/apps`]);

    const before = requests.length;
    await page.goto(home + '?member');
    await card.getByRole('status').filter({ hasText: 'Authorization required' }).waitFor();
    assert.equal(
      await card.getByRole('button', { name: 'Continue authorization' }).isEnabled(),
      false,
    );
    assert.equal(requests.length, before);
    assert.deepEqual(errors, []);
  },
);
