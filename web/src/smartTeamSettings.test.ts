import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import type { AppSettings, BotAgent, ModelProfile } from '../../shared/types';
import type { BotTeamPlan } from '../../shared/bot-team-plans';
import {
  json,
  all,
  component,
  harness,
  settings,
  profile,
  configured,
  team,
  parentProps,
} from './testSupport/smartTeamSettingsFixture';

test('a team template loads into the existing editor without a configured model', async () => {
  const writes: any[] = [];
  const ui = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    {
      ...parentProps(),
      modelConfigured: false,
      onBusy() {},
      onDirty() {},
    },
    {
      window: { location: { pathname: '/w/space-a/' } },
      fetch: async (_url: any, init: any) => {
        if (init.method === 'GET') return json([]);
        const request = JSON.parse(init.body);
        writes.push(request);
        return json({ ...team, requestId: request.requestId, goal: request.goal });
      },
    },
  );
  try {
    await ui.flush();
    assert.equal(writes.length, 0);
    component(ui.tree, 'TeamStarterPicker').props.onUse({
      id: 'launch',
      language: 'zh-CN',
      summary: '核对发布材料',
    });
    await ui.flush();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].goal, '核对发布材料');
    assert.deepEqual(writes[0].template, { id: 'launch', language: 'zh-CN' });
    assert.equal(ui.field('群聊名称').props.value, team.draft?.title);
  } finally {
    ui.dispose();
  }
});

test('switching a planned new Bot to an existing member and back preserves its profile and current assignment', async () => {
  const plan: BotTeamPlan = structuredClone(team);
  plan.draft!.members[0] = {
    key: 'lead',
    kind: 'create',
    name: '资料草稿',
    role: '编辑',
    description: '保留简介',
    instructions: '保留工作方式',
    color: '#9363ed',
    avatar: 'orb',
    avatarImageId: 'saved-avatar',
    assignment: '初始分工',
  };
  let writes = 0;
  const ui = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    {
      ...parentProps(),
      initialPlanId: plan.id,
      onBusy() {},
      onDirty() {},
    },
    {
      window: { location: { pathname: '/w/space-a/' } },
      fetch: async (_url: any, init: any) => {
        if (init.method !== 'GET') writes++;
        return json(plan);
      },
    },
  );
  try {
    await ui.flush();
    ui.field('选择 Bot').props.onChange({ target: { value: 'a' } });
    await ui.flush();
    ui.field('负责的工作').props.onChange({ target: { value: '切换后调整的分工' } });
    await ui.flush();
    ui.field('选择 Bot').props.onChange({ target: { value: 'new' } });
    await ui.flush();
    const restored = component(ui.tree, 'BotProfileFields').props.draft;
    assert.equal(restored.name, '资料草稿');
    assert.equal(restored.instructions, '保留工作方式');
    assert.equal(restored.avatarImageId, 'saved-avatar');
    assert.equal(restored.assignment, '切换后调整的分工');
    assert.equal(writes, 0);
  } finally {
    ui.dispose();
  }
});

test('model setup returns to the same team goal and only an explicit generation click sends a plan request', async () => {
  const writes: { path: string; body: any; headers: Headers }[] = [];
  const window = { location: { pathname: '/w/space-a/' } };
  const transport = async (url: any, init: any) => {
    const path = String(url);
    if (init.method !== 'GET')
      writes.push({
        path,
        body: init.body && JSON.parse(init.body),
        headers: new Headers(init.headers),
      });
    if (path.endsWith('/model-profiles/glm/activate')) return json(configured);
    if (path.endsWith('/model-profiles'))
      return json({
        activeProfileId: 'empty',
        profiles: [
          {
            ...profile,
            id: 'empty',
            configured: false,
            hasApiKey: false,
            credentialSource: 'none',
          },
          profile,
        ],
      });
    return json(init.method === 'POST' ? { ...team, status: 'generating' } : []);
  };
  const parent = await harness(
    'web/src/components/CreateDialog.tsx',
    'CreateDialogContent',
    parentProps(),
    { fetch: transport, window },
  );
  let child: Awaited<ReturnType<typeof harness>> | undefined,
    model: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await parent.flush();
    parent.button('智能组队').props.onClick();
    await parent.flush();
    const original = component(parent.tree, 'SmartTeamPanel');
    child = await harness('web/src/components/SmartTeamPanel.tsx', 'SmartTeamContent', original.props, {
      fetch: transport,
      window,
    });
    await child.flush();
    child
      .field('希望团队完成什么？')
      .props.onChange({ target: { value: '保留这份尚未提交的目标' } });
    await child.flush();
    child.button('配置模型').props.onClick();
    await parent.flush();
    assert.equal(component(parent.tree, 'Dialog').props.active, false);
    assert.equal(component(parent.tree, 'SmartTeamPanel').type, original.type);
    assert.equal(component(parent.tree, 'SmartTeamPanel').key, original.key);
    child.setProps(component(parent.tree, 'SmartTeamPanel').props);
    await child.flush();
    assert.equal(child.button('生成组队方案').props.disabled, true);
    parent.setProps({
      onSettingsChanged: (next: AppSettings) =>
        parent.setProps({
          settings: next,
          modelConfigured: next.configured,
          modelLabel: next.profileName,
        }),
    });
    await parent.flush();
    model = await harness(
      'web/src/components/SettingsDialog.tsx',
      'ModelSettingsDialog',
      { ...component(parent.tree, 'SettingsDialog').props, showManagement: false },
      { fetch: transport, window },
    );
    await model.flush();
    model.field('选择要查看或修改的模型配置').props.onChange({ target: { value: profile.id } });
    await model.flush();
    model.button('设为默认').props.onClick();
    await model.flush();
    await parent.flush();
    assert.equal(writes.length, 1);
    assert.match(writes[0].path, /^\/api\/workspaces\/space-a\/model-profiles\/glm\/activate$/);
    assert.equal(writes[0].headers.get('X-OpenBot-Expected-User'), 'owner-a');
    model.button('返回智能组队').props.onClick();
    await parent.flush();
    assert.equal(component(parent.tree, 'Dialog').props.active, true);
    assert.equal(all(parent.tree, (node) => node.type?.name === 'SettingsDialog').length, 0);
    child.setProps(component(parent.tree, 'SmartTeamPanel').props);
    await child.flush();
    assert.equal(child.field('希望团队完成什么？').props.value, '保留这份尚未提交的目标');
    assert.equal(child.button('生成组队方案').props.disabled, false);
    assert.equal(writes.filter((call) => call.path.endsWith('/bot-team-plans')).length, 0);
    child.button('生成组队方案').props.onClick();
    await child.flush();
    assert.equal(writes.at(-1)?.body.goal, '保留这份尚未提交的目标');
    assert.equal(writes.filter((call) => call.path.endsWith('/bot-team-plans')).length, 1);
  } finally {
    model?.dispose();
    child?.dispose();
    parent.dispose();
  }
});

