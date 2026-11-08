import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import ts from 'typescript';
import type { BotAgent } from '../../shared/types';
import type { BotTeamPlan, BotTeamProposalCard as Proposal } from '../../shared/bot-team-plans';
import { webcrypto } from 'node:crypto';
import {
  json,
  deferred,
  all,
  harness,
  workspaceId,
  userId,
  agents,
  env,
  createProps,
  recipients,
  checkbox,
  plan,
} from './testSupport/groupRecipientsFixture';

test('actual recipient selector searches names and roles, preserves selected tags, marks the leader and caps native checkbox selection at six', async () => {
  let ui: any;
  const changes: any[] = [];
  ui = await harness(
    'web/src/components/GroupRecipients.tsx',
    'GroupRecipients',
    {
      agents,
      ids: [],
      disabled: false,
      onChange: (ids: string[]) => {
        changes.push(ids);
        ui.setProps({ ids });
      },
    },
    async () => {
      throw Error('Selector must not request a service');
    },
  );
  try {
    await ui.flush();
    for (const agent of agents.slice(0, 6)) {
      checkbox(ui, `选择收件人 ${agent.name}`).props.onChange({ target: { checked: true } });
      await ui.flush();
    }
    assert.equal(changes.at(-1).length, 6);
    assert.match(ui.copy, /已选满 6 位/);
    assert.equal(checkbox(ui, '选择收件人 伙伴7').props.disabled, true);
    checkbox(ui, '选择收件人 伙伴7').props.onChange({ target: { checked: true } });
    assert.equal(changes.length, 6);
    const search = all(ui.tree, (node) => node.type === 'input' && node.props.type === 'search')[0];
    search.props.onChange({ target: { value: '报告' } });
    await ui.flush();
    assert.equal(
      all(ui.tree, (node) => node.type === 'input' && node.props.type === 'checkbox').length,
      1,
    );
    ui.button('移除收件人 伙伴1').props.onClick();
    await ui.flush();
    assert.equal(changes.at(-1).length, 5);
    assert.match(ui.copy, /伙伴2负责人/);
    checkbox(ui, '选择收件人 伙伴8').props.onChange({ target: { checked: true } });
    await ui.flush();
    assert.equal(changes.at(-1).at(-1), 'bot-8');
    const oldRemove = ui.button('移除收件人 伙伴2').props.onClick;
    ui.setProps({ disabled: true });
    await ui.flush();
    oldRemove();
    assert.equal(changes.length, 8);
  } finally {
    ui.dispose();
  }
});

test('actual manual create suggests a title but preserves a custom title, protects its dirty draft and posts the selected order with the fixed actor', async () => {
  const calls: any[] = [],
    created: any[] = [];
  const dispatched = deferred<void>();
  let closed = 0;
  let saved: any;
  const ui = await harness(
    'web/src/components/CreateDialog.tsx',
    'CreateDialogContent',
    createProps({
      initialMode: 'group',
      onClose: () => closed++,
      onCreated: (value: any) => created.push(value),
    }),
    async (url, init) => {
      calls.push({ url, init });
      if (init?.method === 'POST') dispatched.resolve();
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const conversation = {
          id: 'group-new',
          title: body.title,
          agentIds: body.agentIds,
          isGroup: true,
          updatedAt: '2026-11-05T00:00:00Z',
          unread: 0,
          pinned: false,
        };
        saved = {
          requestId: body.requestId,
          kind: 'group',
          status: 'created',
          agentIds: body.agentIds,
          conversationId: conversation.id,
          createdAt: '2026-11-05T00:00:00Z',
          userId,
          workspaceId,
          conversation,
          agents: agents.filter((agent) => body.agentIds.includes(agent.id)),
        };
      }
      return json(saved);
    },
    env(),
  );
  try {
    await ui.flush();
    assert.ok(recipients(ui));
    const closeBeforeSelection = all(ui.tree, (node) => node.type?.name === 'Dialog')[0].props
      .onClose;
    recipients(ui).props.onChange(['bot-2', 'bot-1']);
    closeBeforeSelection();
    await ui.flush();
    assert.equal(closed, 0);
    assert.match(ui.copy, /尚未保存/);
    ui.button('继续编辑').props.onClick();
    await ui.flush();
    assert.equal(ui.field('群聊名称').props.value, '伙伴2、伙伴1的工作组');
    ui.field('群聊名称').props.onChange({ target: { value: '新产品研究' } });
    await ui.flush();
    recipients(ui).props.onChange(['bot-2', 'bot-1', 'bot-3']);
    await ui.flush();
    assert.equal(ui.field('群聊名称').props.value, '新产品研究');
    all(ui.tree, (node) => node.type?.name === 'Dialog')[0].props.onClose();
    await ui.flush();
    assert.equal(closed, 0);
    ui.button('继续编辑').props.onClick();
    await ui.flush();
    assert.equal(recipients(ui).props.ids.length, 3);
    ui.button('使用建议名称').props.onClick();
    await ui.flush();
    assert.equal(ui.field('群聊名称').props.value, '伙伴2、伙伴1等 3 位的工作组');
    ui.form().props.onSubmit({ preventDefault() {} });
    await dispatched.promise;
    await ui.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `/api/workspaces/${workspaceId}/creation-requests`);
    assert.equal(calls[0].init.headers['X-OpenBot-Expected-User'], userId);
    const sent = JSON.parse(calls[0].init.body);
    assert.match(sent.requestId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(sent, {
      kind: 'group',
      requestId: sent.requestId,
      title: '伙伴2、伙伴1等 3 位的工作组',
      agentIds: ['bot-2', 'bot-1', 'bot-3'],
    });
    assert.equal(created.length, 0);
    ui.button('打开会话').props.onClick();
    await ui.flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.method, 'GET');
    assert.equal(created.length, 1);
    assert.equal(created[0].id, 'group-new');
  } finally {
    ui.dispose();
  }
});

