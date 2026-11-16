import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright-core';

async function layout(page: Page) {
  return page.locator('.bot-skills-dialog').evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect();
    const scrolling = [...dialog.querySelectorAll<HTMLElement>('*')]
      .filter(
        (element) =>
          element.getClientRects().length &&
          /auto|scroll/.test(getComputedStyle(element).overflowY) &&
          element.scrollHeight > element.clientHeight + 1,
      )
      .map((element) => element.className);
    return {
      horizontal: dialog.scrollWidth > dialog.clientWidth + 1,
      outerScroll: dialog.scrollHeight > dialog.clientHeight + 1,
      contained:
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight + 1 &&
        bounds.left >= 0 &&
        bounds.right <= innerWidth + 1,
      scrolling,
    };
  });
}

async function noListOverlap(page: Page) {
  const list = await page.locator('.skill-manager-list').boundingBox();
  const pagination = await page.locator('.skill-pagination').boundingBox();
  const footer = await page.locator('.skill-secondary-actions').boundingBox();
  assert.ok(list && pagination && footer);
  assert.ok(list.y + list.height <= pagination.y + 1, 'pagination stays below the skill rows');
  assert.ok(
    pagination.y + pagination.height <= footer.y + 1,
    'secondary actions do not cover pagination',
  );
}

