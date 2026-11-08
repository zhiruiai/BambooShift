import { uiText } from './i18n';
import type { BotAgent, Routine } from '../../shared/types';
import { normalizeRoutineSchedule, parseRoutineSchedule } from '../../shared/routine-schedule';
import { DEFAULT_TIME_ZONE, effectiveTimeZone, normalizeTimeZone } from '../../shared/time-zone';
import { routineConfigSnapshot } from '../../shared/routine-operations';
import { zonedTimeLabel } from './timeZones';

export type RoutineDraft = {
  agentId: string;
  title: string;
  prompt: string;
  mode: 'daily' | 'weekdays' | 'weekly' | 'interval' | 'webhook' | 'invalid';
  time: string;
  minutes: string;
  days: number[];
  timeZone: string;
  publicSearch?: { enabled: boolean; text: string };
};
export function draftForRoutine(
  agents: BotAgent[],
  routine?: Routine,
  defaultTimeZone = DEFAULT_TIME_ZONE,
): RoutineDraft {
  const draft: RoutineDraft = {
    agentId: routine?.agentId || agents[0]?.id || '',
    title: routine?.title || '',
    prompt: routine?.prompt || '',
    mode: 'daily',
    time: '09:00',
    minutes: '60',
    days: [1],
    timeZone: routine ? (routine.timeZone ?? DEFAULT_TIME_ZONE) : defaultTimeZone,
    ...(routine?.publicSearchQueries?.length
      ? { publicSearch: { enabled: true, text: routine.publicSearchQueries.join('\n') } }
      : {}),
  };
  if (!routine) return draft;
  try {
    const schedule = parseRoutineSchedule(routine.schedule);
    if (schedule.kind === 'webhook') return { ...draft, mode: 'webhook' };
    if (schedule.kind === 'interval')
      return { ...draft, mode: 'interval', minutes: String(schedule.minutes) };
    if (schedule.kind === 'daily') return { ...draft, time: schedule.time };
    return {
      ...draft,
      mode: schedule.days.join(',') === '1,2,3,4,5' ? 'weekdays' : 'weekly',
      time: schedule.time,
      days: [...schedule.days],
    };
  } catch {
    return { ...draft, mode: 'invalid' };
  }
}
export function scheduleForRoutineDraft(draft: RoutineDraft): string {
  if (draft.mode === 'invalid') throw new Error(uiText('routines:text_57deccb05ce8'));
  if (draft.mode === 'webhook') return 'webhook';
  if (draft.mode === 'interval') return normalizeRoutineSchedule(`interval:${draft.minutes}`);
  if (draft.mode === 'daily') return normalizeRoutineSchedule(`daily:${draft.time}`);
  const days = draft.mode === 'weekdays' ? [1, 2, 3, 4, 5] : draft.days;
  if (!days.length) throw new Error(uiText('routines:text_3ab1a1bcfd82'));
  return normalizeRoutineSchedule(`weekly:${days.join(',')}:${draft.time}`);
}
export function routineSaveBody(draft: RoutineDraft, conversationId: string, editing?: Routine) {
  const schedule = scheduleForRoutineDraft(draft);
  const timeZone = normalizeTimeZone(draft.timeZone);
  let previousZone: string | undefined;
  try {
    if (editing) previousZone = effectiveTimeZone(editing.timeZone);
  } catch {
    /* An explicit valid zone can repair a damaged legacy value. */
  }
  let previous: string | undefined;
  try {
    if (editing) previous = normalizeRoutineSchedule(editing.schedule);
  } catch {
    /* Explicitly selected replacement repairs invalid legacy data. */
  }
  const queries = draft.publicSearch?.enabled
    ? publicSearchQueriesForDraft(draft.publicSearch.text)
    : [];
  const priorQueries = editing?.publicSearchQueries ?? [];
  const searchChanged =
    queries.length !== priorQueries.length || queries.some((query, i) => query !== priorQueries[i]);
  return {
    agentId: draft.agentId,
    conversationId: editing?.conversationId || conversationId,
    title: draft.title,
    prompt: draft.prompt,
    ...(!editing || schedule !== previous ? { schedule } : {}),
    ...(!editing || timeZone !== previousZone ? { timeZone } : {}),
    ...(!editing ? { enabled: true } : {}),
    ...(searchChanged ? { publicSearchQueries: queries } : {}),
    ...(searchChanged && editing ? { expectedRoutine: routineConfigSnapshot(editing) } : {}),
  };
}
function publicSearchQueriesForDraft(text: string): string[] {
  const queries = text
    .split(/\r\n?|\n/)
    .map((line) => line.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ''))
    .filter(Boolean);
  if (!queries.length || queries.length > 4 || queries.some((query) => query.length > 160))
    throw Error(uiText('routines:publicSearchLimit'));
  if (queries.some((query) => /\p{Cc}/u.test(query)))
    throw Error(uiText('routines:publicSearchControl'));
  if (new Set(queries).size !== queries.length)
    throw Error(uiText('routines:publicSearchDuplicate'));
  return queries;
}
export function routineNextRunLabel(routine: Routine, at = Date.now()): string {
  if (!routine.enabled) return uiText('routines:text_7a37aabc78a9');
  if (routine.schedule === 'webhook') return uiText('routines:webhookNoSchedule');
  const next = Date.parse(routine.nextRunAt);
  if (!Number.isFinite(next)) return uiText('routines:text_615b8549245c');
  if (next <= at) return uiText('routines:text_347ecc875aad');
  return uiText('routines:text_730ceae441a5', { value0: zonedTimeLabel(next, routine.timeZone) });
}
