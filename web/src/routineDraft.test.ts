import test from 'node:test';
import assert from 'node:assert/strict';
import type { BotAgent, Routine } from '../../shared/types.js';
import { routineConfigSnapshot } from '../../shared/routine-operations.js';
import {
  draftForRoutine,
  routineNextRunLabel,
  routineSaveBody,
  scheduleForRoutineDraft,
} from './routineDraft.js';

const agents = [{ id: 'chief' }] as BotAgent[];
const routine = (schedule: string, enabled = true): Routine => ({
  id: 'routine-1',
  agentId: 'chief',
  conversationId: 'chat-1',
  title: '团队简报',
  prompt: '整理本周更新',
  schedule,
  enabled,
  nextRunAt: '2026-11-09T01:00:00.000Z',
});

test('weekday and custom weekly plans refill their real selected days and round-trip canonically', () => {
  const workdays = draftForRoutine(agents, routine('weekly:1,2,3,4,5:08:30'));
  assert.equal(workdays.mode, 'weekdays');
  assert.equal(workdays.time, '08:30');
  assert.equal(scheduleForRoutineDraft(workdays), 'weekly:1,2,3,4,5:08:30');
  const custom = draftForRoutine(agents, routine('weekly:7,3,1:23:55'));
  assert.equal(custom.mode, 'weekly');
  assert.deepEqual(custom.days, [1, 3, 7]);
  assert.equal(scheduleForRoutineDraft(custom), 'weekly:1,3,7:23:55');
  const all = draftForRoutine(agents, routine('weekly:1,2,3,4,5,6,7:00:00'));
  assert.equal(all.mode, 'weekly');
  assert.deepEqual(all.days, [1, 2, 3, 4, 5, 6, 7]);
});

test('editing title or prompt preserves the schedule, pause state and original target conversation', () => {
  for (const schedule of [
    'daily:09:00',
    'weekly:5,1,3:17:15',
    'weekly:1,2,3,4,5:09:00',
    'interval:00060',
  ]) {
    const old = routine(schedule, false);
    const draft = { ...draftForRoutine(agents, old), title: '新标题', prompt: '新任务内容' };
    const body = routineSaveBody(draft, 'other-chat', old);
    assert.equal(body.title, '新标题');
    assert.equal(body.prompt, '新任务内容');
    assert.equal(body.conversationId, 'chat-1');
    assert.equal('schedule' in body, false);
    assert.equal('enabled' in body, false);
    assert.equal('nextRunAt' in body, false);
  }
});

test('explicit frequency or weekday changes send a new schedule; empty weekday selections cannot be submitted', () => {
  const old = routine('weekly:1,3,5:09:00');
  const draft = draftForRoutine(agents, old);
  assert.equal(
    routineSaveBody({ ...draft, days: [6, 7], time: '10:00' }, 'chat-1', old).schedule,
    'weekly:6,7:10:00',
  );
  assert.equal(
    routineSaveBody({ ...draft, mode: 'weekdays' }, 'chat-1', old).schedule,
    'weekly:1,2,3,4,5:09:00',
  );
  assert.throws(() => routineSaveBody({ ...draft, days: [] }, 'chat-1', old), /至少选择一天/);
  assert.throws(() => scheduleForRoutineDraft({ ...draft, days: [1, 1] }));
  const created = routineSaveBody({ ...draftForRoutine(agents), mode: 'weekdays' }, 'new-chat');
  assert.equal(created.enabled, true);
  assert.equal(created.conversationId, 'new-chat');
  assert.equal(created.schedule, 'weekly:1,2,3,4,5:09:00');
});

test('unrecognized existing schedules require an explicit repair instead of silently becoming daily', () => {
  const old = routine('broken');
  const draft = draftForRoutine(agents, old);
  assert.equal(draft.mode, 'invalid');
  assert.throws(() => routineSaveBody({ ...draft, title: '仅改名字' }, 'chat-1', old), /重新选择/);
  assert.equal(routineSaveBody({ ...draft, mode: 'daily' }, 'chat-1', old).schedule, 'daily:09:00');
});

test('next-run copy uses the stored instant in Beijing time and never presents a paused/overdue plan as newly scheduled', () => {
  const at = Date.parse('2026-11-08T22:00:00.000Z');
  assert.match(routineNextRunLabel(routine('weekly:1:09:00'), at), /2026\/11\/09 09:00 · 北京时间/);
  assert.equal(
    routineNextRunLabel(routine('weekly:1:09:00', false), at),
    '已暂停 · 启用后重新安排',
  );
  assert.equal(
    routineNextRunLabel(routine('weekly:1:09:00'), Date.parse('2026-11-09T01:00:00.000Z')),
    '计划时间已到 · 等待调度',
  );
  assert.equal(
    routineNextRunLabel({ ...routine('weekly:1:09:00'), nextRunAt: 'invalid' }, at),
    '下次执行时间暂不可用',
  );
});

test('routine public search sends exact approved queries and fences edits against the reviewed grant', () => {
  const old = { ...routine('daily:09:00'), publicSearchQueries: ['OpenBot release notes'] };
  const draft = draftForRoutine(agents, old);
  assert.deepEqual(draft.publicSearch, { enabled: true, text: 'OpenBot release notes' });
  const unchanged = routineSaveBody({ ...draft, title: '更名' }, 'chat-1', old);
  assert.equal('publicSearchQueries' in unchanged, false);
  assert.equal('expectedRoutine' in unchanged, false);

  const changed = routineSaveBody(
    { ...draft, publicSearch: { enabled: true, text: ' Pi  releases \r\n\n Pi docs ' } },
    'chat-1',
    old,
  );
  assert.deepEqual(changed.publicSearchQueries, ['Pi  releases', 'Pi docs']);
  assert.deepEqual(changed.expectedRoutine?.publicSearchQueries, ['OpenBot release notes']);
  assert.notEqual(changed.expectedRoutine?.publicSearchQueries, old.publicSearchQueries);
  assert.deepEqual(changed.expectedRoutine, routineConfigSnapshot(old));

  const cleared = routineSaveBody(
    { ...draft, publicSearch: { enabled: false, text: draft.publicSearch!.text } },
    'chat-1',
    old,
  );
  assert.deepEqual(cleared.publicSearchQueries, []);
  assert.deepEqual(cleared.expectedRoutine, changed.expectedRoutine);
  assert.equal('publicSearchQueries' in routineConfigSnapshot(routine('daily:09:00')), false);
});

test('routine search creation validates exact text, unique lines and UTF-16 limits', () => {
  const create = (text: string) =>
    routineSaveBody(
      { ...draftForRoutine(agents), publicSearch: { enabled: true, text } },
      'chat-1',
    );
  assert.deepEqual(create(' Pi release \nPi Release ').publicSearchQueries, [
    'Pi release',
    'Pi Release',
  ]);
  assert.equal(create('🖥'.repeat(80)).publicSearchQueries?.[0].length, 160);
  assert.throws(() => create('🖥'.repeat(81)), /160/);
  assert.throws(() => create('   '), /160/);
  assert.throws(() => create('a\nb\nc\nd\ne'), /160/);
  assert.throws(() => create('Pi\tdocs'), /纯文本/);
  assert.throws(() => create(' Pi release \nPi release'), /不同/);
});
