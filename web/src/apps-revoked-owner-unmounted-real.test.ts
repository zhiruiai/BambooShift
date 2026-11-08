import { componentSource } from './testSupport/componentSource';
import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import type { AppAction, ConnectedApp } from '../../shared/app-connections';
import type { AppOAuthFlow } from '../../shared/app-oauth';
import {
  compile,
  json,
  deferred,
  app,
  action,
  props,
  oauthIds,
  oauthApp,
  oauthFlow,
  oauthEnvironment,
  text,
  all,
  harness,
} from './testSupport/appsFixture';

test('revoked owner and unmounted real dialog callbacks cannot submit under a later account', async () => {
  const writes: string[] = [];
  const ui = await harness('web/src/components/AppsDialog.tsx', 'AppsDialogContent', props(), (async (
    url: any,
    init: any,
  ) => {
    if (init.method !== 'GET') writes.push(String(url));
    return json([]);
  }) as typeof fetch);
  await ui.flush();
  ui.button('添加').props.onClick();
  await ui.flush();
  ui.field('应用名称').props.onChange({ target: { value: app.name } });
  await ui.flush();
  ui.field('服务地址').props.onChange({ target: { value: app.url } });
  await ui.flush();
  ui.field('我确认').props.onChange({ target: { checked: true } });
  await ui.flush();
  const submit = ui.form().props.onSubmit;
  ui.setProps({ canManage: false });
  await ui.flush();
  submit({ preventDefault() {} });
  await ui.flush();
  assert.deepEqual(writes, []);
  ui.dispose();
  submit({ preventDefault() {} });
  assert.deepEqual(writes, []);
});

test('actual approval handler dispatches one exact decision, and an uncertain response requires authoritative refresh before another decision', async () => {
  const calls: Array<{ url: string; init: any }> = [];
  let authoritative = { ...action, status: 'running' };
  const decision = deferred<Response>();
  const ui = await harness(
    'web/src/components/AppActionCard.tsx',
    'AppActionContent',
    {
      action,
      owner: true,
      workspaceId: 'space-a',
      userId: 'owner-a',
      onChanged: async () => {},
      onApps() {},
    },
    (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (init.method === 'POST') return decision.promise;
      return json({ messages: [{ metadata: { appAction: authoritative } }] });
    }) as typeof fetch,
  );
  try {
    await ui.flush();
    const approve = ui.button('批准这一次').props.onClick;
    approve();
    approve();
    await ui.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/workspaces/space-a/app-actions/action-a/decision');
    assert.deepEqual(JSON.parse(calls[0].init.body), { approve: true });
    decision.resolve(json({ error: '结果未知' }, 502));
    await ui.flush();
    approve();
    assert.equal(
      calls.length,
      1,
      'a retained pre-request handler cannot repeat an uncertain decision',
    );
    assert.equal(ui.button('批准这一次').props.disabled, true);
    assert.match(ui.copy, /不要重复执行外部操作/);
    ui.button('刷新状态').props.onClick();
    await ui.flush();
    assert.equal(calls[1].url, '/api/workspaces/space-a/bootstrap');
    assert.match(ui.copy, /正在执行/);
    assert.equal(ui.maybeButton('批准这一次'), undefined);
    ui.dispose();
    approve();
    assert.equal(calls.length, 2);
  } finally {
    decision.resolve(json(action));
    ui.dispose();
  }
});

test('a delayed tool list from a previously selected connection cannot replace the current application tools', async () => {
  const late = deferred<Response>();
  const other = { ...app, id: 'app-b', name: '另一应用' };
  const ui = await harness('web/src/components/AppsDialog.tsx', 'AppsDialogContent', props(), (async (
    url: any,
  ) => {
    if (String(url).includes('/app-a/tools')) return late.promise;
    if (String(url).includes('/app-b/tools'))
      return json([{ name: 'current-tool', description: '当前应用工具', inputSchema: {} }]);
    return json([app, other]);
  }) as typeof fetch);
  try {
    await ui.flush();
    all(
      ui.tree,
      (node) => node.type === 'button' && text(node).includes(app.name),
    )[0].props.onClick();
    await ui.flush();
    ui.button('全部应用').props.onClick();
    await ui.flush();
    all(
      ui.tree,
      (node) => node.type === 'button' && text(node).includes(other.name),
    )[0].props.onClick();
    await ui.flush();
    assert.match(ui.copy, /current-tool/);
    late.resolve(json([{ name: 'old-tool', description: '旧应用工具', inputSchema: {} }]));
    await ui.flush();
    assert.match(ui.copy, /current-tool/);
    assert.doesNotMatch(ui.copy, /old-tool/);
  } finally {
    late.resolve(json([]));
    ui.dispose();
  }
});

test('retained tool switches cannot repeat an uncertain write before or after authoritative readback', async () => {
  const available = { ...app, toolAccessSupported: true };
  let tool = {
    name: 'issue_read',
    description: 'Read an issue',
    inputSchema: {},
    access: { enabled: true, revision: 'enabled-1' },
  };
  const writes: unknown[] = [];
  const ui = await harness('web/src/components/AppsDialog.tsx', 'AppsDialogContent', props(), (async (
    url: string,
    init: RequestInit,
  ) => {
    if (url.endsWith('/apps')) return json([available]);
    if (url.endsWith('/tools')) return json([tool]);
    if (url.endsWith('/tools/access')) {
      writes.push(JSON.parse(init.body as string));
      tool = { ...tool, access: { enabled: false, revision: 'disabled-2' } };
      return json({ error: 'Result unknown' }, 502);
    }
    return json([]);
  }) as typeof fetch);
  try {
    await ui.flush();
    all(
      ui.tree,
      (node) => node.type === 'button' && text(node).includes(app.name),
    )[0].props.onClick();
    await ui.flush();
    const toolSwitch = () => all(ui.tree, (node) => node.props?.role === 'switch')[0];
    const retained = toolSwitch().props.onClick;
    retained();
    await ui.flush();
    retained();
    assert.equal(writes.length, 1);
    assert.equal(toolSwitch().props.disabled, true);
    ui.button('刷新工具权限').props.onClick();
    await ui.flush();
    assert.equal(toolSwitch().props['aria-checked'], false);
    assert.equal(toolSwitch().props.disabled, false);
    retained();
    assert.equal(writes.length, 1);
  } finally {
    ui.dispose();
  }
});

