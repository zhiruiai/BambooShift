import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { build as viteBuild, type Plugin } from 'vite';
import { frontendConfig } from '../../scripts/vite.shared';
import { all, compile, deferred, harness, json, render } from './testSupport/botProfilesFixture';

const account = {
  id: 'operator-a',
  name: 'Operator A',
  email: 'operator@example.test',
  status: 'active',
  createdAt: '2026-11-05',
};
const browser = (pathname = '/admin/login') =>
  Object.assign(new EventTarget(), {
    location: { pathname, hash: '', search: '', assign() {}, replace() {} },
  });

function proxy(config: ReturnType<typeof frontendConfig>, path: string) {
  return Object.entries(config.server?.proxy || {}).find(([prefix]) =>
    prefix.startsWith('^') ? new RegExp(prefix).test(path) : path.startsWith(prefix),
  )?.[1];
}

test('the two Vite sites use separate ports and operator proxy routes never reach product APIs', () => {
  const product = frontendConfig('product', {});
  const operations = frontendConfig('operations', {});
  assert.equal(product.server?.port, 5173);
  assert.equal(operations.server?.port, 5174);
  assert.equal(operations.build?.outDir, resolve('operations-dist'));
  assert.equal(operations.publicDir, false);
  for (const config of [product, operations]) {
    for (const privatePath of ['**/.local/**', '**/data/**', '**/config/private/**'])
      assert.ok(config.server?.fs?.deny?.includes(privatePath), privatePath);
    assert.ok((config.server?.watch?.ignored as string[]).includes('**/.local/**'));
  }
  for (const path of ['/api/platform/session', '/api/platform/users?q=one', '/api/health'])
    assert.equal(proxy(operations, path), 'http://127.0.0.1:3002');
  for (const path of [
    '/api/account/session',
    '/api/workspaces/x/bootstrap',
    '/api/platform-other',
    '/api/health/extra',
    '/api/health-extra',
  ])
    assert.equal(proxy(operations, path), undefined, path);
  for (const path of ['/admin', '/admin/login', '/admin/setup', '/admin?view=users'])
    assert.equal(proxy(product, path), 'http://127.0.0.1:3001');
  assert.equal(proxy(product, '/administrator'), undefined);
  assert.equal(
    proxy(frontendConfig('operations', { PORT: '3012' }), '/api/health'),
    'http://127.0.0.1:3012',
  );
  assert.equal(
    proxy(
      frontendConfig('operations', { PORT: '3001', OPENBOT_OPERATIONS_API_PORT: '3013' }),
      '/api/health',
    ),
    'http://127.0.0.1:3013',
  );
  assert.throws(() =>
    frontendConfig('operations', { OPENBOT_OPERATIONS_API_PORT: '3002/redirect' }),
  );
});

