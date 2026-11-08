import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Route } from 'playwright-core';
import type { PrivateSkillTeamPublication } from '../../../shared/team-skills';
import type { PrivateSkill } from '../privateSkills';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const teamA = '22222222-2222-4222-8222-222222222222';
const teamB = '33333333-3333-4333-8333-333333333333';
const userId = 'fixture-owner';
const origin = 'https://skill-publication.example.test';
const base = `/api/workspaces/${workspaceId}`;
const original: PrivateSkill = {
  id: 'skill-1',
  sourceAgentId: 'private-source',
  sourceAgentName: 'Private source Bot',
  name: 'Evidence checklist',
  description: 'A workflow for reviewing citations.',
  content: `# Review all evidence\n${'LongSyntheticEvidence'.repeat(30)}\nFinal reviewed instruction.`,
  version: 1,
  revision: 'a'.repeat(64),
  available: true,
  enabledAgentIds: [],
};
const revised = { ...original, id: 'skill-2', version: 2, revision: 'b'.repeat(64) };
const firstPublication: PrivateSkillTeamPublication = {
  id: '44444444-4444-4444-8444-444444444444',
  revision: '55555555-5555-4555-8555-555555555555',
  version: 1,
  sourceRevision: original.revision,
};
const secondPublication: PrivateSkillTeamPublication = {
  ...firstPublication,
  revision: '66666666-6666-4666-8666-666666666666',
  version: 2,
  sourceRevision: revised.revision,
};

