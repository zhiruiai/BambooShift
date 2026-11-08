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
  text,
  all,
  harness,
  workspaceId,
  userId,
  env,
  submit,
  agent,
  chat,
  routine,
  routines,
} from './testSupport/timeZonesFixture';

test('primary form preserves legacy check-in zones and new defaults, while save sends the explicit visible zone', async () => {
  for (const existing of [true, false]) {
    const state = {
      available: true,
      revision: 'primary-a',
      agentId: existing ? agent.id : null,
      conversationId: existing ? chat.id : null,
      checkIn: { enabled: true, time: '09:00' },
    };
    const writes: any[] = [],
      saved: any[] = [];
    const h = await harness(
      'web/src/components/PrimaryBotDialog.tsx',
      'PrimaryBotContent',
      {
        userId,
        workspaceId,
        team: false,
        agents: [agent],
        state,
        initialMode: 'select',
        defaultTimeZone: 'America/New_York',
        onClose() {},
        onSaved: (value: any) => saved.push(value),
      },
      env(async (_, init) => {
        if (init?.method === 'PUT') {
          writes.push(JSON.parse(String(init.body)));
          return json({ error: '设置冲突' }, 409);
        }
        return json(state);
      }),
    );
    try {
      await h.flush();
      assert.equal(h.field('时区').props.value, existing ? 'Asia/Shanghai' : 'America/New_York');
      h.setProps({ defaultTimeZone: 'Europe/Paris' });
      await h.flush();
      assert.equal(h.field('时区').props.value, existing ? 'Asia/Shanghai' : 'America/New_York');
      all(
        h.tree,
        (node) => node.type === 'button' && node.props.className?.startsWith('primary-bot-choice '),
      )[0].props.onClick();
      h.field('时区').props.onChange({ target: { value: 'Europe/London' } });
      await h.flush();
      submit(h);
      await h.flush();
      assert.equal(writes[0].checkIn.timeZone, 'Europe/London');
      assert.equal(h.field('时区').props.value, 'Europe/London');
      assert.equal(saved.length, 0);
      assert.match(h.copy, /填写的内容仍然保留/);
    } finally {
      h.dispose();
    }
  }
});

test('saved schedule labels and template preview preserve source zones rather than applying an import destination default', async () => {
  const source = { ...routine, timeZone: 'America/New_York' };
  assert.match(
    routineNextRunLabel(source as any, Date.parse('2030-11-04T00:00:00Z')),
    /09:00 · America\/New_York/,
  );
  assert.match(zonedTimeLabel(source.nextRunAt), /22:00 · 北京时间/);
  assert.match(routineScheduleLabel(routine.schedule), /北京时间/);
  const draft = draftForRoutine([agent] as any, source as any, 'Europe/London');
  assert.equal(draft.timeZone, source.timeZone);
  assert.equal(
    'timeZone' in routineSaveBody({ ...draft, title: '重命名' }, chat.id, source as any),
    false,
  );
  const blueprint = { profile: agent, skills: [], routines: [source, routine] };
  const h = await harness('web/src/components/BotTemplatePreview.tsx', 'BotTemplatePreview', {
    blueprint,
    routineMode: 'pause',
  });
  try {
    await h.flush();
    assert.match(h.copy, /America\/New_York/);
    assert.match(h.copy, /北京时间/);
    assert.match(h.copy, /创建后暂停/);
  } finally {
    h.dispose();
  }
  const options = timeZoneOptions('America/New_York');
  assert.ok(
    options.some((item) => item.value === 'America/New_York' && item.label.includes('纽约')),
  );
});

test('damaged saved zones remain visible for explicit repair and a text-only save cannot hide the invalid plan', async () => {
  const broken = { ...routine, timeZone: 'Mars/Olympus' };
  const draft = draftForRoutine([agent] as any, broken as any, 'Europe/London');
  assert.equal(draft.timeZone, 'Mars/Olympus');
  assert.throws(
    () => routineSaveBody({ ...draft, title: '只改标题' }, chat.id, broken as any),
    /时区/,
  );
  assert.equal(
    routineSaveBody({ ...draft, timeZone: 'Europe/London' }, chat.id, broken as any).timeZone,
    'Europe/London',
  );
  assert.match(
    routineNextRunLabel(broken as any, Date.parse('2030-11-04T00:00:00Z')),
    /时区暂不可用/,
  );
  const writes: any[] = [];
  const h = await routines({
    routines: [broken],
    initialRoutineId: broken.id,
    onSave: async (body: any) => writes.push(body),
  });
  try {
    await h.flush();
    assert.equal(h.field('时区').props.value, 'Mars/Olympus');
    assert.match(h.copy, /时区暂不可用/);
    h.field('任务名称').props.onChange({ target: { value: '仍需修复' } });
    await h.flush();
    await submit(h);
    await h.flush();
    assert.equal(writes.length, 0);
    h.field('时区').props.onChange({ target: { value: 'Europe/London' } });
    await h.flush();
    await submit(h);
    await h.flush();
    assert.equal(writes[0].timeZone, 'Europe/London');
  } finally {
    h.dispose();
  }
  const intervalWrites: any[] = [];
  const interval = await routines({
    routines: [{ ...broken, schedule: 'interval:60' }],
    initialRoutineId: broken.id,
    onSave: async (body: any) => intervalWrites.push(body),
  });
  try {
    await interval.flush();
    assert.equal(
      interval.field('时区').props.value,
      'Mars/Olympus',
      'damaged interval zone can be repaired directly',
    );
    interval.field('时区').props.onChange({ target: { value: 'Europe/London' } });
    await interval.flush();
    assert.equal(all(interval.tree, (node) => node.type?.name === 'TimeZoneSelect').length, 0);
    await submit(interval);
    await interval.flush();
    assert.equal(intervalWrites[0].timeZone, 'Europe/London');
    assert.equal(
      'schedule' in intervalWrites[0],
      false,
      'repairing a display zone does not change the minute interval',
    );
  } finally {
    interval.dispose();
  }
  const state = {
    available: true,
    revision: 'primary-a',
    agentId: agent.id,
    conversationId: chat.id,
    checkIn: { enabled: true, time: '09:00', timeZone: 'Mars/Olympus' },
  };
  const primaryWrites: any[] = [];
  const primary = await harness(
    'web/src/components/PrimaryBotDialog.tsx',
    'PrimaryBotContent',
    {
      state,
      agents: [agent],
      userId,
      workspaceId,
      team: false,
      onClose() {},
      onSaved() {},
    },
    env(async (_, init) => {
      if (init?.method === 'PUT') {
        primaryWrites.push(JSON.parse(String(init.body)));
        return json({ error: '保持此测试表单' }, 409);
      }
      return json(state);
    }),
  );
  try {
    await primary.flush();
    assert.equal(primary.field('时区').props.value, 'Mars/Olympus');
    submit(primary);
    await primary.flush();
    assert.equal(primaryWrites.length, 0);
    primary.field('时区').props.onChange({ target: { value: 'Europe/London' } });
    await primary.flush();
    submit(primary);
    await primary.flush();
    assert.equal(primaryWrites[0].checkIn.timeZone, 'Europe/London');
  } finally {
    primary.dispose();
  }
});
