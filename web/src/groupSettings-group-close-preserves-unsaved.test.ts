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
import React from 'react';
import ts from 'typescript';
import type { BotAgent } from '../../shared/types';
import type { BotTeamPlan, BotTeamProposalCard as Proposal } from '../../shared/bot-team-plans';
import { webcrypto } from 'node:crypto';
import {
  json,
  text,
  all,
  harness,
  a,
  b,
  conversation,
  snapshot,
  props,
  windowFixture,
} from './testSupport/groupSettingsFixture';

test('group close preserves unsaved text unless explicitly discarded and member removal excludes its assignment from the saved plan', async () => {
  const plan = {
    ...conversation,
    agentIds: [a.id, b.id],
    teamBrief: {
      goal: '目标',
      summary: '分工',
      leadAgentId: a.id,
      assignments: [
        { agentId: a.id, assignment: 'A' },
        { agentId: b.id, assignment: 'B' },
      ],
    },
  };
  let closed = 0,
    body: any;
  const ui = await harness(
    'web/src/components/GroupSettingsDialog.tsx',
    'GroupSettingsContent',
    props({
      conversation: plan,
      onClose() {
        closed++;
      },
    }),
    async (_url, init) => {
      if (init?.method === 'GET') return json(snapshot(plan));
      body = JSON.parse(String(init?.body));
      return json(snapshot({ ...plan, ...body }, 'b'.repeat(64)));
    },
    { window: windowFixture() },
  );
  try {
    await ui.flush();
    all(
      ui.tree,
      (node) => node.type === 'input' && node.props['aria-label'] === '群聊成员 小松',
    )[0].props.onChange({ target: { checked: false } });
    await ui.flush();
    assert.equal(ui.field('负责人').props.value, b.id);
    ui.tree.props.onClose();
    await ui.flush();
    assert.equal(closed, 0);
    ui.button('继续编辑').props.onClick();
    await ui.flush();
    assert.equal(ui.field('负责人').props.value, b.id);
    ui.form().props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.deepEqual(body.agentIds, [b.id]);
    assert.deepEqual(body.teamBrief.assignments, [{ agentId: b.id, assignment: 'B' }]);
    assert.equal(body.teamBrief.leadAgentId, b.id);
    ui.tree.props.onClose();
    assert.equal(closed, 1);
  } finally {
    ui.dispose();
  }
});

test('initial read can be explicitly retried and Unicode line separators are rejected before any group mutation', async () => {
  let gets = 0,
    writes = 0;
  const ui = await harness(
    'web/src/components/GroupSettingsDialog.tsx',
    'GroupSettingsContent',
    props(),
    async (_url, init) => {
      if (init?.method === 'GET')
        return ++gets === 1 ? json({ error: '暂时无法读取' }, 503) : json(snapshot());
      writes++;
      return json(snapshot());
    },
    { window: windowFixture() },
  );
  try {
    await ui.flush();
    assert.match(ui.copy, /暂时无法读取/);
    ui.button('读取当前设置').props.onClick();
    await ui.flush();
    assert.equal(ui.field('群聊名称').props.disabled, false);
    for (const separator of ['\u2028', '\u2029']) {
      const name = `工作${separator}安排`;
      ui.field('群聊名称').props.onChange({ target: { value: name } });
      await ui.flush();
      ui.form().props.onSubmit({ preventDefault() {} });
      await ui.flush();
      assert.equal(writes, 0);
      assert.equal(ui.field('群聊名称').props.value, name);
      assert.match(ui.copy, /单行字符/);
    }
  } finally {
    ui.dispose();
  }
});

test('actual App integration opens an existing Bot DM without un-hiding it and merges group saves without replacing other conversations or preferences', async () => {
  const source = await workspaceSource();
  const ast = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const callbacks: Record<string, string> = {};
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText(ast);
      const prop =
        name === 'AgentDialog'
          ? 'onOpenConversation'
          : name === 'GroupSettingsDialog'
            ? 'onSaved'
            : undefined;
      if (prop) {
        const attribute = node.attributes.properties.find(
          (item) => ts.isJsxAttribute(item) && item.name.getText(ast) === prop,
        ) as ts.JsxAttribute;
        assert.ok(
          attribute?.initializer &&
            ts.isJsxExpression(attribute.initializer) &&
            attribute.initializer.expression,
        );
        callbacks[prop] = (attribute.initializer as ts.JsxExpression).expression!.getText(ast);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.deepEqual(Object.keys(callbacks).sort(), ['onOpenConversation', 'onSaved']);
  const code = ts.transpileModule(
    `export const open = ${callbacks.onOpenConversation}; export const saved = ${callbacks.onSaved};`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } },
  ).outputText;
  const dm = { ...conversation, id: 'dm-a', isGroup: false, agentIds: [a.id] };
  const roster = {
    entries: [{ target: { kind: 'bot', id: a.id }, hidden: true, pinned: false, sectionId: null }],
  };
  const module = { exports: {} as any };
  const opened: any[] = [],
    notices: string[] = [],
    modal: any[] = [];
  let live = true,
    writes = 0,
    refreshes = 0;
  const context: any = {
    module,
    exports: module.exports,
    data: { agents: [a, b], conversations: [conversation, dm], sidebarRoster: roster },
    activeAgent: a,
    sendScope: { ticket: () => 0, current: () => live },
    openConversation: (value: any) => opened.push(value),
    setModal: (value: any) => modal.push(value),
    setToast: (value: string) => notices.push(value),
    sync: { written: () => writes++ },
    refresh: async () => {
      refreshes++;
    },
    setData: (update: any) => {
      context.data = update(context.data);
    },
  };
  runInNewContext(code, context);
  module.exports.open();
  assert.equal(opened[0], dm);
  assert.equal(context.data.sidebarRoster, roster);
  assert.equal(roster.entries[0].hidden, true);
  context.data = { ...context.data, conversations: [conversation] };
  module.exports.open();
  assert.equal(opened.length, 1, 'missing DM is not created');
  assert.match(notices[0], /暂不可用/);
  const observed = { ...conversation, unread: 1, readThrough: 12 };
  context.data = { ...context.data, conversations: [observed, dm] };
  const updated = {
    ...conversation,
    title: '新的分工安排',
    agentIds: [b.id, a.id],
    unread: 3,
    readThrough: 99,
  };
  const merged = { ...updated, unread: observed.unread, readThrough: observed.readThrough };
  module.exports.saved(updated);
  assert.equal(writes, 1);
  assert.equal(refreshes, 1);
  assert.deepEqual({ ...context.data.conversations[0] }, merged);
  assert.equal(context.data.conversations[1], dm);
  assert.equal(context.data.sidebarRoster, roster);
  live = false;
  module.exports.open();
  module.exports.saved(conversation);
  assert.equal(writes, 1);
  assert.equal(opened.length, 1);
  assert.deepEqual({ ...context.data.conversations[0] }, merged);
});
