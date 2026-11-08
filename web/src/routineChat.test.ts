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
import type { Routine } from '../../shared/types';
import { routineChatDestination, type RoutineChatRequest } from './routineChat';
import {
  json,
  deferred,
  text,
  component,
  workspaceId,
  userId,
  agent,
  second,
  chat,
  group,
  routine,
  data,
  submit,
  dialog,
  editButton,
} from './testSupport/routineChatFixture';

test('chat destination resolves exact IDs and the original routine conversation, without inventing another DM', () => {
  const create = routineChatDestination(data, {
    kind: 'create',
    conversationId: group.id,
    agentId: second.id,
  });
  assert.equal(create.agent, second);
  assert.equal(create.conversation, group);
  assert.equal(create.text, '帮我安排一个例行任务：');
  const edit: RoutineChatRequest = {
    kind: 'edit',
    routineId: routine.id,
    conversationId: chat.id,
    agentId: agent.id,
  };
  const result = routineChatDestination(data, edit);
  assert.equal(result.conversation, chat);
  assert.equal(result.routine, routine);
  assert.equal(result.text, '修改例行任务「每日简报」：');
  assert.throws(
    () => routineChatDestination(data, { ...edit, conversationId: group.id }),
    /移除或更换/,
  );
  assert.throws(() => routineChatDestination({ ...data, routines: [] }, edit), /移除或更换/);
  assert.throws(() => routineChatDestination({ ...data, conversations: [] }, edit), /已发生变化/);
  assert.throws(
    () =>
      routineChatDestination(data, { kind: 'create', conversationId: chat.id, agentId: second.id }),
    /已发生变化/,
  );
  assert.throws(
    () =>
      routineChatDestination(
        { ...data, agents: [{ ...agent, sharedBot: { status: 'revoked' } } as any] },
        edit,
      ),
    /共享 Bot 暂不可用/,
  );
});

test('actual create entry uses the visible selected Bot, respects unsaved fields, and never sends or saves by itself', async () => {
  const requests: RoutineChatRequest[] = [];
  let mutations = 0;
  const h = await dialog(
    {
      onChatRequest: async (request: RoutineChatRequest) => {
        requests.push(request);
      },
      onSave: async () => {
        mutations++;
      },
    },
    {
      fetch: async () => {
        mutations++;
        return json({});
      },
    },
  );
  try {
    assert.match(h.copy, /手动添加例行任务/);
    h.field('负责的 Bot').props.onChange({ target: { value: second.id } });
    h.field('任务名称').props.onChange({ target: { value: '未保存的手动计划' } });
    await h.flush();
    h.button('在聊天中安排').props.onClick();
    await h.flush();
    assert.equal(requests.length, 0);
    assert.match(h.copy, /放弃尚未保存/);
    h.button('继续编辑').props.onClick();
    await h.flush();
    assert.equal(h.field('任务名称').props.value, '未保存的手动计划');
    h.button('在聊天中安排').props.onClick();
    await h.flush();
    h.button('放弃更改并继续').props.onClick();
    await h.flush();
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), {
      kind: 'create',
      conversationId: group.id,
      agentId: second.id,
    });
    assert.equal(mutations, 0);
  } finally {
    h.dispose();
  }
});

test('actual edit-chat action retains the saved Bot and conversation even when its manual draft selects a different Bot', async () => {
  const requests: RoutineChatRequest[] = [];
  const original = { ...routine, conversationId: group.id };
  const h = await dialog({
    routines: [original],
    initialRoutineId: original.id,
    conversationId: chat.id,
    onChatRequest: async (request: RoutineChatRequest) => {
      requests.push(request);
    },
  });
  try {
    h.field('负责的 Bot').props.onChange({ target: { value: second.id } });
    await h.flush();
    editButton(h).props.onClick();
    await h.flush();
    assert.equal(requests.length, 0);
    h.button('放弃更改并继续').props.onClick();
    await h.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
      { kind: 'edit', routineId: routine.id, conversationId: group.id, agentId: agent.id },
    ]);
  } finally {
    h.dispose();
  }
});

