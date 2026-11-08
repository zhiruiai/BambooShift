import { expandPureViews } from './testSupport/expandPureViews';
import { componentSource } from './testSupport/componentSource';
import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import React from 'react';
import ts from 'typescript';
import {
  ids,
  json,
  deferred,
  storage,
  environment,
  compile,
  all,
  harness,
  card,
  alias,
  conversation,
  receipt,
  personal,
  sharing,
} from './testSupport/sharedBotsFixture';

test('shared avatar addresses are exact same-origin revision URLs; client keeps the actor and drops late replies', async () => {
  const env = environment();
  let user: string | undefined = ids.user;
  const late = deferred<Response>(),
    calls: any[] = [];
  const api = await compile('web/src/sharedBots.ts', '', env);
  const path = `/api/shared-bots/${ids.share}/avatar?revision=${'a'.repeat(64)}`;
  assert.equal(api.sharedAvatarPath(path), path);
  for (const invalid of [
    `https://evil.example${path}`,
    path + '&other=1',
    path + '#x',
    path.replace('revision=', 'r='),
    path.replace(ids.share, 'wrong'),
  ])
    assert.equal(api.sharedAvatarPath(invalid), undefined);
  const client = api.createSharedBotClient({
    userId: ids.user,
    identity: () => user,
    fetch: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return late.promise;
    },
  });
  const request = client.request('/shared-bots');
  user = undefined;
  late.resolve(json([card]));
  await assert.rejects(request, (error: any) => error.name === 'AbortError');
  await assert.rejects(client.request('/shared-bots'), (error: any) => error.name === 'AbortError');
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0].init.headers).get('X-OpenBot-Expected-User'), ids.user);
});

test('unknown shared join restores one immutable request, checks 404 then retries the same id and confirms actual personal alias/DM', async () => {
  const env = environment(),
    api = await compile('web/src/sharedBots.ts', '', env),
    calls: any[] = [];
  let mode = 'unknown',
    requestId = '';
  const client = api.createSharedBotClient({
    userId: ids.user,
    identity: () => ids.user,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/bootstrap'))
        return json({ agents: [alias], conversations: [conversation] });
      if (init.method === 'GET')
        return mode === 'missing' ? json({ error: '未找到回执' }, 404) : json(receipt(requestId));
      const body = JSON.parse(String(init.body));
      requestId = body.requestId;
      if (mode === 'unknown') throw new TypeError('lost response');
      return json(receipt(requestId));
    },
  });
  const options = {
    client,
    userId: ids.user,
    workspaceId: ids.personal,
    storage: env.sessionStorage,
    onChange() {},
  };
  const first = api.createSharedBotJoin(options);
  await first.start(ids.share);
  assert.equal(first.state().pending.requestId, requestId);
  first.suspend();
  const restored = api.createSharedBotJoin(options);
  mode = 'missing';
  await restored.check();
  assert.equal(restored.state().retryAllowed, true);
  mode = 'success';
  await restored.retry();
  assert.equal(restored.state().confirmed.conversation.id, ids.conversation);
  assert.equal(restored.state().pending, undefined);
  const writes = calls.filter((call) => call.init.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].init.body, writes[1].init.body);
  assert.equal(env.sessionStorage.values.size, 0);
  assert.ok(
    calls.every(
      (call) =>
        call.url.startsWith(`/api/workspaces/${ids.personal}/`) &&
        new Headers(call.init.headers).get('X-OpenBot-Expected-User') === ids.user,
    ),
  );
});

test('shared join never invents a missing conversation or adopts a receipt from another actor; late account cannot continue to bootstrap', async () => {
  for (const mode of ['missing', 'wrong', 'late'] as const) {
    const env = environment(),
      api = await compile('web/src/sharedBots.ts', '', env),
      late = deferred<Response>();
    let user: string | undefined = ids.user,
      posts = 0,
      reads = 0,
      requestId = '';
    const client = api.createSharedBotClient({
      userId: ids.user,
      identity: () => user,
      fetch: async (url: string, init: RequestInit) => {
        if (init.method === 'POST') {
          posts++;
          requestId = JSON.parse(String(init.body)).requestId;
          return mode === 'late'
            ? late.promise
            : json({ ...receipt(requestId), ...(mode === 'wrong' ? { actorId: 'other' } : {}) });
        }
        reads++;
        return json({ agents: [alias], conversations: [] });
      },
    });
    const join = api.createSharedBotJoin({
      client,
      userId: ids.user,
      workspaceId: ids.personal,
      storage: env.sessionStorage,
      onChange() {},
    });
    const running = join.start(ids.share);
    if (mode === 'late') {
      user = 'other';
      late.resolve(json(receipt(requestId)));
    }
    await running;
    assert.equal(join.state().confirmed, undefined);
    assert.ok(join.state().pending);
    assert.equal(posts, 1);
    assert.equal(reads, mode === 'missing' ? 1 : 0);
  }
});

