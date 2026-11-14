import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright-core';
import { skillWorkflowTemplates } from '../skillWorkflowTemplates';

const origin = 'https://bot-capabilities.example.test';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const modelA = '33333333-3333-4333-8333-333333333333';
const modelB = '44444444-4444-4444-8444-444444444444';
const modelC = '55555555-5555-4555-8555-555555555555';
const base = `/api/workspaces/${workspaceId}`;
const home = `${origin}/w/${workspaceId}`;
const recipe = skillWorkflowTemplates.en.find(({ id }) => id === 'frontend-design')!;

async function assertLayout(page: Page) {
  const metrics = await page.getByRole('dialog').evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    const scroll = [...dialog.querySelectorAll('*')].filter((node) => {
      const element = node as HTMLElement;
      return (
        /auto|scroll/.test(getComputedStyle(element).overflowY) &&
        element.scrollHeight > element.clientHeight + 2
      );
    });
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      overflow: dialog.scrollWidth > dialog.clientWidth + 1,
      scroll: scroll.map((node) => node.className),
    };
  });
  assert.ok(metrics.left >= 0 && metrics.right <= metrics.viewportWidth + 1);
  assert.ok(metrics.bottom <= metrics.viewportHeight + 1);
  assert.equal(metrics.overflow, false);
  assert.ok(metrics.scroll.length <= 1, JSON.stringify(metrics));
}

