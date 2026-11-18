import { timeZoneLabel } from './time-zone.js';

export type RoutineSchedule =
  | { kind: 'webhook' }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
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
  const daily = /^daily:((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (daily) return { kind: 'daily', time: daily[1] };
  const weekly = /^weekly:([1-7](?:,[1-7]){0,6}):((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (weekly) {
    const days = weekly[1]
      .split(',')
      .map(Number)
      .sort((a, b) => a - b);
    if (new Set(days).size !== days.length) throw invalid();
    return { kind: 'weekly', days, time: weekly[2] };
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
