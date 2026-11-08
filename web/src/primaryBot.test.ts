import { expandPureViews } from './testSupport/expandPureViews';
import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import React from 'react';
import type { Bootstrap, BotAgent, Conversation } from '../../shared/types';
import type { PrimaryBotState } from '../../shared/primary-bot';
import type { SidebarRosterState } from '../../shared/sidebar-roster';
import { createWorkspaceSync } from './workspaceSync';
import {
  confirmedPrimary,
  conversationSelectionKey,
  createPrimaryBotScope,
  defaultConversation,
  primaryConversation,
} from './primaryBot';
import {
  render,
  workspaceId,
  userId,
  agent,
  other,
  conversation,
  group,
  empty,
  selected,
  bootstrap,
  json,
  deferred,
  compile,
  all,
  harness,
} from './testSupport/primaryBotFixture';

test('primary default preserves valid links/current conversations and isolates stored selection by account/space', () => {
  assert.equal(defaultConversation(group.id, bootstrap()), group.id);
  assert.equal(defaultConversation(conversation.id, bootstrap(empty)), conversation.id);
  assert.equal(defaultConversation('deleted', bootstrap()), conversation.id);
  assert.equal(defaultConversation('', bootstrap(empty)), '');
  assert.equal(
    defaultConversation('', bootstrap({ ...empty, available: false, reason: 'team_workspace' })),
    group.id,
  );
  assert.equal(defaultConversation('', { agents: [agent], conversations: [group] }), group.id);
  assert.equal(
    primaryConversation({ agents: [], conversations: [conversation] }, selected),
    undefined,
  );
  assert.equal(
    primaryConversation(
      { agents: [agent], conversations: [{ ...conversation, isGroup: true }] },
      selected,
    ),
    undefined,
  );
  assert.notEqual(
    conversationSelectionKey({ workspaceId, userId }),
    conversationSelectionKey({ workspaceId, userId: 'other' }),
  );
  assert.notEqual(
    conversationSelectionKey({ workspaceId, userId }),
    conversationSelectionKey({ workspaceId: 'other', userId }),
  );
  assert.notEqual(conversationSelectionKey({}), 'openbot-selected');
});

test('a hidden Bot is excluded only from automatic selection, preserving explicit history and active drafts', () => {
  const data = bootstrap();
  data.sidebarRoster = {
    revision: 'r1',
    sections: [],
    entries: [
      { target: { kind: 'bot', id: agent.id }, hidden: true, pinned: true, sectionId: null },
    ],
  };
  assert.equal(defaultConversation(conversation.id, data), group.id);
  assert.equal(defaultConversation('', data), group.id);
  assert.equal(
    defaultConversation(conversation.id, data, { preserveHidden: true }),
    conversation.id,
  );
  data.sidebarRoster.entries.push({
    target: { kind: 'conversation', id: group.id },
    hidden: true,
    pinned: true,
    sectionId: null,
  });
  assert.equal(defaultConversation(group.id, data), '');
  assert.equal(defaultConversation(group.id, data, { preserveHidden: true }), group.id);
  assert.deepEqual(data.primaryBot, selected, 'hiding never changes the primary role or schedule');
});

test('actual introduction/sidebar and mobile shortcuts show primary without confusing shared team Bots', async () => {
  const module = await compile('web/src/components/PrimaryBotEntry.tsx');
  const intro = render(module.PrimaryBotIntroduction, { onManage() {} });
  assert.match(intro, /创建主 Bot/);
  assert.match(intro, /选择已有 Bot/);
  const common = {
    agent,
    conversation,
    selected: false,
    working: false,
    onOpen() {},
    onManage() {},
  };
  const entry = render(module.PrimaryBotEntry, { ...common, state: selected });
  assert.match(entry, /主 Bot 菜单/);
  assert.match(entry, /每天 09:00/);
  assert.match(entry, /北京时间跟进/);
  const unavailable = render(module.PrimaryBotEntry, {
    ...common,
    agent: undefined,
    conversation: undefined,
    state: { ...empty, available: false, reason: 'team_workspace' },
  });
  assert.match(unavailable, /在个人空间设置/);
  assert.doesNotMatch(unavailable, /主 Bot 菜单/);
  const noModel = render(module.PrimaryBotEntry, {
    ...common,
    state: selected,
    checkInStatus: { status: 'no_model' },
  });
  assert.match(noModel, /需要先连接模型/);
  const mobile = await compile('web/src/components/MobileHome.tsx');
  const html = render(mobile.MobileBotShortcuts, {
    agents: [agent, other],
    conversations: [
      { ...conversation, id: 'dm-b', title: other.name, agentIds: [other.id], pinned: true },
      conversation,
    ],
    selectedId: '',
    primaryConversationId: conversation.id,
    isWorking: () => false,
    onOpen() {},
  });
  assert.ok(html.indexOf('打开与小松') < html.indexOf('打开与小叶'));
});