test(
  'skill settings paginate the list and keep long instructions in one detail scroller',
  { timeout: 60000 },
  async (t) => {
    const { outputFiles } = await build({
      stdin: {
        contents: `
      import './web/src/styles.css'; import './web/src/theme.css';
      import { createRoot } from 'react-dom/client';
      import { initializeLanguage } from './web/src/i18n';
      import { SkillsDialog } from './web/src/components/SkillsDialog';
      import { skillWorkflowPackage, skillWorkflowTemplates } from './web/src/skillWorkflowTemplates';
      initializeLanguage().setLanguage('en');
      const skills = Array.from({length:16},(_,index)=>({
        id:'skill-'+index, agentId:'reviewer', name:'Review '+String(index+1).padStart(2,'0'),
        description:'Check the quality of files and report concrete findings with evidence.',
        version:1, status:index<14?'active':index===14?'proposed':'disabled',
        content:'# Instructions\\n\\n'+Array.from({length:100},(_,line)=>'## Step '+line+'\\n\\nInspect the actual file and explain each finding.').join('\\n\\n'),
        skillPackage:{format:'agent-skills',root:'review-quality',frontmatter:{name:'review-quality',description:'Check quality',license:'MIT'},
          files:[{path:'SKILL.md',size:200},...Array.from({length:25},(_,i)=>({path:'references/check-'+i+'.md',size:120}))]},
      }));
      if (location.search === '?package') {
        const recipe = skillWorkflowTemplates.en.find(item=>item.id==='data-quality-review');
        const {draft} = skillWorkflowPackage(recipe, 'en');
        skills.splice(0, skills.length, {...draft, id:'data-quality', agentId:'reviewer', version:1, status:'active',
          skillPackage:{...draft.skillPackage,format:'agent-skills',files:[{path:'SKILL.md',size:2128},...draft.skillPackage.files]}});
      }
      createRoot(document.getElementById('root')).render(<SkillsDialog agents={[{id:'reviewer',name:'Review Bot'}]}
        skills={skills} busy={false} readOnly={location.search==='?member'} onClose={()=>{}}
        team={location.search==='?team' ? {onImported:()=>{}} : undefined}
        onAdd={async()=>({ok:true})} onTransition={async()=>({ok:true})} />);
    `,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outdir: 'fixture',
      format: 'iife',
      jsx: 'automatic',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    });
    const script = outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const style = outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).pathname === '/fixture.js'
        ? route.fulfill({ contentType: 'text/javascript', body: script })
        : route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style><div id="root"></div><script src="/fixture.js"></script>`,
          }),
    );
    await page.goto('https://skills.example.test/w/11111111-1111-4111-8111-111111111111');
    const dialog = page.getByRole('dialog');
    const items = dialog.locator('.skill-picker');
    await items.first().waitFor();
    assert.equal(await items.count(), 6);
    await noListOverlap(page);
    assert.deepEqual(await layout(page), {
      horizontal: false,
      outerScroll: false,
      contained: true,
      scrolling: [],
    });
    await dialog.getByRole('button', { name: 'Next skills' }).click();
    assert.match(await items.first().innerText(), /Review 07/);
    await dialog.getByRole('searchbox', { name: 'Search skills' }).fill('Review 12');
    assert.equal(await items.count(), 1);
    await items.first().click();
    await dialog.getByRole('tab', { name: 'SKILL.md' }).click();
    assert.deepEqual((await layout(page)).scrolling, ['skill-detail-body']);
    await dialog.getByRole('tab', { name: 'SKILL.md' }).press('ArrowRight');
    await dialog.getByText('references/check-24.md', { exact: true }).waitFor();
    assert.match(
      (await dialog.getByRole('link', { name: 'Download skill ZIP' }).getAttribute('href')) || '',
      /\/skills\/skill-11\/package$/,
    );
    await dialog.locator('.skill-detail .approve-skill').click();
    await dialog.locator('.skill-review-back').click();
    await dialog.locator('.skill-detail-heading h3:focus').waitFor();
    assert.equal(await dialog.locator('.skill-detail-heading h3').innerText(), 'Review 12');
    await mkdir('.build/skill-manager-qa', { recursive: true });
    await page.screenshot({ path: '.build/skill-manager-qa/desktop.png' });
    await page.setViewportSize({ width: 320, height: 568 });
    await dialog.getByRole('button', { name: 'Back to skills', exact: true }).click();
    assert.equal(await items.count(), 2);
    assert.equal(
      await dialog.locator('.skill-picker:focus').getAttribute('data-skill-id'),
      'skill-11',
    );
    await noListOverlap(page);
    assert.deepEqual(await layout(page), {
      horizontal: false,
      outerScroll: false,
      contained: true,
      scrolling: [],
    });
    await page.screenshot({ path: '.build/skill-manager-qa/mobile-list.png' });
    await dialog.locator('.skill-picker:focus').click();
    await dialog.getByRole('tab', { name: 'SKILL.md' }).click();
    assert.deepEqual(await layout(page), {
      horizontal: false,
      outerScroll: false,
      contained: true,
      scrolling: ['skill-detail-body'],
    });
    await page.screenshot({ path: '.build/skill-manager-qa/mobile-detail.png' });
    await page.goto('https://skills.example.test/w/11111111-1111-4111-8111-111111111111?member');
    await items.first().click();
    assert.equal(await dialog.locator('.approve-skill').count(), 0);
    assert.equal(
      await dialog.getByRole('button', { name: 'Create a skill package', exact: true }).count(),
      0,
    );
    await page.goto('https://skills.example.test/w/11111111-1111-4111-8111-111111111111?team');
    await items.first().waitFor();
    assert.equal(await items.count(), 1);
    await noListOverlap(page);
    assert.deepEqual(await layout(page), {
      horizontal: false,
      outerScroll: false,
      contained: true,
      scrolling: [],
    });
    for (const viewport of [
      { width: 320, height: 480 },
      { width: 900, height: 500 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('https://skills.example.test/w/11111111-1111-4111-8111-111111111111');
      await items.first().waitFor();
      const compact = await layout(page);
      assert.equal(compact.horizontal, false);
      assert.equal(compact.outerScroll, false);
      assert.equal(compact.contained, true);
      assert.ok(
        compact.scrolling.length <= 1 && compact.scrolling.every((name) => name === 'modal-body'),
      );
      const secondary = dialog.getByRole('button', { name: 'Import SKILL.md', exact: true });
      await secondary.scrollIntoViewIfNeeded();
      assert.ok(
        await secondary.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return (
            box.top >= 0 &&
            box.bottom <= innerHeight &&
            element.contains(
              document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
            )
          );
        }),
        'secondary actions remain reachable in a short window',
      );
      await items.first().click();
      await dialog.getByRole('tab', { name: 'SKILL.md' }).click();
      assert.deepEqual(await layout(page), {
        horizontal: false,
        outerScroll: false,
        contained: true,
        scrolling: ['skill-detail-body'],
      });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('https://skills.example.test/w/11111111-1111-4111-8111-111111111111?package');
    await items.first().click();
    await dialog.getByRole('tab', { name: 'Files', exact: true }).click();
    assert.equal(await dialog.locator('.skill-package li').count(), 4);
    assert.deepEqual((await layout(page)).scrolling, []);
    for (const locator of [
      dialog.getByText('scripts/profile_csv.py', { exact: true }),
      dialog.getByRole('link', { name: 'Download skill ZIP' }),
    ]) {
      assert.ok(
        await locator.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const body = element.closest('.skill-detail-body')!.getBoundingClientRect();
          return bounds.top >= body.top && bounds.bottom <= body.bottom;
        }),
        'the actual four-file package shows its script and download without scrolling',
      );
    }
    const metadata = dialog.locator('.skill-package details').filter({
      has: page.getByText('Package details', { exact: true }),
    });
    assert.equal(await metadata.getAttribute('open'), null);
    await page.screenshot({ path: '.build/skill-manager-qa/package-files.png' });
    await metadata.locator('summary').click();
    await metadata.getByText('MIT', { exact: true }).waitFor();
    await metadata.getByText(/The optional CSV checker requires Python 3/).waitFor();
    await dialog.locator('.skill-detail .approve-skill').click();
    await dialog
      .locator('.skill-version-review .skill-package')
      .getByText('MIT', { exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
  },
);
