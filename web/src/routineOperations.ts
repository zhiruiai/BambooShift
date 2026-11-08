import { uiText } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { Routine } from '../../shared/types';
import {
  routineConfigSnapshot,
  type CreateRoutineRequest,
  type RoutineOperationReceipt,
  type RoutineOperationRequest,
  type RoutineOperationResolution,
} from '../../shared/routine-operations';
import { ApiError } from './api';
import { createPrimaryBotScope, type PrimaryBotIdentity } from './primaryBot';

export type RoutineCreateInput = Omit<CreateRoutineRequest, 'requestId'>;
type Intent = {
  version: 1;
  kind: 'create' | 'run';
  requestId: string;
  routineId?: string;
  digest: string;
};
export type RoutineOperationState = {
  busy: boolean;
  request?: Intent;
  receipt?: RoutineOperationReceipt;
  canRetry: boolean;
  originalAvailable: boolean;
  error: string;
  message?: string;
  blocked?: boolean;
};
type Options = PrimaryBotIdentity & {
  identity: () => PrimaryBotIdentity;
  locationWorkspace?: () => string | undefined;
  fetch?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  onState?: (state: RoutineOperationState) => void;
  onChanged?: (receipt: RoutineOperationReceipt) => void | Promise<void>;
};
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function routineOperationLabel(receipt: RoutineOperationReceipt) {
  if (receipt.status === 'missing') return uiText('routines:text_a1ae143b0fba');
  if (receipt.kind === 'create') return uiText('routines:text_b4597a12f8fd');
  return {
    submitted: uiText('routines:text_5a13079c88dd'),
    completed: uiText('routines:text_bc38d752409a'),
    error: uiText('routines:text_170bc866adcc'),
    cancelled: uiText('routines:text_ee4f964809dc'),
    interrupted: uiText('routines:text_8a7fd087f51b'),
  }[receipt.status];
}
export function createRoutineOperationClient(options: Options) {
  const scope = createPrimaryBotScope(options);
  const key = `openbot-routine-operation:${JSON.stringify([options.userId || null, options.workspaceId || null])}`;
  let storage = options.storage;
  let state: RoutineOperationState = {
    busy: false,
    canRetry: false,
    originalAvailable: false,
    error: '',
  };
  let body: RoutineOperationRequest | undefined;
  let sequence = 0;
  try {
    storage ||= typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
    if (!storage) throw Error('Storage unavailable');
    const raw = storage.getItem(key);
    if (raw) {
      if (raw.length > 1024) throw Error('Invalid recovery record');
      const value = JSON.parse(raw);
      if (
        !value ||
        value.version !== 1 ||
        !['create', 'run'].includes(value.kind) ||
        !uuid.test(value.requestId) ||
        !/^[a-f\d]{64}$/.test(value.digest) ||
        Object.keys(value).some(
          (field) => !['version', 'kind', 'requestId', 'routineId', 'digest'].includes(field),
        ) ||
        (value.kind === 'run' ? !identifier(value.routineId) : value.routineId !== undefined)
      )
        throw Error('Invalid recovery record');
      state.request = value;
    }
  } catch {
    state.blocked = true;
    state.error = uiText('routines:text_361c140ecfe1');
  }
  const current = (ticket = scope.ticket()) => scope.current(ticket);
  const publish = (patch: Partial<RoutineOperationState>) => {
    state = { ...state, ...patch };
    if (current()) options.onState?.({ ...state });
  };
  function validate(value: RoutineOperationReceipt, intent: Intent) {
    const reviewedSchedule =
      body?.kind === 'run' && body.requestId === intent.requestId
        ? body.expectedRoutine.schedule
        : undefined;
    const validRunTime = (nextRunAt: string) =>
      typeof nextRunAt === 'string' &&
      (nextRunAt === ''
        ? reviewedSchedule === undefined || reviewedSchedule === 'webhook'
        : reviewedSchedule !== 'webhook' && Number.isFinite(Date.parse(nextRunAt)));
    if (
      !value ||
      value.kind !== intent.kind ||
      value.requestId !== intent.requestId ||
      value.userId !== options.userId ||
      value.workspaceId !== options.workspaceId ||
      !identifier(value.routineId) ||
      !identifier(value.agentId) ||
      !identifier(value.conversationId) ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      (value.kind === 'create'
        ? !['created', 'missing'].includes(value.status)
        : value.routineId !== intent.routineId ||
          !identifier(value.messageId) ||
          !validRunTime(value.nextRunAt) ||
          !['submitted', 'completed', 'error', 'cancelled', 'interrupted', 'missing'].includes(
            value.status,
          ))
    )
      throw Error(uiText('routines:text_14d6e6ee3a2e'));
    return value;
  }
  function clear() {
    try {
      storage?.removeItem(key);
    } catch {
      publish({ error: uiText('routines:text_8bb809e1c9e1') });
      return false;
    }
    body = undefined;
    publish({
      request: undefined,
      receipt: undefined,
      canRetry: false,
      originalAvailable: false,
      error: '',
      message: '',
    });
    return true;
  }
  function notify(receipt: RoutineOperationReceipt, ticket: number) {
    if (!current(ticket)) return;
    try {
      void Promise.resolve(options.onChanged?.(receipt)).catch(() => {
        if (current(ticket) && state.receipt?.requestId === receipt.requestId)
          publish({ error: uiText('routines:text_3fa94452f37e') });
      });
    } catch {
      if (current(ticket)) publish({ error: uiText('routines:text_a6f9ba2970e9') });
    }
  }
  async function perform(mode: 'read' | 'write' | 'close') {
    const read = mode === 'read',
      closing = mode === 'close';
    const ticket = scope.ticket(),
      intent = state.request;
    if (
      !current(ticket) ||
      state.busy ||
      state.blocked ||
      !intent ||
      (mode === 'write' && (!body || !state.canRetry)) ||
      (closing && !!state.receipt)
    )
      return;
    const order = ++sequence;
    publish({ busy: true, error: '', message: '', canRetry: false });
    try {
      const resolution = await scope.request<RoutineOperationResolution>(
        `/routine-operations${read || closing ? `/${encodeURIComponent(intent.requestId)}` : ''}${closing ? '/cancel' : ''}`,
        read ? 'GET' : 'POST',
        mode === 'write' ? body : undefined,
      );
      if (!current(ticket) || order !== sequence) return;
      if (resolution?.status === 'not_submitted') {
        if (
          !closing ||
          resolution.requestId !== intent.requestId ||
          resolution.userId !== options.userId ||
          resolution.workspaceId !== options.workspaceId
        )
          throw Error(uiText('routines:text_e1361663e1c3'));
        if (clear()) publish({ message: uiText('routines:text_f08d63e1ac7e') });
        return;
      }
      const value = validate(resolution, intent);
      publish({ receipt: value });
      notify(value, ticket);
      return value;
    } catch (cause) {
      if (!current(ticket) || order !== sequence) return;
      if (
        read &&
        cause instanceof ApiError &&
        cause.status === 410 &&
        cause.code === 'ROUTINE_OPERATION_CLOSED'
      ) {
        if (clear()) publish({ message: uiText('routines:text_f08d63e1ac7e') });
        return;
      }
      if (
        mode === 'write' &&
        cause instanceof ApiError &&
        cause.code === 'ROUTINE_OPERATION_NOT_STARTED' &&
        [400, 409, 413, 422].includes(cause.status)
      ) {
        if (!clear()) return;
      }
      const missing = read && cause instanceof ApiError && cause.status === 404;
      publish({
        error: missing
          ? body
            ? uiText('routines:text_31d5e9e15f2a')
            : uiText('routines:text_0a67fedd9069')
          : (cause as Error).message,
        canRetry: missing && !!body && !state.receipt,
      });
    } finally {
      if (current(ticket) && order === sequence) publish({ busy: false });
    }
  }
  async function start(
    input:
      | Omit<Extract<RoutineOperationRequest, { kind: 'create' }>, 'requestId'>
      | Omit<Extract<RoutineOperationRequest, { kind: 'run' }>, 'requestId'>,
  ) {
    const ticket = scope.ticket();
    if (!current(ticket) || state.busy || state.request || state.blocked) return;
    const order = ++sequence;
    publish({ busy: true, error: '', message: '' });
    try {
      const candidate = structuredClone({
        ...input,
        requestId: crypto.randomUUID(),
      }) as RoutineOperationRequest;
      const encoded = new TextEncoder().encode(JSON.stringify(candidate));
      const hash = await crypto.subtle.digest('SHA-256', encoded);
      if (!current(ticket) || order !== sequence) return;
      const intent: Intent = {
        version: 1,
        kind: candidate.kind,
        requestId: candidate.requestId,
        ...(candidate.kind === 'run' ? { routineId: candidate.routineId } : {}),
        digest: [...new Uint8Array(hash)]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join(''),
      };
      if (!storage) throw Error(uiText('routines:text_a2b5691ec1b6'));
      storage.setItem(key, JSON.stringify(intent));
      body = candidate;
      publish({ request: intent, busy: false, canRetry: true, originalAvailable: true });
      return perform('write');
    } catch {
      if (current(ticket) && order === sequence)
        publish({ busy: false, error: uiText('routines:text_111e3deb5c02') });
    }
  }
  return {
    scope,
    state: () => ({ ...state }),
    resume() {
      scope.resume();
      publish({});
    },
    suspend() {
      scope.suspend();
      sequence++;
      state = { ...state, busy: false, canRetry: false };
    },
    create: (input: RoutineCreateInput) => start({ ...input, kind: 'create' }),
    run: (routine: Routine) =>
      start({
        kind: 'run',
        routineId: routine.id,
        expectedRoutine: routineConfigSnapshot(routine),
      }),
    check: () => perform('read'),
    retry: () => perform('write'),
    closeRequest: () => perform('close'),
    finish() {
      if (!current() || state.busy || !state.receipt) return false;
      return clear();
    },
  };
}
export function useRoutineOperations(
  options: PrimaryBotIdentity & {
    onChanged?: (receipt: RoutineOperationReceipt) => void | Promise<void>;
  },
) {
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState<RoutineOperationState>({
    busy: false,
    canRetry: false,
    originalAvailable: false,
    error: '',
  });
  const [client] = useState(() =>
    createRoutineOperationClient({
      ...options,
      identity: () => latest.current,
      onState: setState,
      onChanged: (receipt) => latest.current.onChanged?.(receipt),
    }),
  );
  useEffect(() => {
    client.resume();
    if (client.state().request) void client.check();
    return () => client.suspend();
  }, [client]);
  return { ...client, getState: client.state, state };
}
