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
  render,
  json,
  deferred,
  app,
  action,
  props,
  oauthIds,
  oauthApp,
  oauthFlow,
  oauthEnvironment,
  all,
  harness,
} from './testSupport/appsFixture';

test('actual OAuth panel passes only task IDs to native open and never constructs an external URL or starts after unmount', async () => {
  const environment = oauthEnvironment(),
    opened: any[] = [],
    calls: string[] = [];
  environment.window.openbotAuthorization = {
    open: async (value) => {
      opened.push(value);
      return { opened: true };
    },
  };
  const ui = await harness(
    'web/src/components/AppOAuthPanel.tsx',
    'OAuthPanel',
    { app: oauthApp, ...oauthIds, onBusy() {}, onChanged() {} },
    (async (url: any) => {
      calls.push(String(url));
      return json(oauthFlow);
    }) as typeof fetch,
    environment,
  );
  try {
    await ui.flush();
    const open = ui.button('在浏览器中授权').props.onClick;
    open();
    await ui.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(opened)), [
      {
        workspaceId: oauthIds.workspaceId,
        connectionId: oauthIds.connectionId,
        flowId: oauthIds.flowId,
        expectedUserId: oauthIds.userId,
      },
    ]);
    assert.equal(environment.navigations.length, 0);
    assert.equal(all(ui.tree, (node) => node.type === 'a').length, 0);
    ui.dispose();
    open();
    await ui.flush();
    assert.equal(opened.length, 1);
    assert.equal(calls.length, 1);
  } finally {
    ui.dispose();
  }
});

test('actual browser handoff displays sharing and scopes, requires consent and refuses foreign provider responses', async () => {
  const environment = oauthEnvironment(),
    writes: string[] = [];
  const ui = await harness(
    'web/src/platform/AppAuthorizePage.tsx',
    'AuthorizationHandoff',
    { ...oauthIds, workspaceName: '产品团队' },
    (async (url: any, init: any) => {
      if (init.method === 'GET') return json(oauthFlow);
      writes.push(String(url));
      return json({
        authorizationUrl: 'https://evil.example/authorize',
      });
    }) as typeof fetch,
    environment,
  );
  try {
    await ui.flush();
    assert.match(ui.copy, /产品团队/);
    assert.match(ui.copy, /documents.read/);
    assert.match(ui.copy, /所有 Bot/);
    assert.equal(writes.length, 0);
    ui.button('前往服务商授权').props.onClick();
    await ui.flush();
    assert.equal(writes.length, 0);
    ui.field('我确认').props.onChange({ target: { checked: true } });
    await ui.flush();
    ui.button('前往服务商授权').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /与已确认的服务不一致/);
    assert.deepEqual(environment.navigations, []);
    ui.button('前往服务商授权').props.onClick();
    await ui.flush();
    assert.equal(writes.length, 1);
    assert.match(ui.copy, /先取消这次授权/);
    assert.deepEqual(environment.navigations, []);
  } finally {
    ui.dispose();
  }
  const fresh = await harness(
    'web/src/platform/AppAuthorizePage.tsx',
    'AuthorizationHandoff',
    { ...oauthIds, workspaceName: '产品团队' },
    (async (_url: any, init: any) =>
      json(
        init.method === 'GET'
          ? oauthFlow
          : { authorizationUrl: 'https://provider.example/authorize?state=opaque' },
      )) as typeof fetch,
    environment,
  );
  try {
    await fresh.flush();
    fresh.field('我确认').props.onChange({ target: { checked: true } });
    await fresh.flush();
    fresh.button('前往服务商授权').props.onClick();
    await fresh.flush();
    assert.deepEqual(environment.navigations, ['https://provider.example/authorize?state=opaque']);
  } finally {
    fresh.dispose();
  }
});

