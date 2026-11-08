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
import type { BotAgent } from '../../shared/types';
import type { BotTeamPlan, BotTeamCatalogReview } from '../../shared/bot-team-plans';
import {
  json,
  deferred,
  first,
  second,
  fresh,
  initialPlan,
  storage,
  fixture,
  clicks,
  writes,
  all,
  component,
} from './testSupport/teamCatalogReviewFixture';

test('review displays actual selected profiles and saves the exact edited plan without creating or starting', async () => {
  const f = await fixture();
  try {
    f.ui.field('群聊名称').props.onChange({ target: { value: '编辑后的方案' } });
    await f.ui.flush();
    f.ui.field('选择 Bot').props.onChange({ target: { value: 'c' } });
    await f.ui.flush();
    await clicks(f.ui, '核对 Bot 资料');
    assert.match(f.ui.copy, /新增/);
    assert.match(f.ui.copy, /一致/);
    assert.match(f.ui.copy, /最新简介/);
    assert.match(f.ui.copy, /核对来源再汇总/);
    assert.equal(writes(f.calls).length, 0);
    await clicks(f.ui, '使用以上资料并保存草稿');
    const sent = writes(f.calls)[0];
    assert.ok(sent.path.endsWith('/refresh-bots'));
    assert.equal(sent.headers.get('X-OpenBot-Expected-User'), 'owner-a');
    assert.equal(sent.body.expectedRevision, 'revision-1');
    assert.equal(sent.body.reviewToken, 'review-token');
    assert.equal(sent.body.draft.title, '编辑后的方案');
    assert.deepEqual(sent.body.draft.members[2], initialPlan.draft!.members[2]);
    assert.equal(f.ui.field('群聊名称').props.value, '编辑后的方案');
    assert.match(f.ui.copy, /保留原目标/);
    assert.match(f.ui.copy, /尚未创建群聊或开始任务/);
    assert.equal(f.state.created, 0);
    assert.equal(f.memory.values.size, 0);
  } finally {
    f.ui.dispose();
  }
});

test('late read-only preview cannot replace an edited draft and stale confirm cannot save it', async () => {
  const gate = deferred<Response>();
  let reply: (() => Response) | undefined;
  const f = await fixture({
    transport: (call, fallback) => {
      if (call.path.endsWith('/review-bots')) {
        reply = fallback;
        return gate.promise;
      }
      return fallback();
    },
  });
  try {
    f.ui.button('核对 Bot 资料').props.onClick();
    await f.ui.flush();
    f.ui.field('协作方式').props.onChange({ target: { value: '核对中继续输入' } });
    await f.ui.flush();
    gate.resolve(reply!());
    await f.ui.flush();
    assert.equal(f.ui.field('协作方式').props.value, '核对中继续输入');
    assert.doesNotMatch(f.ui.copy, /使用以上资料并保存草稿/);
    assert.equal(writes(f.calls).length, 0);
  } finally {
    f.ui.dispose();
  }
});

test('new profile snapshots and avatar activity invalidate an already displayed confirmation', async () => {
  for (const change of ['profile', 'avatar', 'disabled', 'account', 'unmount']) {
    const f = await fixture();
    try {
      await clicks(f.ui, '核对 Bot 资料');
      const confirm = f.ui.button('使用以上资料并保存草稿').props.onClick;
      if (change === 'profile')
        f.ui.setProps({
          agents: [
            { ...first, instructions: '另一窗口的新指令', configRevision: 'next' },
            second,
            fresh,
          ],
        });
      if (change === 'avatar')
        component(f.ui.tree, 'BotProfileFields').props.onAvatarActivity({
          pending: true,
          busy: false,
        });
      if (change === 'disabled') f.ui.setProps({ disabled: true });
      if (change === 'account') f.ui.setProps({ userId: 'another-owner' });
      if (change === 'unmount') f.ui.dispose();
      else await f.ui.flush();
      confirm();
      await f.ui.flush();
      assert.equal(writes(f.calls).length, 0, change);
    } finally {
      f.ui.dispose();
    }
  }
});

test('unknown save freezes ordinary editing and retries only the original body and request identifier', async () => {
  let attempt = 0;
  const f = await fixture({
    transport: (call, fallback) => {
      if (call.path.endsWith('/refresh-bots') && ++attempt === 1)
        throw new TypeError('lost response');
      return fallback();
    },
  });
  try {
    const staleTitle = f.ui.field('群聊名称').props.onChange;
    const staleCommit = f.ui.button('确认创建协作团队').props.onClick;
    await clicks(f.ui, '核对 Bot 资料');
    await clicks(f.ui, '使用以上资料并保存草稿');
    staleTitle({ target: { value: '不得更换原草稿' } });
    staleCommit();
    await f.ui.flush();
    assert.equal(f.ui.field('群聊名称').props.value, '原方案');
    assert.equal(writes(f.calls).length, 1);
    const stored = [...f.memory.values.values()][0];
    assert.ok(stored);
    assert.doesNotMatch(stored, /原方案|私有长指令|assignment|avatarImageId|review-token/);
    await clicks(f.ui, '重试同一次资料保存');
    assert.equal(writes(f.calls).length, 2);
    assert.deepEqual(writes(f.calls)[0].body, writes(f.calls)[1].body);
    assert.equal(f.memory.values.size, 0);
  } finally {
    f.ui.dispose();
  }
});