test('OAuth login return paths accept only exact authorization IDs and provider navigation stays on the reviewed origin', async () => {
  const { safeAccountNext } = await compile('web/src/platform/platformApi.ts');
  const { parseAppAuthorizationPath, validAuthorizationUrl } = await compile('web/src/appOAuth.ts');
  assert.equal(safeAccountNext(oauthFlow.launchPath), oauthFlow.launchPath);
  for (const value of [
    oauthFlow.launchPath + '?next=https://other.example',
    oauthFlow.launchPath + '#other',
    oauthFlow.launchPath + '/',
    oauthFlow.launchPath?.replace('/app-authorize/', '/app-authorize/%2f'),
    'https://evil.example' + oauthFlow.launchPath,
    '/app-authorize/not-an-id',
  ]) {
    assert.equal(safeAccountNext(value), '');
    assert.equal(parseAppAuthorizationPath(value), undefined);
  }
  assert.equal(
    validAuthorizationUrl(
      'https://provider.example/authorize?state=opaque',
      oauthFlow.authorizationOrigin,
    ),
    true,
  );
  for (const value of [
    'https://evil.example/authorize',
    'http://provider.example/authorize',
    'https://secret@provider.example/authorize',
    'https://provider.example:8443/authorize',
    'https://provider.example/authorize#redirect',
  ])
    assert.equal(validAuthorizationUrl(value, oauthFlow.authorizationOrigin), false);
});

test('actual OAuth panel restores a safe web link, polls read-only and exchanges only after explicit finish', async () => {
  const environment = oauthEnvironment(),
    calls: Array<{ url: string; init: RequestInit }> = [];
  let stored = { ...oauthFlow },
    changed = 0;
  const busy: boolean[] = [];
  const ui = await harness(
    'web/src/components/AppOAuthPanel.tsx',
    'OAuthPanel',
    {
      app: oauthApp,
      ...oauthIds,
      onBusy: (value: boolean) => busy.push(value),
      onChanged: () => changed++,
    },
    (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (init.method === 'POST') stored = { ...stored, status: 'complete' };
      return json(stored);
    }) as typeof fetch,
    environment,
  );
  try {
    await ui.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'GET');
    const link = all(ui.tree, (node) => node.type === 'a')[0];
    assert.equal(link.props.href, oauthFlow.launchPath);
    assert.equal(link.props.target, '_blank');
    assert.equal(link.props.rel, 'noopener noreferrer');
    assert.match(ui.copy, /documents.read/);
    stored = { ...stored, status: 'callback_received' };
    environment.tick();
    await ui.flush();
    assert.equal(
      calls.some((call) => call.init.method === 'POST'),
      false,
    );
    const finish = ui.button('完成连接').props.onClick;
    finish();
    finish();
    await ui.flush();
    const writes = calls.filter((call) => call.init.method === 'POST');
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/oauth/${oauthFlow.id}/finish`));
    assert.equal(
      (writes[0].init.headers as Record<string, string>)['X-OpenBot-Expected-User'],
      oauthIds.userId,
    );
    assert.equal(changed, 1);
    assert.deepEqual(busy, [true, false]);
    assert.match(ui.copy, /连接已完成/);
  } finally {
    ui.dispose();
  }
});

test('actual OAuth start binds revision, keeps secrets in memory, and resolves unknown writes through GET before any new action', async () => {
  const environment = oauthEnvironment(),
    calls: Array<{ url: string; init: RequestInit }> = [];
  let stored: AppOAuthFlow | null = null;
  const ui = await harness(
    'web/src/components/AppOAuthPanel.tsx',
    'OAuthPanel',
    { app: oauthApp, ...oauthIds, onBusy() {}, onChanged() {} },
    (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/start')) {
        stored = { ...oauthFlow };
        throw new TypeError('offline after accepted');
      }
      if (String(url).endsWith('/cancel')) stored = { ...oauthFlow, status: 'cancelled' };
      return json(stored);
    }) as typeof fetch,
    environment,
  );
  try {
    await ui.flush();
    ui.field('客户端 ID').props.onChange({ target: { value: 'registered-client' } });
    ui.field('客户端密钥').props.onChange({ target: { value: 'memory-only-secret' } });
    await ui.flush();
    const start = ui.button('开始网页登录授权').props.onClick;
    start();
    start();
    await ui.flush();
    assert.deepEqual(
      JSON.parse(String(calls.find((call) => call.init.method === 'POST')!.init.body)),
      {
        expectedRevision: oauthApp.revision,
        clientId: 'registered-client',
        clientSecret: 'memory-only-secret',
      },
    );
    assert.equal(ui.button('开始网页登录授权').props.disabled, true);
    assert.equal(ui.field('客户端密钥').props.value, 'memory-only-secret');
    start();
    await ui.flush();
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1);
    ui.button('检查状态').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /等待浏览器授权/);
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1);
    ui.button('取消授权').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /授权已取消/);
    assert.equal(ui.field('客户端密钥').props.value, '');
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 2);
  } finally {
    ui.dispose();
  }
});