test('actual browser handoff drops late begin after account scope removal and never redeems callbacks itself', async () => {
  const environment = oauthEnvironment(),
    late = deferred<Response>();
  let writes = 0;
  const ui = await harness(
    'web/src/platform/AppAuthorizePage.tsx',
    'AuthorizationHandoff',
    { ...oauthIds, workspaceName: '个人空间' },
    (async (_url: any, init: any) => {
      if (init.method === 'GET') return json(oauthFlow);
      writes++;
      return late.promise;
    }) as typeof fetch,
    environment,
  );
  await ui.flush();
  ui.field('我确认').props.onChange({ target: { checked: true } });
  await ui.flush();
  const begin = ui.button('前往服务商授权').props.onClick;
  begin();
  await ui.flush();
  ui.dispose();
  late.resolve(json({ authorizationUrl: 'https://provider.example/authorize?state=old' }));
  await ui.flush();
  begin();
  await ui.flush();
  assert.equal(writes, 1);
  assert.deepEqual(environment.navigations, []);
  const done = await harness(
    'web/src/platform/AppAuthorizePage.tsx',
    'AuthorizationHandoff',
    { ...oauthIds, workspaceName: '个人空间' },
    (async (_url: any, init: any) => {
      assert.equal(init.method, 'GET');
      return json({ ...oauthFlow, status: 'callback_received' });
    }) as typeof fetch,
    oauthEnvironment(),
  );
  try {
    await done.flush();
    assert.match(done.copy, /回到发起窗口/);
    assert.equal(done.maybeButton('完成连接'), undefined);
    assert.equal(done.maybeButton('前往服务商授权'), undefined);
  } finally {
    done.dispose();
  }
});

test('actual OAuth application details expose real grants and truthful revocation status without replacing browser authorization by Bearer input', async () => {
  let stored: ConnectedApp = {
    ...oauthApp,
    status: 'connected',
    hasCredential: true,
    authorization: { issuer: 'https://provider.example', scopes: ['documents.read'] },
  };
  const writes: string[] = [];
  const ui = await harness(
    'web/src/components/AppsDialog.tsx',
    'AppsDialogContent',
    { ...props(), ...oauthIds },
    (async (url: any, init: any) => {
      if (init.method === 'GET') return json(String(url).endsWith('/tools') ? [] : [stored]);
      writes.push(String(url));
      stored = {
        ...stored,
        status: 'disconnected',
        hasCredential: false,
        authorization: undefined,
        revocation: 'pending',
      };
      return json(stored);
    }) as typeof fetch,
  );
  try {
    await ui.flush();
    all(
      ui.tree,
      (node) => node.type === 'button' && node.props.className === 'integration',
    )[0].props.onClick();
    await ui.flush();
    assert.match(ui.copy, /已授权的服务与权限/);
    assert.match(ui.copy, /documents.read/);
    assert.ok(ui.button('刷新连接'));
    assert.equal(ui.maybeButton('重新授权'), undefined);
    ui.button('断开连接').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /会尝试撤销服务方授权/);
    ui.button('确认断开').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /正在尝试撤销服务方授权/);
    stored = { ...stored, revocation: 'failed' };
    ui.button('刷新撤销状态').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /未能确认服务方撤销成功/);
    assert.match(ui.copy, /服务的账号设置|服务方的账号设置|该服务的账号设置/);
    assert.equal(writes.length, 1);
  } finally {
    ui.dispose();
  }
});

test('requester approval uses the authenticated person, not the team owner or matching display name', async () => {
  const requested = { ...action, requester: { userId: 'member-a', name: '林' } };
  for (const [userId, owner, allowed] of [
    ['member-a', false, true],
    ['member-b', false, false],
    ['owner-a', true, false],
  ] as const) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ui = await harness(
      'web/src/components/AppActionCard.tsx',
      'AppActionContent',
      {
        action: requested,
        workspaceId: 'space-a',
        userId,
        owner,
        onChanged: async () => {},
        onApps() {},
      },
      (async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return json({ ...requested, status: 'rejected' });
      }) as typeof fetch,
    );
    try {
      await ui.flush();
      assert.equal(!!ui.maybeButton('批准这一次'), allowed);
      assert.equal(!!ui.maybeButton('拒绝'), allowed);
      if (allowed) {
        assert.match(ui.copy, /等待你批准/);
        ui.button('拒绝').props.onClick();
        await ui.flush();
        assert.equal(calls.length, 1);
        assert.deepEqual(JSON.parse(String(calls[0].init.body)), { approve: false });
        assert.equal(new Headers(calls[0].init.headers).get('X-OpenBot-Expected-User'), userId);
      } else {
        assert.match(ui.copy, /等待林批准/);
        assert.match(ui.copy, /拥有者不能代为审批/);
        assert.equal(calls.length, 0);
      }
    } finally {
      ui.dispose();
    }
  }
  const { AppActionCard } = await compile('web/src/components/AppActionCard.tsx');
  for (const requester of [null, {}, { userId: '' }, { userId: 'member-a', name: 7 }]) {
    const html = render(AppActionCard, {
      action: { ...action, requester },
      owner: true,
      userId: 'member-a',
    });
    assert.doesNotMatch(html, /批准这一次<\/button>/);
    assert.match(html, /身份待确认/);
  }
});
