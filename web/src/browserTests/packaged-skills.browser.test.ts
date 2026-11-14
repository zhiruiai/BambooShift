import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { skillWorkflowTemplates } from '../skillWorkflowTemplates';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const origin = 'https://packaged-skills.example.test';
const home = `${origin}/w/${workspaceId}`;
const base = `/api/workspaces/${workspaceId}`;
const ownerId = 'fixture-owner';
const bots = [
  { id: 'design', name: 'Design Bot' },
  { id: 'review', name: 'Review Bot' },
];
const recipe = skillWorkflowTemplates.en.find(({ id }) => id === 'web-app-testing')!;

test(
  'Connect apps previews packaged skills and hands an editable draft to separate approval',
  { skip: process.env.OPENBOT_BROWSER_TEST !== '1', timeout: 40_000 },
  async (t) => {
    const { outputFiles } = await build({
      stdin: {
        contents: `
          import './web/src/styles.css';
          import './web/src/theme.css';
          import { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { AppsDialog } from './web/src/components/AppsDialog';
          import { SkillsDialog } from './web/src/components/SkillsDialog';
          import { initializeLanguage } from './web/src/i18n';
          const owner = location.search !== '?member';
          const userId = owner ? '${ownerId}' : 'fixture-member';
          initializeLanguage().setLanguage(owner ? 'en' : 'zh-CN');
          const bots = ${JSON.stringify(bots)};
          const request = (path, body) => fetch('${base}' + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-openbot-expected-user': userId },
            body: JSON.stringify(body),
          }).then(response => response.json());
          function Fixture() {
            const [draft, setDraft] = useState();
            const [skills, setSkills] = useState([]);
            return draft ? <SkillsDialog agents={bots.filter(bot => bot.id === draft.agentId)}
              skills={skills} readOnly={!owner} busy={false} initialDraft={draft}
              onClose={() => setDraft(undefined)}
              onAdd={async body => {
                setSkills([await request('/skills', body)]);
                return { ok: true };
              }}
              onTransition={async (id, action, expectedActiveId) => {
                setSkills([await request('/skills/' + id + '/' + action, { expectedActiveId })]);
                return { ok: true };
              }} /> :
              <AppsDialog workspaceId="${workspaceId}" userId={userId} workspaceName="Fixture"
                team canManage={owner} computerConnected={false} modelLabel="Fixture"
                modelConfigured={false} onFiles={() => {}} onComputer={() => {}}
                onSettings={() => {}} onClose={() => {}}
                packagedSkills={{ bots: owner ? bots : [], onEdit: setDraft }} />;
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
    const js = outputFiles.find(({ path }) => path.endsWith('.js'))!.text;
    const css = outputFiles.find(({ path }) => path.endsWith('.css'))!.text;
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_EXECUTABLE,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 320, height: 560 } });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    const writes: Array<{ path: string; body: unknown }> = [];
    const requests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
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
      requests.push(url.pathname);
      if (url.pathname === `${base}/apps`) return route.fulfill({ json: [] });
      assert.equal(request.method(), 'POST');
      assert.equal(request.headers()['x-openbot-expected-user'], ownerId);
      const body = request.postDataJSON();
      writes.push({ path: url.pathname, body });
      const first = writes[0].body as object;
      return route.fulfill({
        json: {
          ...first,
          id: 'draft-a',
          version: 1,
          status: url.pathname === `${base}/skills` ? 'proposed' : 'active',
          createdAt: '2026-11-08T00:00:00Z',
        },
      });
    });

    await page.goto(home);
    await page.getByRole('button', { name: 'Packaged skills', exact: true }).click();
    const catalog = page.getByRole('dialog', { name: 'Packaged skills' });
    await catalog
      .getByRole('button', { name: /^Preview instructions for / })
      .last()
      .waitFor();
    assert.deepEqual(
      await catalog
        .getByRole('button', { name: /^Preview instructions for / })
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
      skillWorkflowTemplates.en.map(({ name }) => `Preview instructions for ${name}`),
    );
    const search = catalog.getByRole('searchbox', { name: 'Search packaged skills' });
    await search.fill('nothing matches');
    await catalog.getByText('No matching skills.').waitFor();
    await search.fill(recipe.id);
    assert.equal(
      await catalog.getByRole('button', { name: /^Preview instructions for / }).count(),
      1,
    );
    await catalog.getByRole('button', { name: `Preview instructions for ${recipe.name}` }).click();
    await catalog.getByRole('heading', { name: recipe.name }).waitFor();
    assert.equal(await page.locator(':focus').textContent(), 'Back to packaged skills');
    await catalog
      .getByText('Verify visible outcomes at each important step.', { exact: false })
      .waitFor();
    await catalog
      .getByText('Existing tool permissions and approvals still apply.', { exact: false })
      .waitFor();
    assert.ok(await catalog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    const edit = catalog.getByRole('button', { name: 'Edit skill draft' });
    assert.equal(await edit.isEnabled(), false);
    await catalog.getByRole('combobox', { name: 'Choose a Bot' }).selectOption('review');
    await edit.click();

    const draft = page.getByRole('dialog');
    await draft.getByRole('heading', { name: 'Teach your Bot a new method' }).waitFor();
    assert.equal(await page.locator('select:focus').inputValue(), 'review');
    assert.equal(
      await draft.getByRole('combobox', { name: 'Assigned Bot' }).inputValue(),
      'review',
    );
    assert.equal(
      await draft.getByRole('textbox', { name: 'Skill name' }).inputValue(),
      recipe.name,
    );
    assert.equal(await draft.getByRole('textbox', { name: 'Steps' }).inputValue(), recipe.content);
    assert.deepEqual(writes, []);
    const content = `${recipe.content}\n\nCheck a 320px preview.`;
    await draft.getByRole('textbox', { name: 'Steps' }).fill(content);
    await draft.getByRole('button', { name: 'Save skill draft' }).click();
    await draft.getByRole('button', { name: 'View and confirm' }).click();
    assert.deepEqual(writes, [
      {
        path: `${base}/skills`,
        body: { agentId: 'review', name: recipe.name, description: recipe.description, content },
      },
    ]);
    const review = draft.getByRole('region', { name: 'Confirm skill version' });
    await review.getByText('Check a 320px preview.').waitFor();
    await review.getByRole('button', { name: 'Confirm and enable' }).click();
    await review.waitFor({ state: 'hidden' });
    assert.deepEqual(writes[1], {
      path: `${base}/skills/draft-a/approve`,
      body: { expectedActiveId: null },
    });

    await page.goto(`${home}?member`);
    await page.getByRole('button', { name: '内置技能', exact: true }).click();
    const member = page.getByRole('dialog', { name: '内置技能' });
    await member.getByRole('searchbox', { name: '搜索内置技能' }).fill('前端');
    await member.getByRole('button', { name: '预览「前端设计」的指令' }).click();
    await member.getByText('只有工作空间拥有者可以提交技能草稿。').waitFor();
    assert.equal(await member.getByRole('combobox').count(), 0);
    assert.equal(await member.getByRole('button', { name: '编辑技能草稿' }).count(), 0);
    assert.equal(writes.length, 2);
    assert.ok(
      requests.every((path) => path === `${base}/apps` || path.startsWith(`${base}/skills`)),
    );
    assert.deepEqual(errors, []);
  },
);
