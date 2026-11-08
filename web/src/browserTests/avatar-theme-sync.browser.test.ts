import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { AvatarThemeSnapshot, SyncedAvatarTheme } from '../avatarThemeSync';

const origin = 'https://avatar-theme.example.test';
const workspaces = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const alpha = 'fixture-alpha',
  beta = 'fixture-beta';
const recipe = {
  name: 'Orbit studio',
  motif: 'elephants',
  colors: ['#443388', '#226655', '#ccaa55'],
  badge: 'moon',
  backdrop: 'halo',
} as const;
const artwork = (
  avatarTheme: SyncedAvatarTheme['avatarTheme'],
  customAvatarTheme = null as SyncedAvatarTheme['customAvatarTheme'],
  useCustomAvatarTheme = false,
) => ({ avatarTheme, customAvatarTheme, useCustomAvatarTheme });
const fixture = `
  import './web/src/styles.css';
  import './web/src/theme.css';
  import { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { initializeLanguage } from './web/src/i18n';
  import { WorkspaceAvatarThemeProvider } from './web/src/avatarAppearance';
  import { Avatar } from './web/src/components/Avatar';
  import { AppearanceSettings } from './web/src/components/AppearanceSettings';
  import { CreationDraftCard } from './web/src/components/CreationDraftCard';
  initializeLanguage().setLanguage(location.search === '?zh' ? 'zh-CN' : 'en');
  const workspaceId = location.pathname.split('/')[2];
  const message = { role: 'assistant', kind: 'creation_preview', status: 'done',
    metadata: { creationPreview: { kind: 'theme', theme: ${JSON.stringify(recipe)} } } };
  const agent = { id: 'fixture-agent', avatar: 'orb', color: '#56789a' };
  function Fixture() {
    const [userId, setUser] = useState('${alpha}');
    return <>
      <button onClick={() => setUser('${alpha}')}>Switch to alpha</button>
      <button onClick={() => setUser('${beta}')}>Switch to beta</button>
      <button onClick={() => setUser('')}>Sign out locally</button>
      <div id="device-avatar"><Avatar agent={agent} animate={false} /></div>
      {userId && <WorkspaceAvatarThemeProvider workspaceId={workspaceId} userId={userId}>
        <div id="workspace-avatar"><Avatar agent={agent} animate={false} /></div>
        <CreationDraftCard message={message} owner current={() => true} onProfile={() => {}} />
        <AppearanceSettings />
      </WorkspaceAvatarThemeProvider>}
    </>;
  }
  createRoot(document.getElementById('root')).render(<Fixture />);
`;

