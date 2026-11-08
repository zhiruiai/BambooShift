import test from 'node:test';
import assert from 'node:assert/strict';
import { compareUpdate, releaseUrl, validReleaseRepository } from './updateVersions';
import { checkedUpdates, type UpdatesState } from './updates';
import {
  all,
  base,
  component,
  deferred,
  env,
  harness,
  json,
} from './testSupport/memoryImportSettingsFixture';
const identity = { userId: base.userId, workspaceId: base.workspaceId };
function state(update: Partial<UpdatesState> = {}): UpdatesState {
  return {
    scope: identity,
    repository: 'synthetic-org/openbot-example',
    serviceVersion: '0.1.0',
    status: 'unavailable',
    checkedAt: null,
    reason: 'not_checked',
    release: null,
    ...update,
  };
}
function released(): UpdatesState {
  return state({
    status: 'update_available',
    reason: null,
    checkedAt: '2026-11-01T00:00:00Z',
    release: {
      tag: 'v2.0.0',
      version: '2.0.0',
      name: 'Synthetic release',
      notes: '<script>untrusted release notes</script>',
      publishedAt: '2026-11-01T00:00:00Z',
      url: 'https://github.com/synthetic-org/openbot-example/releases/tag/v2.0.0',
    },
  });
}
test('client and service versions are compared separately with strict semantic version ordering and bound release links', () => {
  assert.equal(compareUpdate('1.9.0', '1.10.0'), 'update_available');
  assert.equal(compareUpdate('2.0.0', '1.10.0'), 'current');
  assert.equal(compareUpdate('2.0.0-rc.1', '2.0.0'), 'update_available');
  assert.equal(compareUpdate('2.0.0+desktop.2', '2.0.0+server.1'), 'current');
  for (const invalid of ['1.02.0', '1.2', '1.2.3-01', '1.2.3+', 'v1.2.3', ' 1.2.3'])
    assert.equal(compareUpdate(invalid, '2.0.0'), 'unknownVersion');
  assert.equal(compareUpdate('1.0.0', '2.0.0-beta'), 'unknownVersion');
  assert.equal(compareUpdate(undefined, '2.0.0'), 'unknownVersion');
  assert.equal(validReleaseRepository('https://example.test/repo'), false);
  assert.equal(releaseUrl('synthetic-org/openbot-example', '../escape'), undefined);
  assert.equal(releaseUrl('synthetic-org/openbot-example', '..'), undefined);
  assert.throws(() =>
    checkedUpdates({ ...released(), scope: { ...identity, userId: 'other-user' } }, identity),
  );
  assert.throws(() =>
    checkedUpdates(
      {
        ...released(),
        release: {
          ...released().release!,
          url: 'https://github.com/other/repository/releases/tag/v2.0.0',
        },
      },
      identity,
    ),
  );
});

test('actual update hook performs only local GET on entry, sends one explicit scoped POST, and keeps native version separate', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const pending = deferred<Response>();
  let versionReads = 0;
  const globals = env();
  const h = await harness(
    'web/src/updates.ts',
    'useUpdates',
    { ...identity, active: true },
    {
      ...globals,
      window: {
        ...globals.window,
        openbotVersion: {
          getVersion: async () => {
            versionReads++;
            return '9.0.0';
          },
        },
      },
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return init.method === 'POST' ? pending.promise : json(state());
      },
    },
  );
  try {
    await h.flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.method, 'GET');
    assert.equal(versionReads, 1);
    assert.equal(h.tree.desktopVersion, '9.0.0');
    assert.equal(h.tree.data.serviceVersion, '0.1.0');
    const click = h.tree.check;
    const first = click();
    const duplicate = click();
    await h.flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, `/api/workspaces/${base.workspaceId}/updates`);
    assert.equal(new Headers(requests[1].init.headers).get('X-OpenBot-Expected-User'), base.userId);
    assert.deepEqual(JSON.parse(String(requests[1].init.body)), {});
    pending.resolve(json(released()));
    await first;
    await duplicate;
    await h.flush();
    assert.equal(h.tree.data.status, 'update_available');
    assert.equal(h.tree.desktopVersion, '9.0.0');
    await h.tree.refresh();
    await h.flush();
    assert.equal(requests.at(-1)!.init.method, 'GET');
  } finally {
    h.dispose();
  }
});

