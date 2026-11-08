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
  require,
  compile,
  render,
  json,
  deferred,
  app,
  action,
  props,
  text,
  all,
  harness,
} from './testSupport/appsFixture';

test('application scope binds account/workspace, drops late auth failures, and revokes old callbacks without breaking effect replay', async () => {
  const { createAppConnectionScope, validAppAddress } = await compile('web/src/appConnections.ts');
  const response = deferred<Response>(),
    calls: Array<{ url: string; init: RequestInit }> = [],
    auth: number[] = [];
  const scope = createAppConnectionScope({
    workspaceId: 'space-a',
    userId: 'owner-a',
    onAuthFailure: (status: number) => auth.push(status),
    fetch: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response.promise;
    },
  });
  const promise = scope.request('/apps/app-a/reconnect', 'POST', {});
  scope.suspend();
  response.resolve(json({ error: 'old account' }, 401));
  await assert.rejects(promise, (error: any) => error.name === 'AbortError');
  assert.equal(calls[0].url, '/api/workspaces/space-a/apps/app-a/reconnect');
  assert.equal((calls[0].init.headers as any)['X-OpenBot-Expected-User'], 'owner-a');
  assert.equal(calls[0].init.signal?.aborted, true);
  assert.deepEqual(auth, []);
  await assert.rejects(
    scope.request('/apps', 'POST', {}),
    (error: any) => error.name === 'AbortError',
  );
  assert.equal(calls.length, 1);
  scope.resume();
  await assert.rejects(scope.request('/apps'), (error: any) => error.status === 401);
  assert.deepEqual(auth, [401]);
  assert.equal(validAppAddress('http://example.com/mcp'), false);
  assert.equal(validAppAddress('https://secret@example.com/mcp'), false);
  assert.equal(validAppAddress('https://example.com/mcp?token=example'), false);
  assert.equal(validAppAddress('https://example.com:8443/mcp'), false);
  assert.equal(validAppAddress('https://example.com/mcp'), true);
});

test('actual action cards distinguish all states and service-level errors; arguments/results are escaped text', async () => {
  const { AppActionCard, parseAppAction } = await compile('web/src/components/AppActionCard.tsx');
  const common = { action, owner: true, onChanged: async () => {}, onApps() {} };
  const owner = render(AppActionCard, common);
  assert.match(owner, /批准这一次/);
  assert.match(owner, /仅批准这一次操作/);
  assert.match(owner, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(owner, /<script>/);
  const member = render(AppActionCard, { ...common, owner: false });
  assert.doesNotMatch(member, /批准这一次<\/button>/);
  assert.match(member, /由空间拥有者/);
  for (const [status, label] of [
    ['running', '正在执行'],
    ['done', '已完成'],
    ['rejected', '已拒绝'],
    ['cancelled', '已取消'],
    ['error', '执行未完成'],
  ]) {
    const html = render(AppActionCard, { ...common, action: { ...action, status } });
    assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, /批准这一次/);
  }
  const error = render(AppActionCard, {
    ...common,
    action: {
      ...action,
      status: 'done',
      result: { isError: true, text: '<img src=x onerror=bad()>' },
    },
  });
  assert.match(error, /服务返回错误/);
  assert.doesNotMatch(error, /已完成|<img/);
  assert.match(error, /&lt;img/);
  assert.equal(parseAppAction({ ...action, arguments: [] }), undefined);
  assert.equal(parseAppAction({ ...action, result: { text: {} } }), undefined);
});

test('actual application dialog lists real connections, preserves environment links, and exposes owner management only', async () => {
  const requests: string[] = [];
  const transport = (async (url: any) => {
    requests.push(String(url));
    return json([app]);
  }) as typeof fetch;
  const ui = await harness(
    'web/src/components/AppsDialog.tsx',
    'AppsDialogContent',
    props(),
    transport,
  );
  try {
    await ui.flush();
    assert.match(ui.copy, /此空间的所有 Bot/);
    assert.match(ui.copy, /工作环境/);
    assert.deepEqual(
      all(ui.tree, (node) => node.type?.name === 'EnvironmentLink').map((node) => node.props.title),
      ['工作空间文件', '工作电脑', 'AI 模型'],
    );
    assert.match(ui.copy, /团队资料/);
    assert.deepEqual(requests, ['/api/workspaces/space-a/apps']);
    assert.ok(ui.button('添加'));
    ui.setProps({ canManage: false });
    await ui.flush();
    assert.equal(ui.maybeButton('添加'), undefined);
    assert.match(ui.copy, /拥有者负责/);
  } finally {
    ui.dispose();
  }
});

