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
  agent,
  other,
  conversation,
  group,
  empty,
  selected,
  bootstrap,
  deferred,
  compile,
  appHookCallback,
} from './testSupport/primaryBotFixture';

test('actual App primary completion handler merges authority and preserves independent composer drafts', async () => {
  const source = await workspaceSource(),
    ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'PrimaryBotDialog') {
      const prop = node.attributes.properties.find(
        (item) => ts.isJsxAttribute(item) && item.name.getText(ast) === 'onSaved',
      ) as ts.JsxAttribute;
      assert.ok(prop?.initializer && ts.isJsxExpression(prop.initializer));
      callback = prop.initializer.expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback);
  const draft = { text: '尚未发送', attachments: [{ id: 'file-a' }], replyTo: { id: 'reply-a' } },
    composers = { [group.id]: draft, [conversation.id]: draft };
  let state = { ...bootstrap(empty), primaryCheckIn: { status: 'error' as const } },
    selectedId = group.id,
    nav = 0;
  const handler = runInNewContext(`(${callback.getText(ast)})`, {
    sync: { written() {} },
    setData: (update: any) => {
      state = update(state);
    },
    selectedRef: { current: group.id },
    setSelected: (id: string) => {
      selectedId = id;
    },
    showChat: () => nav++,
    setModal() {},
    setToast() {},
    refresh: async () => {},
    composers,
    updateComposer() {
      throw Error('Must not replace a draft');
    },
  });
  handler(selected, confirmedPrimary(bootstrap(), selected));
  assert.equal(selectedId, conversation.id);
  assert.equal(nav, 1);
  assert.equal(state.primaryBot?.revision, selected.revision);
  assert.equal(state.primaryCheckIn, undefined);
  assert.equal(composers[group.id], draft);
  assert.equal(composers[conversation.id], draft);
  handler({ ...empty, revision: 'cleared' });
  assert.equal(selectedId, conversation.id);
  assert.equal(nav, 1);
  assert.equal(state.conversations.length, 2);
});

test('the shared rendered list searches primary and regular chats, places primary once, and keeps hidden Bots out of mobile shortcuts', async () => {
  const { SidebarRosterList } = await compile('web/src/components/SidebarRoster.tsx');
  const data = { ...bootstrap(), messages: [] };
  const roster: SidebarRosterState = { revision: 'r1', sections: [], entries: [] };
  data.sidebarRoster = roster;
  const run = (query: string, mobile = false) =>
    render(SidebarRosterList, {
      data,
      query,
      mobile,
      selected: '',
      now: Date.now(),
      roster: { state: roster, busy: false, needsSync: false, error: '', write() {}, read() {} },
      onOpen() {},
      working: () => false,
      onDialog() {},
      onPrimary() {},
      onNotice() {},
    });
  assert.match(run('小松'), /roster-primary/);
  assert.match(run('小松'), /协作组的名单选项/, 'search also finds groups containing that Bot');
  assert.match(run('协作组'), /协作组的名单选项/);
  assert.doesNotMatch(run('协作组'), /roster-primary/);
  assert.match(run('不存在的会话'), /没有找到相关会话/);
  assert.match(run('不存在的会话', true), /协作组的名单选项/);
  const section = {
    id: '33333333-3333-4333-8333-333333333333',
    name: '我的项目',
    collapsed: false,
  };
  roster.sections.push(section);
  roster.entries.push({
    target: { kind: 'bot', id: agent.id },
    pinned: false,
    hidden: false,
    sectionId: section.id,
  });
  const inSection = run('');
  assert.doesNotMatch(inSection, /roster-primary/);
  assert.equal((inSection.match(/aria-label="小松的名单选项"/g) || []).length, 1);
  assert.match(inSection, /aria-label="我的项目"/);
  roster.entries[0].pinned = true;
  const pinned = run('');
  assert.doesNotMatch(pinned, /roster-primary/);
  assert.equal((pinned.match(/aria-label="小松的名单选项"/g) || []).length, 1);
  assert.match(pinned, /aria-label="置顶"/);
  const mobile = await compile('web/src/components/MobileHome.tsx');
  const third = { ...agent, id: 'agent-c', name: '小白' };
  const mobileData = {
    agents: [agent, other, third],
    conversations: [
      conversation,
      { ...conversation, id: 'dm-b', agentIds: [other.id], title: other.name, pinned: true },
      { ...conversation, id: 'dm-c', agentIds: [third.id], title: third.name },
    ],
    selectedId: '',
    primaryConversationId: conversation.id,
    sidebarRoster: roster,
    isWorking: () => false,
    onOpen() {},
  };
  roster.entries[0].hidden = true;
  roster.entries.push({
    target: { kind: 'bot', id: third.id },
    pinned: true,
    hidden: false,
    sectionId: null,
  });
  const shortcuts = render(mobile.MobileBotShortcuts, mobileData);
  assert.doesNotMatch(shortcuts, /打开与小松/);
  assert.ok(
    shortcuts.indexOf('打开与小白') < shortcuts.indexOf('打开与小叶'),
    'personal pins override the old shared pin',
  );
});

