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
  team,
  environment,
  settingsProps,
  teamProps,
  creationWorkspaceId,
  createdBotReceipt,
} from './testSupport/botProfilesFixture';

test('actual Bot forms treat pending crop as dirty before rerender and late image patches preserve newly typed fields', async () => {
  const imageId = '55555555-5555-4555-8555-555555555555',
    writes: any[] = [];
  let closed = 0;
  const ui = await harness(
    'web/src/components/AgentDialog.tsx',
    'AgentSettingsContent',
    { ...settingsProps(), onClose: () => closed++ },
    async (_url, init) => {
      writes.push(JSON.parse(String(init?.body)));
      return json({
        ...agent,
        avatarImageId: imageId,
        name: '上传期间的新名字',
        configRevision: 'new',
      });
    },
  );
  await ui.flush();
  const fields = all(ui.tree, (node) => node.type?.name === 'BotProfileFields')[0];
  const changeTab = ui.button('工作方式').props.onClick;
  fields.props.onAvatarActivity({ pending: true, busy: false });
  changeTab();
  ui.tree.props.onClose();
  await ui.flush();
  assert.equal(closed, 0);
  assert.match(ui.copy, /未保存的修改/);
  assert.ok(ui.field('Bot 名称'));
  ui.button('继续编辑').props.onClick();
  ui.form().props.onSubmit({ preventDefault() {} });
  await ui.flush();
  assert.equal(writes.length, 0);
  assert.match(ui.copy, /先确认或取消头像裁剪/);
  ui.field('Bot 名称').props.onChange({ target: { value: '上传期间的新名字' } });
  await ui.flush();
  fields.props.onAvatarChange({ avatarImageId: imageId });
  fields.props.onAvatarActivity({ pending: false, busy: false });
  await ui.flush();
  assert.equal(ui.field('Bot 名称').props.value, '上传期间的新名字');
  ui.form().props.onSubmit({ preventDefault() {} });
  await ui.flush();
  assert.equal(writes[0].avatarImageId, imageId);
  assert.equal(writes[0].name, '上传期间的新名字');
  assert.equal(writes[0].expectedRevision, agent.configRevision);
  ui.tree.props.onClose();
  await ui.flush();
  assert.equal(closed, 1);
  assert.doesNotMatch(ui.copy, /是否放弃这些修改/);
  ui.dispose();
  const creations: any[] = [];
  const dispatched = deferred<void>();
  const create = await harness(
    'web/src/components/CreateDialog.tsx',
    'CreateDialogContent',
    {
      agents: [agent],
      canCreateBot: true,
      workspaceId: creationWorkspaceId,
      userId: 'owner-a',
      modelConfigured: true,
      modelLabel: 'GLM',
      onClose: () => closed++,
      onCreated() {},
      onTeamCreated() {},
    },
    async (_url, init) => {
      if (init?.method === 'POST') {
        creations.push(JSON.parse(String(init.body)));
        dispatched.resolve();
        return json(createdBotReceipt(creations.at(-1)));
      }
      return json({ conversations: [{ id: 'created-dm', isGroup: false, agentIds: [agent.id] }] });
    },
  );
  await create.flush();
  create.field('Bot 名称').props.onChange({ target: { value: '最初的名字' } });
  await create.flush();
  create.field('工作角色').props.onChange({ target: { value: '助理' } });
  await create.flush();
  const createFields = all(create.tree, (node) => node.type?.name === 'BotProfileFields')[0];
  createFields.props.onAvatarActivity({ pending: true, busy: false });
  all(create.tree, (node) => node.type?.name === 'Dialog')[0].props.onClose();
  await create.flush();
  assert.match(create.copy, /尚未保存的内容/);
  create.button('继续编辑').props.onClick();
  create.form().props.onSubmit({ preventDefault() {} });
  await create.flush();
  assert.equal(creations.length, 0);
  create.field('Bot 名称').props.onChange({ target: { value: '创建时的新名字' } });
  await create.flush();
  createFields.props.onAvatarChange({ avatarImageId: imageId });
  createFields.props.onAvatarActivity({ pending: false, busy: false });
  await create.flush();
  create.form().props.onSubmit({ preventDefault() {} });
  await dispatched.promise;
  await create.flush();
  assert.equal(creations[0].profile.avatarImageId, imageId);
  assert.equal(creations[0].profile.name, '创建时的新名字');
  create.dispose();
});

