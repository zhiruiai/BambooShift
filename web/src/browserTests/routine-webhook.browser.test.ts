import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { RoutineRun } from '../../../shared/routine-runs';
import type { Routine } from '../../../shared/types';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = 'fixture-owner';
const origin = 'http://127.0.0.1:31339';
const base = `/api/workspaces/${workspaceId}`;
const now = '2026-11-08T09:00:00Z';
const revisionA = '22222222-2222-4222-8222-222222222222';
const revisionB = '33333333-3333-4333-8333-333333333333';
const revisionC = '44444444-4444-4444-8444-444444444444';
const freshKey = 'x'.repeat(43);
const scheduled: Routine = {
  id: 'fixture-brief',
  agentId: 'fixture-bot',
  conversationId: 'fixture-chat',
  title: 'Scheduled public brief',
  prompt: 'Review public releases.',
  schedule: 'daily:09:00',
  enabled: true,
  nextRunAt: now,
};
const eventOnly: Routine = {
  ...scheduled,
  id: 'fixture-event',
  title: 'Event-only brief',
  schedule: 'webhook',
  nextRunAt: '',
};
const endpoint = `/api/routine-webhooks/${workspaceId}/${scheduled.id}`;
const run: RoutineRun = {
  runId: 'fixture-run',
  routineId: scheduled.id,
  agentId: scheduled.agentId,
  conversationId: scheduled.conversationId,
  trigger: 'webhook',
  status: 'completed',
  startedAt: now,
};

