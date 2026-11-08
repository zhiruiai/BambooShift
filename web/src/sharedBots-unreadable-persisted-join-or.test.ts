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
  storage,
  environment,
  compile,
  text,
  all,
  harness,
  alias,
  conversation,
  receipt,
  personal,
  sharing,
} from './testSupport/sharedBotsFixture';

test('unreadable persisted join or sharing request blocks new mutations instead of overwriting an unknown attempt', async () => {
  const store = storage(),
    calls: string[] = [];
  store.setItem(`openbot-shared-join:${ids.user}:${ids.personal}`, '{broken');
  const module = await compile('web/src/sharedBots.ts', '', environment());
  const client = module.createSharedBotClient({
    userId: ids.user,
    identity: () => ids.user,
    fetch: async (url: any) => {
      calls.push(String(url));
      return json([]);
    },
  });
  const join = module.createSharedBotJoin({
    client,
    userId: ids.user,
    workspaceId: ids.personal,
    storage: store,
    onChange() {},
  });
  await join.start(ids.share);
  assert.equal(calls.length, 0);
  assert.equal(join.state().recoveryBlocked, true);
  store.setItem(`openbot-sharing:${ids.user}:${ids.team}:${ids.agent}`, '{broken');
  const ui = await harness(
    'web/src/components/SharedBotsDialog.tsx',
    'ManageSharedBotContent',
    {
      userId: ids.user,
      workspaceId: ids.team,
      workspaceKind: 'team',
      agentId: ids.agent,
      agentName: '小松',
      onClose() {},
      async onChanged() {},
    },
    async (url, init) => {
      calls.push(init?.method || 'GET');
      return json(sharing);
    },
    { sessionStorage: store },
  );
  try {
    await ui.flush();
    assert.match(ui.copy, /尚未发送新请求/);
    assert.equal(ui.button('保存并共享').props.disabled, true);
    all(ui.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.deepEqual(calls, ['GET']);
  } finally {
    ui.dispose();
  }
});

test('shared Bot settings remain readonly even for its personal owner while personal resources stay reachable; primary selector excludes references', async () => {
  let files = 0,
    skills = 0;
  const props = {
    agent: alias,
    computer: { connected: false },
    workspaceId: ids.personal,
    userId: ids.user,
    workspaceKind: 'personal',
    readOnly: false,
    busy: false,
    deleteBlocked: '',
    boundScreen: false,
    skillCount: 2,
    fileCount: 0,
    onComputer() {},
    onSkills() {
      skills++;
    },
    onFiles() {
      files++;
    },
    onCopy() {
      throw Error('copy');
    },
    onShare() {
      throw Error('template');
    },
    onManageSharing() {
      throw Error('share');
    },
    onClose() {},
    onSaved() {},
    onDeleted() {},
  };
  const ui = await harness(
    'web/src/components/AgentDialog.tsx',
    'AgentSettingsContent',
    props,
    async () => {
      throw Error('unexpected request');
    },
  );
  try {
    await ui.flush();
    assert.match(ui.copy, /配置和技能由发布者维护/);
    assert.equal(all(ui.tree, (node) => node.type?.name === 'BotProfileFields').length, 0);
    assert.doesNotMatch(ui.copy, /保存更改|删除 Bot|复制 Bot|发布模板/);
    all(
      ui.tree,
      (node) => node.type === 'button' && text(node).startsWith('会话资料'),
    )[0].props.onClick();
    all(
      ui.tree,
      (node) => node.type === 'button' && text(node).startsWith('相关技能'),
    )[0].props.onClick();
    assert.equal(files, 1);
    assert.equal(skills, 1);
  } finally {
    ui.dispose();
  }
  const state = {
    available: true,
    revision: 'unset',
    agentId: ids.agent,
    conversationId: ids.conversation,
    checkIn: { enabled: true, time: '09:00' },
  };
  let writes = 0;
  const primary = await harness(
    'web/src/components/PrimaryBotDialog.tsx',
    'PrimaryBotContent',
    {
      state,
      agents: [alias, { ...alias, id: ids.team, name: '自己的 Bot', sharedBot: undefined }].map(
        (item, index) => {
          if (index) delete item.sharedBot;
          return item;
        },
      ),
      workspaceId: ids.personal,
      userId: ids.user,
      team: false,
      initialMode: 'select',
      onClose() {},
      onSaved() {},
    },
    async (_url, init) => {
      if (init?.method !== 'GET') writes++;
      return json(state);
    },
    { window: Object.assign(new EventTarget(), { location: { pathname: `/w/${ids.personal}` } }) },
  );
  try {
    await primary.flush();
    assert.equal(
      all(
        primary.tree,
        (node) =>
          node.type === 'button' &&
          node.props.className?.includes('primary-bot-choice') &&
          text(node).startsWith(alias.name),
      ).length,
      0,
    );
    all(primary.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    await primary.flush();
    assert.equal(writes, 0);
    assert.match(primary.copy, /请选择一位当前空间的 Bot/);
  } finally {
    primary.dispose();
  }
});

test('actual App shared navigation preserves every composer until explicit cross-space confirmation and blocks unfinished operations and stale accounts', async () => {
  const source = await workspaceSource(),
    ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let node: ts.FunctionDeclaration | undefined;
  const find = (item: ts.Node) => {
    if (ts.isFunctionDeclaration(item) && item.name?.text === 'openSharedConversation') node = item;
    ts.forEachChild(item, find);
  };
  find(ast);
  assert.ok(node);
  const js = ts.transpileModule(
    node.getText(ast) + '\nglobalThis.openShared=openSharedConversation;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const composer = { text: '待发内容', attachments: [{ id: 'file' }], replyTo: { id: 'quoted' } },
    navigation: string[] = [],
    selections: any[] = [],
    scope = { active: true };
  const env: any = {
    sendScope: { ticket: () => 0, current: () => scope.active },
    currentUserId: ids.user,
    personalSpace: personal,
    account: { workspace: { id: ids.team } },
    receipts: { pending: () => 0 },
    sendingRef: { current: new Set() },
    uploadingRef: { current: new Set() },
    dictation: { busy: false },
    pendingDictation: { current: null },
    composers: { old: composer },
    setSharedNavigation: (value: any) => selections.push(value),
    window: { location: { assign: (path: string) => navigation.push(path) } },
    encodeURIComponent,
    sync: {
      written() {
        throw Error('no local merge');
      },
    },
    setData() {
      throw Error('no local merge');
    },
    openConversation() {
      throw Error('no local merge');
    },
    setModal() {},
    refresh() {},
  };
  runInNewContext(js, env);
  const confirmed = { receipt: receipt(ids.revision), agent: alias, conversation };
  env.openShared(confirmed);
  assert.equal(navigation.length, 0);
  assert.equal(selections.at(-1), confirmed);
  assert.equal(env.composers.old, composer);
  env.dictation.busy = true;
  env.openShared(confirmed, true);
  assert.equal(navigation.length, 0);
  env.dictation.busy = false;
  env.uploadingRef.current.add('up');
  env.openShared(confirmed, true);
  assert.equal(navigation.length, 0);
  env.uploadingRef.current.clear();
  env.receipts.pending = () => 1;
  env.openShared(confirmed, true);
  assert.equal(navigation.length, 0);
  env.receipts.pending = () => 0;
  scope.active = false;
  env.openShared(confirmed, true);
  assert.equal(navigation.length, 0);
  scope.active = true;
  env.currentUserId = 'another-user';
  env.openShared(confirmed, true);
  assert.equal(navigation.length, 0);
  env.currentUserId = ids.user;
  env.openShared(confirmed, true);
  assert.deepEqual(navigation, [`/w/${ids.personal}?conversation=${ids.conversation}`]);
  assert.equal(env.composers.old, composer);
});
