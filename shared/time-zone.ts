import { Temporal } from '@js-temporal/polyfill';

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** Validate an explicit named zone. Numeric offsets are not scheduling zones. */
export function normalizeTimeZone(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 100 ||
    !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(value)
  )
    throw new Error('请选择有效的 IANA 时区，例如 Asia/Shanghai 或 America/New_York。');
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new Error('请选择有效的 IANA 时区，例如 Asia/Shanghai 或 America/New_York。');
  }
}

/** Only absence preserves the historical Beijing-time default; invalid values fail closed. */
export function effectiveTimeZone(value?: string): string {
  return value === undefined ? DEFAULT_TIME_ZONE : normalizeTimeZone(value);
}

export function timeZoneLabel(value?: string): string {
  const zone = effectiveTimeZone(value);
  return zone === DEFAULT_TIME_ZONE ? '北京时间' : zone;
}

export function localDayKey(at: number, timeZone?: string): string {
  if (!Number.isSafeInteger(at)) throw new Error('计算执行时间的起点无效');
  return Temporal.Instant.fromEpochMilliseconds(at)
    .toZonedDateTimeISO(effectiveTimeZone(timeZone))
    .toPlainDate()
    .toString();
}

/** Internal shared calendar primitive; no elapsed-day arithmetic or offset guessing. */
export function routineSlotOnDay(
  day: string,
  time: string,
  timeZone?: string,
): { day: string; at: number } | undefined {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('执行时间无效。');
  const desired = Temporal.PlainDate.from(day, { overflow: 'reject' }).toPlainDateTime(time);
  const resolved = desired.toZonedDateTime(effectiveTimeZone(timeZone), {
    disambiguation: 'earlier',
  });
  // earlier chooses only the first occurrence in a fold. For a gap it shifts
  // to another wall-clock time; reject that shift instead of silently running.
  if (!resolved.toPlainDateTime().equals(desired)) return;
  return { day: desired.toPlainDate().toString(), at: resolved.epochMilliseconds };
}

/** Today's occurrence in the task's zone; undefined when its clock time does not exist. */
export function dailyRoutineSlot(time: string, at: number, timeZone?: string) {
  const zone = effectiveTimeZone(timeZone);
  return routineSlotOnDay(localDayKey(at, zone), time, zone);
}