test('actual intelligent-team image callbacks patch only their member and preserve new text before persistent draft save', async () => {
  const env = environment(),
    imageId = '55555555-5555-4555-8555-555555555555';
  const plan: BotTeamPlan = {
    ...team,
    draft: {
      ...team.draft!,
      members: [
        team.draft!.members[0],
        {
          key: 'new',
          kind: 'create',
          name: '新伙伴',
          role: '研究',
          description: '',
          instructions: '',
          color: '#9363ed',
          avatar: 'leaf',
          assignment: '资料研究',
        },
      ],
    },
  };
  const writes: any[] = [],
    dirty: boolean[] = [],
    busy: boolean[] = [];
  const ui = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    {
      ...teamProps(),
      initialPlanId: plan.id,
      onDirty: (value: boolean) => dirty.push(value),
      onBusy: (value: boolean) => busy.push(value),
    },
    async (_url, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        return json({ ...plan, revision: 'saved', draft: body.draft });
      }
      return json(plan);
    },
    env,
  );
  await ui.flush();
  const fields = all(ui.tree, (node) => node.type?.name === 'BotProfileFields')[0];
  fields.props.onAvatarActivity({ pending: true, busy: true });
  assert.equal(dirty.at(-1), true);
  assert.equal(busy.at(-1), true);
  await ui.flush();
  assert.equal(ui.button('确认创建协作团队').props.disabled, true);
  ui.field('Bot 名称').props.onChange({ target: { value: '上传时修改名字' } });
  await ui.flush();
  fields.props.onAvatarChange({ avatarImageId: imageId });
  fields.props.onAvatarActivity({ pending: false, busy: false });
  await ui.flush();
  assert.equal(ui.field('Bot 名称').props.value, '上传时修改名字');
  assert.equal(busy.at(-1), false);
  ui.button('保存草稿').props.onClick();
  await ui.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].draft.members[1].avatarImageId, imageId);
  assert.equal(writes[0].draft.members[1].name, '上传时修改名字');
  assert.equal(writes[0].draft.members[0].agentId, agent.id);
  ui.dispose();
});

test('actual Bot settings retain edits across working status updates and send every editable field with the opening revision exactly once', async () => {
  const pending = deferred<Response>(),
    writes: Array<{ url: string; init: RequestInit }> = [];
  let closed = 0,
    saved: BotAgent | undefined;
  const ui = await harness(
    'web/src/components/AgentDialog.tsx',
    'AgentSettingsContent',
    {
      ...settingsProps(),
      onClose: () => closed++,
      onSaved: (value: BotAgent) => {
        saved = value;
      },
    },
    (async (url: any, init: any) => {
      writes.push({ url: String(url), init });
      return pending.promise;
    }) as typeof fetch,
  );
  try {
    await ui.flush();
    ui.field('Bot 名称').props.onChange({ target: { value: '小松的新名字' } });
    await ui.flush();
    ui.field('简介').props.onChange({ target: { value: '只做联系人简介' } });
    await ui.flush();
    all(ui.tree, (node) => node.type?.name === 'AvatarPicker')[0].props.onChange({
      avatar: 'drop',
      avatarImageId: null,
    });
    await ui.flush();
    all(ui.tree, (node) => node.type?.name === 'AvatarPicker')[0].props.onChange({
      color: '#3294f9',
      avatarImageId: null,
    });
    await ui.flush();
    ui.setProps({ agent: { ...agent, status: 'working' } });
    await ui.flush();
    assert.equal(ui.field('Bot 名称').props.value, '小松的新名字');
    ui.button('工作方式').props.onClick();
    await ui.flush();
    ui.field('长期指令').props.onChange({ target: { value: '所有报告先写结论' } });
    await ui.flush();
    const submit = ui.form().props.onSubmit;
    submit({ preventDefault() {} });
    submit({ preventDefault() {} });
    await ui.flush();
    ui.tree.props.onClose();
    assert.equal(closed, 0);
    assert.equal(writes.length, 1);
    const body = JSON.parse(String(writes[0].init.body));
    assert.deepEqual(body, {
      name: '小松的新名字',
      role: agent.role,
      description: '只做联系人简介',
      instructions: '所有报告先写结论',
      color: '#3294f9',
      avatar: 'drop',
      avatarImageId: null,
      expectedRevision: agent.configRevision,
    });
    assert.equal((writes[0].init.headers as any)['X-OpenBot-Expected-User'], 'owner-a');
    pending.resolve(json({ ...agent, ...body, configRevision: 'revision-b' }));
    await ui.flush();
    assert.equal(saved?.configRevision, 'revision-b');
    assert.match(ui.copy, /应用于后续任务/);
    assert.equal(ui.button('保存更改').props.disabled, true);
  } finally {
    pending.resolve(json(agent));
    ui.dispose();
  }
});
