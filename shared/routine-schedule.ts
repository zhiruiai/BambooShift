import { Temporal } from '@js-temporal/polyfill';
import { effectiveTimeZone, localDayKey, routineSlotOnDay, timeZoneLabel } from './time-zone.js';

export type RoutineSchedule =
  | { kind: 'webhook' }
  | { kind: 'daily'; time: string; hour: number; minute: number }
  | { kind: 'weekly'; days: number[]; time: string; hour: number; minute: number }
  | { kind: 'interval'; minutes: number };

const invalid = () =>
  new Error('请选择有效的执行频率；每周任务需选择周一到周日中的至少一天，且不能重复。');

/** ISO weekdays (Monday=1, Sunday=7); the owning task supplies its fixed time zone. */
export function parseRoutineSchedule(value: unknown): RoutineSchedule {
  if (typeof value !== 'string' || value.length > 80) throw invalid();
  if (value === 'webhook') return { kind: 'webhook' };
  const interval = /^interval:(\d+)$/.exec(value);
  if (interval) {
    const minutes = Number(interval[1]);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 525600)
      throw new Error('间隔应为 1 到 525600 分钟');
    return { kind: 'interval', minutes };
  }
  const daily = /^daily:(([01]\d|2[0-3]):([0-5]\d))$/.exec(value);
  if (daily)
    return { kind: 'daily', time: daily[1], hour: Number(daily[2]), minute: Number(daily[3]) };
  const weekly = /^weekly:([1-7](?:,[1-7]){0,6}):(([01]\d|2[0-3]):([0-5]\d))$/.exec(value);
  if (weekly) {
    const days = weekly[1]
      .split(',')
      .map(Number)
      .sort((a, b) => a - b);
    if (new Set(days).size !== days.length) throw invalid();
    return {
      kind: 'weekly',
      days,
      time: weekly[2],
      hour: Number(weekly[3]),
      minute: Number(weekly[4]),
    };
  }
  throw invalid();
}

export function normalizeRoutineSchedule(value: unknown): string {
  const parsed = parseRoutineSchedule(value);
  if (parsed.kind === 'webhook') return 'webhook';
  if (parsed.kind === 'interval') return `interval:${parsed.minutes}`;
  if (parsed.kind === 'daily') return `daily:${parsed.time}`;
  return `weekly:${parsed.days.join(',')}:${parsed.time}`;
}

/** Always schedule strictly after the reference instant, independent of host timezone. */
export function nextRoutineRun(schedule: string, from = new Date(), timeZone?: string): string {
  const parsed = parseRoutineSchedule(schedule);
  if (parsed.kind === 'webhook') return '';
  const timestamp = from.getTime(),
    zone = effectiveTimeZone(timeZone);
  if (!Number.isFinite(timestamp)) throw new Error('计算执行时间的起点无效');
  if (parsed.kind === 'interval') return new Date(timestamp + parsed.minutes * 60000).toISOString();
  const start = Temporal.PlainDate.from(localDayKey(timestamp, zone));
  // A weekly occurrence can disappear during a DST gap or an entire skipped
  // date, so search the next week as well. Add calendar days, never 24 hours.
  for (let days = 0; days <= 14; days++) {
    const day = start.add({ days });
    if (parsed.kind === 'weekly' && !parsed.days.includes(day.dayOfWeek)) continue;
    const candidate = routineSlotOnDay(day.toString(), parsed.time, zone);
    if (candidate && candidate.at > timestamp) return new Date(candidate.at).toISOString();
  }
  throw new Error('无法计算下一次执行时间');
}

export function routineScheduleLabel(schedule: string, timeZone?: string): string {
  let parsed: ReturnType<typeof parseRoutineSchedule>;
  try {
    parsed = parseRoutineSchedule(schedule);
  } catch {
    return schedule;
  }
  // An elapsed interval remains meaningful without a valid calendar zone.
  if (parsed.kind === 'webhook') return '仅 Webhook 触发';
  if (parsed.kind === 'interval') return `每 ${parsed.minutes} 分钟`;
  try {
    const label = timeZoneLabel(timeZone);
    if (parsed.kind === 'daily') return `每天 ${parsed.time} · ${label}`;
    const days = parsed.days.join(',');
    const prefix =
      days === '1,2,3,4,5'
        ? '工作日'
        : days === '6,7'
          ? '周末'
          : parsed.days.length === 7
            ? '每天'
            : `每周${parsed.days.map((day) => ['一', '二', '三', '四', '五', '六', '日'][day - 1]).join('、')}`;
    return `${prefix} ${parsed.time} · ${label}`;
  } catch {
    return '计划时区暂不可用';
  }
}
