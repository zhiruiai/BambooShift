import { currentLanguage } from './i18n';
import { uiText } from './i18n';
import { useEffect, useRef, useState } from 'react';
import {
  ROUTINE_RUN_HISTORY_LIMIT,
  type RoutineRun,
  type RoutineRunHistory,
} from '../../shared/routine-runs';
import { createPrimaryBotScope, type PrimaryBotIdentity } from './primaryBot';
import { displayTimeZone, validTimeZone } from './timeZones';

export const routineRunLabel = (status: RoutineRun['status']) =>
  ({
    running: uiText('routines:text_9273b8cc8f40'),
    completed: uiText('routines:text_f28461bb49c8'),
    error: uiText('routines:text_7e53786684a1'),
    cancelled: uiText('routines:text_a37778f17c5f'),
    interrupted: uiText('routines:text_88cf2dc00c34'),
  })[status];

export function routineRunTime(value: string, timeZone?: string) {
  if (!validTimeZone(timeZone === undefined ? 'Asia/Shanghai' : timeZone))
    return uiText('routines:text_3541ab9fa8f8');
  if (!Number.isFinite(Date.parse(value))) return uiText('routines:text_ea6fb76bff48');
  return `${new Intl.DateTimeFormat(currentLanguage(), {
    timeZone: timeZone || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))} · ${displayTimeZone(timeZone)}`;
}

export type RoutineRunsState = {
  loading: boolean;
  loaded: boolean;
  runs: RoutineRun[];
  error: string;
};
type Options = PrimaryBotIdentity & {
  routineId: string;
  identity: () => PrimaryBotIdentity;
  locationWorkspace?: () => string | undefined;
  fetch?: typeof fetch;
  onState?: (state: RoutineRunsState) => void;
};
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function checkedRun(value: RoutineRun, routineId: string, runId?: string) {
  if (
    !value ||
    value.routineId !== routineId ||
    !id(value.runId) ||
    (runId !== undefined && value.runId !== runId) ||
    !id(value.agentId) ||
    !id(value.conversationId) ||
    !['scheduled', 'manual', 'webhook'].includes(value.trigger) ||
    !['running', 'completed', 'error', 'cancelled', 'interrupted'].includes(value.status) ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    (value.finishedAt !== undefined && !Number.isFinite(Date.parse(value.finishedAt))) ||
    (value.inputMessageId !== undefined && !id(value.inputMessageId)) ||
    (value.resultMessageId !== undefined && !id(value.resultMessageId)) ||
    (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 2000))
  )
    throw Error(uiText('routines:text_be4532138613'));
  return value;
}

/** Read-only history: never runs or recreates work, including after missing records. */
export function createRoutineRunsClient(options: Options) {
  const scope = createPrimaryBotScope(options);
  let state: RoutineRunsState = { loading: false, loaded: false, runs: [], error: '' },
    sequence = 0;
  const path = `/routines/${encodeURIComponent(options.routineId)}/runs`;
  const publish = (patch: Partial<RoutineRunsState>) => {
    state = { ...state, ...patch };
    if (scope.current(scope.ticket())) options.onState?.(state);
  };
  async function read() {
    const ticket = scope.ticket();
    if (!scope.current(ticket) || !id(options.routineId)) return;
    const order = ++sequence;
    publish({ loading: true, error: '' });
    try {
      const value = await scope.request<RoutineRunHistory>(path);
      if (!scope.current(ticket) || order !== sequence) return;
      if (
        !value ||
        value.routineId !== options.routineId ||
        !Array.isArray(value.runs) ||
        value.runs.length > ROUTINE_RUN_HISTORY_LIMIT
      )
        throw Error(uiText('routines:text_6b6f3365b240'));
      const runs = value.runs.map((run) => checkedRun(run, options.routineId));
      if (new Set(runs.map((run) => run.runId)).size !== runs.length)
        throw Error(uiText('routines:text_479ffccabc80'));
      publish({ loaded: true, runs });
    } catch (cause) {
      if (scope.current(ticket) && order === sequence)
        publish({ error: (cause as Error).message || uiText('routines:text_9981f09ae6ac') });
    } finally {
      if (scope.current(ticket) && order === sequence) publish({ loading: false });
    }
  }
  async function get(runId: string) {
    const ticket = scope.ticket();
    if (!scope.current(ticket) || !id(options.routineId) || !id(runId)) return;
    const value = checkedRun(
      await scope.request<RoutineRun>(`${path}/${encodeURIComponent(runId)}`),
      options.routineId,
      runId,
    );
    if (!scope.current(ticket)) return;
    publish({ runs: state.runs.map((run) => (run.runId === runId ? value : run)) });
    return value;
  }
  return {
    scope,
    state: () => state,
    read,
    get,
    resume: () => scope.resume(),
    suspend() {
      ++sequence;
      scope.suspend();
      state = { ...state, loading: false };
    },
  };
}

export function useRoutineRuns(
  options: PrimaryBotIdentity & { routineId: string; refreshKey?: string },
) {
  const identity = useRef<PrimaryBotIdentity>(options);
  identity.current = options;
  const [state, setState] = useState<RoutineRunsState>({
    loading: false,
    loaded: false,
    runs: [],
    error: '',
  });
  const [client] = useState(() =>
    createRoutineRunsClient({ ...options, identity: () => identity.current, onState: setState }),
  );
  useEffect(() => {
    client.resume();
    void client.read();
    return () => client.suspend();
  }, [client, options.routineId, options.workspaceId, options.userId, options.refreshKey]);
  useEffect(() => {
    if (!state.runs.some((run) => run.status === 'running')) return;
    const timer = setInterval(() => {
      if (!document.hidden) void client.read();
    }, 15000);
    return () => clearInterval(timer);
  }, [client, state.runs.some((run) => run.status === 'running')]);
  return { ...client, state };
}
