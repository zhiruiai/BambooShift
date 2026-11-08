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
  compile,
  json,
  all,
  harness,
  workspaceId,
  userId,
  agents,
  env,
  checkbox,
  plan,
} from './testSupport/groupRecipientsFixture';

test('actual smart-team editor accepts six members, blocks a seventh and preserves legacy one-member plans for explicit correction before commit', async () => {
  for (const initial of [6, 1]) {
    const state = plan(initial),
      writes: any[] = [];
    const ui = await harness(
      'web/src/components/SmartTeamPanel.tsx',
      'SmartTeamContent',
      {
        agents,
        workspaceId,
        userId,
        modelConfigured: true,
        modelLabel: 'GLM',
        initialPlanId: state.id,
        onBusy() {},
        onDirty() {},
        onCreated() {},
      },
      async (url, init) => {
        if (init?.method === 'GET') return json(state);
        writes.push(JSON.parse(String(init?.body)));
        if (String(url).endsWith('/revise'))
          return json({ ...state, revision: 'revised', draft: writes.at(-1).draft });
        return json({
          ...state,
          status: 'committed',
          result: {
            conversationId: 'group-a',
            createdAgentIds: [],
            memberAgentIds: state.draft.members.map((member) => member.agentId),
            leadAgentId: 'bot-1',
          },
        });
      },
      env(),
    );
    try {
      await ui.flush();
      if (initial === 6) {
        const add = ui.button('添加成员 · 最多 6 位');
        assert.equal(add.props.disabled, true);
        add.props.onClick();
        await ui.flush();
        assert.equal(
          all(ui.tree, (node) => node.props?.className === 'smart-team-member').length,
          6,
        );
        ui.button('确认创建协作团队').props.onClick();
        await ui.flush();
        assert.equal(writes.length, 1);
        assert.equal(writes[0].draft.members.length, 6);
      } else {
        ui.button('确认创建协作团队').props.onClick();
        await ui.flush();
        assert.equal(writes.length, 0);
        assert.match(ui.copy, /2–6/);
        ui.field('群聊名称').props.onChange({ target: { value: '保留旧的单人成稿' } });
        await ui.flush();
        ui.button('保存草稿').props.onClick();
        await ui.flush();
        assert.equal(writes.length, 1);
        assert.equal(
          writes[0].draft.members.length,
          1,
          'saving the old draft does not create a group',
        );
        ui.button('添加成员 · 最多 6 位').props.onClick();
        await ui.flush();
        assert.equal(
          all(ui.tree, (node) => node.props?.className === 'smart-team-member').length,
          2,
        );
        assert.equal(ui.button('移除成员 1').props.disabled, true);
      }
    } finally {
      ui.dispose();
    }
  }
  const { parseBotTeamProposal } = await compile('web/src/components/BotTeamProposalCard.tsx');
  const ready = plan(6);
  const card = {
    planId: ready.id,
    revision: ready.revision,
    status: ready.status,
    goal: ready.goal,
    ...ready.draft,
    members: ready.draft.members.map((member, index) => ({
      ...member,
      name: agents[index].name,
      role: agents[index].role,
    })),
  };
  assert.ok(parseBotTeamProposal(card));
  assert.equal(
    parseBotTeamProposal({
      ...card,
      members: [...card.members, { ...card.members[0], key: 'seventh' }],
    }),
    undefined,
  );
});

test('actual oversized legacy group can reorder and shrink only its original members; saving within six allows later addition, and a one-member group stays editable', async () => {
  for (const count of [7, 1]) {
    let stored = {
      id: 'legacy-group',
      title: '既有群',
      agentIds: agents.slice(0, count).map((agent) => agent.id),
      isGroup: true,
      updatedAt: '2026-11-05T00:00:00Z',
      unread: 0,
      pinned: false,
    };
    const bodies: any[] = [];
    const ui = await harness(
      'web/src/components/GroupSettingsDialog.tsx',
      'GroupSettingsContent',
      { conversation: stored, agents, workspaceId, userId, onClose() {}, onSaved() {} },
      async (_url, init) => {
        if (init?.method === 'GET') return json({ conversation: stored, revision: 'a'.repeat(64) });
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        stored = { ...stored, ...body };
        return json({ conversation: stored, revision: 'b'.repeat(64) });
      },
      env(),
    );
    try {
      await ui.flush();
      if (count === 7) {
        assert.match(ui.copy, /已有的 7 人工作组/);
        assert.equal(checkbox(ui, '群聊成员 伙伴8').props.disabled, true);
        ui.field('负责人').props.onChange({ target: { value: 'bot-7' } });
        await ui.flush();
        ui.form().props.onSubmit({ preventDefault() {} });
        await ui.flush();
        assert.equal(bodies[0].agentIds.length, 7);
        assert.equal(bodies[0].agentIds[0], 'bot-7');
        for (const name of ['伙伴6', '伙伴7']) {
          checkbox(ui, `群聊成员 ${name}`).props.onChange({ target: { checked: false } });
          await ui.flush();
        }
        const add = checkbox(ui, '群聊成员 伙伴8');
        assert.equal(add.props.disabled, true);
        add.props.onChange({ target: { checked: true } });
        await ui.flush();
        ui.form().props.onSubmit({ preventDefault() {} });
        await ui.flush();
        assert.equal(bodies[1].agentIds.length, 5);
        assert.equal(bodies[1].agentIds.includes('bot-8'), false);
        assert.equal(checkbox(ui, '群聊成员 伙伴8').props.disabled, false);
        checkbox(ui, '群聊成员 伙伴8').props.onChange({ target: { checked: true } });
        await ui.flush();
        ui.form().props.onSubmit({ preventDefault() {} });
        await ui.flush();
        assert.equal(bodies[2].agentIds.length, 6);
        assert.equal(bodies[2].agentIds.at(-1), 'bot-8');
      } else {
        ui.field('群聊名称').props.onChange({ target: { value: '继续使用单人工作组' } });
        await ui.flush();
        ui.form().props.onSubmit({ preventDefault() {} });
        await ui.flush();
        assert.equal(bodies[0].agentIds.length, 1);
      }
    } finally {
      ui.dispose();
    }
  }
});