test('saved follow-up status is truthful Beijing time and refreshes independently of dirty configuration', async () => {
  const { PrimaryBotFollowUpStatus } = await compile('web/src/components/PrimaryBotDialog.tsx');
  for (const [status, label] of [
    ['no_model', '需要先连接模型'],
    ['running', '正在主动跟进'],
    ['error', '未完成'],
    ['interrupted', '已中断'],
    ['completed', '已完成'],
    ['disabled', '已关闭'],
  ] as const) {
    assert.match(
      render(PrimaryBotFollowUpStatus, { state: selected, status: { status } }),
      new RegExp(label),
    );
  }
  const next = render(PrimaryBotFollowUpStatus, {
    state: selected,
    status: { status: 'waiting', nextRunAt: '2030-01-02T01:15:00Z' },
  });
  assert.match(next, /下次跟进/);
  assert.match(next, /09:15/);
  assert.match(next, /北京时间/);
  const overdue = render(PrimaryBotFollowUpStatus, {
    state: selected,
    status: { status: 'waiting', nextRunAt: '2000-01-02T01:15:00Z' },
  });
  assert.match(overdue, /等待处理，原定/);
  assert.doesNotMatch(overdue, /下次跟进：/);
  assert.equal(
    render(PrimaryBotFollowUpStatus, { state: empty, status: { status: 'completed' } }),
    '',
  );
  const view = await harness({ state: selected, checkInStatus: { status: 'waiting' } }, async () =>
    json(selected),
  );
  await view.flush();
  view.field('跟进时间').props.onChange({ target: { value: '10:30' } });
  await view.flush();
  view.update({ checkInStatus: { status: 'error', reason: '模型暂不可用' } });
  await view.flush();
  assert.equal(view.field('跟进时间').props.value, '10:30');
  const statusNode = all(view.tree, (node) => node.type?.name === 'PrimaryBotFollowUpStatus')[0];
  assert.equal(statusNode.props.status.status, 'error');
  view.tree.props.onClose();
  await view.flush();
  assert.match(view.text, /放弃尚未保存/);
  view.dispose();
});

test('HTTP 408 is uncertain and cannot reopen a create submit until current state is checked', async () => {
  let writes = 0;
  const view = await harness({ state: selected, initialMode: 'select' }, async (_url, init) => {
    if (init?.method === 'PUT') {
      writes++;
      return json({ error: '超时' }, 408);
    }
    return json(selected);
  });
  await view.flush();
  view.submit();
  await view.flush();
  assert.match(view.text, /无法确认是否已保存/);
  view.submit();
  await view.flush();
  assert.equal(writes, 1);
  assert.ok(view.button('检查当前设置'));
  view.dispose();
});

test('existing Bot saves explicit check-in/CAS under fixed identity and only opens a confirmed real DM', async () => {
  const put = deferred<Response>(),
    read = deferred<Response>(),
    calls: Array<{ url: string; init?: RequestInit }> = [],
    saved: any[] = [];
  let closed = 0;
  const view = await harness(
    {
      initialMode: 'select',
      onSaved: (...args: any[]) => saved.push(args),
      onClose: () => closed++,
    },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return init?.method === 'PUT'
        ? put.promise
        : String(url).endsWith('/bootstrap')
          ? read.promise
          : json(empty);
    },
  );
  await view.flush();
  view.choice(agent.id).props.onClick();
  await view.flush();
  view.field('每天主动跟进').props.onChange({ target: { checked: false } });
  await view.flush();
  view.submit();
  await view.flush();
  view.tree.props.onClose();
  assert.equal(closed, 0);
  assert.equal(saved.length, 0);
  const call = calls.find((item) => item.init?.method === 'PUT')!;
  assert.equal(call.url, `/api/workspaces/${workspaceId}/primary-bot`);
  assert.equal(new Headers(call.init?.headers).get('X-OpenBot-Expected-User'), userId);
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    mode: 'select',
    agentId: agent.id,
    checkIn: { enabled: false, time: '09:00', timeZone: 'Asia/Shanghai' },
    expectedRevision: 'unset',
  });
  put.resolve(json(selected));
  await view.flush();
  assert.equal(saved.length, 0);
  read.resolve(json(bootstrap()));
  await view.flush();
  assert.equal(saved.length, 1);
  assert.equal(saved[0][1].conversation.id, conversation.id);
  assert.equal(calls.filter((item) => item.init?.method === 'PUT').length, 1);
  view.dispose();
});

test('create uses actual profile fields, validates drafts and submits one atomic primary mutation', async () => {
  const writes: any[] = [],
    saved: any[] = [];
  const view = await harness(
    { onSaved: (...args: any[]) => saved.push(args) },
    async (url, init) => {
      if (init?.method === 'PUT') {
        writes.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return json(selected);
      }
      return json(String(url).endsWith('/bootstrap') ? bootstrap() : empty);
    },
  );
  await view.flush();
  view.submit();
  await view.flush();
  assert.match(view.text, /名称请填写/);
  assert.equal(writes.length, 0);
  view.field('Bot 名称').props.onChange({ target: { value: agent.name } });
  await view.flush();
  view.field('工作角色').props.onChange({ target: { value: agent.role } });
  await view.flush();
  view.field('长期指令').props.onChange({ target: { value: '先整理优先级' } });
  await view.flush();
  view.submit();
  await view.flush();
  assert.equal(writes.length, 1);
  assert.ok(writes[0].url.endsWith('/primary-bot'));
  assert.equal(writes[0].body.mode, 'create');
  assert.equal(writes[0].body.bot.instructions, '先整理优先级');
  assert.deepEqual(writes[0].body.checkIn, {
    enabled: true,
    time: '09:00',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(saved.length, 1);
  view.dispose();
});