test(
  'avatar theme sync is explicit, keeps device settings and previews, reconciles, and fences identities',
  { timeout: 60_000 },
  async (t) => {
    const bundle = await build({
      stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true,
      write: false,
      outdir: 'fixture-dist',
      format: 'iife',
      jsx: 'automatic',
      platform: 'browser',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    });
    const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const executablePath = process.env.CHROME_EXECUTABLE;
    const browser = await chromium
      .launch({ headless: true, executablePath })
      .catch((error: Error) => {
        if (
          executablePath ||
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
    const page = await browser.newPage({ viewport: { width: 320, height: 580 } });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    const writes: Array<{ workspaceId: string; userId: string; payload: AvatarThemeSnapshot }> = [];
    const reads: string[] = [];
    const states = new Map<string, AvatarThemeSnapshot>([
      [`${workspaces[0]}:${beta}`, { theme: artwork('dinosaurs'), revision: 7 }],
      [`${workspaces[1]}:${alpha}`, { theme: artwork('elephants'), revision: 9 }],
    ]);
    const first = `${workspaces[0]}:${alpha}`;
    let dropWrite = false;
    let holdRead: Promise<void> | undefined;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      assert.equal(url.origin, origin);
      if (url.pathname.startsWith('/w/'))
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`,
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: js });
      const match = /^\/api\/workspaces\/([^/]+)\/avatar-theme$/.exec(url.pathname);
      if (!match) return route.abort();
      const workspaceId = match[1];
      const userId = request.headers()['x-openbot-expected-user'];
      assert.ok(workspaces.includes(workspaceId) && [alpha, beta].includes(userId));
      const key = `${workspaceId}:${userId}`;
      const state = states.get(key) || { theme: null, revision: 0 };
      if (request.method() === 'GET') {
        reads.push(key);
        if (holdRead && key === first) await holdRead;
        return route.fulfill({ json: state }).catch(() => {});
      }
      assert.equal(request.method(), 'PUT');
      const payload: AvatarThemeSnapshot = request.postDataJSON();
      writes.push({ workspaceId, userId, payload });
      if (payload.revision !== state.revision)
        return route.fulfill({ status: 409, json: { code: 'AVATAR_THEME_CONFLICT' } });
      const saved = { theme: payload.theme, revision: state.revision + 1 };
      states.set(key, saved);
      if (dropWrite) {
        dropWrite = false;
        return route.abort('failed');
      }
      return route.fulfill({ json: saved });
    });
    const goto = (workspaceId = workspaces[0], suffix = '') =>
      page.goto(`${origin}/w/${workspaceId}${suffix}`);
    const panel = page.getByRole('region', { name: 'Sync avatar theme' });
    const save = panel.getByRole('button', { name: 'Save theme to this workspace' });
    const check = panel.getByRole('button', { name: 'Check synced theme' });
    const pick = (name: string) =>
      page
        .getByRole('group', { name: 'Avatar theme' })
        .getByRole('button', { name: new RegExp(name) });
    const waitArt = (theme: string, selector = '#workspace-avatar') =>
      page.locator(`${selector} [data-avatar-theme="${theme}"]`).waitFor();
    const device = async () =>
      page.evaluate(() => JSON.parse(localStorage.getItem('openbot-appearance') || '{}'));
    await goto();
    await panel.getByText('Using this device’s theme.').waitFor();
    await pick('Pandas').click();
    await waitArt('pandas');
    assert.equal((await device()).avatarTheme, 'pandas');
    assert.equal(writes.length, 0);
    await save.click();
    await panel.getByText('Theme synced for this workspace.').waitFor();
    assert.deepEqual(writes[0].payload, { theme: artwork('pandas'), revision: 0 });
    assert.equal(await save.isDisabled(), true);

    await page.getByRole('button', { name: 'Preview in this workspace' }).click();
    await waitArt('elephants');
    await waitArt('pandas', '#device-avatar');
    assert.equal((await device()).customAvatarTheme, undefined);
    assert.equal(writes.length, 1);
    states.set(first, { theme: artwork('chicks'), revision: 2 });
    await save.click();
    await panel.getByText(/changed on another device/).waitFor();
    assert.equal(await save.isDisabled(), true);
    await check.click();
    await panel.getByText(/Previewing an unsaved theme/).waitFor();
    await waitArt('elephants');
    await save.click();
    await panel.getByText('Theme synced for this workspace.').waitFor();
    assert.deepEqual(
      writes.slice(1).map(({ payload }) => payload),
      [
        { theme: artwork('pandas', recipe, true), revision: 1 },
        { theme: artwork('pandas', recipe, true), revision: 2 },
      ],
    );
    await page.reload();
    await waitArt('elephants');
    await waitArt('pandas', '#device-avatar');
    assert.equal(writes.length, 3);

    await pick('Chicks').click();
    await panel.getByRole('button', { name: 'Restore synced theme' }).click();
    await waitArt('elephants');
    assert.equal(writes.length, 3);
    await pick('Chicks').click();
    dropWrite = true;
    await save.click();
    await panel.getByText(/save could not be confirmed/).waitFor();
    await check.click();
    await panel.getByText('Theme synced for this workspace.').waitFor();
    await waitArt('chicks');
    assert.deepEqual(writes[3].payload, { theme: artwork('chicks', recipe, false), revision: 3 });
    assert.equal(writes.length, 4);

    let release!: () => void;
    holdRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed = page.waitForRequest(
      (request) =>
        request.url().endsWith('/avatar-theme') &&
        request.headers()['x-openbot-expected-user'] === alpha,
    );
    await page.reload();
    await observed;
    await page.getByRole('button', { name: 'Switch to beta' }).click();
    await waitArt('dinosaurs');
    release();
    holdRead = undefined;
    await page.getByRole('button', { name: 'Sign out locally' }).click();
    assert.equal(await panel.count(), 0);
    await waitArt('pandas', '#device-avatar');
    assert.equal(writes.length, 4);
    await page.getByRole('button', { name: 'Switch to alpha' }).click();
    await waitArt('chicks');
    const useDevice = panel.getByRole('button', { name: 'Use device theme', exact: true });
    await useDevice.click();
    const confirmation = panel.getByRole('group', { name: 'Remove the synced theme?' });
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(writes.length, 4);
    await useDevice.click();
    await confirmation.getByRole('button', { name: 'Confirm and use device theme' }).click();
    await panel.getByText('Using this device’s theme.').waitFor();
    await waitArt('pandas');
    assert.deepEqual(writes[4], {
      workspaceId: workspaces[0],
      userId: alpha,
      payload: { theme: null, revision: 4 },
    });

    await goto(workspaces[1], '?zh');
    await waitArt('elephants');
    const zh = page.getByRole('region', { name: '同步头像主题' });
    await zh.getByText('主题已同步到此空间。').waitFor();
    assert.ok(await zh.evaluate((node) => node.scrollWidth <= node.clientWidth));
    assert.equal((await device()).avatarTheme, 'pandas');
    assert.equal((await device()).customAvatarTheme, undefined);
    assert.ok(
      reads.includes(`${workspaces[0]}:${beta}`) && reads.includes(`${workspaces[1]}:${alpha}`),
    );
    assert.equal(writes.length, 5);

    await page.getByRole('button', { name: 'Switch to beta' }).click();
    await zh.getByText('正在使用当前设备的主题。').waitFor();
    dropWrite = true;
    const zhSave = zh.getByRole('button', { name: '保存主题到此空间' });
    await zhSave.click();
    await zh.getByText('暂时无法确认保存结果，请先核对已同步主题。').waitFor();
    await page
      .getByRole('group', { name: '头像主题' })
      .getByRole('button', { name: /小鸡/ })
      .click();
    await waitArt('chicks');
    await waitArt('pandas', '#device-avatar');
    await zh.getByRole('button', { name: '核对已同步主题' }).click();
    await zh.getByText('正在此空间预览尚未保存的主题。').waitFor();
    await waitArt('chicks');
    await zhSave.click();
    await zh.getByText('主题已同步到此空间。').waitFor();
    assert.deepEqual(writes.slice(5), [
      {
        workspaceId: workspaces[1],
        userId: beta,
        payload: { theme: artwork('pandas'), revision: 0 },
      },
      {
        workspaceId: workspaces[1],
        userId: beta,
        payload: { theme: artwork('chicks'), revision: 1 },
      },
    ]);
    assert.deepEqual(errors, []);
  },
);