test(
  'routine Webhook controls are scoped and preserve one-time keys in a narrow dialog',
  {
    timeout: 55_000,
    skip: process.env.OPENBOT_BROWSER_TEST !== '1',
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
        import { RoutineDialog } from './web/src/components/RoutineDialog';
        const query = location.search;
        initializeLanguage().setLanguage(query === '?zh' ? 'zh-CN' : 'en');
        const scheduled = ${JSON.stringify(scheduled)};
        const eventOnly = ${JSON.stringify(eventOnly)};
        const agents = [{ id: scheduled.agentId, name: 'Research Bot', ...(query === '?shared' ? { sharedBot: {} } : {}) }];
        const conversations = [{ id: scheduled.conversationId, title: 'Research', agentIds: [scheduled.agentId], isGroup: query === '?group' }];
        function Fixture() {
          const [routines, setRoutines] = useState([scheduled]);
          return <RoutineDialog workspaceId="${workspaceId}" userId="${userId}"
            canManageWebhooks={query !== '?member'} routines={routines} busy={false}
            agents={agents} allAgents={agents} conversations={conversations}
            conversationId={scheduled.conversationId} initialRoutineId={scheduled.id}
            onClose={() => {}} onDelete={async () => {}} onToggle={async () => {}} onSave={async () => {}}
            onChanged={(receipt) => { if (receipt.kind === 'create' && receipt.status === 'created') setRoutines([scheduled, eventOnly]); }} />;
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
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          async writeText(value: string) {
            if (!navigator.userActivation.isActive) throw Error('Clipboard needs a gesture');
            document.documentElement.dataset.fixtureCopied = value;
          },
        },
      });
    });
    const requests: Array<{ method: string; revision: string }> = [];
    const creates: Array<{ schedule: string }> = [];
    let config: { enabled: boolean; revision: string; path?: string } = {
      enabled: false,
      revision: 'unset',
    };
    let reads = 0;
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      assert.equal(url.origin, origin);
      if (request.isNavigationRequest())
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.pathname.endsWith('/runs')) {
        const routineId = url.pathname.split('/').at(-2);
        return route.fulfill({
          json: { routineId, runs: routineId === scheduled.id ? [run] : [] },
        });
      }
      assert.equal(request.headers()['x-openbot-expected-user'], userId);
      if (url.pathname === `${base}/routine-operations`) {
        assert.equal(request.method(), 'POST');
        const input = request.postDataJSON();
        creates.push(input);
        return route.fulfill({
          json: {
            kind: 'create',
            status: 'created',
            requestId: input.requestId,
            routineId: eventOnly.id,
            agentId: scheduled.agentId,
            conversationId: scheduled.conversationId,
            createdAt: now,
            workspaceId,
            userId,
          },
        });
      }
      assert.equal(url.pathname, `${base}/routines/${scheduled.id}/webhook`);
      if (request.method() === 'GET') {
        reads++;
        return route.fulfill({ json: config });
      }
      const revision = request.postDataJSON().expectedRevision;
      assert.equal(revision, config.revision);
      requests.push({ method: request.method(), revision });
      if (request.method() === 'PUT' && revision === 'unset') {
        config = { enabled: true, revision: revisionA, path: endpoint };
        return route.fulfill({ json: { ...config, secret: freshKey } });
      }
      if (request.method() === 'PUT') {
        config = { enabled: true, revision: revisionB, path: endpoint };
        return route.abort('failed');
      }
      assert.equal(request.method(), 'DELETE');
      config = { enabled: false, revision: revisionC };
      return route.fulfill({ json: config });
    });

    const home = `${origin}/w/${workspaceId}`;
    await page.goto(home);
    const dialog = page.getByRole('dialog', { name: 'Routines' });
    const panel = dialog.getByRole('region', { name: 'Webhook trigger' });
    const toggle = panel.getByRole('button', { name: 'Webhook trigger', exact: true });
    await dialog
      .locator('.routine-history-list')
      .getByText('Webhook trigger', { exact: true })
      .waitFor();
    await toggle.click();
    await panel.getByRole('button', { name: 'Create Webhook key' }).click();
    const key = panel.getByRole('textbox', { name: 'New Webhook key' });
    assert.equal(await key.inputValue(), freshKey);
    assert.equal(
      await panel.getByRole('textbox', { name: 'Webhook endpoint' }).inputValue(),
      origin + endpoint,
    );
    await panel.getByRole('button', { name: 'Copy key' }).click();
    assert.equal(await page.locator('html').getAttribute('data-fixture-copied'), freshKey);
    assert.ok(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await toggle.click();
    await key.waitFor({ state: 'detached' });
    await toggle.click();
    await panel.getByText('Webhook key active', { exact: true }).waitFor();
    assert.equal(await key.count(), 0);
    await panel.getByRole('button', { name: 'Rotate key', exact: true }).click();
    assert.equal(requests.length, 1);
    await panel.getByRole('button', { name: 'Rotate Webhook key' }).click();
    await panel
      .getByRole('alert')
      .filter({ hasText: 'The result could not be confirmed' })
      .waitFor();
    await panel.getByText('Webhook key active', { exact: true }).waitFor();
    assert.equal(requests.length, 2);
    assert.equal(await key.count(), 0);
    await panel.getByRole('button', { name: 'Revoke key', exact: true }).click();
    assert.equal(requests.length, 2);
    await panel.getByRole('button', { name: 'Revoke Webhook key' }).click();
    await panel.getByText('Webhook key revoked.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('textbox', { name: 'Webhook endpoint' }).count(), 0);
    assert.deepEqual(requests, [
      { method: 'PUT', revision: 'unset' },
      { method: 'PUT', revision: revisionA },
      { method: 'DELETE', revision: revisionB },
    ]);
    assert.equal(reads, 3);

    const editor = dialog.locator('.routine-editor');
    await editor.getByRole('combobox', { name: 'Frequency' }).selectOption('webhook');
    assert.equal(await editor.locator('input[type=time]').count(), 0);
    await editor.locator('input[required]').fill(eventOnly.title);
    await editor.locator('textarea').fill(eventOnly.prompt);
    await editor.getByRole('button', { name: 'Create routine' }).click();
    await dialog.getByRole('heading', { name: eventOnly.title }).waitFor();
    await dialog.getByText('No time-based run', { exact: true }).first().waitFor();
    assert.equal(creates[0].schedule, 'webhook');
    assert.equal(requests.length, 3, 'saving an event-only routine creates no Webhook key');
    await page.evaluate(() => sessionStorage.clear());
    for (const query of ['?member', '?group', '?shared']) {
      await page.goto(home + query);
      await dialog.getByRole('combobox', { name: 'Frequency' }).waitFor();
      assert.equal(await dialog.locator('option[value=webhook]').count(), 0);
      assert.equal(await panel.count(), 0);
    }
    assert.deepEqual(errors, []);
  },
);