test('actual independent Vite builds contain only their own page modules and emit an operations index at the root', async () => {
  const graphs = new Map<string, string[]>();
  for (const mode of ['product', 'operations'] as const) {
    const modules: string[] = [];
    const audit: Plugin = {
      name: 'test-application-boundary',
      generateBundle() {
        modules.push(...this.getModuleIds());
      },
    };
    const config = frontendConfig(mode, {});
    const result = await viteBuild({
      ...config,
      configFile: false,
      logLevel: 'silent',
      plugins: [...(config.plugins || []), audit],
      build: { ...config.build, write: false },
    });
    assert.ok(!('on' in result));
    const outputs = Array.isArray(result) ? result.flatMap((part) => part.output) : result.output;
    const html = outputs.find((output) => output.fileName === 'index.html');
    assert.ok(html && html.type === 'asset');
    assert.match(String(html.source), new RegExp(`name="openbot-application" content="${mode}"`));
    assert.match(String(html.source), /src="\/assets\//);
    assert.ok(!outputs.some((output) => output.fileName === 'operations/index.html'));
    graphs.set(
      mode,
      modules.map((id) => id.replaceAll('\\', '/')),
    );
  }
  const product = graphs.get('product')!;
  const operations = graphs.get('operations')!;
  assert.ok(product.some((id) => id.endsWith('/web/src/PlatformRoot.tsx')));
  assert.ok(operations.some((id) => id.endsWith('/operations/src/OperationsRoot.tsx')));
  assert.ok(operations.some((id) => id.endsWith('/operations/src/PlatformAdminApp.tsx')));
  assert.ok(operations.some((id) => id.endsWith('/operations/src/OperatorLoginPage.tsx')));
  for (const id of product) assert.doesNotMatch(id, /\/operations\/src\//);
  for (const id of operations)
    assert.doesNotMatch(
      id,
      /\/web\/src\/(PlatformRoot\.tsx|App\.tsx|workspace\/|admin\/.*\.tsx|platform\/(AccountPages\.tsx|AccountAccess\.tsx|AccountSettingsPage\.tsx|TeamPage\.tsx|team\/|account\/TeamCreateDialog\.tsx))/,
    );
});

test('operator login and product registration render separate real forms and navigation in both languages', async () => {
  for (const locale of ['zh-CN', 'en']) {
    const window = browser();
    const globals = {
      window: Object.assign(window, {
        localStorage: { getItem: () => JSON.stringify({ version: 1, locale }) },
      }),
      document: { documentElement: { lang: locale, dataset: {}, style: {} } },
      Event,
      URLSearchParams,
    };
    const calls: string[] = [];
    const operator = await harness(
      'web/src/testSupport/operationsComponents.tsx',
      'OperatorLogin',
      {},
      (async (path) => {
        calls.push(String(path));
        return json({ authenticated: false, setupRequired: false });
      }) as typeof fetch,
      globals,
    );
    await operator.flush();
    assert.deepEqual(calls, ['/api/platform/session']);
    assert.ok(operator.form());
    const html = render(() => operator.tree, {});
    assert.doesNotMatch(html, /href="\/(?:login|register|account|w\/)/);
    assert.match(html, locale === 'en' ? /For platform operators only/ : /仅供平台运营人员使用/);
    operator.dispose();
    const product = await harness(
      'web/src/testSupport/operationsComponents.tsx',
      'ProductAccount',
      { mode: 'register' },
      (async (path) => {
        assert.equal(path, '/api/account/session');
        return json({ authenticated: false, workspaces: [] });
      }) as typeof fetch,
      {
        ...globals,
        window: Object.assign(browser('/register'), { localStorage: globals.window.localStorage }),
      },
    );
    await product.flush();
    const signup = render(() => product.tree, {});
    assert.match(signup, /href="\/login"/);
    assert.doesNotMatch(signup, /href="\/admin/);
    product.dispose();
  }
});

test('operator root uses the isolated session gate at slash and never renders a product account page', async () => {
  for (const path of ['/', '/admin', '/admin/login', '/admin/setup']) {
    const api = await compile('operations/src/OperationsRoot.tsx', '', {
      window: browser(path),
      document: { documentElement: { lang: '', dataset: {}, style: {} } },
    });
    const html = render(api.default, {});
    assert.match(html, /href="\/admin\/login"/);
    assert.doesNotMatch(html, /href="\/(?:login|register|account)"/);
    assert.match(html, /operations-language-toolbar/);
  }
});

test('operator scope fixes the original account, rejects stale requests and drops late responses', async () => {
  const pending = deferred<Response>();
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = await compile('operations/src/workspace/operatorScope.ts', '', {
    fetch: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return calls.length === 1 ? pending.promise : json({ ok: true });
    },
  });
  const first = api.createOperatorScope('operator-a');
  const response = first.request('/platform/users/user-a', 'PATCH', { status: 'suspended' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/platform/users/user-a');
  assert.equal(new Headers(calls[0].init?.headers).get('X-OpenBot-Expected-User'), 'operator-a');
  first.suspend();
  pending.resolve(json({ ok: true }));
  await assert.rejects(response, { name: 'AbortError' });
  await assert.rejects(first.request('/platform/logout', 'POST'), { name: 'AbortError' });
  assert.equal(calls.length, 1);
  first.activate();
  await first.request('/platform/users');
  assert.equal(new Headers(calls[1].init?.headers).get('X-OpenBot-Expected-User'), 'operator-a');
  await assert.rejects(first.request('/account/logout', 'POST'), { name: 'AbortError' });
  assert.equal(calls.length, 2);
});

test('authenticated operator login logout sends its fixed actor and a late login cannot navigate an unmounted page', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const page = await harness(
    'web/src/testSupport/operationsComponents.tsx',
    'OperatorLogin',
    {},
    (async (path, init) => {
      calls.push({ path: String(path), init });
      return json(
        path === '/api/platform/session'
          ? { authenticated: true, setupRequired: false, user: account }
          : { ok: true },
      );
    }) as typeof fetch,
    { window: browser() },
  );
  await page.flush();
  const logout = all(page.tree, (node) => node.type === 'button')[0];
  await logout.props.onClick();
  assert.equal(calls[1].path, '/api/platform/logout');
  assert.equal(new Headers(calls[1].init?.headers).get('X-OpenBot-Expected-User'), account.id);
  page.dispose();

  const late = deferred<Response>();
  const navigation: string[] = [];
  const window = browser();
  window.location.assign = (path?: string) => {
    navigation.push(path || '');
  };
  const form = await harness(
    'web/src/testSupport/operationsComponents.tsx',
    'OperatorLogin',
    {},
    (async (path) =>
      path === '/api/platform/session'
        ? json({ authenticated: false, setupRequired: false })
        : late.promise) as typeof fetch,
    { window },
  );
  await form.flush();
  const attempt = form.form().props.onSubmit({ preventDefault() {} });
  form.dispose();
  late.resolve(json({ authenticated: true, user: account }));
  await attempt;
  assert.deepEqual(navigation, []);
});
