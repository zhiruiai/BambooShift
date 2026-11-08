import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import type { BotAgent } from '../../shared/types';
import type { BotTeamPlan, BotTeamProposalCard as Proposal } from '../../shared/bot-team-plans';
import { webcrypto } from 'node:crypto';
import {
  require,
  json,
  deferred,
  all,
  harness,
  agent,
  other,
  team,
  environment,
  settingsProps,
  teamProps,
  creationWorkspaceId,
  createdBotReceipt,
  teamBootstrap,
} from './testSupport/botProfilesFixture';

test('actual Bot settings preserve conflict drafts, require explicit discard to reload and block stale account or member callbacks', async () => {
  let writes = 0;
  const ui = await harness(
    'web/src/components/AgentDialog.tsx',
    'AgentSettingsContent',
    settingsProps(),
    (async (_url: any, init: any) => {
      if (init.method === 'PATCH') {
        writes++;
        return json({ error: '配置已更新' }, 409);
      }
      return json({
        agents: [{ ...agent, name: '其他窗口的新名字', configRevision: 'revision-b' }],
      });
    }) as typeof fetch,
  );
  try {
    await ui.flush();
    ui.field('Bot 名称').props.onChange({ target: { value: '当前草稿' } });
    await ui.flush();
    const submit = ui.form().props.onSubmit;
    submit({ preventDefault() {} });
    await ui.flush();
    assert.equal(ui.field('Bot 名称').props.value, '当前草稿');
    assert.equal(ui.button('保存更改').props.disabled, true);
    ui.button('载入最新配置').props.onClick();
    await ui.flush();
    assert.equal(ui.field('Bot 名称').props.value, '当前草稿');
    ui.button('继续编辑').props.onClick();
    await ui.flush();
    assert.equal(ui.field('Bot 名称').props.value, '当前草稿');
    ui.button('载入最新配置').props.onClick();
    await ui.flush();
    ui.button('放弃修改并继续').props.onClick();
    await ui.flush();
    assert.equal(ui.field('Bot 名称').props.value, '其他窗口的新名字');
    ui.setProps({ readOnly: true });
    await ui.flush();
    submit({ preventDefault() {} });
    await ui.flush();
    assert.equal(writes, 1);
    ui.dispose();
    submit({ preventDefault() {} });
    await ui.flush();
    assert.equal(writes, 1);
  } finally {
    ui.dispose();
  }
});

test('actual Bot related content routes to existing skills/files/desktop and deletion obeys live task and screen guards', async () => {
  const calls: string[] = [],
    writes: string[] = [];
  const ui = await harness(
    'web/src/components/AgentDialog.tsx',
    'AgentSettingsContent',
    {
      ...settingsProps(),
      deleteBlocked: '请先释放电脑画面。',
      boundScreen: true,
      onComputer: () => calls.push('computer'),
      onSkills: () => calls.push('skills'),
      onFiles: () => calls.push('files'),
    },
    (async (url: any) => {
      writes.push(String(url));
      return json({ ok: true });
    }) as typeof fetch,
  );
  try {
    await ui.flush();
    ui.button('相关内容').props.onClick();
    await ui.flush();
    assert.equal(ui.button('删除这位 Bot').props.disabled, true);
    assert.match(ui.copy, /请先释放/);
    const related = all(
      ui.tree,
      (node) => node.type === 'button' && all(node, (child) => child.type === 'small').length > 0,
    );
    related.forEach((button) => button.props.onClick());
    assert.deepEqual(calls, ['computer', 'skills', 'files']);
    ui.setProps({ deleteBlocked: '', boundScreen: false });
    await ui.flush();
    ui.button('删除这位 Bot').props.onClick();
    await ui.flush();
    const remove = ui.button('确认删除「小松」').props.onClick;
    ui.setProps({ deleteBlocked: '正在执行任务' });
    await ui.flush();
    remove();
    await ui.flush();
    assert.equal(writes.length, 0);
    ui.setProps({ deleteBlocked: '' });
    await ui.flush();
    ui.button('确认删除「小松」').props.onClick();
    await ui.flush();
    assert.deepEqual(writes, ['/api/workspaces/space-a/agents/bot-a']);
  } finally {
    ui.dispose();
  }
});

