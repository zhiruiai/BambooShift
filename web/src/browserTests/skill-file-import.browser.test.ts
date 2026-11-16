import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

test(
  'SKILL.md and skill folder imports preserve drafts and require separate approvals',
  { skip: process.env.OPENBOT_BROWSER_TEST !== '1', timeout: 75_000 },
  async (t) => {
    const { outputFiles } = await build({
      stdin: {
        contents: `
          import './web/src/styles.css';
          import './web/src/theme.css';
          import { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { SkillsDialog } from './web/src/components/SkillsDialog';
          import { initializeLanguage } from './web/src/i18n';
          initializeLanguage().setLanguage('en');
          const agents = [{id:'one',name:'First Bot'},{id:'two',name:'Second Bot'}];
          const request = (path, body) => fetch(path, {
            method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
          }).then(response => response.json());
          function Fixture() {
            const [skills,setSkills] = useState([]);
            return <SkillsDialog agents={agents} skills={skills} readOnly={location.search==='?member'}
              busy={false} onClose={() => {}} onAdd={async body => {
                setSkills([await request('/skills',body)]);return {ok:true};
              }} onTransition={async (id,action,expectedActiveId) => {
                setSkills([await request('/skills/'+id+'/'+action,{expectedActiveId})]);return {ok:true};
              }} />;
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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(8000);
    const writes: { path: string; body: unknown }[] = [];
    let saved: Record<string, unknown> = {};
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      assert.equal(url.origin, 'https://skill-import.example.test');
      if (request.isNavigationRequest())
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      assert.equal(request.method(), 'POST');
      const body = request.postDataJSON();
      writes.push({ path: url.pathname, body });
      if (url.pathname === '/skills') {
        saved = body;
        if (body.skillPackage) {
          const { root, frontmatter, files } = body.skillPackage;
          saved = {
            ...body,
            skillPackage: {
              format: 'agent-skills',
              root,
              frontmatter: { ...frontmatter, name: body.name, description: body.description },
              files: [
                { path: 'SKILL.md', size: 50, sha256: 'a'.repeat(64) },
                ...files.map(({ path, base64 }: { path: string; base64: string }) => ({
                  path,
                  size: Buffer.from(base64, 'base64').length,
                  sha256: 'b'.repeat(64),
                })),
              ],
            },
          };
        }
      }
      return route.fulfill({
        json: {
          ...saved,
          id: 'skill-a',
          version: 1,
          status: url.pathname === '/skills' ? 'proposed' : 'active',
          createdAt: '2026-11-12T00:00:00Z',
        },
      });
    });
    await page.goto('https://skill-import.example.test');
    const dialog = page.getByRole('dialog');
    const add = dialog.getByRole('button', { name: 'Create a skill package', exact: true });
    const picker = dialog.locator('input[type=file][accept=".md"]');
    await dialog.getByRole('button', { name: 'Import SKILL.md', exact: true }).waitFor();
    assert.equal(await picker.getAttribute('accept'), '.md');
    await add.click();
    await dialog.getByRole('textbox', { name: 'Skill name' }).fill('Existing draft');
    await dialog.getByRole('textbox', { name: 'Short description' }).fill('Existing description');
    await dialog.getByRole('textbox', { name: 'Steps' }).fill('Existing steps');
    assert.equal(await picker.count(), 0);
    assert.equal(
      await dialog.getByRole('button', { name: 'Import SKILL.md', exact: true }).count(),
      0,
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await picker.setInputFiles([]);
    await add.click();
    assert.equal(
      await dialog.getByRole('textbox', { name: 'Skill name' }).inputValue(),
      'Existing draft',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await picker.setInputFiles({
      name: 'SKILL.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from([0xff]),
    });
    await dialog.getByRole('alert').waitFor();
    assert.match((await dialog.getByRole('alert').textContent()) || '', /not valid UTF-8/);
    assert.equal(await page.locator(':focus').getAttribute('role'), 'alert');
    assert.deepEqual(writes, []);
    await add.click();
    assert.equal(
      await dialog.getByRole('textbox', { name: 'Steps' }).inputValue(),
      'Existing steps',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    // A file read finishing after the user opens a manual draft cannot replace it.
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () {
        if (this.name !== 'late.md') return original.call(this);
        return new Promise<ArrayBuffer>((resolve) => {
          (window as unknown as { finishRead: () => void }).finishRead = () =>
            resolve(
              new TextEncoder().encode('---\nname: Late\ndescription: Late\n---\nLate').buffer,
            );
        });
      };
    });
    await picker.setInputFiles({
      name: 'late.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('delayed'),
    });
    await dialog.getByRole('button', { name: 'Reading skill…', exact: true }).waitFor();
    await add.click();
    await page.evaluate(async () => {
      (window as unknown as { finishRead: () => void }).finishRead();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    assert.equal(
      await dialog.getByRole('textbox', { name: 'Skill name' }).inputValue(),
      'Existing draft',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    await picker.setInputFiles({
      name: 'SKILL.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(
        '\ufeff---\r\nname: Imported skill\r\ndescription: Check outputs\r\npermissions: [all]\r\ndependencies: [never-install]\r\n---\r\n# Review\r\n\r\nCheck all results.',
      ),
    });
    await dialog.getByRole('textbox', { name: 'Skill name' }).waitFor();
    assert.equal(await page.locator('select:focus').inputValue(), 'one');
    assert.equal(
      await dialog.getByRole('textbox', { name: 'Skill name' }).inputValue(),
      'Imported skill',
    );
    assert.equal(
      await dialog.getByRole('textbox', { name: 'Short description' }).inputValue(),
      'Check outputs',
    );
    assert.equal(
      await dialog.getByRole('textbox', { name: 'Steps' }).inputValue(),
      '# Review\n\nCheck all results.',
    );
    assert.deepEqual(writes, []);
    await dialog.getByRole('combobox', { name: 'Assigned Bot' }).selectOption('two');
    await dialog.getByRole('textbox', { name: 'Steps' }).fill('Reviewed imported instructions.');
    await dialog.getByRole('button', { name: 'Save skill draft', exact: true }).click();
    await dialog.locator('.skill-picker').first().click();
    await dialog.getByRole('button', { name: 'View and confirm', exact: true }).click();
    assert.deepEqual(writes, [
      {
        path: '/skills',
        body: {
          agentId: 'two',
          name: 'Imported skill',
          description: 'Check outputs',
          content: 'Reviewed imported instructions.',
        },
      },
    ]);
    const review = dialog.getByRole('region', { name: 'Confirm skill version' });
    await review.getByText('Reviewed imported instructions.').waitFor();
    await review.getByRole('button', { name: 'Confirm and enable' }).click();
    await review.waitFor({ state: 'hidden' });
    assert.deepEqual(writes[1], {
      path: '/skills/skill-a/approve',
      body: { expectedActiveId: null },
    });
    assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await page.goto('https://skill-import.example.test?member');
    await page.getByRole('dialog').waitFor();
    assert.equal(await picker.count(), 0);
    assert.equal(
      await dialog.getByRole('button', { name: 'Import SKILL.md', exact: true }).count(),
      0,
    );
    assert.equal(writes.length, 2);

    await t.test('folder resources remain attached through draft, review and enable', async () => {
      const staging = await mkdtemp(join(tmpdir(), 'bambooshift-skill-folder-'));
      const folder = join(staging, 'review-pdf');
      const resource = Buffer.from([0, 1, 128, 255]);
      await mkdir(join(folder, 'assets'), { recursive: true });
      try {
        await Promise.all([
          writeFile(
            join(folder, 'SKILL.md'),
            '---\nname: review-pdf\ndescription: Review a PDF\nlicense: MIT\nmetadata: {team: QA}\nallowed-tools: Read\n---\n',
          ),
          writeFile(join(folder, 'assets', 'sample.bin'), resource),
        ]);
        assert.equal(await dialog.getByRole('button', { name: 'Import skill folder' }).count(), 0);
        const workspaceId = '11111111-1111-4111-8111-111111111111';
        await page.goto(`https://skill-import.example.test/w/${workspaceId}/`);
        await dialog.getByRole('button', { name: 'Import skill folder' }).waitFor();
        await dialog.locator('input[webkitdirectory]').setInputFiles(folder);
        const draftName = dialog.getByRole('textbox', { name: 'Skill name' });
        await draftName.waitFor();
        assert.equal(await draftName.inputValue(), 'review-pdf');
        assert.equal(await draftName.getAttribute('readonly'), '');
        const details = dialog.getByRole('region', { name: 'Agent Skills package' });
        await details.getByText('MIT', { exact: true }).waitFor();
        await details.getByText('Files (2)', { exact: true }).click();
        await details.getByText('assets/sample.bin', { exact: true }).waitFor();
        assert.equal(writes.length, 2);
        await dialog.getByRole('button', { name: 'Save skill draft', exact: true }).click();
        await dialog.locator('.skill-picker').first().click();
        await dialog.getByRole('button', { name: 'View and confirm', exact: true }).click();
        assert.deepEqual(writes[2], {
          path: '/skills',
          body: {
            agentId: 'one',
            name: 'review-pdf',
            description: 'Review a PDF',
            content: '',
            skillPackage: {
              root: 'review-pdf',
              frontmatter: { license: 'MIT', metadata: { team: 'QA' }, 'allowed-tools': 'Read' },
              files: [{ path: 'assets/sample.bin', base64: resource.toString('base64') }],
            },
          },
        });
        const reviewed = dialog.getByRole('region', { name: 'Confirm skill version' });
        await reviewed.getByText('Declared tools', { exact: true }).waitFor();
        assert.equal(
          await reviewed.getByRole('link', { name: 'Download skill ZIP' }).getAttribute('href'),
          `/api/workspaces/${workspaceId}/skills/skill-a/package`,
        );
        assert.equal(writes.length, 3);
        await reviewed.getByRole('button', { name: 'Confirm and enable' }).click();
        await reviewed.waitFor({ state: 'hidden' });
        assert.deepEqual(writes[3], {
          path: '/skills/skill-a/approve',
          body: { expectedActiveId: null },
        });
        assert.ok(
          await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        );
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
    assert.deepEqual(errors, []);
  },
);