test('even a 409 keeps the original attempt until explicit CAS recovery preserves local edits', async () => {
  const f = await fixture({
    transport: (call, fallback) =>
      call.path.endsWith('/refresh-bots') ? json({ error: '资料已变化' }, 409) : fallback(),
  });
  try {
    f.ui.field('群聊名称').props.onChange({ target: { value: '不能丢的方案名称' } });
    await f.ui.flush();
    await clicks(f.ui, '核对 Bot 资料');
    await clicks(f.ui, '使用以上资料并保存草稿');
    assert.ok(f.memory.values.size);
    await clicks(f.ui, '核对原保存请求');
    assert.match(f.ui.copy, /尚未找到保存回执/);
    await clicks(f.ui, '保留本页编辑并结束原核对');
    const fence = f.calls.find((call) => call.path.endsWith('/revise'))!;
    assert.equal(fence.body.expectedRevision, 'revision-1');
    assert.deepEqual(fence.body.draft, initialPlan.draft);
    assert.equal(f.ui.field('群聊名称').props.value, '不能丢的方案名称');
    assert.equal(
      component(f.ui.tree, 'BotProfileFields').props.draft.avatarImageId,
      initialPlan.draft!.members[2].kind === 'create'
        ? initialPlan.draft!.members[2].avatarImageId
        : undefined,
    );
    assert.equal(f.memory.values.size, 0);
    await clicks(f.ui, '核对 Bot 资料');
    assert.equal(
      f.calls.filter((call) => call.path.endsWith('/review-bots')).at(-1)!.body.expectedRevision,
      'revision-fenced',
    );
  } finally {
    f.ui.dispose();
  }
});

test('remount restores only metadata, reads the receipt and never rebuilds an absent request payload', async () => {
  const memory = storage();
  const firstUi = await fixture({
    storage: memory,
    transport: (call, fallback) => {
      if (call.path.endsWith('/refresh-bots')) throw new TypeError('offline');
      return fallback();
    },
  });
  await clicks(firstUi.ui, '核对 Bot 资料');
  await clicks(firstUi.ui, '使用以上资料并保存草稿');
  firstUi.ui.dispose();
  const f = await fixture({ storage: memory });
  try {
    assert.ok(f.calls.some((call) => call.path.includes('/catalog-refreshes/')));
    assert.doesNotMatch(f.ui.copy, /重试同一次资料保存/);
    assert.match(f.ui.copy, /未提交的原文没有保存在此页面/);
    assert.equal(writes(f.calls).length, 0);
    await clicks(f.ui, '继续已保存方案');
    assert.equal(writes(f.calls).length, 1);
    assert.ok(writes(f.calls)[0].path.endsWith('/revise'));
    assert.equal(f.ui.field('群聊名称').props.disabled, false);
    assert.equal(memory.values.size, 0);
  } finally {
    f.ui.dispose();
  }
});

test('a recovered receipt with later plan edits does not overwrite the local draft', async () => {
  const f = await fixture({
    transport: (call, fallback) => {
      if (call.path.endsWith('/refresh-bots'))
        return json({
          requestId: call.body.requestId,
          planId: 'plan',
          appliedRevision: 'applied',
          plan: {
            ...initialPlan,
            revision: 'later',
            draft: { ...initialPlan.draft, title: '另一窗口的方案' },
          },
        });
      return fallback();
    },
  });
  try {
    f.ui.field('群聊名称').props.onChange({ target: { value: '本页要保留的编辑' } });
    await f.ui.flush();
    await clicks(f.ui, '核对 Bot 资料');
    await clicks(f.ui, '使用以上资料并保存草稿');
    assert.equal(f.ui.field('群聊名称').props.value, '本页要保留的编辑');
    assert.match(f.ui.copy, /方案后来又有修改/);
    assert.equal(f.ui.button('确认创建协作团队').props.disabled, true);
    assert.equal(f.memory.values.size, 0);
    await clicks(f.ui, '核对 Bot 资料');
    assert.equal(
      f.calls.filter((call) => call.path.endsWith('/review-bots')).at(-1)!.body.expectedRevision,
      'later',
    );
  } finally {
    f.ui.dispose();
  }
});

test('a pending save completed before recovery returns its receipt without fencing or resending', async () => {
  let original: any;
  const f = await fixture({
    transport: (call, fallback) => {
      if (call.path.endsWith('/refresh-bots')) {
        original = call.body;
        throw new TypeError('lost receipt');
      }
      if (call.path.includes('/catalog-refreshes/'))
        return json({
          requestId: original.requestId,
          planId: 'plan',
          appliedRevision: 'saved',
          plan: { ...initialPlan, revision: 'saved', draft: original.draft },
        });
      return fallback();
    },
  });
  try {
    await clicks(f.ui, '核对 Bot 资料');
    await clicks(f.ui, '使用以上资料并保存草稿');
    await clicks(f.ui, '核对原保存请求');
    assert.equal(writes(f.calls).length, 1);
    assert.doesNotMatch(f.ui.copy, /核对上次资料保存/);
    assert.match(f.ui.copy, /已使用核对的 Bot 资料保存草稿/);
  } finally {
    f.ui.dispose();
  }
});

test('storage denial prevents dispatch and all-new plans explain that no profile review is needed', async () => {
  const memory = storage();
  memory.setItem = () => {
    throw new Error('denied');
  };
  const f = await fixture({ storage: memory });
  try {
    await clicks(f.ui, '核对 Bot 资料');
    await clicks(f.ui, '使用以上资料并保存草稿');
    assert.match(f.ui.copy, /本次尚未提交/);
    assert.equal(writes(f.calls).length, 0);
  } finally {
    f.ui.dispose();
  }
  const plan = structuredClone(initialPlan);
  plan.draft!.members = [plan.draft!.members[2]];
  plan.draft!.leadKey = 'new';
  const only = await fixture({ plan });
  try {
    assert.match(only.ui.copy, /当前成员均为新 Bot，无需核对复用资料/);
  } finally {
    only.ui.dispose();
  }
});
