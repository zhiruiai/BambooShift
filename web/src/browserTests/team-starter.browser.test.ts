import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { BotTeamDraft, BotTeamPlan } from '../../../shared/bot-team-plans';
import catalog from '../../../shared/team-starter-templates.json';
import skillPacks from '../../../shared/starter-skill-packs.json';
import workflowRecipes from '../../../mobile/assets/skills/en.json';

test('reviewed team templates open the group directly and recover an uncertain commit', async (t) => {
  const origin = 'https://team-template.example.test';
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const workspace = `/w/${workspaceId}`;
  const base = `/api/workspaces/${workspaceId}`;
  const starter = catalog.en.find((item) => item.id === 'launch')!;
  const leadSkill = skillPacks.packs['work-coordination'].locales.en;
  const foundationIds = ['web-research', 'browser-use', 'computer-use', 'agent-desktop'];
  assert.deepEqual(skillPacks.foundation, foundationIds);
  const leadSkills = [
    { id: 'work-coordination', name: leadSkill.name, description: leadSkill.description },
    ...foundationIds.map((id) => {
      const recipe = workflowRecipes.find((item) => item.id === id);
      assert.ok(recipe, `Missing foundation skill ${id}`);
      return { id, name: recipe.name, description: recipe.description };
    }),
  ];
  assert.deepEqual(
    leadSkills.map(({ name }) => name),
    ['Work coordination', 'Web research', 'Browser use', 'Computer use', 'Agent Desktop'],
  );
  const leadSkillText = `Included skills · ${leadSkills.map(({ name }) => name).join(' · ')}`;
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import './web/src/styles.css'; import './web/src/theme.css';
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { initializeLanguage } from './web/src/i18n';
        import { SmartTeamPanel } from './web/src/components/SmartTeamPanel';
        initializeLanguage().setLanguage('en');
        function Fixture() {
          const [opened, setOpened] = useState('');
          return opened ? <h1>{opened}</h1> : (
            <SmartTeamPanel
              agents={[]} workspaceId="${workspaceId}" userId="owner-a"
              modelConfigured={false} modelLabel="" onBusy={() => {}} onDirty={() => {}}
              onCreated={(_, start, confirmed) => setOpened(
                start ? 'Unexpected auto-send' : 'Opened ' + confirmed.conversation.title
              )}
            />
          );
        }
        createRoot(document.getElementById('fixture')).render(<Fixture />);
      `,
      loader: 'tsx',
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    outdir: 'fixture-dist',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    logLevel: 'silent',
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

  for (const mode of ['direct', 'edit', 'changed', 'unknown'] as const) {
    await t.test(mode, async () => {
      const page = await browser.newPage({ viewport: { width: 340, height: 740 } });
      try {
        page.setDefaultTimeout(5000);
        const errors: string[] = [];
        const writes: string[] = [];
        let plan: BotTeamPlan;
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route(`${origin}/**`, async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.pathname === workspace)
            return route.fulfill({
              contentType: 'text/html',
              body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
                  <link rel="icon" href="data:,"><style>${css}</style><div id="fixture"></div>
                  <script src="/fixture.js"></script>`,
            });
          if (url.pathname === '/fixture.js')
            return route.fulfill({ contentType: 'text/javascript', body: script });
          if (request.method() === 'POST') {
            writes.push(url.pathname);
            const body = request.postDataJSON();
            if (url.pathname === `${base}/bot-team-plans`) {
              assert.deepEqual(body.template, { id: starter.id, language: 'en' });
              const draft: BotTeamDraft = structuredClone(starter.draft) as BotTeamDraft;
              if (mode === 'changed') draft.summary = 'Updated on server';
              const first = draft.members[0];
              if (first.kind === 'create') first.name += ' 2';
              plan = {
                id: 'plan-launch',
                requestId: body.requestId,
                revision: 'revision-a',
                goal: body.goal,
                status: 'ready',
                draft,
                starterSkills: { brief: leadSkills },
                createdAt: '2026-11-10T09:00:00Z',
                updatedAt: '2026-11-10T09:00:00Z',
              };
              return route.fulfill({ status: 202, json: plan });
            }
            if (url.pathname === `${base}/bot-team-plans/plan-launch/commit`) {
              assert.equal(mode === 'direct' || mode === 'unknown', true);
              assert.equal(body.expectedRevision, plan.revision);
              assert.deepEqual(body.draft, plan.draft);
              plan = {
                ...plan,
                status: 'committed',
                result: {
                  conversationId: 'group-launch',
                  createdAgentIds: ['a', 'b', 'c'],
                  memberAgentIds: ['a', 'b', 'c'],
                  leadAgentId: 'a',
                },
              };
              if (mode === 'unknown')
                return route.fulfill({
                  status: 503,
                  json: { error: 'Commit response unavailable' },
                });
              return route.fulfill({ json: plan });
            }
          } else if (url.pathname === `${base}/bot-team-plans`) {
            return route.fulfill({ json: [] });
          } else if (url.pathname === `${base}/bot-team-plans/plan-launch`) {
            return route.fulfill({ json: plan });
          } else if (url.pathname === `${base}/bootstrap`) {
            return route.fulfill({
              json: {
                conversations: [
                  {
                    id: 'group-launch',
                    isGroup: true,
                    title: starter.draft.title,
                    agentIds: ['a', 'b', 'c'],
                  },
                ],
                agents: ['a', 'b', 'c'].map((id) => ({ id })),
              },
            });
          }
          return route.abort();
        });
        await page.goto(origin + workspace);
        await page.getByRole('button', { name: starter.draft.title }).click();
        await page.getByText('Team lead', { exact: true }).waitFor();
        await page.getByText(leadSkillText, { exact: true }).waitFor();
        assert.deepEqual(writes, []);
        await page
          .getByRole('button', {
            name: mode === 'edit' ? 'Edit first' : 'Use template and open chat',
          })
          .click();
        if (mode === 'edit' || mode === 'changed') {
          await page
            .getByRole('button', { name: 'Confirm and create collaboration team' })
            .waitFor();
          await page.getByText(leadSkillText, { exact: true }).waitFor();
          if (mode === 'edit') {
            await page
              .locator('.smart-team-member')
              .first()
              .getByRole('textbox', { name: /^Assigned work/ })
              .fill('Different work');
            await page.getByText(leadSkillText, { exact: true }).waitFor({ state: 'hidden' });
          }
          if (mode === 'changed') await page.getByText(/The saved template has changed/).waitFor();
        } else {
          if (mode === 'unknown') {
            await page.getByText('Commit response unavailable').waitFor();
            await page.getByRole('button', { name: 'Check status', exact: true }).click();
            await page.getByRole('button', { name: 'Enter group chat', exact: true }).click();
          }
          await page.getByRole('heading', { name: `Opened ${starter.draft.title}` }).waitFor();
        }
        assert.deepEqual(
          writes,
          mode === 'direct' || mode === 'unknown'
            ? [`${base}/bot-team-plans`, `${base}/bot-team-plans/plan-launch/commit`]
            : [`${base}/bot-team-plans`],
        );
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
});