test('actual add form requires explicit sharing, submits once, blocks close while saving and never refills saved credentials', async () => {
  const saving = deferred<Response>(),
    calls: Array<{ url: string; init: RequestInit }> = [];
  let closes = 0;
  const ui = await harness(
    'web/src/components/AppsDialog.tsx',
    'AppsDialogContent',
    {
      ...props(),
      onClose: () => {
        closes++;
      },
    },
    (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (init.method === 'POST') return saving.promise;
      return json(
        String(url).endsWith('/tools')
          ? [{ name: 'read', description: '读取资料', inputSchema: { type: 'object' } }]
          : [],
      );
    }) as typeof fetch,
  );
  try {
    await ui.flush();
    ui.button('添加').props.onClick();
    await ui.flush();
    for (const [label, value] of [
      ['应用名称', '团队资料'],
      ['服务地址', app.url],
      ['认证方式', 'bearer'],
      ['访问密钥', 'test-only-secret'],
    ]) {
      ui.field(label).props.onChange({ target: { value } });
      await ui.flush();
    }
    ui.form().props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 0);
    ui.field('我确认').props.onChange({ target: { checked: true } });
    await ui.flush();
    const submit = ui.form().props.onSubmit;
    submit({ preventDefault() {} });
    submit({ preventDefault() {} });
    await ui.flush();
    ui.tree.props.onClose();
    assert.equal(closes, 0);
    const posts = calls.filter((call) => call.init.method === 'POST');
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(String(posts[0].init.body)), {
      name: '团队资料',
      url: app.url,
      authType: 'bearer',
      shared: true,
      token: 'test-only-secret',
    });
    saving.resolve(json(app));
    await ui.flush();
    assert.match(ui.copy, /访问密钥已保存/);
    assert.doesNotMatch(ui.copy, /test-only-secret/);
    ui.button('重新授权').props.onClick();
    await ui.flush();
    assert.equal(ui.field('新的访问密钥').props.value, '');
    ui.tree.props.onClose();
    assert.equal(closes, 1);
  } finally {
    saving.resolve(json(app));
    ui.dispose();
  }
});

test('actual add failure retains draft; uncertain outcomes require rereading the list, with no automatic retry', async () => {
  let added = false;
  const writes: any[] = [];
  const ui = await harness('web/src/components/AppsDialog.tsx', 'AppsDialogContent', props(), (async (
    _url: any,
    init: any,
  ) => {
    if (init.method === 'POST') {
      writes.push(JSON.parse(init.body));
      added = true;
      throw new TypeError('offline');
    }
    return json(added ? [app] : []);
  }) as typeof fetch);
  try {
    await ui.flush();
    ui.button('添加').props.onClick();
    await ui.flush();
    ui.field('应用名称').props.onChange({ target: { value: app.name } });
    await ui.flush();
    ui.field('服务地址').props.onChange({ target: { value: app.url } });
    await ui.flush();
    ui.field('我确认').props.onChange({ target: { checked: true } });
    await ui.flush();
    ui.form().props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.equal(ui.field('应用名称').props.value, app.name);
    assert.equal(ui.button('连接应用').props.disabled, true);
    assert.equal(writes.length, 1);
    ui.button('刷新状态').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /核对列表/);
    assert.match(ui.copy, /团队资料/);
    assert.equal(ui.maybeButton('连接应用'), undefined);
    assert.equal(writes.length, 1);
  } finally {
    ui.dispose();
  }
});

test('needs_auth can explicitly upgrade an unauthenticated connection; disconnect/delete remain separate confirmed actions', async () => {
  let stored: ConnectedApp = {
    ...app,
    authType: 'none',
    hasCredential: false,
    status: 'needs_auth',
  };
  const writes: Array<{ url: string; body: any; method: string }> = [];
  const ui = await harness('web/src/components/AppsDialog.tsx', 'AppsDialogContent', props(), (async (
    url: any,
    init: any,
  ) => {
    if (init.method === 'GET') return json(String(url).endsWith('/tools') ? [] : [stored]);
    writes.push({
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
      method: init.method,
    });
    if (init.method === 'DELETE') return json({ ok: true });
    stored = String(url).endsWith('/disconnect')
      ? { ...stored, status: 'disconnected', hasCredential: false }
      : {
          ...stored,
          authType: 'bearer',
          hasCredential: true,
          status: 'connected',
          revision: 'revision-b',
        };
    return json(stored);
  }) as typeof fetch);
  try {
    await ui.flush();
    all(
      ui.tree,
      (node) => node.type === 'button' && text(node).includes(app.name),
    )[0].props.onClick();
    await ui.flush();
    ui.button('重新授权').props.onClick();
    await ui.flush();
    ui.field('新的访问密钥').props.onChange({ target: { value: 'replacement-test-key' } });
    await ui.flush();
    ui.form().props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.deepEqual(writes[0].body, { token: 'replacement-test-key' });
    assert.match(ui.copy, /访问密钥已保存/);
    ui.button('断开连接').props.onClick();
    await ui.flush();
    assert.equal(writes.length, 1);
    assert.match(ui.copy, /所有 Bot 将无法继续使用/);
    ui.button('确认断开').props.onClick();
    await ui.flush();
    assert.equal(stored.status, 'disconnected');
    assert.equal(ui.button('重新连接').props.disabled, true);
    ui.button('移除应用').props.onClick();
    await ui.flush();
    assert.equal(writes.length, 2);
    ui.button('确认移除').props.onClick();
    await ui.flush();
    assert.equal(writes[2].method, 'DELETE');
    assert.match(ui.copy, /尚未连接应用/);
    assert.doesNotMatch(ui.copy, /undefined/);
  } finally {
    ui.dispose();
  }
});