test('closing model setup preserves an existing edited plan and the parent dirty guard', async () => {
  let closed = 0;
  const parent = await harness('web/src/components/CreateDialog.tsx', 'CreateDialogContent', {
    ...parentProps(),
    initialPlanId: team.id,
    onClose: () => closed++,
  });
  let child: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await parent.flush();
    child = await harness(
      'web/src/components/SmartTeamPanel.tsx',
      'SmartTeamContent',
      component(parent.tree, 'SmartTeamPanel').props,
      { fetch: async () => json(team) },
    );
    await child.flush();
    child.field('群聊名称').props.onChange({ target: { value: '尚未保存的新名称' } });
    await child.flush();
    child.button('配置模型').props.onClick();
    await parent.flush();
    assert.doesNotMatch(parent.copy, /还有尚未保存的内容/);
    component(parent.tree, 'SettingsDialog').props.onClose();
    await parent.flush();
    child.setProps(component(parent.tree, 'SmartTeamPanel').props);
    await child.flush();
    assert.equal(child.field('群聊名称').props.value, '尚未保存的新名称');
    assert.match(child.copy, /准备发布/);
    component(parent.tree, 'Dialog').props.onClose();
    await parent.flush();
    assert.equal(closed, 0);
    assert.match(parent.copy, /还有尚未保存的内容/);
    parent.button('继续编辑').props.onClick();
    await parent.flush();
    assert.equal(child.field('群聊名称').props.value, '尚未保存的新名称');
  } finally {
    child?.dispose();
    parent.dispose();
  }
});

test('model settings keep per-profile drafts, save without activation, and retain an unconfirmed save draft', async () => {
  const second = { ...profile, id: 'second', name: '备用' },
    writes: any[] = [],
    changes: AppSettings[] = [];
  const ui = await harness(
    'web/src/components/SettingsDialog.tsx',
    'ModelSettingsDialog',
    {
      settings: configured,
      workspaceId: 'space-a',
      userId: 'owner-a',
      showManagement: false,
      onClose() {},
      onSettingsChanged: (value: AppSettings) => changes.push(value),
    },
    {
      window: { location: { pathname: '/w/space-a/' } },
      fetch: async (_url: any, init: any) => {
        if (init.method === 'GET')
          return json({ activeProfileId: profile.id, profiles: [profile, second] });
        writes.push(JSON.parse(init.body));
        return json({ error: '无法确认保存结果' }, 503);
      },
    },
  );
  try {
    await ui.flush();
    ui.field('配置名称').props.onChange({ target: { value: '第一份草稿' } });
    await ui.flush();
    ui.field('选择要查看或修改的模型配置').props.onChange({ target: { value: second.id } });
    await ui.flush();
    ui.field('配置名称').props.onChange({ target: { value: '第二份草稿' } });
    await ui.flush();
    ui.field('选择要查看或修改的模型配置').props.onChange({ target: { value: profile.id } });
    await ui.flush();
    assert.equal(ui.field('配置名称').props.value, '第一份草稿');
    all(ui.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].activate, false);
    assert.equal(writes[0].apiKey, undefined);
    assert.equal(ui.field('配置名称').props.value, '第一份草稿');
    assert.match(ui.copy, /无法确认保存结果/);
    assert.equal(changes.length, 0);
  } finally {
    ui.dispose();
  }
});
