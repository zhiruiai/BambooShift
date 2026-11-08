import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import type { BotAgent, Conversation } from '../../shared/types';
import type { CreationReceipt, CreationRequest } from '../../shared/creation-requests';
import {
  workspaceId,
  userId,
  agent,
  peer,
  json,
  deferred,
  storage,
  receipt,
  fixture,
  until,
  click,
  writes,
  text,
  all,
  component,
} from './testSupport/creationFlowFixture';

test('Bot creation uses one durable request, waits for explicit navigation and opens freshly checked entities', async () => {
  const f = await fixture({
    transport(call, fallback) {
      const response = fallback();
      if (call.method === 'GET')
        return response.json().then((value) =>
          json({
            ...value,
            conversation: { ...value.conversation, title: 'Latest saved title' },
            agents: value.agents.map((a: BotAgent) => ({ ...a, role: 'Latest role' })),
          }),
        );
      return response;
    },
  });
  try {
    await f.fill();
    await f.submit();
    await until(f.ui, () => f.ui.copy.includes('已创建'));
    assert.equal(f.opened.length, 0);
    assert.equal(writes(f.calls).length, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(writes(f.calls)[0].body.kind, 'bot');
    assert.equal(writes(f.calls)[0].body.profile.name, 'My synthetic Bot');
    assert.ok(f.calls.every((call) => call.headers.get('X-OpenBot-Expected-User') === userId));
    assert.doesNotMatch(
      f.calls.map((call) => call.path).join(' '),
      /\/agents|\/bootstrap|\/conversations/,
    );
    await click(f.ui, '打开会话');
    await until(f.ui, () => f.opened.length === 1);
    assert.equal(f.opened[0].conversation.title, 'Latest saved title');
    assert.equal(f.opened[0].agents?.[0].role, 'Latest role');
    assert.equal(f.memory.values.size, 0);
    assert.equal(writes(f.calls).length, 1);
  } finally {
    f.ui.dispose();
  }
});

test('a member creates a group using the selected order without gaining Bot creation', async () => {
  const f = await fixture({ member: true });
  try {
    assert.equal(
      all(f.ui.tree, (node) => node.type === 'button' && text(node) === '创建 Bot').length,
      0,
    );
    component(f.ui.tree, 'GroupRecipients').props.onChange([agent.id, peer.id]);
    await f.ui.flush();
    await f.submit();
    await until(f.ui, () => f.ui.copy.includes('已创建'));
    assert.equal(writes(f.calls)[0].body.kind, 'group');
    assert.deepEqual(writes(f.calls)[0].body.agentIds, [agent.id, peer.id]);
    assert.equal(f.opened.length, 0);
  } finally {
    f.ui.dispose();
  }
});

test('lost submission preserves the frozen draft and repeats only the same request after a read confirms no receipt', async () => {
  let attempt = 0;
  const f = await fixture({
    transport(call, fallback) {
      if (call.method === 'POST' && call.path.endsWith('/creation-requests') && ++attempt === 1)
        throw new TypeError('synthetic lost response');
      return fallback();
    },
  });
  try {
    await f.fill('Keep my edited name');
    await f.submit();
    await until(f.ui, () => f.ui.copy.includes('创建结果待核实'));
    assert.equal(f.profile().props.draft.name, 'Keep my edited name');
    assert.equal(f.profile().props.disabled, true);
    assert.equal(f.memory.values.size, 1);
    assert.doesNotMatch(
      [...f.memory.values.values()].join(''),
      /Keep my edited name|SYNTHETIC_PRIVATE_INSTRUCTIONS/,
    );
    assert.equal(f.ui.button('重试同一次创建').props.disabled, true);
    await click(f.ui, '核对原请求');
    await click(f.ui, '重试同一次创建');
    await until(f.ui, () => f.ui.copy.includes('已创建'));
    assert.equal(writes(f.calls).length, 2);
    assert.deepEqual(writes(f.calls)[0].body, writes(f.calls)[1].body);
    assert.equal(f.opened.length, 0);
  } finally {
    f.ui.dispose();
  }
});

test('reopening an unknown request reads only and can explicitly seal it before creating with a fresh ID', async () => {
  const memory = storage();
  const first = await fixture({
    memory,
    transport(call, fallback) {
      if (call.method === 'POST' && call.path.endsWith('/creation-requests'))
        throw new TypeError('offline');
      return fallback();
    },
  });
  await first.fill();
  await first.submit();
  await until(first.ui, () => first.ui.copy.includes('创建结果待核实'));
  const oldId = writes(first.calls)[0].body.requestId;
  first.ui.dispose();
  const next = await fixture({ memory });
  try {
    await until(next.ui, () => next.ui.copy.includes('创建结果待核实'));
    assert.equal(writes(next.calls).length, 0);
    assert.equal(next.calls[0].method, 'GET');
    assert.equal(
      all(next.ui.tree, (node) => node.type === 'button' && text(node) === '重试同一次创建').length,
      0,
    );
    await click(next.ui, '结束本次核对');
    assert.equal(memory.values.size, 0);
    await next.fill('A separately confirmed new Bot');
    await next.submit();
    await until(next.ui, () => next.ui.copy.includes('已创建'));
    assert.notEqual(writes(next.calls)[0].body.requestId, oldId);
    assert.equal(writes(next.calls).length, 1);
  } finally {
    next.ui.dispose();
  }
});

test('a created item deleted before navigation becomes missing and never opens or recreates it', async () => {
  const f = await fixture({
    transport(call, fallback) {
      const response = fallback();
      if (call.method === 'GET')
        return response.json().then((value) => {
          const { conversation: _chat, ...rest } = value;
          return json({ ...rest, status: 'missing', agents: [] });
        });
      return response;
    },
  });
  try {
    await f.fill();
    await f.submit();
    await until(f.ui, () => f.ui.copy.includes('已创建'));
    await click(f.ui, '打开会话');
    assert.match(f.ui.copy, /原项目已删除或已不可用/);
    assert.equal(f.opened.length, 0);
    assert.equal(writes(f.calls).length, 1);
    assert.equal(f.memory.values.size, 1);
    await click(f.ui, '继续新建');
    assert.equal(f.memory.values.size, 0);
    assert.equal(f.profile().props.draft.name, '');
  } finally {
    f.ui.dispose();
  }
});

test('a navigation failure retains the confirmed receipt; retrying navigation reads again but never repeats creation', async () => {
  let navigation = 0;
  const f = await fixture({
    onCreated() {
      if (++navigation === 1) throw Error('synthetic navigation failure');
    },
  });
  try {
    await f.fill();
    await f.submit();
    await until(f.ui, () => f.ui.copy.includes('已创建'));
    await click(f.ui, '打开会话');
    assert.match(f.ui.copy, /会话暂未打开/);
    assert.equal(f.memory.values.size, 1);
    await click(f.ui, '打开会话');
    assert.equal(f.opened.length, 1);
    assert.equal(writes(f.calls).length, 1);
    assert.equal(f.calls.filter((call) => call.method === 'GET').length, 2);
    assert.equal(f.memory.values.size, 0);
  } finally {
    f.ui.dispose();
  }
});

test('late submission results and saved click handlers cannot cross an account change', async () => {
  const pending = deferred<Response>();
  let complete!: () => Response;
  const f = await fixture({
    transport(call, fallback) {
      if (call.method === 'POST') {
        complete = fallback;
        return pending.promise;
      }
      return fallback();
    },
  });
  try {
    await f.fill();
    await f.submit();
    await until(f.ui, () => writes(f.calls).length === 1);
    const metadata = [...f.memory.values.entries()];
    f.ui.setProps({ userId: '33333333-3333-4333-8333-333333333333' });
    await f.ui.flush();
    pending.resolve(complete());
    await f.ui.flush();
    assert.equal(f.opened.length, 0);
    assert.deepEqual([...f.memory.values.entries()], metadata);
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch(f.ui.copy, /可以打开会话/);
  } finally {
    f.ui.dispose();
  }
  const g = await fixture();
  try {
    await g.fill();
    await g.submit();
    await until(g.ui, () => g.ui.copy.includes('已创建'));
    const open = g.ui.button('打开会话').props.onClick;
    g.ui.setProps({ workspaceId: '44444444-4444-4444-8444-444444444444' });
    await g.ui.flush();
    open();
    await g.ui.flush();
    assert.equal(g.calls.length, 1);
    assert.equal(g.opened.length, 0);
  } finally {
    g.ui.dispose();
  }
});

test('pending avatar edits still block submission and model settings preserve the smart-team view', async () => {
  const f = await fixture();
  try {
    await f.fill('Latest text');
    const fields = f.profile();
    fields.props.onAvatarActivity({ pending: true, busy: false });
    await f.submit();
    assert.equal(f.calls.length, 0);
    assert.match(f.ui.copy, /先确认或取消头像裁剪/);
    fields.props.onAvatarActivity({ pending: false, busy: false });
    fields.props.onAvatarChange({ avatarImageId: '55555555-5555-4555-8555-555555555555' });
    await f.ui.flush();
    await f.submit();
    await until(f.ui, () => f.ui.copy.includes('已创建'));
    assert.equal(writes(f.calls)[0].body.profile.name, 'Latest text');
    assert.equal(
      writes(f.calls)[0].body.profile.avatarImageId,
      '55555555-5555-4555-8555-555555555555',
    );
  } finally {
    f.ui.dispose();
  }
  const g = await fixture({ mode: 'team' });
  try {
    const team = component(g.ui.tree, 'SmartTeamPanel');
    team.props.onDirty(true);
    team.props.onConfigureModel();
    await g.ui.flush();
    assert.equal(component(g.ui.tree, 'Dialog').props.active, false);
    assert.equal(component(g.ui.tree, 'SmartTeamPanel').props.disabled, true);
    component(g.ui.tree, 'SettingsDialog').props.onClose();
    await g.ui.flush();
    assert.equal(component(g.ui.tree, 'Dialog').props.active, true);
    assert.equal(component(g.ui.tree, 'SmartTeamPanel').props.disabled, false);
    assert.equal(g.calls.length, 0);
  } finally {
    g.ui.dispose();
  }
});
