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
import { draftForRoutine, routineSaveBody, routineNextRunLabel } from './routineDraft';
import { routineScheduleLabel } from '../../shared/routine-schedule';
import { timeZoneOptions, zonedTimeLabel } from './timeZones';
import {
  json,
  deferred,
  text,
  all,
  component,
  workspaceId,
  userId,
  initial,
  env,
  settings,
  submit,
  routine,
  routines,
} from './testSupport/timeZonesFixture';

test('workspace time zone stays read-only for members and hidden settings wait until visible', async () => {
  const calls: any[] = [];
  const h = await settings(
    async (url, init) => {
      calls.push({ url, init });
      return json(initial);
    },
    { active: false },
  );
  try {
    await h.flush();
    assert.equal(calls.length, 0);
    h.setProps({ active: true });
    await h.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `/api/workspaces/${workspaceId}/workspace-time-zone`);
    assert.equal(new Headers(calls[0].init.headers).get('X-OpenBot-Expected-User'), userId);
    const handler = h.field('工作默认时区').props.onChange;
    h.setProps({ active: false });
    await h.flush();
    handler({ target: { value: 'Europe/London' } });
    await h.flush();
    assert.equal(h.field('工作默认时区').props.value, 'Asia/Shanghai');
    h.setProps({ active: true, canManage: false });
    await h.flush();
    assert.equal(all(h.tree, (node) => node.type === 'select').length, 0);
    assert.match(h.copy, /空间拥有者管理/);
    handler({ target: { value: 'Europe/London' } });
    await h.flush();
    assert.equal(calls.length, 1);
  } finally {
    h.dispose();
  }
});

test('default-zone CAS conflict preserves the draft through prop updates and explicitly rebases before another save', async () => {
  const activity: any[] = [],
    saved: any[] = [],
    writes: any[] = [];
  let current = initial;
  const h = await settings(
    async (_, init) => {
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        if (writes.length === 1) return json({ error: '设置已变化' }, 409);
        return json({ timeZone: writes.at(-1).timeZone, revision: 'revision-c' });
      }
      return json(current);
    },
    {
      onActivity: (value: any) => activity.push(value),
      onSaved: (value: any) => saved.push(value),
    },
  );
  try {
    await h.flush();
    h.field('工作默认时区').props.onChange({ target: { value: 'America/New_York' } });
    assert.equal(activity.at(-1).dirty, true, 'close guard receives dirty before React rerenders');
    current = { timeZone: 'Europe/London', revision: 'revision-b' };
    h.setProps({ initialState: current });
    await h.flush();
    assert.equal(h.field('工作默认时区').props.value, 'America/New_York');
    h.button('保存工作时区').props.onClick();
    assert.equal(activity.at(-1).pending, true);
    await h.flush();
    h.button('检查当前时区').props.onClick();
    await h.flush();
    assert.equal(h.field('工作默认时区').props.value, 'America/New_York');
    assert.match(h.copy, /Europe\/London/);
    h.button('保留选择并继续编辑').props.onClick();
    await h.flush();
    assert.equal(h.field('工作默认时区').props.disabled, false);
    h.button('保存工作时区').props.onClick();
    await h.flush();
    assert.deepEqual(writes, [
      { expectedRevision: 'revision-a', timeZone: 'America/New_York' },
      { expectedRevision: 'revision-b', timeZone: 'America/New_York' },
    ]);
    assert.equal(saved.length, 1);
    assert.equal(activity.at(-1).dirty, false);
    assert.match(h.copy, /已有任务和主动跟进时间保持不变/);
  } finally {
    h.dispose();
  }
});

test('unknown default save only retries the original fixed CAS payload after a read, and a matching current value needs no resend', async () => {
  const writes: any[] = [],
    saved: any[] = [];
  let current = initial;
  const h = await settings(
    async (_, init) => {
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        throw new TypeError('Network lost');
      }
      return json(current);
    },
    { onSaved: (value: any) => saved.push(value) },
  );
  try {
    await h.flush();
    h.field('工作默认时区').props.onChange({ target: { value: 'Europe/London' } });
    await h.flush();
    const oldSave = h.button('保存工作时区').props.onClick;
    oldSave();
    await h.flush();
    oldSave();
    await h.flush();
    assert.equal(writes.length, 1);
    h.button('检查当前时区').props.onClick();
    await h.flush();
    assert.equal(h.field('工作默认时区').props.disabled, true);
    assert.equal(
      all(h.tree, (node) => node.type === 'button' && text(node) === '保留选择并继续编辑').length,
      0,
    );
    h.button('重试原设置').props.onClick();
    await h.flush();
    assert.deepEqual(writes[1], writes[0]);
    current = { timeZone: 'Europe/London', revision: 'revision-c' };
    h.button('检查当前时区').props.onClick();
    await h.flush();
    assert.equal(writes.length, 2);
    assert.equal(saved.length, 1);
    assert.match(h.copy, /当前设置已是所选时区/);
    assert.equal(h.field('工作默认时区').props.disabled, false);
  } finally {
    h.dispose();
  }
});

