import { currentLanguage } from './i18n';
import { uiText } from './i18n';
/** Calendar labels use the viewer's local calendar, including daylight-saving transitions. */
export function validDate(value: string | number | Date): Date | null {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === 'string' && !value.trim()
        ? new Date(NaN)
        : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
export function dateKey(value: string | number | Date): string {
  const date = validDate(value);
  return date ? `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` : 'unknown';
}
export function calendarLabel(
  value: string | number | Date,
  now: string | number | Date = Date.now(),
): string {
  const date = validDate(value),
    today = validDate(now);
  if (!date) return uiText('common:text_0a680746ce36');
  if (today) {
    const dayNumber = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
    const difference = dayNumber(today) - dayNumber(date);
    if (difference === 0) return uiText('common:text_d5f5a7a01073');
    if (difference === 1) return uiText('common:text_0c184871f658');
  }
  if (currentLanguage() !== 'zh-CN')
    return new Intl.DateTimeFormat(currentLanguage(), {
      month: 'short',
      day: 'numeric',
      ...(!today || date.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}),
    }).format(date);
  return uiText('common:text_89a9efc147a1', {
    value0:
      !today || date.getFullYear() !== today.getFullYear()
        ? uiText('common:text_366980183519', { value0: date.getFullYear() })
        : '',
    value1: date.getMonth() + 1,
    value2: date.getDate(),
  });
}
export function messageTime(value: string | number | Date): string {
  return (
    validDate(value)?.toLocaleTimeString(currentLanguage(), {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) || uiText('common:text_664939a1fa2e')
  );
}
export function conversationTime(
  value: string | number | Date,
  now: string | number | Date = Date.now(),
): string {
  const date = validDate(value);
  if (!date) return uiText('common:text_664939a1fa2e');
  return dateKey(date) === dateKey(now) ? messageTime(date) : calendarLabel(date, now);
}
export function timestamp(value: string | number | Date): number {
  return validDate(value)?.getTime() ?? 0;
}
