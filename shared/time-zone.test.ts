import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TIME_ZONE, normalizeTimeZone, effectiveTimeZone, timeZoneLabel } from './time-zone.js';
import { routineScheduleLabel } from './routine-schedule.js';

test('named time zones are canonical and only a missing legacy value defaults to Shanghai', () => {
  assert.equal(DEFAULT_TIME_ZONE, 'Asia/Shanghai');
  assert.equal(effectiveTimeZone(), 'Asia/Shanghai');
  assert.equal(normalizeTimeZone('asia/shanghai'), 'Asia/Shanghai');
  assert.equal(normalizeTimeZone('america/new_york'), 'America/New_York');
  assert.equal(normalizeTimeZone('US/Eastern'), 'America/New_York');
  assert.equal(normalizeTimeZone('utc'), 'UTC');
  assert.equal(normalizeTimeZone('Etc/UTC'), 'UTC');
  assert.equal(normalizeTimeZone('Etc/GMT+5'), 'Etc/GMT+5');
  assert.equal(timeZoneLabel(), '北京时间');
  assert.equal(timeZoneLabel('Asia/Shanghai'), '北京时间');
  assert.equal(timeZoneLabel('America/New_York'), 'America/New_York');
  assert.equal(timeZoneLabel('UTC'), 'UTC');
  for (const value of [
    undefined,
    null,
    '',
    ' ',
    'UTC ',
    ' UTC',
    '\nUTC',
    0,
    false,
    {},
    ['UTC'],
    '+08:00',
    '-0530',
    '+23',
    'Asia/Nowhere',
    'Asia/Shanghai\0',
    'x'.repeat(101),
  ]) {
    assert.throws(() => normalizeTimeZone(value), /时区/, String(value));
    if (value !== undefined) assert.throws(() => effectiveTimeZone(value as any), /时区/);
  }
});

test('calendar labels use the saved time zone and retain legacy values', () => {
  assert.equal(routineScheduleLabel('daily:09:00'), '每天 09:00 · 北京时间');
  assert.equal(
    routineScheduleLabel('weekly:1,2,3,4,5:09:00', 'America/New_York'),
    '工作日 09:00 · America/New_York',
  );
  assert.equal(routineScheduleLabel('interval:90', 'America/New_York'), '每 90 分钟');
  assert.equal(routineScheduleLabel('unknown-legacy', 'America/New_York'), 'unknown-legacy');
});

test('calendar labels expose an invalid stored zone while keeping legacy schedule and elapsed interval labels', () => {
  for (const schedule of ['daily:09:00', 'weekly:1,2,3,4,5:09:00'])
    assert.equal(routineScheduleLabel(schedule, 'Invalid/Zone'), '计划时区暂不可用');
  assert.equal(routineScheduleLabel('legacy-schedule', 'Invalid/Zone'), 'legacy-schedule');
  assert.equal(routineScheduleLabel('interval:60', 'Invalid/Zone'), '每 60 分钟');
});