test(
  'each Bot chooses a model and reviewed skills across desktop and narrow layouts',
  {
    skip: process.env.OPENBOT_BROWSER_TEST !== '1',
    timeout: 80_000,
  },
  async (t) => {
    const bundle = await build({
      entryPoints: ['web/src/browserTests/botCapabilitiesFixture.tsx'],
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
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(6000);
    const errors: string[] = [];
    const writes: { path: string; body: Record<string, unknown> }[] = [];
    let skill: Record<string, unknown> | undefined;
    let modelRequests = 0;
    let failModels = false;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      assert.equal(url.origin, origin, 'fixtures never contact external services');
      if (request.isNavigationRequest())
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      assert.equal(request.headers()['x-openbot-expected-user'], userId);
      if (url.pathname === `${base}/model-profiles`) {
        modelRequests++;
        if (failModels)
          return route.fulfill({
            status: 503,
            json: { error: 'Synthetic model list unavailable' },
          });
        return route.fulfill({
          json: {
            activeProfileId: modelA,
            profiles: [
              {
                id: modelA,
                name: 'Everyday',
                provider: 'synthetic-one',
                model: 'compact',
                configured: true,
              },
              {
                id: modelB,
                name: 'Design reasoning',
                provider: 'synthetic-two',
                model: 'reasoner',
                configured: true,
              },
              {
                id: modelC,
                name: 'Unconfigured',
                provider: 'synthetic-three',
                model: 'offline',
                configured: false,
              },
            ],
          },
        });
      }
      const body = request.postDataJSON();
      writes.push({ path: url.pathname, body });
      if (url.pathname === `${base}/agents/bot-a`) {
        assert.equal(request.method(), 'PATCH');
        return route.fulfill({
          json: {
            ...body,
            id: 'bot-a',
            status: 'idle',
            configRevision: `revision-${writes.length}`,
          },
        });
      }
      assert.equal(request.method(), 'POST');
      if (url.pathname === `${base}/skills`) {
        skill = {
          ...body,
          id: 'skill-a',
          version: 1,
          status: 'proposed',
          createdAt: '2030-01-01T00:00:00Z',
        };
      } else {
        assert.match(url.pathname, /\/skills\/skill-a\/(approve|disable|restore)$/);
        skill = { ...skill, status: url.pathname.endsWith('/disable') ? 'disabled' : 'active' };
      }
      return route.fulfill({ json: skill });
    });

    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 500 ? 640 : 900 });
      await page.goto(home);
      const select = page.getByRole('combobox', { name: 'Model for this Bot' });
      await select.locator(`option[value="${modelB}"]`).waitFor({ state: 'attached' });
      assert.equal(await select.inputValue(), modelA);
      assert.equal(
        await select
          .locator(`option[value="${modelC}"]`)
          .evaluate((option) => (option as HTMLOptionElement).disabled),
        true,
      );
      await select.scrollIntoViewIfNeeded();
      await assertLayout(page);
      await page.getByRole('button', { name: 'Choose and manage skills' }).scrollIntoViewIfNeeded();
      await assertLayout(page);
      if (process.env.BAMBOOSHIFT_CAPTURE_UI === '1' && [1440, 320].includes(width))
        await page.screenshot({ path: `.local/bot-capabilities-${width}.png` });
      assert.equal(writes.length, 0);
    }
    const select = page.getByRole('combobox', { name: 'Model for this Bot' });
    await select.selectOption(modelB);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLButtonElement>('button.primary-button')?.disabled,
    );
    assert.equal(writes[0].body.modelProfileId, modelB);
    assert.equal(writes[0].body.expectedRevision, 'revision-a');
    assert.equal('apiKey' in writes[0].body, false);
    await select.selectOption('');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLButtonElement>('button.primary-button')?.disabled,
    );
    assert.equal(writes[1].body.modelProfileId, null);

    await page.getByRole('button', { name: 'Choose and manage skills' }).click();
    await page.getByRole('button', { name: 'Choose from skill library' }).click();
    await page.getByRole('searchbox', { name: 'Search packaged skills' }).fill(recipe.id);
    await page.getByRole('button', { name: `Preview instructions for ${recipe.name}` }).click();
    assert.equal(await page.getByRole('combobox', { name: 'Choose a Bot' }).inputValue(), 'bot-a');
    await assertLayout(page);
    await page.getByRole('button', { name: 'Edit skill draft' }).click();
    assert.equal(await page.getByRole('combobox', { name: 'Assigned Bot' }).inputValue(), 'bot-a');
    assert.equal(writes.length, 2, 'preview and selection do not activate a skill');
    await page.getByRole('button', { name: 'Save skill draft' }).click();
    await page.getByRole('button', { name: 'View and confirm' }).click();
    await page.getByRole('button', { name: 'Confirm and enable' }).click();
    await page.getByRole('region', { name: 'Confirm skill version' }).waitFor({ state: 'hidden' });
    assert.equal(writes[2].body.agentId, 'bot-a');
    assert.equal(writes[2].body.content, recipe.content);
    assert.deepEqual(writes[3], {
      path: `${base}/skills/skill-a/approve`,
      body: { expectedActiveId: null },
    });
    await page.getByRole('button', { name: /^In use/ }).click();
    await page.getByRole('button', { name: 'Manage current version' }).click();
    await page.getByRole('button', { name: 'Disable this skill', exact: true }).click();
    await page.getByRole('region', { name: 'Confirm skill version' }).waitFor({ state: 'hidden' });
    assert.deepEqual(writes[4], {
      path: `${base}/skills/skill-a/disable`,
      body: { expectedActiveId: 'skill-a' },
    });
    await page.getByRole('button', { name: /^Version history/ }).click();
    await page.locator('.approve-skill').click();
    await page.getByRole('button', { name: 'Restore this version', exact: true }).click();
    await page.getByRole('region', { name: 'Confirm skill version' }).waitFor({ state: 'hidden' });
    assert.deepEqual(writes[5], {
      path: `${base}/skills/skill-a/restore`,
      body: { expectedActiveId: null },
    });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const summary = page.getByRole('region', { name: 'Skills for this Bot' });
    await summary.getByText('1 enabled', { exact: true }).waitFor();
    await summary.getByText(recipe.name, { exact: true }).waitFor();

    await page.goto(`${home}?missing`);
    const missing = page.getByRole('combobox', { name: 'Model for this Bot' });
    await page.getByText('This model is no longer available.', { exact: false }).waitFor();
    assert.equal(await missing.inputValue(), '99999999-9999-4999-8999-999999999999');
    assert.equal(await missing.getAttribute('aria-invalid'), 'true');
    assert.equal(writes.length, 6);

    failModels = true;
    await page.goto(`${home}?zh`);
    await page.getByRole('alert').getByText('Synthetic model list unavailable').waitFor();
    assert.equal(
      await page.getByRole('combobox', { name: '此 Bot 使用的模型' }).isDisabled(),
      true,
    );
    failModels = false;
    await page.getByRole('button', { name: '刷新模型列表' }).click();
    await page.getByRole('combobox', { name: '此 Bot 使用的模型' }).selectOption(modelB);
    await assertLayout(page);
    const beforeReadOnly = modelRequests;
    await page.goto(`${home}?member`);
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'Model for this Bot' }).count(), 0);
    assert.equal(
      modelRequests,
      beforeReadOnly,
      'read-only Bot view does not fetch model management data',
    );
    assert.equal(writes.length, 6);
    assert.deepEqual(errors, []);
  },
);
