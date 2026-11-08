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
  all,
  harness,
  agent,
  other,
  team,
  environment,
  teamProps,
} from './testSupport/botProfilesFixture';

test('actual smart team rejected commit preserves editable draft; unknown commit requires read and exact request replay', async () => {
  const env = environment(),
    writes: any[] = [];
  let behavior: 'reject' | 'unknown' | 'success' = 'reject';
  const ui = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    teamProps(),
    (async (url: any, init: any) => {
      if (init.method === 'GET')
        return json(String(url).endsWith('/bot-team-plans') ? [team] : team);
      writes.push(JSON.parse(init.body));
      if (behavior === 'reject') return json({ error: '复用 Bot 已更新，请确认配置。' }, 409);
      if (behavior === 'unknown') throw new TypeError('lost receipt');
      return json({
        ...team,
        status: 'committed',
        result: {
          conversationId: 'group-a',
          createdAgentIds: [],
          memberAgentIds: ['bot-a', 'bot-b'],
          leadAgentId: 'bot-a',
        },
      });
    }) as typeof fetch,
    env,
  );
  try {
    await ui.flush();
    ui.button('发布协作组待确认').props.onClick();
    await ui.flush();
    ui.field('群聊名称').props.onChange({ target: { value: '保留的方案标题' } });
    await ui.flush();
    ui.button('确认创建协作团队').props.onClick();
    await ui.flush();
    assert.equal(ui.field('群聊名称').props.value, '保留的方案标题');
    assert.equal(ui.field('群聊名称').props.disabled, false);
    behavior = 'unknown';
    ui.button('确认创建协作团队').props.onClick();
    await ui.flush();
    assert.equal(ui.field('群聊名称').props.disabled, true);
    assert.equal(writes.length, 2);
    ui.button('检查状态').props.onClick();
    await ui.flush();
    assert.equal(ui.field('群聊名称').props.value, '保留的方案标题');
    assert.equal(ui.field('群聊名称').props.disabled, true);
    behavior = 'success';
    ui.button('继续同一次创建请求').props.onClick();
    await ui.flush();
    assert.deepEqual(writes[2], writes[1]);
    assert.notEqual(writes[0].requestId, writes[1].requestId);
    assert.match(ui.copy, /已创建/);
  } finally {
    ui.dispose();
  }
});

test('actual smart team lost start is restored by request ID without another model request, and stale callbacks cannot mutate', async () => {
  const env = environment(),
    writes: any[] = [],
    reads: string[] = [];
  const ui = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    teamProps(),
    (async (url: any, init: any) => {
      if (init.method === 'POST') {
        writes.push(JSON.parse(init.body));
        throw new TypeError('lost start');
      }
      reads.push(String(url));
      return json(String(url).includes('?requestId=') ? [team] : []);
    }) as typeof fetch,
    env,
  );
  await ui.flush();
  ui.field('希望团队').props.onChange({ target: { value: team.goal } });
  await ui.flush();
  const start = ui.button('生成组队方案').props.onClick;
  start();
  await ui.flush();
  start();
  await ui.flush();
  assert.equal(writes.length, 1);
  ui.button('检查状态').props.onClick();
  await ui.flush();
  assert.ok(reads.some((url) => url.endsWith(`?requestId=${writes[0].requestId}`)));
  assert.equal(writes.length, 1);
  assert.ok(ui.field('群聊名称'));
  const commit = ui.button('确认创建协作团队').props.onClick;
  ui.dispose();
  commit();
  await ui.flush();
  assert.equal(writes.length, 1);
});

test('actual child edits protect parent close without a parent rerender between the child callback and closing', async () => {
  let closed = 0;
  const env = environment();
  const parent = await harness(
    'web/src/components/CreateDialog.tsx',
    'CreateDialogContent',
    {
      agents: [agent, other],
      canCreateBot: true,
      workspaceId: 'space-a',
      userId: 'owner-a',
      modelConfigured: true,
      modelLabel: 'GLM',
      onClose: () => closed++,
      onCreated() {},
      onTeamCreated() {},
    },
    (async () => json([])) as typeof fetch,
    env,
  );
  await parent.flush();
  parent.button('智能组队').props.onClick();
  await parent.flush();
  const node = all(parent.tree, (value) => value.type?.name === 'SmartTeamPanel')[0];
  assert.ok(node);
  const child = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    node.props,
    (async () => json([])) as typeof fetch,
    env,
  );
  try {
    await child.flush();
    child.field('希望团队').props.onChange({ target: { value: '尚未保存的真实目标' } });
    await child.flush();
    all(parent.tree, (node) => node.type?.name === 'Dialog')[0].props.onClose();
    assert.equal(closed, 0);
    await parent.flush();
    assert.match(parent.copy, /尚未保存的内容/);
    parent.button('继续编辑').props.onClick();
    await parent.flush();
    assert.equal(child.field('希望团队').props.value, '尚未保存的真实目标');
    all(parent.tree, (node) => node.type?.name === 'Dialog')[0].props.onClose();
    await parent.flush();
    parent.button('放弃修改并继续').props.onClick();
    assert.equal(closed, 1);
  } finally {
    child.dispose();
    parent.dispose();
  }
});

