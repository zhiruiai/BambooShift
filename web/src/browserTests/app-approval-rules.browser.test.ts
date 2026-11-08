import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { AppAction, AppApprovalRule, ConnectedApp } from '../../../shared/app-connections';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = 'fixture-owner';
const origin = 'https://approval-rules.example.test';
const base = `/api/workspaces/${workspaceId}`;
const now = '2026-11-07T00:00:00Z';
const app: ConnectedApp = {
  id: 'github-app',
  name: 'GitHub',
  url: 'https://api.githubcopilot.com/mcp/readonly',
  revision: 'synthetic-revision',
  authType: 'bearer',
  hasCredential: true,
  status: 'connected',
  toolCount: 1,
  createdAt: now,
};
const input = { method: 'get', owner: 'fixture-org', repo: 'demo', issue_number: 17 } as const;
const labels = { agentName: 'Issue Bot', conversationTitle: 'Issue tracking' };
const action: AppAction = {
  id: 'fixture-action',
  conversationId: 'fixture-chat',
  agentId: 'fixture-bot',
  requester: { userId },
  connectionId: app.id,
  appName: app.name,
  toolName: 'issue_read',
  arguments: input,
  status: 'pending',
  createdAt: now,
  expiresAt: '2099-11-07T00:00:00Z',
  interactiveApproval: { eligible: true, ...labels },
};
const rule: AppApprovalRule = {
  id: '22222222-2222-4222-8222-222222222222',
  agentId: action.agentId,
  conversationId: action.conversationId,
  connectionId: app.id,
  connectionName: app.name,
  toolName: action.toolName,
  input,
  createdAt: now,
  ...labels,
};

test(
  'narrow Web chat saves an exact read after review and revokes it in connected apps',
  { timeout: 60_000 },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `
        import './web/src/styles.css';
        import './web/src/theme.css';
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { initializeLanguage } from './web/src/i18n';
        import { AppActionCard } from './web/src/components/AppActionCard';
        import { AppsDialog } from './web/src/components/AppsDialog';
        initializeLanguage().setLanguage('en');
        const workspaceId = ${JSON.stringify(workspaceId)};
        const userId = ${JSON.stringify(userId)};
        function Fixture() {
          const [show, setShow] = useState(false);
          return <>
            <AppActionCard action={${JSON.stringify(action)}} owner userId={userId}
              workspaceId={workspaceId} onChanged={async () => {}} onApps={() => setShow(true)} />
            {show && <AppsDialog workspaceId={workspaceId} userId={userId} workspaceName="Fixture space"
              canManage computerConnected={false} modelLabel="Fixture" modelConfigured
              onFiles={() => {}} onComputer={() => {}} onSettings={() => {}}
              onClose={() => setShow(false)} />}
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
    const chrome = process.env.CHROME_EXECUTABLE;
    const browser = await chromium
      .launch({ headless: true, executablePath: chrome })
      .catch((error: Error) => {
        if (
          chrome ||
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
    const page = await browser.newPage({ viewport: { width: 320, height: 620 } });
    page.setDefaultTimeout(8_000);
    const errors: string[] = [];
    const writes: string[] = [];
    let saved = false;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === `/w/${workspaceId}`)
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.pathname === `${base}/apps`) return route.fulfill({ json: [app] });
      if (url.pathname === `${base}/app-actions/${action.id}/decision`) {
        assert.equal(request.headers()['x-openbot-expected-user'], userId);
        assert.equal(request.method(), 'POST');
        assert.deepEqual(request.postDataJSON(), { decision: 'always_allow' });
        writes.push('save');
        saved = true;
        return route.fulfill({
          json: {
            ...action,
            status: 'done',
            interactiveApproval: { eligible: false, ...labels, usage: 'saved', ruleId: rule.id },
          },
        });
      }
      if (url.pathname === `${base}/apps/approval-rules`) {
        assert.equal(request.headers()['x-openbot-expected-user'], userId);
        assert.equal(request.method(), 'GET');
        return route.fulfill({ json: { rules: saved ? [rule] : [] } });
      }
      if (url.pathname === `${base}/apps/approval-rules/${rule.id}`) {
        assert.equal(request.headers()['x-openbot-expected-user'], userId);
        assert.equal(request.method(), 'DELETE');
        writes.push('revoke');
        saved = false;
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ status: 404, json: {} });
    });

    await page.goto(`${origin}/w/${workspaceId}`);
    await page.getByRole('button', { name: 'Always allow', exact: true }).click();
    const review = page.getByRole('region', {
      name: 'Allow this exact read again in this conversation?',
    });
    await review.getByText('fixture-org/demo #17', { exact: true }).waitFor();
    await review.getByText('Issue tracking', { exact: true }).waitFor();
    assert.deepEqual(writes, []);
    await review.getByRole('button', { name: 'Save and allow' }).click();
    await page.getByText('Saved exact permission').waitFor();
    await page.getByRole('button', { name: 'View app connection' }).click();
    await page.getByRole('button', { name: 'Saved app permissions' }).click();
    const dialog = page.getByRole('dialog', { name: 'Saved app permissions' });
    await dialog.getByText('fixture-org/demo #17', { exact: true }).waitFor();
    const revoke = dialog.getByRole('button', {
      name: 'Revoke permission for fixture-org/demo #17 in Issue tracking',
    });
    await revoke.click();
    await dialog.getByText('No saved app permissions.').waitFor();
    await dialog.getByText('Permission revoked.').waitFor();
    assert.deepEqual(writes, ['save', 'revoke']);
    assert.deepEqual(errors, []);
  },
);
