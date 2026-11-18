import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { launchBackend } from '../../scripts/backend-launch.mjs';

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
type Scenario = { name: string; url: string; selector: string; session?: Session };

async function register(browser: Browser, origin: string, endpoint: string, data: object) {
  const context = await browser.newContext();
  try {
    const response = await context.request.post(origin + endpoint, { data });
    assert.ok(response.ok(), `${endpoint} returned ${response.status()}`);
    return { body: await response.json(), session: await context.storageState() };
  } finally {
    await context.close();
  }
}

async function coldLoad(browser: Browser, scenario: Scenario) {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: 'zh-CN',
    serviceWorkers: 'block',
    storageState: scenario.session,
  });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const assets = new Map<string, { path: string; start: number; bytes?: number }>();
    const documents: number[] = [];
    const origin = new URL(scenario.url).origin;
    cdp.on('Network.requestWillBeSent', ({ requestId, type, request, wallTime }) => {
      const url = new URL(request.url);
      if (url.origin !== origin) return;
      if (type === 'Document') documents.push(wallTime * 1000);
      if (/\.(js|css)$/.test(url.pathname))
        assets.set(requestId, { path: url.pathname, start: wallTime * 1000 });
    });
    cdp.on('Network.responseReceived', ({ requestId, response }) => {
      const asset = assets.get(requestId);
      if (asset) {
        if (response.status !== 200) errors.push('HTTP ' + response.status + ' for ' + asset.path);
        const size = Object.entries(response.headers).find(
          ([key]) => key.toLowerCase() === 'content-length',
        );
        if (size) asset.bytes = Number(size[1]);
      }
    });
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 80,
      downloadThroughput: 1_000_000,
      uploadThroughput: 250_000,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 });
    await page.goto(scenario.url, { waitUntil: 'commit' });
    await page
      .waitForFunction((selector) => {
        const target = document.querySelector<HTMLElement>(selector);
        if (
          !target?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
          !target.getClientRects().length ||
          target.matches(':disabled')
        )
          return false;
        performance.mark('first-action-ready');
        return true;
      }, scenario.selector)
      .catch((cause: unknown) => {
        throw new Error(`${scenario.name} did not become ready. ${errors.join(', ')}`, { cause });
      });
    await page.waitForLoadState('load');
    const ready = await page.evaluate(
      () =>
        performance.timeOrigin + performance.getEntriesByName('first-action-ready')[0].startTime,
    );
    const requested = [...assets.values()].filter((a) => a.start <= ready);
    assert.ok(
      documents.length && requested.every((a) => Number.isFinite(a.bytes)),
      'Missing static asset response sizes',
    );
    const sum = (extension: string) =>
      requested.filter((a) => a.path.endsWith(extension)).reduce((n, a) => n + a.bytes!, 0);
    const sample = {
      readyMs: Math.round(ready - documents[0]),
      jsBytes: sum('.js'),
      cssBytes: sum('.css'),
      documents: documents.length,
      assets: requested.map((a) => a.path),
    };
    assert.deepEqual(errors, []);
    assert.ok(sample.jsBytes > 0 && sample.cssBytes > 0);
    return sample;
  } finally {
    await context.close();
  }
}

