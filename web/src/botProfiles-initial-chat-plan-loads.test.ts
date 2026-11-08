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
  json,
  deferred,
  text,
  all,
  harness,
  agent,
  other,
  team,
  environment,
  settingsProps,
  teamProps,
  teamBootstrap,
  committedTeam,
} from './testSupport/botProfilesFixture';

test('actual initial chat plan loads by ID without starting the model, then edits and saves through the existing wizard', async () => {
  const env = environment(),
    calls: Array<{ url: string; init: RequestInit }> = [];
  let stored = structuredClone(team);
  const ui = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    { ...teamProps(), initialPlanId: team.id },
    (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/revise'))
        stored = { ...stored, revision: 'saved-chat-draft', draft: JSON.parse(init.body).draft };
      return json(stored);
    }) as typeof fetch,
    env,
  );
  try {
    await ui.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/workspaces/space-a/bot-team-plans/plan-a');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(ui.field('群聊名称').props.value, team.draft!.title);
    assert.equal(ui.maybeButton('生成组队方案'), undefined);
    ui.field('群聊名称').props.onChange({ target: { value: '在聊天方案上继续编辑' } });
    await ui.flush();
    ui.button('保存草稿').props.onClick();
    await ui.flush();
    assert.equal(stored.draft!.title, '在聊天方案上继续编辑');
    assert.ok(calls[1].url.endsWith('/revise'));
    assert.equal(calls.filter((call) => call.url.endsWith('/commit')).length, 0);
  } finally {
    ui.dispose();
  }
});

test('actual initial plan loading cannot overwrite a new goal or an unmounted account and never enables generation on a failed lookup', async () => {
  for (const outcome of ['new-goal', 'unmount', 'failed'] as const) {
    const late = deferred<Response>();
    const ui = await harness(
      'web/src/components/SmartTeamPanel.tsx',
      'SmartTeamContent',
      { ...teamProps(), initialPlanId: team.id },
      (async () => late.promise) as typeof fetch,
      environment(),
    );
    await ui.flush();
    assert.match(ui.copy, /正在读取聊天/);
    assert.equal(ui.maybeButton('生成组队方案'), undefined);
    if (outcome === 'new-goal') {
      ui.button('返回创建向导').props.onClick();
      await ui.flush();
      ui.field('希望团队').props.onChange({ target: { value: '新的用户目标' } });
      await ui.flush();
    }
    if (outcome === 'unmount') ui.dispose();
    late.resolve(outcome === 'failed' ? json({ error: '方案不可用' }, 404) : json(team));
    await ui.flush();
    if (outcome === 'new-goal') {
      assert.equal(ui.field('希望团队').props.value, '新的用户目标');
      assert.equal(ui.maybeButton('确认创建协作团队'), undefined);
    }
    if (outcome === 'failed') {
      assert.match(ui.copy, /方案不可用/);
      assert.equal(ui.maybeButton('生成组队方案'), undefined);
      assert.ok(ui.button('检查状态'));
    }
    if (outcome === 'unmount') assert.equal(ui.maybeButton('确认创建协作团队'), undefined);
    ui.dispose();
  }
});

