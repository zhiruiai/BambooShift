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
  initialPlan,
  fixture,
  clicks,
  writes,
  all,
  component,
} from './testSupport/teamCatalogReviewFixture';

test('late preview and saved results cannot cross an account change or a disposed panel', async () => {
  for (const stage of ['preview', 'save']) {
    for (const change of ['account', 'unmount']) {
      const gate = deferred<Response>();
      let reply: (() => Response) | undefined;
      const f = await fixture({
        transport: (call, fallback) => {
          if (call.path.endsWith(stage === 'preview' ? '/review-bots' : '/refresh-bots')) {
            reply = fallback;
            return gate.promise;
          }
          return fallback();
        },
      });
      try {
        if (stage === 'save') await clicks(f.ui, '核对 Bot 资料');
        f.ui
          .button(stage === 'preview' ? '核对 Bot 资料' : '使用以上资料并保存草稿')
          .props.onClick();
        await f.ui.flush();
        const before = [...f.memory.values.entries()];
        if (change === 'account') {
          f.ui.setProps({ userId: 'owner-b' });
          await f.ui.flush();
        } else f.ui.dispose();
        gate.resolve(reply!());
        await f.ui.flush();
        assert.doesNotMatch(f.ui.copy, /已使用核对的 Bot 资料保存草稿/);
        assert.equal(f.state.created, 0);
        assert.deepEqual([...f.memory.values.entries()], before);
        assert.ok(
          f.calls.every((call) => call.headers.get('X-OpenBot-Expected-User') === 'owner-a'),
        );
      } finally {
        f.ui.dispose();
      }
    }
  }
});

test('a later saved plan must be shown again before ending an unknown request without another write', async () => {
  let generation = 0;
  const f = await fixture({
    transport: (call, fallback) => {
      if (call.path.endsWith('/refresh-bots')) throw new TypeError('lost response');
      if (call.method === 'GET' && call.path.endsWith('/plan') && generation)
        return json({
          ...initialPlan,
          revision: `external-${generation}`,
          draft: { ...initialPlan.draft, title: `其他窗口 ${generation}` },
        });
      return fallback();
    },
  });
  try {
    f.ui.field('群聊名称').props.onChange({ target: { value: '仍保留本页名称' } });
    await f.ui.flush();
    await clicks(f.ui, '核对 Bot 资料');
    await clicks(f.ui, '使用以上资料并保存草稿');
    generation = 1;
    await clicks(f.ui, '核对原保存请求');
    generation = 2;
    await clicks(f.ui, '保留本页编辑并结束原核对');
    assert.match(f.ui.copy, /已保存方案又有变化/);
    assert.match(f.ui.copy, /其他窗口 2/);
    assert.equal(f.memory.values.size, 1);
    await clicks(f.ui, '保留本页编辑并结束原核对');
    assert.equal(writes(f.calls).length, 1);
    assert.equal(f.memory.values.size, 0);
    assert.equal(f.ui.field('群聊名称').props.value, '仍保留本页名称');
  } finally {
    f.ui.dispose();
  }
});

test('successful profile acceptance retains a temporarily switched new Bot draft and updated assignment', async () => {
  const f = await fixture();
  try {
    const members = () =>
      all(
        f.ui.tree,
        (node) => node.type === 'section' && node.props.className === 'smart-team-member',
      );
    const select = () => all(members()[2], (node) => node.type === 'select')[0];
    select().props.onChange({ target: { value: 'c' } });
    await f.ui.flush();
    const assignment = all(members()[2], (node) => node.type === 'textarea')[0];
    assignment.props.onChange({ target: { value: '核对时调整的分工' } });
    await f.ui.flush();
    await clicks(f.ui, '核对 Bot 资料');
    await clicks(f.ui, '使用以上资料并保存草稿');
    select().props.onChange({ target: { value: 'new' } });
    await f.ui.flush();
    const restored = component(f.ui.tree, 'BotProfileFields').props.draft;
    assert.equal(restored.name, '新 Bot 草稿');
    assert.equal(restored.instructions, '私有长指令不得落入恢复存储');
    assert.equal(restored.avatarImageId, '11111111-1111-4111-8111-111111111111');
    assert.equal(restored.assignment, '核对时调整的分工');
  } finally {
    f.ui.dispose();
  }
});

test('an incomplete successful response remains an unknown request instead of accepting a new base', async () => {
  const f = await fixture({
    transport: (call, fallback) => {
      if (call.path.endsWith('/refresh-bots'))
        return json({ requestId: call.body.requestId, planId: 'plan', plan: initialPlan });
      return fallback();
    },
  });
  try {
    await clicks(f.ui, '核对 Bot 资料');
    await clicks(f.ui, '使用以上资料并保存草稿');
    assert.match(f.ui.copy, /无法确认这次保存结果/);
    assert.match(f.ui.copy, /核对上次资料保存/);
    assert.equal(f.memory.values.size, 1);
    assert.equal(f.ui.field('群聊名称').props.disabled, true);
  } finally {
    f.ui.dispose();
  }
});