test('late default-zone save cannot update a different account, workspace, or disposed form', async () => {
  for (const mode of ['account', 'workspace', 'unmount']) {
    const slow = deferred<Response>(),
      saved: any[] = [];
    let writes = 0;
    const runtime = env(async (_, init) => {
      if (init?.method === 'PUT') {
        writes++;
        return slow.promise;
      }
      return json(initial);
    });
    const h = await settings(
      runtime.fetch,
      { onSaved: (value: any) => saved.push(value) },
      runtime,
    );
    await h.flush();
    h.field('工作默认时区').props.onChange({ target: { value: 'Europe/London' } });
    await h.flush();
    const save = h.button('保存工作时区').props.onClick;
    save();
    if (mode === 'account') {
      h.setProps({ userId: 'user-b' });
      await h.flush();
    }
    if (mode === 'workspace')
      runtime.window.location.pathname = '/w/99999999-9999-4999-8999-999999999999';
    if (mode === 'unmount') h.dispose();
    slow.resolve(json({ timeZone: 'Europe/London', revision: 'revision-b' }));
    await h.flush();
    save();
    await h.flush();
    assert.equal(saved.length, 0, mode);
    assert.equal(writes, 1, mode);
    if (mode !== 'unmount') h.dispose();
  }
});

test('new routine snapshots the default once, submits its visible zone, and restores it after editing an interval', async () => {
  const writes: any[] = [];
  const h = await routines({ onCreate: async (body: any) => writes.push(body) });
  try {
    await h.flush();
    assert.equal(h.field('时区').props.value, 'America/New_York');
    h.field('任务名称').props.onChange({ target: { value: '纽约早报' } });
    h.field('要完成什么').props.onChange({ target: { value: '整理消息' } });
    h.setProps({ defaultTimeZone: 'Europe/London' });
    await h.flush();
    assert.equal(h.field('时区').props.value, 'America/New_York');
    h.field('执行频率').props.onChange({ target: { value: 'interval' } });
    await h.flush();
    assert.equal(all(h.tree, (node) => node.type?.name === 'TimeZoneSelect').length, 0);
    h.field('执行频率').props.onChange({ target: { value: 'daily' } });
    await h.flush();
    assert.equal(h.field('时区').props.value, 'America/New_York');
    await submit(h);
    await h.flush();
    assert.equal(writes[0].timeZone, 'America/New_York');
    assert.equal(writes[0].schedule, 'daily:09:00');
    assert.equal(
      h.field('时区').props.value,
      'Europe/London',
      'next new draft uses the latest default',
    );
  } finally {
    h.dispose();
  }
});

test('legacy routine retains Shanghai and text-only edits omit zone; explicit zone edits preserve failures and trigger dirty close guards', async () => {
  const writes: any[] = [];
  let closed = 0;
  const h = await routines({
    routines: [routine],
    initialRoutineId: routine.id,
    onClose() {
      closed++;
    },
    onSave: async (body: any) => {
      writes.push(body);
      throw Error('保存失败，保留草稿');
    },
  });
  try {
    await h.flush();
    assert.equal(h.field('时区').props.value, 'Asia/Shanghai');
    h.field('任务名称').props.onChange({ target: { value: '只改标题' } });
    await h.flush();
    await submit(h);
    await h.flush();
    assert.equal('timeZone' in writes[0], false);
    assert.equal('schedule' in writes[0], false);
    h.field('时区').props.onChange({ target: { value: 'Europe/London' } });
    component(h.tree, 'Dialog').props.onClose();
    await h.flush();
    assert.equal(closed, 0);
    assert.match(h.copy, /放弃尚未保存/);
    h.button('继续编辑').props.onClick();
    await h.flush();
    await submit(h);
    await h.flush();
    assert.equal(writes[1].timeZone, 'Europe/London');
    assert.equal('schedule' in writes[1], false);
    assert.equal(h.field('时区').props.value, 'Europe/London');
    assert.equal(h.field('任务名称').props.value, '只改标题');
    h.button('取消编辑').props.onClick();
    await h.flush();
    h.button('放弃更改并继续').props.onClick();
    await h.flush();
    assert.equal(h.field('时区').props.value, 'America/New_York');
  } finally {
    h.dispose();
  }
});
