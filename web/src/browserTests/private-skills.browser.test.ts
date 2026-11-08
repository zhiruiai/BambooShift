import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { PrivateSkill } from '../privateSkills';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = 'fixture-owner';
const origin = 'https://private-skills.example.test';
const base = `/api/workspaces/${workspaceId}`;
const agents = [
  { id: 'source', name: 'Source Bot' },
  { id: 'target', name: 'Review Bot' },
];
const original: PrivateSkill = {
  id: 'skill-review',
  sourceAgentId: 'source',
  sourceAgentName: 'Source Bot',
  name: 'Review checklist',
  description: 'A reviewed workspace skill',
  content: `# Scope\n${'LongSyntheticEvidence'.repeat(35)}\nReview each citation.\nFinal marker`,
  version: 2,
  revision: 'b'.repeat(64),
  available: true,
  enabledAgentIds: [],
};
const previous: PrivateSkill = {
  ...original,
  content: 'Older version still pinned on this Bot.',
  version: 1,
  revision: 'a'.repeat(64),
  available: false,
  enabledAgentIds: ['target'],
};

test(
  'private skills reviews and changes exact pinned versions on a narrow app panel',
  { timeout: 60_000 },
  async (t) => {
    const bundled = await build({
      stdin: {
        contents: `
        import './web/src/styles.css';
        import './web/src/theme.css';
        import { createRoot } from 'react-dom/client';
        import { initializeLanguage } from './web/src/i18n';
        import { AppsDialog } from './web/src/components/AppsDialog';
        initializeLanguage().setLanguage('en');
        createRoot(document.getElementById('root')).render(
          <AppsDialog workspaceId={${JSON.stringify(workspaceId)}} userId={${JSON.stringify(userId)}}
            workspaceName="Fixture space" canManage computerConnected={false} modelLabel="Fixture"
            modelConfigured onFiles={() => {}} onComputer={() => {}} onSettings={() => {}} onClose={() => {}} />,
        );
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
    const js = bundled.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const css = bundled.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
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
    const writes: unknown[] = [];
    let skills = [original, previous];
    let reads = 0;
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
      if (url.pathname === `${base}/apps`) return route.fulfill({ json: [] });
      if (url.pathname === `${base}/private-skills`) {
        assert.equal(request.headers()['x-openbot-expected-user'], userId);
        assert.equal(request.method(), 'GET');
        reads++;
        return route.fulfill({ json: { agents, skills } });
      }
      if (url.pathname === `${base}/private-skills/${original.id}/bots/target`) {
        assert.equal(request.headers()['x-openbot-expected-user'], userId);
        assert.equal(request.method(), 'PUT');
        const body = request.postDataJSON();
        writes.push(body);
        assert.equal(body.expectedRevision, body.enabled ? original.revision : previous.revision);
        skills = [{ ...original, enabledAgentIds: body.enabled ? ['target'] : [] }];
        return route.fulfill({ json: { enabled: body.enabled } });
      }
      return route.fulfill({ status: 404, json: {} });
    });

    await page.goto(`${origin}/w/${workspaceId}`);
    await page.getByRole('button', { name: 'Private skills', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Private skills' });
    const currentVersion = dialog.getByRole('button', { name: /Review checklist.*Version 2/ });
    await currentVersion.click();
    await dialog.getByRole('heading', { name: 'Review checklist' }).waitFor();
    await dialog.getByText(original.revision, { exact: true }).waitFor();
    assert.match(await dialog.locator('pre').innerText(), /Final marker$/);
    assert.ok(
      await dialog
        .locator('.apps-scroll')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    );
    const target = dialog.getByRole('combobox', { name: 'Target Bot' });
    assert.equal(await target.locator('option[value="source"]').count(), 0);
    assert.equal(
      await dialog.getByRole('button', { name: 'Enable this version' }).isDisabled(),
      true,
    );
    await target.selectOption('target');
    await dialog.getByRole('button', { name: 'Review installed version' }).click();
    await dialog.getByText(previous.revision, { exact: true }).waitFor();
    await dialog.getByText(previous.content, { exact: true }).waitFor();
    assert.deepEqual(writes, []);
    await dialog.getByRole('button', { name: 'Disable this version' }).click();
    await dialog.getByText('Skill version disabled.', { exact: true }).waitFor();
    await currentVersion.click();
    await target.selectOption('target');
    await dialog.getByRole('button', { name: 'Enable this version' }).click();
    await dialog.getByText('Enabled for Review Bot', { exact: true }).waitFor();
    assert.deepEqual(writes, [
      { enabled: false, expectedRevision: previous.revision },
      { enabled: true, expectedRevision: original.revision },
    ]);
    assert.equal(reads, 3);
    assert.deepEqual(errors, []);
  },
);
