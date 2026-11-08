import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIME_ZONE,
  normalizeTimeZone,
  effectiveTimeZone,
  timeZoneLabel,
  localDayKey,
  dailyRoutineSlot,
  routineSlotOnDay,
} from './time-zone.js';
import { nextRoutineRun, routineScheduleLabel } from './routine-schedule.js';

const at = (value: string) => Date.parse(value);
const next = (schedule: string, from: string, zone?: string) =>
  nextRoutineRun(schedule, new Date(from), zone);

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

test('local calendar keys and labels use the task zone, including non-hour offsets', () => {
  const instant = at('2026-11-06T01:00:00Z');
  assert.equal(localDayKey(instant), '2026-11-06');
  assert.equal(localDayKey(instant, 'America/New_York'), '2026-11-05');
  assert.deepEqual(dailyRoutineSlot('09:00', instant), { day: '2026-11-06', at: instant });
  assert.deepEqual(dailyRoutineSlot('09:00', instant, 'America/New_York'), {
    day: '2026-11-05',
    at: at('2026-11-05T14:00:00Z'),
  });
  assert.equal(
    next('daily:09:00', '2026-11-06T01:00:00Z', 'Asia/Kathmandu'),
    '2026-11-06T03:15:00.000Z',
  );
  assert.equal(next('daily:09:00', '2026-11-06T01:00:00Z'), '2026-11-07T01:00:00.000Z');
  assert.equal(routineScheduleLabel('daily:09:00'), '每天 09:00 · 北京时间');
  assert.equal(
    routineScheduleLabel('weekly:1,2,3,4,5:09:00', 'America/New_York'),
    '工作日 09:00 · America/New_York',
  );
  assert.equal(routineScheduleLabel('interval:90', 'America/New_York'), '每 90 分钟');
  assert.equal(routineScheduleLabel('unknown-legacy', 'America/New_York'), 'unknown-legacy');
});

test('New York spring gaps are skipped and autumn folds choose only the earliest occurrence', () => {
  assert.equal(
    dailyRoutineSlot('02:30', at('2026-03-08T05:00:00Z'), 'America/New_York'),
    undefined,
  );
  assert.equal(
    next('daily:02:30', '2026-03-08T05:00:00Z', 'America/New_York'),
    '2026-03-09T06:30:00.000Z',
  );
  assert.equal(
    next('daily:01:30', '2026-11-01T05:29:59.999Z', 'America/New_York'),
    '2026-11-01T05:30:00.000Z',
  );
  for (const from of [
    '2026-11-01T05:30:00Z',
    '2026-11-01T06:00:00Z',
    '2026-11-01T06:29:59.999Z',
    '2026-11-01T06:30:00Z',
  ]) {
    assert.equal(next('daily:01:30', from, 'America/New_York'), '2026-11-02T06:30:00.000Z', from);
    assert.deepEqual(dailyRoutineSlot('01:30', at(from), 'America/New_York'), {
      day: '2026-11-01',
      at: at('2026-11-01T05:30:00Z'),
    });
  }
});

test('weekly schedules search beyond a missing selected day instead of shifting its time', () => {
  assert.equal(
    next('weekly:7:02:30', '2026-03-07T05:00:00Z', 'America/New_York'),
    '2026-03-15T06:30:00.000Z',
  );
  assert.equal(
    next('weekly:1,7:02:30', '2026-03-07T05:00:00Z', 'America/New_York'),
    '2026-03-09T06:30:00.000Z',
  );
  assert.equal(
    next('weekly:7:01:30', '2026-11-01T06:00:00Z', 'America/New_York'),
    '2026-11-08T06:30:00.000Z',
  );
});

