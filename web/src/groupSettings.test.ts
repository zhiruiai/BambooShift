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
  deferred,
  text,
  all,
  harness,
  userId,
  workspaceId,
  a,
  b,
  c,
  conversation,
  snapshot,
  props,
  windowFixture,
} from './testSupport/groupSettingsFixture';

test('actual manual group settings save a legal single member and explicit leader without inventing a team plan or modifying a Bot', async () => {
  const calls: any[] = [],
    saved: any[] = [];
  const ui = await harness(
    'web/src/components/GroupSettingsDialog.tsx',
    'GroupSettingsContent',
    props({ onSaved: (value: any) => saved.push(value) }),
    async (url, init) => {
      calls.push({ url, init });
      if (init?.method === 'GET') return json(snapshot());
      const body = JSON.parse(String(init?.body));
      return json(snapshot({ ...conversation, ...body }, 'b'.repeat(64)));
    },
    { window: windowFixture() },
  );
  try {
    await ui.flush();
    assert.equal(ui.field('负责人').props.value, a.id);
    assert.equal(all(ui.tree, (node) => node.type === 'textarea').length, 0);
    ui.field('群聊名称').props.onChange({ target: { value: '单人研究组' } });
    await ui.flush();
    assert.equal(ui.button('保存群聊设置').props.disabled, false);
    ui.form().props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.equal(saved.length, 1);
    const write = calls.find((call) => call.init.method === 'PATCH');
    assert.equal(write.url, `/api/workspaces/${workspaceId}/conversations/group-1/settings`);
    assert.equal(write.init.headers['X-OpenBot-Expected-User'], userId);
    const body = JSON.parse(write.init.body);
    assert.deepEqual(body, {
      title: '单人研究组',
      agentIds: ['bot-a'],
      expectedRevision: 'a'.repeat(64),
    });
    assert.ok(calls.every((call) => !String(call.url).includes('/agents/')));
    assert.match(ui.copy, /不会自动发送任务/);
  } finally {
    ui.dispose();
  }
});

test('actual planned group can change leader and edit assignments; every newly selected member needs its own assignment before one atomic save', async () => {
  const plan = {
    ...conversation,
    agentIds: [a.id, b.id],
    teamBrief: {
      goal: '原目标',
      summary: '原协作方式',
      leadAgentId: a.id,
      assignments: [
        { agentId: a.id, assignment: '负责汇总' },
        { agentId: b.id, assignment: '负责研究' },
      ],
    },
  };
  const calls: any[] = [],
    late = deferred<Response>();
  let closed = 0;
  const ui = await harness(
    'web/src/components/GroupSettingsDialog.tsx',
    'GroupSettingsContent',
    props({
      conversation: plan,
      onClose() {
        closed++;
      },
    }),
    async (url, init) => {
      calls.push({ url, init });
      return init?.method === 'GET' ? json(snapshot(plan)) : late.promise;
    },
    { window: windowFixture() },
  );
  try {
    await ui.flush();
    ui.field('负责人').props.onChange({ target: { value: b.id } });
    ui.field('协作目标').props.onChange({ target: { value: '新目标' } });
    ui.field('协作方式').props.onChange({ target: { value: '先研究再总结' } });
    all(
      ui.tree,
      (node) => node.type === 'input' && node.props['aria-label'] === '群聊成员 小滴',
    )[0].props.onChange({ target: { checked: true } });
    await ui.flush();
    ui.form().props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.equal(calls.length, 1);
    assert.match(ui.copy, /请为每位成员填写/);
    ui.field('小滴的本组分工').props.onChange({ target: { value: '验证结果' } });
    await ui.flush();
    ui.form().props.onSubmit({ preventDefault() {} });
    await ui.flush();
    ui.tree.props.onClose();
    assert.equal(closed, 0);
    ui.form().props.onSubmit({ preventDefault() {} });
    assert.equal(calls.length, 2);
    const body = JSON.parse(calls[1].init.body);
    assert.deepEqual(body.agentIds, [b.id, a.id, c.id]);
    assert.equal(body.teamBrief.leadAgentId, b.id);
    assert.equal(body.teamBrief.goal, '新目标');
    assert.deepEqual(
      body.teamBrief.assignments.map((item: any) => item.agentId),
      body.agentIds,
    );
    assert.equal(body.teamBrief.assignments[2].assignment, '验证结果');
    late.resolve(json(snapshot({ ...plan, ...body }, 'b'.repeat(64))));
    await ui.flush();
    assert.match(ui.copy, /群聊安排已保存/);
  } finally {
    ui.dispose();
  }
});

