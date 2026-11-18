import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { routineConfigSnapshot } from '../../../shared/routine-operations';
import type { Routine } from '../../../shared/types';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = 'fixture-owner';
const origin = 'https://routine-search.example.test';
const base = `/api/workspaces/${workspaceId}`;
const now = '2026-11-08T09:00:00Z';
const routine: Routine = {
  id: 'brief',
  agentId: 'research',
  conversationId: 'research-chat',
  title: 'Daily public brief',
  prompt: 'Summarize official release notes.',
  schedule: 'daily:09:00',
  timeZone: 'Asia/Shanghai',
  enabled: true,
  nextRunAt: now,
  publicSearchQueries: ['Pi releases'],
};
const changedRoutine = { ...routine, publicSearchQueries: ['Pi architecture'] };

test(
  'owner reviews exact routine search on a narrow viewport and can clear its persisted permission',
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
          import { createAppConnectionScope } from './web/src/appConnections';
          import { RoutineDialog } from './web/src/components/RoutineDialog';
          initializeLanguage().setLanguage(location.search === '?zh' ? 'zh-CN' : 'en');
          const workspaceId = ${JSON.stringify(workspaceId)};
          const userId = ${JSON.stringify(userId)};
          const routine = window.fixtureRoutine;
          const group = location.search === '?group';
          const canManagePublicSearch = location.search !== '?member';
          const agents = [{ id: 'research', name: 'Research Bot',
            ...(location.search === '?shared' ? { sharedBot: {} } : {}) }];
          const conversations = [{ id: 'research-chat', agentIds: ['research'], title: 'Research', isGroup: group }];
          const scope = createAppConnectionScope({ workspaceId, userId, identity: () => ({ workspaceId, userId }) });
          function Fixture() {
            const [routines, setRoutines] = useState(group ? [] : [routine]);
            return <RoutineDialog workspaceId={workspaceId} userId={userId} canManagePublicSearch={canManagePublicSearch}
              agents={agents} allAgents={agents} conversations={conversations} routines={routines} busy={false}
              conversationId="research-chat" initialRoutineId={group ? undefined : routine.id} initialAction="edit"
              onClose={() => {}} onDelete={async () => {}} onToggle={async () => {}}
              onSave={async (body, id) => setRoutines([await scope.request('/routines/' + id, 'PATCH', body)])} />;
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
    const page = await browser.newPage({ viewport: { width: 320, height: 560 } });
    page.setDefaultTimeout(8_000);
    const errors: string[] = [];
    const writes: Array<{
      expectedRoutine: ReturnType<typeof routineConfigSnapshot>;
      publicSearchQueries: string[];
    }> = [];
    let current = routine;
    const creates: unknown[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === `/w/${workspaceId}`)
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.fixtureRoutine=${JSON.stringify(current)}</script><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.pathname === `${base}/routines/${routine.id}` && request.method() === 'PATCH') {
        assert.equal(request.headers()['x-openbot-expected-user'], userId);
        writes.push(request.postDataJSON());
        if (writes.length === 1) {
          current = changedRoutine;
          return route.fulfill({ status: 409, json: { code: 'ROUTINE_SEARCH_SCOPE_CHANGED' } });
        }
        current = { ...current, publicSearchQueries: undefined };
        return route.fulfill({ json: current });
      }
      if (url.pathname === `${base}/routine-operations` && request.method() === 'POST') {
        assert.equal(request.headers()['x-openbot-expected-user'], userId);
        const input = request.postDataJSON();
        creates.push(input);
        return route.fulfill({
          json: {
            kind: 'create',
            status: 'created',
            requestId: input.requestId,
            routineId: 'created-brief',
            agentId: routine.agentId,
            conversationId: routine.conversationId,
            createdAt: now,
            userId,
            workspaceId,
          },
        });
      }
      return route.fulfill({ json: [] });
    });

    const url = `${origin}/w/${workspaceId}`;
    await page.goto(url);
    const dialog = page.getByRole('dialog', { name: 'Routines' });
    const editor = dialog.locator('.routine-editor');
    const toggle = editor.getByRole('checkbox', {
      name: 'Allow public web search for this routine',
    });
    const queries = editor.getByRole('textbox', { name: 'Approved public queries', exact: true });
    const save = editor.getByRole('button', { name: 'Save changes' });
    await queries.waitFor();
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await queries.inputValue(), 'Pi releases');
    await editor.getByText(/Each run may send these exact queries to Exa/).waitFor();
    await queries.fill('Pi releases\nPi releases');
    await save.click();
    await editor.getByText('Each public query must be unique.').waitFor();
    assert.equal(writes.length, 0);
    await queries.fill('  Pi docs  \nPi  releases');
    await save.click();
    await editor.getByText(/This routine changed/).waitFor();
    assert.deepEqual(writes[0].publicSearchQueries, ['Pi docs', 'Pi  releases']);
    assert.deepEqual(writes[0].expectedRoutine, routineConfigSnapshot(routine));
    assert.equal(await queries.inputValue(), '  Pi docs  \nPi  releases');

    await page.reload();
    await queries.waitFor();
    assert.equal(await queries.inputValue(), 'Pi architecture');
    await toggle.uncheck();
    await save.click();
    await editor.getByRole('heading', { name: 'Add routine' }).waitFor();
    assert.deepEqual(writes[1].publicSearchQueries, []);
    assert.deepEqual(writes[1].expectedRoutine, routineConfigSnapshot(changedRoutine));
    assert.equal(await queries.count(), 0);
    assert.equal(await toggle.isChecked(), false);
    assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth));

    await toggle.check();
    await editor.getByRole('textbox', { name: 'Routine name' }).fill('New research brief');
    await editor.getByRole('textbox', { name: 'What should be done?' }).fill('Summarize findings.');
    await queries.fill('OpenBot  release notes\nExa search docs');
    await editor.getByRole('button', { name: 'Create routine' }).click();
    await dialog.getByText('Routine created.', { exact: true }).waitFor();
    assert.equal(creates.length, 1);
    assert.deepEqual((creates[0] as { publicSearchQueries: string[] }).publicSearchQueries, [
      'OpenBot  release notes',
      'Exa search docs',
    ]);
    await dialog.getByRole('button', { name: 'Finish viewing' }).click();

    for (const scenario of ['group', 'member', 'shared']) {
      await page.goto(`${url}?${scenario}`);
      await editor.getByRole('textbox', { name: 'Routine name' }).waitFor();
      assert.equal(await toggle.count(), 0);
    }
    await page.goto(`${url}?zh`);
    await page.getByRole('checkbox', { name: '允许此例行任务搜索公开网页' }).check();
    await page.getByText(/查询原样发给 Exa/).waitFor();
    assert.deepEqual(errors, []);
  },
);