async function fixture(browser: Browser, assets: string) {
  for (const site of ['dist', 'operations-dist']) await access(join(assets, site, 'index.html'));
  const temporary = await mkdtemp(join(tmpdir(), 'bambooshift-first-load-'));
  const config = join(temporary, 'server.private.json');
  const dataDir = join(temporary, 'data');
  let child: ReturnType<typeof launchBackend> | undefined;
  let closed: Promise<unknown> | undefined;
  const close = async () => {
    try {
      child?.kill('SIGTERM');
      await closed;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
  try {
    await writeFile(
      config,
      JSON.stringify({
        dataDir,
        runtimeDir: assets,
        nodeBinary: process.execPath,
        bind: '127.0.0.1:0',
        operations: { bind: '127.0.0.1:0' },
      }),
      { mode: 0o600 },
    );
    child = launchBackend(['--config', config, '--init-operator'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    closed = once(child, 'close');
    const lines = createInterface({ input: child.stdout! });
    const ready = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(30_000) }).then(([line]) =>
        JSON.parse(line),
      ),
      closed.then(() => {
        throw Error('Rust server closed before it was ready');
      }),
    ]).finally(() => lines.close());
    if (
      ready.backend !== 'rust' ||
      ![ready.address, ready.operationsAddress].every((v) => /^127\.0\.0\.1:\d+$/.test(v))
    ) {
      throw Error('Expected two loopback listeners');
    }
    const product = 'http://' + ready.address;
    const operations = 'http://' + ready.operationsAddress;
    const credentials = {
      name: 'Benchmark',
      email: 'benchmark@example.test',
      password: randomBytes(20).toString('hex'),
    };
    const account = await register(browser, product, '/api/account/register', {
      ...credentials,
      kind: 'personal',
    });
    const owner = await browser.newContext({ storageState: account.session });
    try {
      const workspace = product + '/api/workspaces/' + account.body.workspaceId;
      const response = await owner.request.get(workspace + '/bootstrap');
      assert.ok(response.ok(), 'Workspace bootstrap failed');
      const setup = await response.json();
      const selected = await owner.request.put(workspace + '/primary-bot', {
        headers: { 'X-OpenBot-Expected-User': account.body.user.id },
        data: {
          mode: 'select',
          expectedRevision: setup.primaryBot.revision,
          agentId: setup.agents[0].id,
          checkIn: { ...setup.primaryBot.checkIn, enabled: false },
        },
      });
      assert.ok(selected.ok(), 'Could not select the synthetic workspace Bot');
    } finally {
      await owner.close();
    }
    const operator = await register(browser, operations, '/api/platform/setup', {
      ...credentials,
      email: 'operator@example.test',
      code: (await readFile(join(dataDir, 'platform/operator-setup-code'), 'utf8')).trim(),
    });
    const scenarios: Scenario[] = [
      { name: 'product-login', url: product + '/login', selector: 'form input[type=password]' },
      { name: 'product-home-anonymous', url: product + '/', selector: 'form input[type=password]' },
      {
        name: 'workspace-chooser',
        url: product + '/',
        selector: '.account-space-list a',
        session: account.session,
      },
      {
        name: 'workspace-chat',
        url: product + '/w/' + account.body.workspaceId,
        selector: 'textarea[role=combobox]',
        session: account.session,
      },
      {
        name: 'operator-login',
        url: operations + '/admin/login',
        selector: 'form input[type=password]',
      },
      {
        name: 'operator-home-anonymous',
        url: operations + '/admin',
        selector: 'form input[type=password]',
      },
      {
        name: 'operator-overview',
        url: operations + '/admin',
        selector: '.admin-stat strong',
        session: operator.session,
      },
    ];
    return { scenarios, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const roots = process.argv.slice(2).map((argument) => resolve(argument));
const rounds = Number(process.env.FIRST_LOAD_ROUNDS || 5);
if (!roots.length || !Number.isInteger(rounds) || rounds < 1)
  throw Error('Supply built runtime directories and a positive round count.');
const browser = await chromium.launch({
  channel: 'chrome',
  executablePath: process.env.CHROME_EXECUTABLE || undefined,
  headless: true,
});
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
try {
  for (const root of roots) fixtures.push(await fixture(browser, root));
  const results = fixtures.map(() => new Map<string, Awaited<ReturnType<typeof coldLoad>>[]>());
  for (let round = 0; round < rounds; round++) {
    for (let route = 0; route < fixtures[0].scenarios.length; route++) {
      for (let offset = 0; offset < fixtures.length; offset++) {
        const index = (offset + round + route) % fixtures.length;
        const scenario = fixtures[index].scenarios[route];
        const sample = await coldLoad(browser, scenario);
        const samples = results[index].get(scenario.name) || [];
        samples.push(sample);
        results[index].set(scenario.name, samples);
        console.error(round + 1, index, scenario.name, sample.jsBytes, sample.readyMs);
      }
    }
  }
  console.log(
    JSON.stringify(
      { chromium: browser.version(), rounds, results: results.map((s) => Object.fromEntries(s)) },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(fixtures.map((f) => f.close()));
  await browser.close();
}
