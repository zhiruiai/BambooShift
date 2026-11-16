import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { skillPackageUpload } from '../skillPackageImport';
import { skillWorkflowPackage, skillWorkflowTemplates } from '../skillWorkflowTemplates';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const origin = 'https://packaged-skills.example.test';
const home = `${origin}/w/${workspaceId}`;
const base = `/api/workspaces/${workspaceId}`;
const bots = [
  { id: 'design', name: 'Design Bot' },
  { id: 'review', name: 'Review Bot' },
];
const recipe = skillWorkflowTemplates.en.find(({ id }) => id === 'web-app-testing')!;
const { draft: packageDraft, fileContents } = skillWorkflowPackage(recipe, 'en');

test(
  'packaged skills install once in place, preserve failed selections, and import folders without drafts',
  { skip: process.env.OPENBOT_BROWSER_TEST !== '1', timeout: 60_000 },
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
        import { skillInstallBody, acceptInstalledSkill } from './web/src/skillInstallation';
        import { initializeLanguage } from './web/src/i18n';
        const owner = location.search !== '?member';
        initializeLanguage().setLanguage(owner ? 'en' : 'zh-CN');
        const bots = ${JSON.stringify(bots)};
        function Fixture() {
          const [skills,setSkills] = useState([]);
          const [closed,setClosed] = useState(false);
          globalThis.fixtureSkillStatus = status => setSkills(previous => previous.map(skill => ({...skill,status})));
          const install = async (draft, expectedActiveId) => {
            const response = await fetch('${base}/skills/install', {method:'POST',
              headers:{'content-type':'application/json'},body:JSON.stringify(skillInstallBody(draft,expectedActiveId))});
            const value = await response.json();
            if (!response.ok) throw new Error(value.error);
            setSkills(previous => acceptInstalledSkill(previous,value));
            return value;
          };
          if (closed) return <p>Closed</p>;
          if (location.search === '?single') return <SkillsDialog agents={[bots[0]]} skills={skills}
            busy={false} readOnly={false} onClose={() => setClosed(true)} onInstall={install}
            onAdd={() => {throw Error('unexpected draft');}} onTransition={() => {throw Error('unexpected approval');}} />;
          return <AppsDialog workspaceId="${workspaceId}" userId={owner?'owner':'member'}
            workspaceName="Fixture" team canManage={owner} computerConnected={false} modelLabel="Fixture"
            modelConfigured={false} onFiles={() => {}} onComputer={() => {}} onSettings={() => {}}
            onClose={() => setClosed(true)} packagedSkills={{bots:owner?bots:[],skills,onInstall:install}} />;
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
    const writes: Array<{ path: string; body: any }> = [];
    let failOnce = true;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      assert.equal(url.origin, origin);
      if (request.isNavigationRequest())
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.pathname === `${base}/apps`) return route.fulfill({ json: [] });
      assert.equal(request.method(), 'POST');
      assert.equal(url.pathname, `${base}/skills/install`);
      const body = request.postDataJSON();
      writes.push({ path: url.pathname, body });
      if (failOnce) {
        failOnce = false;
        return route.fulfill({
          status: 503,
          json: { error: 'Connection interrupted. Try again.' },
        });
      }
      const { skillPackage, ...draft } = body;
      return route.fulfill({
        json: {
          ...draft,
          id: `installed-${writes.length}`,
          version: 1,
          status: 'active',
          createdAt: '2026-11-16T00:00:00Z',
          skillPackage: {
            ...skillPackage,
            format: 'agent-skills',
            frontmatter: {
              ...skillPackage.frontmatter,
              name: body.name,
              description: body.description,
            },
            files: skillPackage.files.map(({ path, base64 }: { path: string; base64: string }) => {
              const bytes = Buffer.from(base64, 'base64');
              return {
                path,
                size: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              };
            }),
          },
        },
      });
    });
    await page.goto(home);
    await page.getByRole('button', { name: 'Packaged skills', exact: true }).click();
    const catalog = page.getByRole('dialog', { name: 'Packaged skills' });
    const search = catalog.getByRole('searchbox', { name: 'Search packaged skills' });
    const tiles = catalog.getByRole('button', { name: /^Preview package for / });
    assert.equal(await tiles.count(), 2, 'compact catalog pages avoid a long mobile list');
    const first = await tiles.first().getAttribute('aria-label');
    await catalog.getByRole('button', { name: 'Next skills page' }).click();
    assert.notEqual(await tiles.first().getAttribute('aria-label'), first);
    await catalog.getByRole('button', { name: 'Previous skills page' }).click();
    assert.equal(await tiles.first().getAttribute('aria-label'), first);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(
      () => document.querySelectorAll('.packaged-skill-tile').length === 9,
    );
    assert.ok(
      await catalog
        .locator('.apps-scroll')
        .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
      'desktop catalog fits without vertical scrolling',
    );
    await page.setViewportSize({ width: 320, height: 560 });
    await page.waitForFunction(
      () => document.querySelectorAll('.packaged-skill-tile').length === 2,
    );
    await search.fill('nothing matches');
    await catalog.getByText('No matching skills.').waitFor();
    await search.fill(recipe.id);
    assert.equal(await catalog.getByRole('button', { name: /^Preview package for / }).count(), 1);
    await catalog.getByRole('button', { name: `Preview package for ${recipe.name}` }).click();
    assert.equal(await page.locator(':focus').textContent(), 'Back to packaged skills');
    const install = catalog.getByRole('button', { name: 'Install skill', exact: true });
    assert.equal(await install.isEnabled(), false);
    await catalog.getByRole('combobox', { name: 'Choose a Bot' }).selectOption('review');
    assert.equal(
      await install.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.bottom <= window.innerHeight &&
          element.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          )
        );
      }),
      true,
      'install is usable above the fold at 320px',
    );
    assert.ok(await catalog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await catalog.getByText('View instructions and files', { exact: true }).click();
    const files = catalog.getByRole('region', { name: 'Agent Skills package' });
    const sample = 'assets/test-cases.csv';
    await files.getByText(sample, { exact: true }).click();
    assert.equal(await files.locator('details[open] > pre').textContent(), fileContents[sample]);
    await catalog.getByText('View instructions and files', { exact: true }).click();
    await install.click();
    await catalog.getByRole('alert').getByText('Connection interrupted. Try again.').waitFor();
    assert.equal(await catalog.getByRole('combobox').inputValue(), 'review');
    assert.equal(await catalog.getByRole('heading', { name: 'Skill package draft' }).count(), 0);
    await install.click();
    await catalog
      .getByRole('status')
      .getByText('Enabled for Review Bot and ready to use.')
      .waitFor();
    assert.equal(
      await catalog.getByRole('button', { name: 'Installed', exact: true }).isEnabled(),
      false,
    );
    await page.evaluate(() => (window as any).fixtureSkillStatus('disabled'));
    await catalog.getByRole('button', { name: 'Install skill', exact: true }).waitFor();
    assert.equal(await catalog.locator('.skill-install-success').count(), 0);
    await page.evaluate(() => (window as any).fixtureSkillStatus('active'));
    await catalog.getByRole('button', { name: 'Installed', exact: true }).waitFor();
    assert.deepEqual(
      writes.map(({ body }) => body),
      Array(2).fill({
        agentId: 'review',
        name: recipe.id,
        description: recipe.description,
        content: packageDraft.content,
        skillPackage: skillPackageUpload(packageDraft, packageDraft.skillPackage),
        expectedActiveId: null,
      }),
    );
    await catalog.getByRole('button', { name: 'Done', exact: true }).click();
    await catalog.getByRole('button', { name: `Preview package for ${recipe.name}` }).click();
    await catalog.getByRole('combobox').selectOption('review');
    await catalog.getByRole('button', { name: 'Installed', exact: true }).waitFor();
    assert.equal(
      await catalog.getByRole('button', { name: 'Installed', exact: true }).isEnabled(),
      false,
    );
    await catalog.getByRole('combobox').selectOption('design');
    await catalog.getByRole('button', { name: 'Install skill', exact: true }).waitFor();
    assert.equal(writes.length, 2);

    await page.goto(`${home}?single`);
    const manager = page.getByRole('dialog');
    await manager.getByRole('button', { name: 'Choose from skill library' }).click();
    await manager.getByRole('searchbox').fill(recipe.id);
    await manager.getByRole('button', { name: `Preview package for ${recipe.name}` }).click();
    assert.equal(await manager.getByRole('combobox').count(), 0);
    await manager.getByRole('button', { name: 'Install skill', exact: true }).click();
    await manager.getByText('Enabled for Design Bot and ready to use.').waitFor();
    await manager.getByRole('button', { name: 'Done', exact: true }).click();
    await manager
      .getByRole('button', { name: new RegExp(recipe.name) })
      .first()
      .waitFor();
    assert.equal(writes.length, 3);

    const folder = await mkdtemp(join(tmpdir(), 'skill-install-'));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const root = join(folder, 'quality-review');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: quality-review\ndescription: Check data quality.\n---\nRun scripts/check.py to inspect data.\n',
    );
    await writeFile(join(root, 'scripts/check.py'), 'print("checked")\n');
    await manager.locator('input[type=file][webkitdirectory]').setInputFiles(root);
    await manager.getByRole('heading', { name: 'quality-review', exact: true }).waitFor();
    await manager.getByRole('button', { name: 'Install skill', exact: true }).click();
    await manager.getByText('Enabled for Design Bot and ready to use.').waitFor();
    assert.equal(writes.length, 4);
    assert.equal(writes[3].body.name, 'quality-review');
    assert.equal(writes[3].body.skillPackage.files[0].path, 'scripts/check.py');
    assert.equal(await manager.getByRole('heading', { name: 'Skill package draft' }).count(), 0);

    await page.goto(`${home}?member`);
    await page.getByRole('button', { name: '内置技能', exact: true }).click();
    const member = page.getByRole('dialog', { name: '内置技能' });
    await member.getByRole('searchbox').fill('前端');
    await member.getByRole('button', { name: '预览「前端设计」技能包' }).click();
    await member.getByText('只有工作空间拥有者可以安装技能。').waitFor();
    assert.equal(await member.getByRole('button', { name: '安装技能', exact: true }).count(), 0);
    assert.equal(writes.length, 4);
    assert.deepEqual(errors, []);
  },
);