test('409 keeps group draft and delayed read only offers server state; preserving edits adopts the reviewed revision explicitly', async () => {
  const calls: any[] = [],
    late = deferred<Response>();
  let gets = 0,
    writes = 0;
  const ui = await harness(
    'web/src/components/GroupSettingsDialog.tsx',
    'GroupSettingsContent',
    props(),
    async (url, init) => {
      calls.push({ url, init });
      if (init?.method === 'GET') return ++gets === 1 ? json(snapshot()) : late.promise;
      if (++writes === 1) return json({ error: '已有其他人修改' }, 409);
      const body = JSON.parse(String(init?.body));
      return json(snapshot({ ...conversation, ...body }, 'c'.repeat(64)));
    },
    { window: windowFixture() },
  );
  try {
    await ui.flush();
    ui.field('群聊名称').props.onChange({ target: { value: '我的草稿' } });
    await ui.flush();
    const oldSubmit = ui.form().props.onSubmit;
    oldSubmit({ preventDefault() {} });
    await ui.flush();
    assert.equal(ui.field('群聊名称').props.value, '我的草稿');
    oldSubmit({ preventDefault() {} });
    await ui.flush();
    assert.equal(writes, 1);
    ui.button('检查当前设置').props.onClick();
    await ui.flush();
    ui.field('群聊名称').props.onChange({ target: { value: '读取期间继续编辑' } });
    await ui.flush();
    late.resolve(
      json(
        snapshot(
          { ...conversation, title: '同事保存的名称', agentIds: [b.id, c.id] },
          'b'.repeat(64),
        ),
      ),
    );
    await ui.flush();
    assert.equal(ui.field('群聊名称').props.value, '读取期间继续编辑');
    assert.match(ui.copy, /同事保存的名称/);
    assert.match(ui.copy, /成员：小叶、小滴/);
    ui.button('保留修改，继续编辑').props.onClick();
    await ui.flush();
    assert.equal(ui.field('群聊名称').props.value, '读取期间继续编辑');
    ui.form().props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.equal(writes, 2);
    const body = JSON.parse(calls.filter((call) => call.init.method === 'PATCH')[1].init.body);
    assert.equal(body.expectedRevision, 'b'.repeat(64));
    assert.equal(body.title, '读取期间继续编辑');
  } finally {
    ui.dispose();
  }
});

test('unknown group save checks without replay and explicitly loading the actual saved version requires discarding dirty text', async () => {
  let writes = 0,
    closed = 0,
    gets = 0;
  const ui = await harness(
    'web/src/components/GroupSettingsDialog.tsx',
    'GroupSettingsContent',
    props({
      onClose() {
        closed++;
      },
    }),
    async (_url, init) => {
      if (init?.method === 'PATCH') {
        writes++;
        throw new TypeError('network');
      }
      return json(
        ++gets === 1
          ? snapshot()
          : snapshot({ ...conversation, title: '已在服务端保存' }, 'b'.repeat(64)),
      );
    },
    { window: windowFixture() },
  );
  try {
    await ui.flush();
    ui.field('群聊名称').props.onChange({ target: { value: '已在服务端保存' } });
    await ui.flush();
    ui.form().props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.equal(ui.button('保存群聊设置').props.disabled, true);
    ui.button('检查当前设置').props.onClick();
    await ui.flush();
    assert.equal(writes, 1);
    ui.button('载入已保存设置').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /载入会替换/);
    ui.button('放弃修改并载入').props.onClick();
    await ui.flush();
    assert.equal(ui.field('群聊名称').props.value, '已在服务端保存');
    ui.tree.props.onClose();
    assert.equal(closed, 1);
    assert.equal(writes, 1);
  } finally {
    ui.dispose();
  }
});

test('group rerenders do not overwrite edits and old handlers cannot dispatch or publish after account, workspace or unmount changes', async () => {
  for (const change of ['user', 'workspace', 'unmount']) {
    let writes = 0,
      saved = 0;
    const late = deferred<Response>(),
      win = windowFixture();
    const ui = await harness(
      'web/src/components/GroupSettingsDialog.tsx',
      'GroupSettingsContent',
      props({
        onSaved() {
          saved++;
        },
      }),
      async (_url, init) => {
        if (init?.method === 'GET') return json(snapshot());
        writes++;
        return late.promise;
      },
      { window: win },
    );
    try {
      await ui.flush();
      ui.field('群聊名称').props.onChange({ target: { value: '保留本地编辑' } });
      await ui.flush();
      ui.setProps({ conversation: { ...conversation, title: '新快照', unread: 5 } });
      await ui.flush();
      assert.equal(ui.field('群聊名称').props.value, '保留本地编辑');
      const submit = ui.form().props.onSubmit;
      submit({ preventDefault() {} });
      await ui.flush();
      assert.equal(writes, 1);
      if (change === 'user') ui.setProps({ userId: 'other' });
      else if (change === 'workspace') win.location.pathname = '/w/another';
      else ui.dispose();
      if (change !== 'unmount') await ui.flush();
      late.resolve(json(snapshot({ ...conversation, title: '迟到' }, 'b'.repeat(64))));
      await ui.flush();
      assert.equal(saved, 0);
      submit({ preventDefault() {} });
      await ui.flush();
      assert.equal(writes, 1);
    } finally {
      ui.dispose();
    }
  }
});