test('late confirmation revalidates the current routine, and callback failure preserves the manual draft', async () => {
  let calls = 0;
  const h = await dialog({
    initialRoutineId: routine.id,
    onChatRequest: async () => {
      calls++;
      throw Error('目标会话已有草稿，请先核对');
    },
  });
  try {
    h.field('任务名称').props.onChange({ target: { value: '我的修改' } });
    await h.flush();
    editButton(h).props.onClick();
    await h.flush();
    h.setProps({ routines: [{ ...routine, agentId: second.id }] });
    await h.flush();
    h.button('放弃更改并继续').props.onClick();
    await h.flush();
    assert.equal(calls, 0);
    assert.match(h.copy, /移除或更换/);
    assert.equal(h.field('任务名称').props.value, '我的修改');
    h.setProps({ routines: [routine] });
    await h.flush();
    editButton(h).props.onClick();
    await h.flush();
    h.button('放弃更改并继续').props.onClick();
    await h.flush();
    assert.equal(calls, 1);
    assert.match(h.copy, /目标会话已有草稿/);
    assert.equal(h.field('任务名称').props.value, '我的修改');
  } finally {
    h.dispose();
  }
});

test('unknown persistent submission blocks both chat entry points until the original request is safely resolved', async () => {
  let calls = 0,
    requestId = '';
  const h = await dialog(
    {
      onChatRequest: async () => {
        calls++;
      },
    },
    {
      fetch: async (url: string, init: RequestInit) => {
        if (url.endsWith('/cancel'))
          return json({ requestId, status: 'not_submitted', userId, workspaceId });
        requestId = JSON.parse(String(init.body)).requestId;
        return json({ error: '结果未知' }, 503);
      },
    },
  );
  try {
    const oldCreate = h.button('在聊天中安排').props.onClick,
      oldEdit = editButton(h).props.onClick;
    h.field('任务名称').props.onChange({ target: { value: '新任务' } });
    h.field('要完成什么').props.onChange({ target: { value: '执行目标' } });
    await h.flush();
    await submit(h);
    await h.flush();
    assert.equal(h.button('在聊天中安排').props.disabled, true);
    assert.equal(editButton(h).props.disabled, true);
    oldCreate();
    oldEdit();
    await h.flush();
    assert.equal(calls, 0);
    h.button('结束提交核对').props.onClick();
    await h.flush();
    assert.equal(h.button('在聊天中安排').props.disabled, false);
  } finally {
    h.dispose();
  }
});

test('chat handoff is single-flight and blocks closing until its callback settles; stale busy callbacks do not dispatch', async () => {
  let calls = 0,
    closed = 0;
  const result = deferred<void>();
  const h = await dialog({
    onChatRequest: async () => {
      calls++;
      await result.promise;
    },
    onClose: () => {
      closed++;
    },
  });
  try {
    const click = h.button('在聊天中安排').props.onClick;
    h.setProps({ busy: true });
    await h.flush();
    click();
    assert.equal(calls, 0);
    h.setProps({ busy: false });
    await h.flush();
    click();
    click();
    await h.flush();
    assert.equal(calls, 1);
    assert.equal(h.button('在聊天中安排').props.disabled, true);
    component(h.tree, 'Dialog').props.onClose();
    assert.equal(closed, 0);
    result.resolve();
    await h.flush();
    assert.equal(h.button('在聊天中安排').props.disabled, false);
  } finally {
    result.resolve();
    h.dispose();
  }
});

test('account switches, workspace URL changes, and unmount invalidate old chat callbacks and dirty confirmations', async () => {
  for (const mode of ['account', 'workspace', 'unmount'] as const) {
    let calls = 0;
    const window = Object.assign(new EventTarget(), {
      location: { pathname: `/w/${workspaceId}` },
    });
    const h = await dialog(
      {
        onChatRequest: async () => {
          calls++;
        },
      },
      { window },
    );
    h.field('任务名称').props.onChange({ target: { value: '保留草稿' } });
    await h.flush();
    const click = h.button('在聊天中安排').props.onClick;
    click();
    await h.flush();
    const confirm = h.button('放弃更改并继续').props.onClick;
    if (mode === 'account') {
      h.setProps({ userId: 'owner-b' });
      await h.flush();
    } else if (mode === 'workspace')
      window.location.pathname = '/w/22222222-2222-4222-8222-222222222222';
    else h.dispose();
    click();
    confirm();
    await h.flush();
    assert.equal(calls, 0);
    if (mode !== 'unmount') h.dispose();
  }
});

test('without a chat callback the same dialog keeps its manual editor and does not show an unusable action', async () => {
  const h = await dialog({ onChatRequest: undefined });
  try {
    assert.match(h.copy, /添加例行任务/);
    assert.doesNotMatch(h.copy, /在聊天中安排|在聊天中修改/);
    assert.equal(h.field('负责的 Bot').props.value, agent.id);
  } finally {
    h.dispose();
  }
});