test('actual smart team shows its model, blocks unconfigured generation and retains failed goals for an explicit new request', async () => {
  const writes: any[] = [],
    env = environment();
  const ui = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    { ...teamProps(), modelConfigured: false },
    (async (_url: any, init: any) => {
      if (init.method === 'GET') return json([]);
      writes.push(JSON.parse(init.body));
      return json({ ...team, status: 'error', draft: undefined, error: '模型服务暂不可用' });
    }) as typeof fetch,
    env,
  );
  try {
    await ui.flush();
    ui.field('希望团队').props.onChange({ target: { value: team.goal } });
    await ui.flush();
    assert.match(ui.copy, /先连接模型/);
    assert.equal(ui.button('生成组队方案').props.disabled, true);
    ui.button('生成组队方案').props.onClick();
    await ui.flush();
    assert.equal(writes.length, 0);
    ui.setProps({ modelConfigured: true });
    await ui.flush();
    assert.match(ui.copy, /GLM 工作模型/);
    ui.button('生成组队方案').props.onClick();
    await ui.flush();
    assert.equal(ui.field('希望团队').props.value, team.goal);
    ui.field('希望团队').props.onChange({ target: { value: '修改后的发布目标' } });
    await ui.flush();
    ui.button('重新生成组队方案').props.onClick();
    await ui.flush();
    assert.equal(writes.length, 2);
    assert.notEqual(writes[0].requestId, writes[1].requestId);
    assert.equal(writes[1].goal, '修改后的发布目标');
  } finally {
    ui.dispose();
  }
});

test('actual unknown team commit unlocks only after confirmed revise CAS, and a racing committed result is restored instead', async () => {
  for (const race of [false, true]) {
    const env = environment(),
      revise = deferred<Response>();
    const calls: Array<{ url: string; body: any }> = [];
    let committed = false;
    const ui = await harness(
      'web/src/components/SmartTeamPanel.tsx',
      'SmartTeamContent',
      teamProps(),
      (async (url: any, init: any) => {
        const endpoint = String(url);
        if (init.method === 'GET')
          return json(
            endpoint.endsWith('/bot-team-plans')
              ? [team]
              : committed
                ? {
                    ...team,
                    status: 'committed',
                    result: {
                      conversationId: 'group-a',
                      createdAgentIds: [],
                      memberAgentIds: ['bot-a', 'bot-b'],
                      leadAgentId: 'bot-a',
                    },
                  }
                : team,
          );
        calls.push({ url: endpoint, body: JSON.parse(init.body) });
        if (endpoint.endsWith('/commit') && calls.length === 1) throw new TypeError('lost receipt');
        if (endpoint.endsWith('/revise')) return revise.promise;
        return json({
          ...team,
          status: 'committed',
          result: {
            conversationId: 'group-a',
            createdAgentIds: [],
            memberAgentIds: ['bot-a', 'bot-b'],
            leadAgentId: 'bot-a',
          },
        });
      }) as typeof fetch,
      env,
    );
    try {
      await ui.flush();
      ui.button('发布协作组待确认').props.onClick();
      await ui.flush();
      ui.field('群聊名称').props.onChange({ target: { value: '保留此草稿' } });
      await ui.flush();
      ui.button('确认创建协作团队').props.onClick();
      await ui.flush();
      assert.equal(ui.button('继续编辑方案').props.disabled, true);
      ui.button('检查状态').props.onClick();
      await ui.flush();
      assert.equal(ui.field('群聊名称').props.disabled, true);
      const resume = ui.button('继续编辑方案').props.onClick;
      resume();
      resume();
      await ui.flush();
      assert.equal(calls.length, 2);
      assert.equal(calls[1].body.expectedRevision, team.revision);
      assert.equal(calls[1].body.draft.title, '保留此草稿');
      assert.equal(ui.field('群聊名称').props.disabled, true);
      if (race) {
        committed = true;
        revise.resolve(json({ error: '方案已创建' }, 409));
      } else
        revise.resolve(
          json({ ...team, revision: 'revised', draft: { ...team.draft!, title: '保留此草稿' } }),
        );
      await ui.flush();
      if (race) {
        assert.match(ui.copy, /已创建/);
        assert.equal(ui.maybeButton('确认创建协作团队'), undefined);
      } else {
        assert.equal(ui.field('群聊名称').props.disabled, false);
        assert.equal(ui.field('群聊名称').props.value, '保留此草稿');
        ui.button('确认创建协作团队').props.onClick();
        await ui.flush();
        assert.equal(calls[2].body.expectedRevision, 'revised');
        assert.notEqual(calls[2].body.requestId, calls[0].body.requestId);
      }
    } finally {
      revise.resolve(json(team));
      ui.dispose();
    }
  }
});
