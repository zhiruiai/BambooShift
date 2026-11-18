import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

test(
  'only explicit local permission refresh restores a native surface without repeating a grant',
  { timeout: 60_000 },
  async (t) => {
    const origin = 'https://computer-permissions.example.test';
    const workspace = '11111111-1111-4111-8111-111111111111';
    const base = `/api/workspaces/${workspace}/computer`;
    const bundle = await build({
      stdin: {
        contents: `
        import { useEffect, useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ComputerSurface } from './web/src/components/ComputerSurface';
        import { createComputerLifecycleActions } from './web/src/components/computer/createComputerLifecycleActions';
        import { createComputerScope } from './web/src/computerScope';
        import { initializeLanguage } from './web/src/i18n';
        initializeLanguage().setLanguage('zh-CN');
        const scope = createComputerScope({ workspaceId:'${workspace}', userId:'fixture-user', agentId:'fixture-bot' });
        function Fixture() {
          const [machine, setMachine] = useState({mode:'local',surface:'browser'});
          const [error, setControlError] = useState('');
          const [permissionBusy, setPermissionBusy] = useState(false);
          const [inputBusy, setInputBusy] = useState(false);
          const mounted = useRef(true), controlTransition = useRef(false), statusSequence = useRef(0);
          const computerStatusSequence = useRef(0);
          const observationRequests = useRef(new Map());
          const actions = createComputerLifecycleActions(() => ({
            scope, machine, canManage:true, busy:false, inputBusy, preparing:false,
            current:scope.current, setPermissionBusy, setInputBusy, setControlError, setMachine,
            controlTransition, statusSequence, computerStatusSequence, mounted, observationRequests, agentId:'fixture-bot',
            observe:async (_, work) => work(), setInventory:() => {}, applyScreen:() => {},
          } as any));
          useEffect(() => { void actions.checkComputer(); }, []);
          return <main>
            <ComputerSurface computer={machine as any} busy={inputBusy} checking={permissionBusy}
              onCheck={() => void actions.refreshPermissions()} onSelect={() => { throw Error('Unexpected surface selection'); }} />
            <button onClick={() => void actions.checkComputer()}>Read status</button>
            <button onClick={() => { statusSequence.current++; }}>Poll takeover</button>
            {error && <p role="alert">{error}</p>}
          </main>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
      logLevel: 'silent',
    });
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [],
      writes: { path: string; body: unknown }[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let surface = 'browser',
      revision = 'target-a',
      ready = false,
      remote = false,
      reads = 0;
    let refreshGate: Promise<void> | undefined;
    let refreshEntered = () => {};
    let healthGate: Promise<void> | undefined;
    let healthEntered = () => {};
    const state = () => ({
      connected: true,
      mode: remote ? 'remote' : 'local',
      surface,
      targetRevision: revision,
      capabilities: ['macos-accessibility-v1'],
      desktop: {
        accessibilityReady: ready,
        accessibilityAvailable: true,
        permissions: { accessibility: ready ? 'granted' : 'denied' },
      },
    });
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      assert.equal(url.origin, origin);
      if (request.isNavigationRequest())
        return route.fulfill({
          contentType: 'text/html',
          body: '<div id="root"></div><script src="/fixture.js"></script>',
        });
      if (url.pathname === '/fixture.js')
        return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
      assert.equal(request.headers()['x-openbot-expected-user'], 'fixture-user');
      if (request.method() === 'POST') {
        writes.push({ path: url.pathname, body: request.postDataJSON() });
        assert.equal(url.pathname, `${base}/permissions/refresh`);
        if (request.postDataJSON().expectedTargetRevision !== revision)
          return route.fulfill({ status: 409, json: { error: '工作电脑已切换，请刷新后再试。' } });
        refreshEntered();
        await refreshGate;
        if (ready) surface = 'accessibility';
        return route.fulfill({ json: state() });
      }
      reads++;
      if (url.pathname === `${base}/status`) {
        healthEntered();
        await healthGate;
      }
      if (url.pathname.endsWith('/status')) return route.fulfill({ json: state() });
      if (url.pathname === `${base}/bots`)
        return route.fulfill({ json: { bots: [], shared: true } });
      throw Error(`Unexpected request: ${url.pathname}`);
    });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Mac 应用', exact: true }).click();
    const refresh = page.getByRole('button', { name: '重新检查权限', exact: true });
    await refresh.waitFor();
    assert.deepEqual(writes, []);
    ready = true;
    const previousReads = reads;
    let releaseHealth = () => {};
    healthGate = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const enteredHealth = new Promise<void>((resolve) => {
      healthEntered = resolve;
    });
    await page.getByRole('button', { name: 'Read status' }).click();
    await enteredHealth;
    await page.getByRole('button', { name: 'Poll takeover' }).click();
    releaseHealth();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('button')).some(
        (button) => button.textContent?.includes('使用 Mac 应用') && !button.disabled,
      ),
    );
    assert.equal(
      await refresh.isEnabled(),
      true,
      'routine takeover polling cannot discard computer readiness or leave checking stuck',
    );
    assert.ok(reads > previousReads);
    assert.equal(surface, 'browser', 'read polling cannot switch the current surface');
    assert.deepEqual(writes, []);
    revision = 'target-b';
    await refresh.click();
    await page.getByRole('alert').waitFor();
    assert.equal(surface, 'browser', 'a stale target is not replayed automatically');
    assert.equal(writes.length, 1);
    let releaseRefresh = () => {};
    refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const enteredRefresh = new Promise<void>((resolve) => {
      refreshEntered = resolve;
    });
    await refresh.click();
    await enteredRefresh;
    const readsDuringRefresh = reads;
    await page.getByRole('button', { name: 'Read status' }).click();
    assert.equal(
      reads,
      readsDuringRefresh,
      'background polling pauses while permissions are restored',
    );
    releaseRefresh();
    await page.locator('.surface-heading small').filter({ hasText: '当前：Mac 应用' }).waitFor();
    assert.equal(surface, 'accessibility');
    assert.deepEqual(writes, [
      { path: `${base}/permissions/refresh`, body: { expectedTargetRevision: 'target-a' } },
      { path: `${base}/permissions/refresh`, body: { expectedTargetRevision: 'target-b' } },
    ]);
    remote = true;
    surface = 'browser';
    await page.reload();
    await page.getByRole('button', { name: 'Mac 应用', exact: true }).click();
    await refresh.click();
    assert.equal(writes.length, 2, 'a remote permission refresh is read-only');
    assert.deepEqual(errors, []);
  },
);