test('actual manual creation separates profile fields and only owner can create Bots; manual group remains available', async () => {
  const writes: any[] = [];
  const dispatched = deferred<void>();
  const ui = await harness(
    'web/src/components/CreateDialog.tsx',
    'CreateDialogContent',
    {
      agents: [agent, other],
      canCreateBot: true,
      workspaceId: creationWorkspaceId,
      userId: 'owner-a',
      onClose() {},
      onCreated() {},
      onTeamCreated() {},
    },
    (async (_url: any, init: any) => {
      if (init.method === 'POST') {
        writes.push(JSON.parse(init.body));
        dispatched.resolve();
        return json(createdBotReceipt(writes.at(-1)));
      }
      return json({ conversations: [{ id: 'chat-a', isGroup: false, agentIds: [agent.id] }] });
    }) as typeof fetch,
  );
  try {
    await ui.flush();
    for (const [label, value] of [
      ['Bot 名称', '小松'],
      ['工作角色', '协调'],
      ['简介', '展示简介'],
      ['长期指令', '真实工作要求'],
    ]) {
      ui.field(label).props.onChange({ target: { value } });
      await ui.flush();
    }
    ui.form().props.onSubmit({ preventDefault() {} });
    await dispatched.promise;
    await ui.flush();
    assert.equal(writes[0].profile.description, '展示简介');
    assert.equal(writes[0].profile.instructions, '真实工作要求');
    const create = ui.form().props.onSubmit;
    ui.setProps({ canCreateBot: false });
    await ui.flush();
    assert.ok(ui.field('群聊名称'));
    assert.equal(ui.maybeButton('智能组队'), undefined);
    create({ preventDefault() {} });
    await ui.flush();
    assert.equal(writes.length, 1);
  } finally {
    ui.dispose();
  }
});

test('actual smart team generation is explicit, polls only GET, edits reuse/lead/assignments, commits once and never auto-starts', async () => {
  const env = environment(),
    calls: Array<{ url: string; init: RequestInit }> = [],
    created: Array<{ plan: BotTeamPlan; start: boolean }> = [];
  let stored: BotTeamPlan = { ...team, status: 'generating', draft: undefined };
  const ui = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    {
      ...teamProps(),
      onCreated: (value: BotTeamPlan, start: boolean) => created.push({ plan: value, start }),
    },
    (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/bootstrap')) return json(teamBootstrap());
      if (String(url).endsWith('/commit')) {
        const body = JSON.parse(init.body);
        stored = {
          ...team,
          status: 'committed',
          draft: body.draft,
          result: {
            conversationId: 'group-a',
            createdAgentIds: [],
            memberAgentIds: ['bot-b', 'bot-a'],
            leadAgentId: 'bot-b',
          },
        };
      }
      if (String(url).endsWith('/bot-team-plans') && init.method === 'GET') return json([]);
      return json(stored);
    }) as typeof fetch,
    env,
  );
  try {
    await ui.flush();
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 0);
    ui.field('希望团队').props.onChange({ target: { value: team.goal } });
    await ui.flush();
    const start = ui.button('生成组队方案').props.onClick;
    start();
    start();
    await ui.flush();
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1);
    stored = { ...team };
    env.tick();
    await ui.flush();
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1);
    ui.field('负责人').props.onChange({ target: { value: 'research' } });
    await ui.flush();
    ui.field('群聊名称').props.onChange({ target: { value: '确认后的组名' } });
    await ui.flush();
    const assignment = all(
      ui.tree,
      (node) => node.type === 'textarea' && node.props.value === '研究市场',
    )[0];
    assignment.props.onChange({ target: { value: '对比三家竞品' } });
    await ui.flush();
    const commit = ui.button('确认创建协作团队').props.onClick;
    commit();
    commit();
    await ui.flush();
    const writes = calls.filter((call) => call.init.method === 'POST');
    assert.equal(writes.length, 2);
    const body = JSON.parse(String(writes[1].init.body));
    assert.equal(body.expectedRevision, team.revision);
    assert.equal(body.draft.leadKey, 'research');
    assert.equal(body.draft.title, '确认后的组名');
    assert.equal(body.draft.members[1].assignment, '对比三家竞品');
    assert.equal(created.length, 0);
    assert.match(ui.copy, /已创建/);
    ui.button('开始协作').props.onClick();
    ui.button('开始协作').props.onClick();
    await ui.flush();
    assert.equal(created.length, 1);
    assert.equal(created[0].start, true);
  } finally {
    ui.dispose();
  }
});