test('actual App roster receipt fences an older workspace GET, conditionally merges revisions, and never changes composer or selection', async () => {
  const code = await appHookCallback('roster', 'onChanged');
  const before: SidebarRosterState = { revision: 'r0', sections: [], entries: [] },
    saved: SidebarRosterState = {
      revision: 'r1',
      sections: [{ id: 'section', name: '我的分区', collapsed: false }],
      entries: [],
    },
    newest: SidebarRosterState = { ...saved, revision: 'r2' };
  let state = { ...bootstrap(), sync: { epoch: 'test', revision: 0 }, sidebarRoster: before },
    current = true,
    writes = 0;
  const draft = { text: '未发送的文字', attachments: ['file'], replyTo: 'message' },
    composers = { [conversation.id]: draft },
    selection = conversation.id;
  const old = deferred<Bootstrap>();
  let reads = 0;
  const sync = createWorkspaceSync({
    fetch: async () =>
      ++reads === 1
        ? old.promise
        : { ...state, sync: { epoch: 'test', revision: 1 }, sidebarRoster: saved },
    snapshot: (data) => {
      state = data as typeof state;
    },
    message() {},
    status() {},
  });
  const handler = runInNewContext(`(${code})`, {
    sendScope: { current: () => current, ticket: () => 0 },
    sync: {
      written() {
        writes++;
        sync.written();
      },
    },
    setData: (update: (value: typeof state) => typeof state) => {
      state = update(state);
    },
    composers,
  });
  try {
    const firstRead = sync.refresh();
    handler(saved, 'r0', true);
    assert.equal(writes, 1);
    assert.equal(state.sidebarRoster.revision, 'r1');
    old.resolve({ ...state, sidebarRoster: before });
    await firstRead;
    assert.equal(
      state.sidebarRoster.revision,
      'r1',
      'GET begun before write cannot replace the receipt',
    );
    const deadline = Date.now() + 3000;
    while (reads < 2) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setImmediate(resolve));
    sync.stop();
    state = { ...state, sidebarRoster: newest };
    handler(saved, 'r0', true);
    assert.equal(writes, 2, 'even an older receipt fences old GETs');
    assert.equal(
      state.sidebarRoster.revision,
      'r2',
      'newer SSE/GET authority survives an older receipt',
    );
    handler(before, 'r0', false);
    assert.equal(state.sidebarRoster.revision, 'r2');
    current = false;
    handler(saved, 'r2', true);
    assert.equal(writes, 2);
    assert.equal(state.sidebarRoster.revision, 'r2');
    assert.equal(composers[conversation.id], draft);
    assert.equal(selection, conversation.id);
  } finally {
    sync.stop();
  }
});

test('actual App first snapshot avoids stored hidden selections but preserves explicit links and later hidden active chats', async () => {
  const code = await appHookCallback('sync', 'snapshot');
  const hidden: Bootstrap = {
    ...bootstrap(),
    messages: [],
    sidebarRoster: {
      revision: 'r1',
      sections: [],
      entries: [
        { target: { kind: 'bot', id: agent.id }, hidden: true, pinned: false, sectionId: null },
      ],
    },
  };
  for (const explicit of [false, true]) {
    let selection = conversation.id;
    const initialized = { current: false },
      draft = { text: '保留我的草稿' },
      composers = { [conversation.id]: draft };
    const handler = runInNewContext(`(${code})`, {
      notifications: { baseline() {} },
      voice: { baseline() {} },
      reconcileReceipts() {},
      setData() {},
      selectionInitialized: initialized,
      initialExplicitSelection: { current: explicit },
      defaultConversation,
      setSelected: (update: (value: string) => string) => {
        selection = update(selection);
      },
      composers,
    });
    handler(hidden);
    assert.equal(selection, explicit ? conversation.id : group.id);
    selection = conversation.id;
    handler(hidden);
    assert.equal(selection, conversation.id);
    assert.equal(composers[conversation.id], draft);
  }
});