test('actual dialog initially opens chat plans in the shared editor and requires dirty confirmation before another initial plan', async () => {
  const props = {
    agents: [agent, other],
    canCreateBot: true,
    workspaceId: 'space-a',
    userId: 'owner-a',
    modelConfigured: true,
    modelLabel: 'GLM',
    initialPlanId: team.id,
    onClose() {},
    onCreated() {},
    onTeamCreated() {},
  };
  const parent = await harness(
    'web/src/components/CreateDialog.tsx',
    'CreateDialogContent',
    props,
    (async () => json([])) as typeof fetch,
    environment(),
  );
  await parent.flush();
  const first = all(parent.tree, (node) => node.type?.name === 'SmartTeamPanel')[0];
  assert.equal(first.props.initialPlanId, team.id);
  const child = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    first.props,
    (async () => json(team)) as typeof fetch,
    environment(),
  );
  try {
    await child.flush();
    child.field('群聊名称').props.onChange({ target: { value: '未保存的方案' } });
    await child.flush();
    parent.setProps({ initialPlanId: 'plan-b' });
    await parent.flush();
    assert.match(parent.copy, /尚未保存/);
    assert.equal(
      all(parent.tree, (node) => node.type?.name === 'SmartTeamPanel')[0].props.initialPlanId,
      team.id,
    );
    parent.button('继续编辑').props.onClick();
    await parent.flush();
    assert.equal(child.field('群聊名称').props.value, '未保存的方案');
    parent.setProps({ initialPlanId: 'plan-c' });
    await parent.flush();
    parent.button('放弃修改并继续').props.onClick();
    await parent.flush();
    assert.equal(
      all(parent.tree, (node) => node.type?.name === 'SmartTeamPanel')[0].props.initialPlanId,
      'plan-c',
    );
    parent.setProps({ canCreateBot: false });
    await parent.flush();
    assert.equal(all(parent.tree, (node) => node.type?.name === 'SmartTeamPanel').length, 0);
  } finally {
    child.dispose();
    parent.dispose();
  }
});

test('actual restored committed editor verifies existence before explicit enter/start and ignores a late account response', async () => {
  for (const outcome of ['success', 'missing', 'unmount'] as const) {
    const late = deferred<Response>(),
      calls: string[] = [],
      entered: any[] = [];
    const ui = await harness(
      'web/src/components/SmartTeamPanel.tsx',
      'SmartTeamContent',
      { ...teamProps(), initialPlanId: team.id, onCreated: (...args: any[]) => entered.push(args) },
      (async (url: any, init: any) => {
        assert.equal(init.method, 'GET');
        calls.push(String(url));
        return String(url).endsWith('/bootstrap') ? late.promise : json(committedTeam);
      }) as typeof fetch,
      environment(),
    );
    await ui.flush();
    assert.equal(entered.length, 0);
    ui.button('开始协作').props.onClick();
    await ui.flush();
    assert.equal(calls.length, 2);
    if (outcome === 'unmount') ui.dispose();
    late.resolve(
      json(outcome === 'missing' ? { ...teamBootstrap(), conversations: [] } : teamBootstrap()),
    );
    await ui.flush();
    if (outcome === 'success') {
      assert.equal(entered.length, 1);
      assert.equal(entered[0][0].id, team.id);
      assert.equal(entered[0][1], true);
      assert.equal(entered[0][2].conversation.title, '真实群聊');
    } else {
      assert.equal(entered.length, 0);
      if (outcome === 'missing') assert.match(ui.copy, /不存在或成员暂不可用/);
    }
    ui.dispose();
  }
});

test('existing team Bot files are labelled team-visible while personal files remain labelled private, with identical navigation', async () => {
  for (const [workspaceKind, label] of [
    ['team', '团队可见'],
    ['personal', '仅你可见'],
    [undefined, '当前空间可见'],
  ] as const) {
    let opened = 0;
    const ui = await harness(
      'web/src/components/AgentDialog.tsx',
      'AgentSettingsContent',
      {
        ...settingsProps(),
        workspaceKind,
        onFiles: () => opened++,
      },
      (async () => {
        throw Error('read-only labels must not write');
      }) as typeof fetch,
    );
    try {
      await ui.flush();
      ui.button('相关内容').props.onClick();
      await ui.flush();
      assert.match(ui.copy, new RegExp(label));
      assert.doesNotMatch(ui.copy, /私聊文件/);
      const row = all(
        ui.tree,
        (node) => node.type === 'button' && text(node).startsWith('会话资料'),
      )[0];
      assert.ok(row);
      row.props.onClick();
      assert.equal(opened, 1);
    } finally {
      ui.dispose();
    }
  }
});