test('Lord Howe handles half-hour gaps and folds without assuming one-hour DST', () => {
  assert.equal(
    dailyRoutineSlot('02:15', at('2026-10-03T15:00:00Z'), 'Australia/Lord_Howe'),
    undefined,
  );
  assert.equal(
    next('daily:02:15', '2026-10-03T15:00:00Z', 'Australia/Lord_Howe'),
    '2026-10-04T15:15:00.000Z',
  );
  assert.equal(
    next('daily:01:45', '2026-04-04T14:44:59.999Z', 'Australia/Lord_Howe'),
    '2026-04-04T14:45:00.000Z',
  );
  assert.equal(
    next('daily:01:45', '2026-04-04T15:00:00Z', 'Australia/Lord_Howe'),
    '2026-04-05T15:15:00.000Z',
  );
});

test('an entirely skipped Apia date does not turn a Friday routine into Saturday work', () => {
  assert.equal(routineSlotOnDay('2011-12-30', '09:00', 'Pacific/Apia'), undefined);
  assert.equal(
    next('daily:09:00', '2011-12-29T20:00:00Z', 'Pacific/Apia'),
    '2011-12-30T19:00:00.000Z',
  );
  assert.equal(
    next('weekly:5:09:00', '2011-12-29T20:00:00Z', 'Pacific/Apia'),
    '2012-01-05T19:00:00.000Z',
  );
  assert.equal(localDayKey(at('2011-12-30T19:00:00Z'), 'Pacific/Apia'), '2011-12-31');
});

test('elapsed intervals do not skip or duplicate minutes during DST or date changes', () => {
  for (const from of ['2026-03-08T06:30:00Z', '2026-11-01T05:30:00Z', '2011-12-30T09:30:00Z'])
    for (const zone of ['America/New_York', 'Australia/Lord_Howe', 'Pacific/Apia', 'Asia/Shanghai'])
      assert.equal(Date.parse(next('interval:60', from, zone)) - at(from), 3600000);
  assert.equal(
    next('interval:60', '2026-11-01T05:30:00Z', 'America/New_York'),
    '2026-11-01T06:30:00.000Z',
  );
});

test('calendar scheduling is strictly later across leap days and year boundaries regardless of host TZ', () => {
  const original = process.env.TZ;
  try {
    for (const host of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = host;
      assert.equal(
        next('daily:09:00', '2028-02-28T14:00:00Z', 'America/New_York'),
        '2028-02-29T14:00:00.000Z',
      );
      assert.equal(
        next('daily:00:00', '2026-12-31T10:00:00Z', 'Pacific/Kiritimati'),
        '2027-01-01T10:00:00.000Z',
      );
      assert.equal(
        next('daily:00:00', '2026-12-31T23:59:59.999Z', 'UTC'),
        '2027-01-01T00:00:00.000Z',
      );
      assert.equal(
        next('daily:01:30', '2026-11-01T06:00:00Z', 'America/New_York'),
        '2026-11-02T06:30:00.000Z',
      );
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('invalid zones, instants and clock formats never silently select a different execution time', () => {
  for (const time of ['9:00', '24:00', '12:60', '09:00:00', ' 09:00', '09:00\n', '', 'abc'])
    assert.throws(() => dailyRoutineSlot(time, at('2026-01-01T00:00:00Z'), 'UTC'), /时间/);
  for (const time of [NaN, Infinity, -Infinity, 0.5])
    assert.throws(() => localDayKey(time), /起点/);
  assert.throws(() => nextRoutineRun('daily:09:00', new Date(NaN)), /起点/);
  assert.throws(() => nextRoutineRun('interval:1', new Date(), 'invalid/time-zone'), /时区/);
  assert.throws(() => dailyRoutineSlot('09:00', Date.now(), '+08:00'), /时区/);
  assert.throws(() => routineSlotOnDay('2026-02-30', '09:00', 'UTC'));
});

test('calendar labels expose an invalid stored zone while keeping legacy schedule and elapsed interval labels', () => {
  for (const schedule of ['daily:09:00', 'weekly:1,2,3,4,5:09:00'])
    assert.equal(routineScheduleLabel(schedule, 'Invalid/Zone'), '计划时区暂不可用');
  assert.equal(routineScheduleLabel('legacy-schedule', 'Invalid/Zone'), 'legacy-schedule');
  assert.equal(routineScheduleLabel('interval:60', 'Invalid/Zone'), '每 60 分钟');
});