test(
  'the narrow private skill shelf publishes a reviewed version and recovers, syncs or cancels exact requests',
  { timeout: 60_000 },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `
          import './web/src/styles.css';
          import './web/src/theme.css';
          import { createRoot } from 'react-dom/client';
          import { initializeLanguage } from './web/src/i18n';
          import { AppsDialog } from './web/src/components/AppsDialog';
          initializeLanguage().setLanguage(location.search === '?zh' ? 'zh-CN' : 'en');
          createRoot(document.getElementById('root')).render(
            <AppsDialog workspaceId={${JSON.stringify(workspaceId)}} userId={${JSON.stringify(userId)}}
              workspaceName="Fixture space" team={location.search === '?team'} canManage computerConnected={false}
              modelLabel="Fixture" modelConfigured onFiles={() => {}} onComputer={() => {}} onSettings={() => {}} onClose={() => {}} />,
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
    const viewport = { width: 320, height: 560 };
    const errors: string[] = [];
    const writes: Array<{
      path: string;
      requestId: string;
      expectedSourceRevision: string;
      expectedPublicationRevision: string | null;
    }> = [];
    const closed: string[] = [];
    const receipts = new Map<string, PrivateSkillTeamPublication>();
    let live = original;
    let published: PrivateSkillTeamPublication | null = null;
    let changed = false;
    async function intercept(route: Route) {
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
      assert.equal(request.headers()['x-openbot-expected-user'], userId);
      if (url.pathname === `${base}/apps`) return route.fulfill({ json: [] });
      if (url.pathname === `${base}/private-skills`)
        return route.fulfill({ json: { agents: [], skills: [live] } });
      if (url.pathname === `${base}/private-skills/${live.id}/team-publication-targets`)
        return route.fulfill({
          json: {
            teams: [
              { workspaceId: teamA, workspaceName: 'Research Team', publication: published },
              { workspaceId: teamB, workspaceName: 'Operations Team', publication: null },
            ],
          },
        });
      if (url.pathname.includes('/team-publications/')) {
        const last = url.pathname.split('/').at(-1)!;
        if (request.method() === 'GET') {
          const accepted = receipts.get(last);
          return accepted
            ? route.fulfill({ json: { publication: accepted } })
            : route.fulfill({ status: 404, json: { code: 'TEAM_SKILL_PUBLICATION_NOT_FOUND' } });
        }
        if (request.method() === 'DELETE') {
          assert.equal(request.postData(), null);
          closed.push(last);
          return route.fulfill({ json: { status: 'cancelled' } });
        }
        assert.equal(request.method(), 'PUT');
        const body = request.postDataJSON();
        writes.push({ path: url.pathname, ...body });
        if (last === teamB) return route.fulfill({ status: 502, json: {} });
        if (!published) {
          published = firstPublication;
          receipts.set(body.requestId, published);
          return route.fulfill({ status: 502, json: {} });
        }
        if (!changed) {
          changed = true;
          published = { ...firstPublication, revision: '77777777-7777-4777-8777-777777777777' };
          return route.fulfill({ status: 409, json: { code: 'TEAM_SKILL_REVISION' } });
        }
        published = secondPublication;
        return route.fulfill({ json: { publication: published } });
      }
      return route.fulfill({ status: 404, json: {} });
    }

    const url = `${origin}/w/${workspaceId}`;
    let context = await browser.newContext({ viewport });
    async function newPage() {
      await context.route('**/*', intercept);
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      page.on('pageerror', (error) => errors.push(error.message));
      return page;
    }
    let page = await newPage();
    function locators() {
      const shelf = page.getByRole('dialog', { name: 'Private skills' });
      return {
        shelf,
        teamSelector: shelf.getByRole('combobox', { name: 'Team workspace' }),
        publish: shelf.getByRole('button', { name: 'Publish this version' }),
        sync: shelf.getByRole('button', { name: 'Sync this version' }),
      };
    }
    let { shelf, teamSelector, publish, sync } = locators();
    async function openShelf() {
      await page.goto(url);
      await page.getByRole('button', { name: 'Private skills', exact: true }).click();
    }
    async function review(teamId: string) {
      await shelf.getByRole('button', { name: /Evidence checklist/ }).click();
      await shelf.getByText(/Final reviewed instruction/).waitFor();
      await chooseTeam(teamId);
    }
    async function chooseTeam(teamId: string) {
      await shelf.getByRole('button', { name: 'Publish to team', exact: true }).click();
      await teamSelector.selectOption(teamId);
    }
    await openShelf();
    await review(teamA);
    await shelf.getByText('Reviewed skill version 1', { exact: true }).waitFor();
    await shelf.getByText(/Members of Research Team can review and import/).waitFor();
    assert.equal(writes.length, 0);
    assert.ok(
      await shelf.locator('.apps-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    await publish.click();
    await shelf.getByText(/publication result is unconfirmed/).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].expectedSourceRevision, original.revision);
    assert.equal(writes[0].expectedPublicationRevision, null);
    const persisted = await context.storageState();
    const markers = persisted.origins
      .find((entry) => entry.origin === origin)
      ?.localStorage.filter((entry) =>
        entry.name.startsWith('openbot-private-skill-publication-v1:'),
      );
    assert.equal(markers?.length, 1);
    assert.ok(markers?.[0].name.endsWith(writes[0].requestId));
    assert.doesNotMatch(
      markers?.[0].value || '',
      /Private source|Final reviewed instruction|Research Team/,
    );
    await context.close();
    context = await browser.newContext({ viewport, storageState: persisted });
    page = await newPage();
    ({ shelf, teamSelector, publish, sync } = locators());
    await openShelf();
    await shelf.getByRole('button', { name: 'Check publication status' }).click();
    await shelf.getByText('The team accepted this skill version.', { exact: true }).waitFor();
    assert.equal(writes.length, 1);
    await review(teamA);
    await shelf.getByText(/already published to this team/).waitFor();

    live = revised;
    await shelf.getByRole('button', { name: 'Refresh skills' }).click();
    await review(teamA);
    await shelf.getByText('Reviewed skill version 2', { exact: true }).waitFor();
    await shelf.getByText('Published team version 1', { exact: true }).waitFor();
    await sync.click();
    await shelf.getByText(/team’s publication changed/).waitFor();
    assert.equal(writes[1].expectedPublicationRevision, firstPublication.revision);
    await chooseTeam(teamA);
    await sync.click();
    await shelf.getByText('Published team version 2', { exact: true }).waitFor();
    assert.equal(writes[2].expectedSourceRevision, revised.revision);
    assert.notEqual(writes[2].expectedPublicationRevision, firstPublication.revision);

    await teamSelector.selectOption(teamB);
    await publish.click();
    await shelf.getByRole('button', { name: 'Check publication status' }).click();
    await shelf.getByText(/no receipt for this request yet/).waitFor();
    await shelf.getByRole('button', { name: 'Retry original publication' }).click();
    await shelf.getByText(/publication result is unconfirmed/).waitFor();
    assert.deepEqual(writes[4], writes[3]);
    await shelf.getByRole('button', { name: 'Cancel original publication' }).click();
    await shelf
      .getByText('The original publication request was cancelled.', { exact: true })
      .waitFor();
    assert.deepEqual(closed, [writes[3].requestId]);
    assert.equal(writes.length, 5);
    assert.deepEqual(errors, []);
  },
);