test('initial create mode honors owner commands and plan priority, while members stay in manual groups and rerenders cannot replace an edited mode', async () => {
  for (const [initialMode, canCreateBot, initialPlanId, want] of [
    ['group', true, undefined, 'group'],
    ['team', true, undefined, 'team'],
    ['bot', true, 'plan-existing', 'team'],
    ['team', false, 'plan-existing', 'group'],
  ] as const) {
    const ui = await harness(
      'web/src/components/CreateDialog.tsx',
      'CreateDialogContent',
      createProps({ initialMode, canCreateBot, initialPlanId }),
      async () => json([]),
      env(),
    );
    try {
      await ui.flush();
      assert.equal(!!recipients(ui), want === 'group');
      assert.equal(
        all(ui.tree, (node) => node.type?.name === 'SmartTeamPanel').length,
        want === 'team' ? 1 : 0,
      );
      if (want === 'group') {
        recipients(ui).props.onChange(['bot-1', 'bot-2']);
        await ui.flush();
        ui.setProps({ initialMode: 'bot' });
        await ui.flush();
        assert.deepEqual(recipients(ui).props.ids, ['bot-1', 'bot-2']);
      }
    } finally {
      ui.dispose();
    }
  }
});

test('actual manual group handler rejects one or seven Bots, prevents replay after an unknown response, and ignores retained callbacks after account changes', async () => {
  const calls: any[] = [];
  const dispatched = deferred<void>();
  const ui = await harness(
    'web/src/components/CreateDialog.tsx',
    'CreateDialogContent',
    createProps({ initialMode: 'group' }),
    async (url, init) => {
      calls.push({ url, init });
      dispatched.resolve();
      throw new TypeError('reply lost');
    },
    env(),
  );
  try {
    await ui.flush();
    for (const ids of [['bot-1'], agents.slice(0, 7).map((agent) => agent.id)]) {
      recipients(ui).props.onChange(ids);
      await ui.flush();
      ui.form().props.onSubmit({ preventDefault() {} });
      await ui.flush();
      assert.equal(calls.length, 0);
      assert.match(ui.copy, /2–6/);
    }
    recipients(ui).props.onChange(['bot-1', 'bot-2']);
    await ui.flush();
    const submit = ui.form().props.onSubmit;
    submit({ preventDefault() {} });
    await dispatched.promise;
    await ui.flush();
    assert.equal(calls.length, 1);
    submit({ preventDefault() {} });
    await dispatched.promise;
    await ui.flush();
    assert.equal(calls.length, 1);
    assert.match(ui.copy, /创建结果待核实/);
  } finally {
    ui.dispose();
  }
  for (const change of ['user', 'workspace', 'unmount'] as const) {
    let count = 0;
    const view = await harness(
      'web/src/components/CreateDialog.tsx',
      'CreateDialogContent',
      createProps({ initialMode: 'group' }),
      async () => {
        count++;
        return json({});
      },
      env(),
    );
    await view.flush();
    recipients(view).props.onChange(['bot-1', 'bot-2']);
    await view.flush();
    const submit = view.form().props.onSubmit,
      select = recipients(view).props.onChange;
    if (change === 'user') view.setProps({ userId: 'other' });
    if (change === 'workspace') view.setProps({ workspaceId: 'different' });
    if (change === 'unmount') view.dispose();
    await view.flush();
    submit({ preventDefault() {} });
    select(['bot-3', 'bot-4']);
    await view.flush();
    assert.equal(count, 0);
    assert.deepEqual(recipients(view).props.ids, ['bot-1', 'bot-2']);
    view.dispose();
  }
});
