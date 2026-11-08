import test from 'node:test';
import assert from 'node:assert/strict';
import { appProviders, providerDraft, providerConnection } from './appProviders';
import { all, harness, json, props, app } from './testSupport/appsFixture';
import { harness as componentHarness } from './testSupport/memoryImportSettingsFixture';

test('provider presets contain only documented endpoints and no credentials or standing grants', () => {
  for (const provider of appProviders) {
    assert.equal(new URL(provider.url).protocol, 'https:');
    assert.equal(new URL(provider.documentation).protocol, 'https:');
    assert.equal(new URL(provider.url).search, '');
    const draft = providerDraft(provider.id)!;
    assert.equal(draft.token, '');
    assert.equal(draft.shared, false);
    assert.ok(!('status' in draft));
  }
  assert.equal(providerDraft('arbitrary-provider'), undefined);
  assert.equal(providerDraft('gmail'), undefined);
  assert.deepEqual(providerDraft('microsoft-learn'), {
    name: 'Microsoft Learn',
    url: 'https://learn.microsoft.com/api/mcp',
    authType: 'none',
    token: '',
    shared: false,
  });
  assert.equal(providerDraft('gitlab')?.authType, 'oauth');
  assert.equal(providerDraft('cloudflare-docs')?.authType, 'none');
  assert.equal(providerDraft('deepwiki')?.authType, 'none');
  const notion = appProviders[0];
  assert.equal(providerConnection(notion, [{ ...app, name: 'Notion' }]), undefined);
  assert.equal(
    providerConnection(notion, [{ ...app, url: notion.url, status: 'needs_auth' }])?.status,
    'needs_auth',
  );
});
test('actual provider catalog filters categories and search and never labels an unauthenticated connection connected', async () => {
  const selected: string[] = [],
    opened: string[] = [];
  const h = await componentHarness(
    'web/src/components/apps/AppProviderCatalog.tsx',
    'AppProviderCatalog',
    {
      apps: [{ ...app, url: appProviders[0].url, status: 'needs_auth' }],
      category: 'all',
      search: '',
      canManage: true,
      busy: false,
      onSelect: (id: string) => selected.push(id),
      onOpen: (id: string) => opened.push(id),
    },
    {
      fetch: async () => {
        throw Error('Catalog cannot issue network requests');
      },
    },
  );
  try {
    await h.flush();
    assert.match(h.copy, /Notion/);
    assert.doesNotMatch(h.copy, /已连接/);
    all(h.tree, (node) => node.props?.['aria-label'] === '配置 Notion')[0].props.onClick();
    assert.deepEqual(opened, [app.id]);
    all(h.tree, (node) => node.props?.['aria-label'] === '配置 Linear')[0].props.onClick();
    assert.deepEqual(selected, ['linear']);
    h.setProps({ category: 'code' });
    await h.flush();
    assert.match(h.copy, /GitHub/);
    assert.match(h.copy, /GitLab/);
    assert.match(h.copy, /Microsoft Learn/);
    assert.match(h.copy, /Cloudflare Docs/);
    assert.match(h.copy, /DeepWiki/);
    assert.doesNotMatch(h.copy, /Notion|Linear/);
    h.setProps({ search: '源码解析' });
    await h.flush();
    assert.match(h.copy, /DeepWiki/);
    assert.doesNotMatch(h.copy, /Cloudflare Docs/);
    h.setProps({ search: 'unlisted-service' });
    await h.flush();
    assert.match(h.copy, /没有符合搜索条件/);
    h.setProps({ search: '', canManage: false });
    await h.flush();
    assert.equal(
      all(h.tree, (node) => node.props?.['aria-label'] === '配置 GitHub')[0].props.disabled,
      true,
    );
  } finally {
    h.dispose();
  }
});
test('choosing a provider uses the real add form, requires consent and preserves unfinished credentials', async () => {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const h = await harness(
    'web/src/components/AppsDialog.tsx',
    'AppsDialogContent',
    props(),
    async (path: any, init: any) => {
      calls.push({
        path: String(path),
        method: init.method,
        body: init.body && JSON.parse(init.body),
      });
      return json([]);
    },
  );
  try {
    await h.flush();
    const catalog = all(h.tree, (node) => node.type?.name === 'AppProviderCatalog')[0];
    assert.ok(catalog);
    const toolbar = all(h.tree, (node) => node.props?.className === 'apps-list-toolbar')[0];
    const scroll = all(h.tree, (node) => node.props?.className === 'apps-scroll')[0];
    const footer = all(h.tree, (node) => node.type === 'footer')[0];
    assert.ok(toolbar && scroll && footer);
    assert.equal(all(scroll, (node) => node === toolbar || node === footer).length, 0);
    h.button('代码').props.onClick();
    await h.flush();
    assert.equal(
      all(h.tree, (node) => node.type?.name === 'AppProviderCatalog')[0].props.category,
      'code',
    );
    assert.equal(h.button('代码').props['aria-pressed'], true);
    catalog.props.onSelect('github');
    await h.flush();
    const inputs = all(h.tree, (node) => node.type === 'input');
    assert.ok(
      inputs.some((node) => node.props.value === 'https://api.githubcopilot.com/mcp/readonly'),
    );
    assert.ok(inputs.some((node) => node.props.value === 'GitHub'));
    assert.equal(inputs.find((node) => node.props.type === 'checkbox').props.checked, false);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
    const token = inputs.find((node) => node.props.type === 'password');
    token.props.onChange({ target: { value: 'SYNTHETIC_TOKEN_RETAINED' } });
    await h.flush();
    h.button('全部应用').props.onClick();
    await h.flush();
    all(h.tree, (node) => node.type?.name === 'AppProviderCatalog')[0].props.onSelect('notion');
    await h.flush();
    assert.match(h.copy, /未完成的连接资料已保留/);
    h.button('添加').props.onClick();
    await h.flush();
    assert.equal(
      all(h.tree, (node) => node.type === 'input' && node.props.type === 'password')[0].props.value,
      'SYNTHETIC_TOKEN_RETAINED',
    );
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  } finally {
    h.dispose();
  }
});
