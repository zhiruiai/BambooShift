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
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import type { AppSettings, BotAgent, ModelProfile } from '../../shared/types';
import type { BotTeamPlan } from '../../shared/bot-team-plans';
import ts from 'typescript';
import {
  deferred,
  text,
  all,
  component,
  harness,
  base,
  env,
} from './testSupport/memoryImportSettingsFixture';

test('actual App import navigation verifies original actor and private conversation without replacing composer drafts', async () => {
  const source = await workspaceSource();
  const ast = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let handler: ts.FunctionDeclaration | undefined;
  function visit(n: ts.Node) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'openMemoryImport') handler = n;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(handler);
  const code = ts.transpileModule(handler!.getText(ast) + '\nexports.open=openMemoryImport;', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const receipt = {
    userId: 'u',
    workspaceId: 'w',
    agentId: 'a',
    conversationId: 'c',
    messageId: 'm',
    requestId: 'r',
    status: 'completed',
  };
  const conversation = { id: 'c', isGroup: false, agentIds: ['a'] };
  const message = {
    id: 'm',
    role: 'user',
    userId: 'u',
    conversationId: 'c',
    delivery: { clientId: 'r', agentId: 'a' },
    metadata: { memoryImport: { id: 'r' } },
  };
  const savedDraft = { text: 'draft must stay', attachments: ['f'] };
  const events: any[] = [];
  let live = true;
  let response: any = { agents: [{ id: 'a' }], conversations: [conversation], messages: [message] };
  let next: Promise<any> | undefined;
  const context: any = {
    exports: {},
    currentUserId: 'u',
    sendIdentity: { current: { workspaceId: 'w' } },
    sendScope: { ticket: () => 1, current: () => live, request: async () => next || response },
    isSharedBot: (a: any) => !!a.sharedBot,
    setData: (v: any) => events.push(['data', v]),
    sync: { written: () => events.push(['written']) },
    refresh: async () => events.push(['refresh']),
    openConversation: (v: any) => events.push(['open', v.id]),
    setModal: (v: any) => events.push(['modal', v]),
    setToast: (v: any) => events.push(['toast', v]),
    composers: { c: savedDraft },
  };
  runInNewContext(code, context);
  await context.exports.open(receipt);
  assert.equal(events.find((event) => event[0] === 'open')[1], 'c');
  assert.equal(
    events.some((event) => event[0] === 'data'),
    false,
    'Navigation checks must not overwrite ordered sync data',
  );
  assert.equal(context.composers.c, savedDraft);
  const count = events.length;
  await assert.rejects(context.exports.open({ ...receipt, userId: 'other' }), /账户/);
  await assert.rejects(context.exports.open({ ...receipt, status: 'missing' }), /已不存在/);
  response = { agents: [{ id: 'a' }], conversations: [conversation], messages: [] };
  await assert.rejects(context.exports.open(receipt), /不可用/);
  response = {
    agents: [{ id: 'a' }],
    conversations: [{ ...conversation, isGroup: true }],
    messages: [message],
  };
  await assert.rejects(context.exports.open(receipt), /不可用/);
  assert.equal(events.length, count);
  const slow = deferred<any>();
  next = slow.promise;
  const opening = context.exports.open(receipt);
  live = false;
  slow.resolve({ agents: [{ id: 'a' }], conversations: [conversation] });
  await assert.rejects(opening, /账户/);
  assert.equal(events.length, count);
  assert.equal(context.composers.c.text, 'draft must stay');
});

test('general settings combines timezone and memory activity without one panel clearing the other draft or pending write', async () => {
  let closed = 0,
    imported = 0,
    saved = 0;
  const h = await harness(
    'web/src/components/WorkspaceSettingsDialog.tsx',
    'WorkspaceSettingsContent',
    {
      ...base,
      onClose: () => closed++,
      onImported: async () => {
        imported++;
      },
      onTimeZoneChanged: () => saved++,
      onSettingsChanged() {},
      onPrimaryChanged() {},
    },
    env(),
  );
  try {
    await h.flush();
    component(h.tree, 'SettingsNavigation').props.onChange('work');
    await h.flush();
    const zone = component(h.tree, 'WorkspaceTimeZoneSettings');
    const memory = component(h.tree, 'MemoryImportPanel');
    zone.props.onActivity({ dirty: true, busy: false, pending: false });
    memory.props.onActivity({ dirty: false, busy: false, pending: false });
    component(h.tree, 'Dialog').props.onClose();
    await h.flush();
    assert.equal(closed, 0);
    assert.match(h.copy, /未保存的工作时区/);
    h.button('继续编辑').props.onClick();
    memory.props.onConfigureModel();
    await h.flush();
    assert.equal(component(h.tree, 'WorkspaceTimeZoneSettings').type, zone.type);
    assert.equal(component(h.tree, 'WorkspaceTimeZoneSettings').props.active, false);
    component(h.tree, 'SettingsDialog').props.onClose();
    await h.flush();
    assert.equal(component(h.tree, 'WorkspaceTimeZoneSettings').props.active, true);
    await assert.rejects(memory.props.onImported({}), /工作时区/);
    assert.equal(imported, 0);
    zone.props.onActivity({ dirty: false, busy: true, pending: true });
    memory.props.onActivity({ dirty: false, busy: false, pending: false });
    component(h.tree, 'Dialog').props.onClose();
    memory.props.onConfigurePrimary();
    await h.flush();
    assert.equal(closed, 0);
    assert.equal(all(h.tree, (node) => node.type?.name === 'PrimaryBotDialog').length, 0);
    zone.props.onActivity({ dirty: false, busy: false, pending: false });
    memory.props.onActivity({ dirty: true, busy: false, pending: false });
    zone.props.onActivity({ dirty: false, busy: false, pending: false });
    component(h.tree, 'Dialog').props.onClose();
    await h.flush();
    assert.match(h.copy, /尚未提交的导入内容/);
    h.button('继续编辑').props.onClick();
    zone.props.onSaved({ timeZone: 'UTC', revision: 'new' });
    assert.equal(saved, 1);
    await memory.props.onImported({});
    assert.equal(imported, 1);
    h.setProps({ userId: 'different-account' });
    await h.flush();
    zone.props.onSaved({ timeZone: 'UTC', revision: 'stale' });
    assert.equal(saved, 1);
  } finally {
    h.dispose();
  }
});