test('actual shared browser lets a team member join only the personal target, blocks close while pending, and opens only after confirmation', async () => {
  const late = deferred<Response>(),
    calls: any[] = [];
  let id = '',
    opened: any,
    closed = 0;
  const ui = await harness(
    'web/src/components/SharedBotsDialog.tsx',
    'SharedBotsContent',
    {
      userId: ids.user,
      personalWorkspace: personal,
      teams: [],
      initialTeamId: ids.team,
      onClose: () => closed++,
      onOpen: (value: any) => {
        opened = value;
      },
    },
    (async (url, init) => {
      calls.push({ url: String(url), init });
      if (init?.method === 'POST') {
        id = JSON.parse(String(init.body)).requestId;
        return late.promise;
      }
      if (String(url).endsWith('/bootstrap'))
        return json({ agents: [alias], conversations: [conversation] });
      return json([card]);
    }) as typeof fetch,
  );
  try {
    await ui.flush();
    assert.match(ui.copy, /发布者和团队成员不能读取/);
    ui.button('加入个人空间').props.onClick();
    await ui.flush();
    ui.tree.props.onClose();
    assert.equal(closed, 0);
    assert.equal(opened, undefined);
    late.resolve(json(receipt(id)));
    await ui.flush();
    assert.equal(opened, undefined);
    ui.button('打开私人会话').props.onClick();
    assert.equal((opened as any)?.conversation.id, ids.conversation);
    assert.equal(calls.filter((call) => call.init?.method === 'POST').length, 1);
  } finally {
    ui.dispose();
  }
});

test('actual sharing form preserves unknown payload across reopen and requires explicit retry or revoke confirmation', async () => {
  const env = environment(),
    writes: any[] = [];
  let mode = 'unknown',
    changed = 0,
    closed = 0;
  const saved = {
    ...sharing,
    share: {
      id: ids.share,
      sourceWorkspaceId: ids.personal,
      sourceAgentId: 'chief',
      createdBy: ids.user,
      targetTeamId: ids.team,
      audience: 'selected',
      memberIds: [ids.user],
      status: 'active',
      revision: ids.revision,
      accessRevision: ids.revision,
      createdAt: 'now',
      updatedAt: 'now',
    },
  };
  const props = {
    userId: ids.user,
    workspaceId: ids.personal,
    workspaceKind: 'team',
    agentId: 'chief',
    agentName: '小松',
    onClose: () => closed++,
    onChanged: async () => {
      changed++;
    },
  };
  const fetcher = (async (url: any, init: any) => {
    if (init.method === 'GET') return json(mode === 'unknown' ? sharing : saved);
    writes.push({ url, body: JSON.parse(init.body) });
    if (mode === 'unknown') throw new TypeError('lost response');
    return json({
      ...saved,
      share: { ...saved.share, status: String(url).endsWith('/revoke') ? 'revoked' : 'active' },
    });
  }) as typeof fetch;
  const first = await harness(
    'web/src/components/SharedBotsDialog.tsx',
    'ManageSharedBotContent',
    props,
    fetcher,
    env,
  );
  await first.flush();
  first.field('谁可以使用').props.onChange({ target: { value: 'selected' } });
  await first.flush();
  first.field('林').props.onChange({ target: { checked: true } });
  await first.flush();
  assert.match(first.copy, /原团队会话和资料仍然团队可见/);
  first.tree.props.onClose();
  await first.flush();
  assert.equal(closed, 0);
  first.button('继续处理').props.onClick();
  first.button('保存并共享').props.onClick?.();
  all(first.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  await first.flush();
  assert.equal(writes.length, 1);
  assert.match(first.copy, /上次保存结果尚未确认/);
  first.dispose();
  mode = 'saved';
  const reopened = await harness(
    'web/src/components/SharedBotsDialog.tsx',
    'ManageSharedBotContent',
    props,
    fetcher,
    env,
  );
  try {
    await reopened.flush();
    assert.equal(reopened.field('共享到团队').props.disabled, true);
    reopened.button('重试原请求').props.onClick();
    await reopened.flush();
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].body, writes[1].body);
    assert.equal(changed, 1);
    reopened.button('撤销共享').props.onClick();
    await reopened.flush();
    assert.equal(writes.length, 2);
    reopened.button('确认撤销共享').props.onClick();
    await reopened.flush();
    assert.equal(writes.length, 3);
    assert.ok(String(writes[2].url).endsWith('/sharing/revoke'));
    assert.match(reopened.copy, /已撤销共享/);
  } finally {
    reopened.dispose();
  }
});
