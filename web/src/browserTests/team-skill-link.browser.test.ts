import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { teamSkillLinkPath, type TeamSkillPublication } from '../../../shared/team-skills';

const teamId = '11111111-1111-4111-8111-111111111111';
const publicationId = '22222222-2222-4222-8222-222222222222';
const linkId = '33333333-3333-4333-8333-333333333333';
const path = teamSkillLinkPath(teamId, publicationId, linkId)!;
const endpoint = `/api/workspaces/${teamId}/team-skills/${publicationId}/link/${linkId}`;
const origin = 'http://127.0.0.1:31338';
const member = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Fixture member',
  email: 'member@example.test',
  status: 'active',
  createdAt: '2026-11-08T00:00:00Z',
};
const team = {
  id: teamId,
  name: 'Research Team',
  kind: 'team',
  role: 'member',
  status: 'active',
  createdAt: member.createdAt,
};
const item: TeamSkillPublication = {
  id: publicationId,
  linkId,
  revision: '55555555-5555-4555-8555-555555555555',
  version: 1,
  name: 'Evidence review',
  description: 'Published team instructions.',
  content:
    '# Review the evidence\n\n[Example](https://outside.example/click)\n\n![Diagram](https://outside.example/image.png)',
  source: { origin: 'personal', version: 2 },
  updatedAt: member.createdAt,
};

test(
  'team skill link copies on a gesture and opens an identity-scoped read-only view',
  {
    skip: process.env.OPENBOT_BROWSER_TEST !== '1',
    timeout: 55_000,
  },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `
        import { createRoot } from 'react-dom/client';
        import { initializeLanguage } from './web/src/i18n';
        import PlatformRoot from './web/src/PlatformRoot';
        import { TeamSkillCopyLink } from './web/src/components/TeamSkillCopyLink';
        import './web/src/styles.css';
        import './web/src/theme.css';
        initializeLanguage().setLanguage('en');
        createRoot(document.getElementById('root')).render(location.pathname === '/fixture-copy' ?
          <TeamSkillCopyLink teamId="${teamId}" publicationId="${publicationId}" linkId="${linkId}" /> : <PlatformRoot />);
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
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          async writeText(value: string) {
            const html = document.documentElement;
            if (!navigator.userActivation.isActive || html.dataset.clipboardMode === 'deny')
              throw new Error('clipboard denied');
            html.dataset.copied = value;
          },
        },
      });
    });
    let session: 'signed-out' | 'member' | 'outsider' = 'signed-out';
    let publication: TeamSkillPublication | undefined = item;
    let detailReads = 0;
    const outside: string[] = [];
    const unexpected: string[] = [];
    const account = () => ({
      authenticated: session !== 'signed-out',
      user: session === 'signed-out' ? undefined : member,
      workspaces: session === 'member' ? [team] : [],
    });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        outside.push(url.href);
        return route.abort();
      }
      if (request.isNavigationRequest())
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.pathname === '/fixture.css')
        return route.fulfill({ contentType: 'text/css', body: css });
      if (url.pathname === '/api/account/session' && request.method() === 'GET')
        return route.fulfill({ json: account() });
      if (url.pathname === '/api/account/login' && request.method() === 'POST') {
        session = 'member';
        return route.fulfill({ json: { ...account(), workspaceId: teamId } });
      }
      if (url.pathname === endpoint && request.method() === 'GET') {
        assert.equal(request.headers()['x-openbot-expected-user'], member.id);
        assert.equal(session, 'member');
        detailReads++;
        return publication
          ? route.fulfill({ json: publication })
          : route.fulfill({ status: 404, json: { error: 'private service detail' } });
      }
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404 });
    });

    await page.goto(`${origin}/fixture-copy`);
    const copy = page.getByRole('button', { name: 'Copy link' });
    await copy.click();
    await page.getByRole('status').filter({ hasText: 'Link copied' }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-copied'), `${origin}${path}`);
    await page.evaluate(() => {
      document.documentElement.dataset.clipboardMode = 'deny';
    });
    await copy.click();
    const fallback = page.getByLabel('Select and copy this team link.');
    assert.equal(await fallback.inputValue(), `${origin}${path}`);
    assert.equal(
      await fallback.evaluate((input: HTMLInputElement) => input.selectionEnd),
      `${origin}${path}`.length,
    );

    await page.goto(`${origin}${path}`);
    await page.waitForURL(`${origin}/login?next=${encodeURIComponent(path)}`);
    assert.equal(detailReads, 0);
    await page.locator('input[type=email]').fill(member.email);
    await page.locator('input[type=password]').fill('fixture-password-12');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(`${origin}${path}`);
    const skill = page.getByRole('heading', { name: 'Evidence review' });
    await skill.waitFor();
    await page.getByText('Research Team · Version 1').waitFor();
    await page.getByText('From a private skill library').waitFor();
    assert.equal(
      await page.getByRole('link', { name: 'Open team workspace' }).getAttribute('href'),
      `/w/${teamId}`,
    );
    assert.equal(await page.getByRole('link', { name: 'Example' }).count(), 0);
    assert.equal(await page.locator('article img').count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    publication = { ...item, version: 2 };
    await page.evaluate(() => window.dispatchEvent(new Event('openbot:revalidate')));
    await page.getByText('Research Team · Version 2').waitFor();
    publication = { ...item, linkId: '66666666-6666-4666-8666-666666666666' };
    await page.evaluate(() => window.dispatchEvent(new Event('openbot:revalidate')));
    const unavailable = page.getByText(/This skill link is unavailable/);
    await unavailable.waitFor();
    assert.equal(await skill.count(), 0);
    publication = item;
    await page.evaluate(() => window.dispatchEvent(new Event('openbot:revalidate')));
    await skill.waitFor();

    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
    );
    await skill.waitFor({ state: 'detached' });
    session = 'outsider';
    const before = detailReads;
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
    );
    await unavailable.waitFor();
    assert.equal(detailReads, before);

    session = 'member';
    publication = undefined;
    await page.goto(`${origin}${path}`);
    await unavailable.waitFor();
    assert.equal(await page.getByText('private service detail').count(), 0);
    const readsAfterWithdrawal = detailReads;
    await page.goto(`${origin}${path}?next=/admin`);
    await unavailable.waitFor();
    assert.equal(detailReads, readsAfterWithdrawal);
    assert.deepEqual(outside, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(pageErrors, []);
  },
);