test('late check bodies and native versions cannot update hidden or changed-account settings and old callbacks do not dispatch', async () => {
  const response = deferred<Response>(),
    native = deferred<string>(),
    requests: RequestInit[] = [];
  const globals = env();
  const h = await harness(
    'web/src/updates.ts',
    'useUpdates',
    { ...identity, active: true },
    {
      ...globals,
      window: { ...globals.window, openbotVersion: { getVersion: () => native.promise } },
      fetch: async (_url: string, init: RequestInit) => {
        requests.push(init);
        return requests.length === 1 ? json(state()) : response.promise;
      },
    },
  );
  try {
    await h.flush();
    const prior = h.tree;
    const checking = prior.check();
    await h.flush();
    h.setProps({ active: false, userId: 'other-user' });
    await h.flush();
    assert.equal((requests[1].signal as AbortSignal).aborted, true);
    response.resolve(json(released()));
    native.resolve('8.8.8');
    await checking;
    await h.flush();
    assert.notEqual(h.tree.data?.status, 'update_available');
    assert.equal(h.tree.desktopVersion, undefined);
    await prior.check();
    await prior.refresh();
    assert.equal(requests.length, 2);
    h.dispose();
    await prior.check();
    assert.equal(requests.length, 2);
  } finally {
    h.dispose();
  }
});

test('unconfigured updates are honest and disabled; release notes stay plain text and desktop links keep native confirmation', async () => {
  const globals = env();
  let checks = 0;
  const h = await harness(
    'web/src/components/UpdatesPanel.tsx',
    'UpdatesContent',
    { ...identity, active: true },
    {
      ...globals,
      fetch: async (_url: string, init: RequestInit) => {
        if (init.method === 'POST') checks++;
        return json(state({ repository: null, status: 'unconfigured', reason: null }));
      },
    },
  );
  try {
    await h.flush();
    assert.match(h.copy, /尚未配置发行仓库/);
    assert.equal(h.button('检查更新').props.disabled, true);
    assert.equal(checks, 0);
    assert.doesNotMatch(h.copy, /最新版本是/);
  } finally {
    h.dispose();
  }
  const ready = await harness(
    'web/src/components/UpdatesPanel.tsx',
    'UpdatesContent',
    { ...identity, active: true },
    {
      ...globals,
      window: { ...globals.window, openbotVersion: { getVersion: async () => '0.0.1' } },
      fetch: async () => json(released()),
    },
  );
  try {
    await ready.flush();
    assert.equal(all(ready.tree, (node) => node.type === 'script').length, 0);
    assert.match(ready.copy, /<script>untrusted release notes<\/script>/);
    const link = all(ready.tree, (node) => node.type === 'a')[0];
    assert.equal(link.props.href, released().release!.url);
    let prevented = 0;
    link.props.onClick({
      preventDefault() {
        prevented++;
      },
    });
    assert.equal(prevented, 1);
    assert.match(ready.copy, /右键此链接/);
  } finally {
    ready.dispose();
  }
});

test('members can reach updates without gaining model configuration or losing other settings drafts', async () => {
  const data = {
    agents: [],
    conversations: [],
    messages: [],
    memories: [],
    routines: [],
    skills: [],
    files: [],
    settings: { configured: false },
    computer: {},
  };
  const h = await harness(
    'web/src/components/WorkspaceSettingsDialog.tsx',
    'WorkspaceSettingsContent',
    {
      ...identity,
      data,
      canManage: false,
      team: true,
      onClose() {},
      onSettingsChanged() {},
      onPrimaryChanged() {},
      onImported: async () => {},
      onTimeZoneChanged() {},
    },
    env(),
  );
  try {
    await h.flush();
    const memory = component(h.tree, 'MemoryImportPanel');
    component(h.tree, 'SettingsNavigation').props.onChange('updates');
    await h.flush();
    assert.equal(component(h.tree, 'UpdatesPanel').props.active, true);
    assert.equal(component(h.tree, 'UpdatesPanel').props.userId, base.userId);
    assert.equal(component(h.tree, 'MemoryImportPanel').type, memory.type);
    assert.equal(component(h.tree, 'SettingsNavigation').props.canManage, false);
  } finally {
    h.dispose();
  }
});
