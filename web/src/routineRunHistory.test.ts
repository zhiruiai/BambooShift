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
import type { Routine } from '../../shared/types';
import type { RoutineRun } from '../../shared/routine-runs';
import {
  json,
  deferred,
  all,
  component,
  harness,
  workspaceId,
  userId,
  agent,
  chat,
  routine,
  run,
  env,
  history,
  dialog,
  icon,
} from './testSupport/routineRunHistoryFixture';

test('actual history renders every real status, explicit times and fresh result navigation without writes', async () => {
  const calls: string[] = [],
    opened: RoutineRun[] = [];
  const runs = ['running', 'completed', 'error', 'cancelled', 'interrupted'].map((status, i) => ({
    ...run,
    runId: `run-${i}`,
    status,
    resultMessageId: status === 'running' ? undefined : `result-${i}`,
    error: status === 'error' ? '模型未能完成本次工作。' : undefined,
  }));
  const h = await history(
    async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.method, 'GET');
      return json(String(url).endsWith('/runs') ? { routineId: routine.id, runs } : runs[1]);
    },
    {
      onOpenRun: async (value: RoutineRun) => {
        opened.push(value);
      },
    },
  );
  try {
    assert.match(h.copy, /正在运行/);
    assert.match(h.copy, /已完成/);
    assert.match(h.copy, /运行失败/);
    assert.match(h.copy, /已取消/);
    assert.match(h.copy, /已中断/);
    assert.match(h.copy, /09:00:00.*北京时间/);
    assert.match(h.copy, /模型未能完成/);
    assert.match(h.copy, /查看进度/);
    await h.button('查看结果').props.onClick();
    await h.flush();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].runId, 'run-1');
    assert.ok(calls[1].endsWith('/runs/run-1'));
  } finally {
    h.dispose();
  }
});

test('empty and failed histories are distinct; refresh failure keeps recorded results visible', async () => {
  let fail = false;
  const h = await history(async () =>
    fail ? json({ error: '暂时不能读取' }, 503) : json({ routineId: routine.id, runs: [] }),
  );
  try {
    assert.match(h.copy, /暂无运行记录/);
    fail = true;
    await h.button('刷新记录').props.onClick();
    await h.flush();
    assert.match(h.copy, /暂时不能读取/);
    assert.doesNotMatch(h.copy, /暂无运行记录/);
  } finally {
    h.dispose();
  }
  const failed = await history(async () => json({ error: '任务已移除' }, 404));
  try {
    assert.match(failed.copy, /任务已移除/);
    assert.doesNotMatch(failed.copy, /暂无运行记录/);
  } finally {
    failed.dispose();
  }
});

test('actual fresh-read handler refuses deleted result and offers surviving trigger record explicitly', async () => {
  let opened = 0;
  const h = await history(
    async (url) =>
      json(
        String(url).endsWith('/runs')
          ? { routineId: routine.id, runs: [run] }
          : { ...run, resultMessageId: undefined },
      ),
    {
      onOpenRun: () => {
        opened++;
      },
    },
  );
  try {
    await h.button('查看结果').props.onClick();
    await h.flush();
    assert.equal(opened, 0);
    assert.match(h.copy, /原结果已不可用/);
    assert.match(h.copy, /查看触发记录/);
    await h.button('查看触发记录').props.onClick();
    await h.flush();
    assert.equal(opened, 1);
  } finally {
    h.dispose();
  }
});

test('late exact-read response after account change or unmount never opens a result', async () => {
  for (const mode of ['account', 'unmount']) {
    const late = deferred<Response>();
    let opened = 0;
    const h = await history(
      async (url) =>
        String(url).endsWith('/runs') ? json({ routineId: routine.id, runs: [run] }) : late.promise,
      {
        onOpenRun: () => {
          opened++;
        },
      },
    );
    h.button('查看结果').props.onClick();
    if (mode === 'account') {
      h.setProps({ userId: 'other-user' });
      await h.flush();
    } else h.dispose();
    late.resolve(json(run));
    await h.flush();
    assert.equal(opened, 0);
    if (mode === 'account') h.dispose();
  }
});

