import {
  parseRoutineSchedule,
  routineScheduleLabel as originalLabel,
} from '../../shared/routine-schedule';
import { currentLanguage, uiText } from './i18n';
import { displayTimeZone, validTimeZone } from './timeZones';

/** Keep persisted schedules intact and localize only their presentation. */
export function routineScheduleLabel(schedule: string, timeZone?: string): string {
  if (currentLanguage() === 'zh-CN') return originalLabel(schedule, timeZone);
  let parsed: ReturnType<typeof parseRoutineSchedule>;
  try {
    parsed = parseRoutineSchedule(schedule);
  } catch {
    return schedule;
  }
  if (parsed.kind === 'interval')
    return uiText('routines:everyMinutes', { minutes: parsed.minutes });
  if (parsed.kind === 'webhook') return uiText('routines:webhookSchedule');
  if (!validTimeZone(timeZone ?? 'Asia/Shanghai')) return uiText('routines:text_3541ab9fa8f8');
  const days = parsed.kind === 'weekly' ? parsed.days.join(',') : '';
  const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
  const prefix =
    parsed.kind === 'daily' || (parsed.kind === 'weekly' && parsed.days.length === 7)
      ? uiText('routines:daily')
      : days === '1,2,3,4,5'
        ? uiText('routines:weekdays')
        : days === '6,7'
          ? uiText('routines:weekends')
          : uiText('routines:weekly', {
              days: parsed.days.map((day) => uiText(`routines:${weekdays[day - 1]}`)).join(', '),
            });
  return `${prefix} ${parsed.time} · ${displayTimeZone(timeZone)}`;
}
