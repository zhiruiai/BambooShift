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