test('opening a routine selects the read-only overview, while explicit edit preserves the existing form workflow', async () => {
  const h = await dialog({ initialRoutineId: routine.id });
  try {
    assert.equal(component(h.tree, 'RoutineOverview').props.routine.id, routine.id);
    assert.equal(component(h.tree, 'RoutineRunHistory').props.routineId, routine.id);
    assert.equal(h.field('任务名称').props.value, '');
    icon(h, `编辑任务 ${routine.title}`).props.onClick();
    await h.flush();
    assert.equal(h.field('任务名称').props.value, routine.title);
    h.field('任务名称').props.onChange({ target: { value: '我的未保存修改' } });
    await h.flush();
    h.button(routine.title).props.onClick();
    await h.flush();
    assert.equal(
      h.field('任务名称').props.value,
      '我的未保存修改',
      'toggling details does not replace an editor draft',
    );
  } finally {
    h.dispose();
  }
});

test('routine deletion requires explicit confirmation, sends captured configuration and preserves draft on failure', async () => {
  const deleted: Routine[] = [];
  const h = await dialog({
    onDelete: async (value: Routine) => {
      deleted.push(value);
      throw Error('删除未完成，请核对');
    },
  });
  try {
    icon(h, '删除任务').props.onClick();
    await h.flush();
    assert.equal(deleted.length, 0);
    assert.match(h.copy, /已开始的工作不会停止/);
    h.button('取消删除').props.onClick();
    await h.flush();
    assert.equal(deleted.length, 0);
    icon(h, `编辑任务 ${routine.title}`).props.onClick();
    await h.flush();
    h.field('任务名称').props.onChange({ target: { value: '尚未保存' } });
    await h.flush();
    icon(h, '删除任务').props.onClick();
    await h.flush();
    assert.match(h.copy, /放弃尚未保存/);
    h.button('放弃更改并继续').props.onClick();
    await h.flush();
    await h.button(`确认删除「${routine.title}」`).props.onClick();
    await h.flush();
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].title, routine.title);
    assert.match(h.copy, /删除未完成/);
    assert.equal(h.field('任务名称').props.value, '尚未保存');
  } finally {
    h.dispose();
  }
});

test('delete confirmation rejects changed plans and stale account callbacks without sending', async () => {
  for (const mode of ['plan', 'account', 'unmount']) {
    let calls = 0;
    const h = await dialog({
      onDelete: async () => {
        calls++;
      },
    });
    icon(h, '删除任务').props.onClick();
    await h.flush();
    const confirm = h.button(`确认删除「${routine.title}」`).props.onClick;
    if (mode === 'plan') {
      h.setProps({ routines: [{ ...routine, prompt: '新内容' }] });
      await h.flush();
    }
    if (mode === 'account') {
      h.setProps({ userId: 'other-user' });
      await h.flush();
    }
    if (mode === 'unmount') h.dispose();
    await confirm();
    await h.flush();
    assert.equal(calls, 0);
    if (mode === 'plan') assert.match(h.copy, /任务已有变化/);
    if (mode !== 'unmount') h.dispose();
  }
});

test('member details reuse the overview/history but expose no edit, run or delete controls', async () => {
  const h = await harness(
    'web/src/components/RoutineDetails.tsx',
    'RoutineDetails',
    {
      routines: [routine],
      agents: [agent],
      conversations: [chat],
      initialRoutineId: routine.id,
      workspaceId,
      userId: 'member-a',
      onClose() {},
      onOpenRun: async () => {},
    },
    env(async () => json({ routineId: routine.id, runs: [run] })),
  );
  try {
    await h.flush();
    assert.equal(component(h.tree, 'RoutineOverview').props.routine.id, routine.id);
    assert.equal(component(h.tree, 'RoutineRunHistory').props.userId, 'member-a');
    assert.equal(
      all(h.tree, (node) => node.type === 'button' || node.type?.name === 'IconButton').length,
      0,
    );
    assert.doesNotMatch(h.copy, /立即运行|删除任务|保存修改/);
  } finally {
    h.dispose();
  }
});
