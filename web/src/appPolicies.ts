import type { AppPolicyOptions, AppReadPolicy } from '../../shared/app-policies';
import { createAppConnectionScope } from './appConnections';
import { ApiError } from './api';
import { uiText } from './i18n';

export interface AppPolicyState {
  options?: AppPolicyOptions;
  policies: AppReadPolicy[];
  busy: boolean;
  loading: boolean;
  pendingId?: string;
  blocked: boolean;
  error: string;
}
type Identity = { userId?: string; workspaceId?: string; canManage: boolean };
export function policyArguments(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    new TextEncoder().encode(text).byteLength > 16384
  )
    throw new Error(uiText('workspace:appPolicies.argumentsInvalid'));
  return value as Record<string, unknown>;
}
export function createAppPolicies(
  options: Identity & {
    connectionId: string;
    identity: () => Identity;
    onState: (state: AppPolicyState) => void;
    fetch?: typeof fetch;
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  },
) {
  const scope = createAppConnectionScope(options);
  const root = `/apps/${encodeURIComponent(options.connectionId)}/policies`;
  const key = `openbot-app-policy:${options.userId}:${options.workspaceId}:${options.connectionId}`;
  let state: AppPolicyState = {
    policies: [],
    busy: false,
    loading: false,
    blocked: false,
    error: '',
  };
  let sequence = 0;
  const memory = () => options.storage || window.sessionStorage;
  const emit = (changes: Partial<AppPolicyState>) => {
    state = { ...state, ...changes };
    options.onState(state);
  };
  const current = (ticket: number) => scope.current(ticket) && options.identity().canManage;
  const allowed = () => !!options.userId && !!options.workspaceId && current(scope.ticket());
  const failed = (error: unknown) => {
    if (error instanceof ApiError && error.code === 'APP_POLICY_CHANGED')
      return uiText('workspace:appPolicies.changed');
    if (error instanceof ApiError && error.code === 'APP_POLICY_CLOSED')
      return uiText('workspace:appPolicies.closed');
    return error instanceof Error ? error.message : uiText('workspace:appPolicies.failed');
  };
  function clear() {
    memory().removeItem(key);
    emit({ pendingId: undefined });
  }
  async function read() {
    if (!allowed() || state.busy) return;
    const ticket = scope.ticket(),
      version = ++sequence;
    emit({ loading: true, error: '' });
    try {
      const [policies, choices] = await Promise.all([
        scope.request<AppReadPolicy[]>(root),
        scope.request<AppPolicyOptions>(`${root}/options`),
      ]);
      if (!current(ticket) || version !== sequence) return;
      emit({ policies, options: choices });
      if (state.pendingId && policies.some((policy) => policy.id === state.pendingId)) clear();
    } catch (error) {
      if (current(ticket) && version === sequence) emit({ error: failed(error) });
    } finally {
      if (current(ticket) && version === sequence) emit({ loading: false });
    }
  }
  async function create(input: {
    routineId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    confirmed: boolean;
  }) {
    if (
      !allowed() ||
      state.busy ||
      state.loading ||
      state.blocked ||
      state.pendingId ||
      !input.confirmed
    )
      return;
    const routine = state.options?.routines.find((r) => r.id === input.routineId);
    const tool = state.options?.tools.find((t) => t.tool.name === input.toolName && t.eligible);
    if (!routine || !tool || !state.options) return;
    const ticket = scope.ticket(),
      id = crypto.randomUUID();
    const body = {
      requestId: id,
      routineId: routine.id,
      expectedRoutineRevision: routine.revision,
      connectionRevision: state.options.connectionRevision,
      catalogRevision: state.options.catalogRevision,
      toolName: tool.tool.name,
      toolRevision: tool.revision,
      arguments: input.arguments,
      confirmReadOnly: true,
    };
    try {
      memory().setItem(key, id);
    } catch {
      emit({ blocked: true, error: uiText('workspace:appPolicies.storageUnavailable') });
      return;
    }
    emit({ pendingId: id, busy: true, error: '' });
    sequence++;
    try {
      const policy = await scope.request<AppReadPolicy>(root, 'POST', body);
      if (!current(ticket)) return;
      emit({ policies: [policy, ...state.policies.filter((p) => p.id !== id)] });
      clear();
    } catch (error) {
      if (current(ticket)) emit({ error: failed(error) });
    } finally {
      if (current(ticket)) emit({ busy: false });
    }
  }
  async function revoke(id: string) {
    if (!allowed() || state.busy || state.loading || (state.pendingId && state.pendingId !== id))
      return;
    const ticket = scope.ticket();
    emit({ busy: true, error: '' });
    sequence++;
    try {
      const policy = await scope.request<AppReadPolicy | { id: string; status: 'not_created' }>(
        `${root}/${encodeURIComponent(id)}/revoke`,
        'POST',
        {},
      );
      if (!current(ticket)) return;
      if (policy.status !== 'not_created')
        emit({ policies: [policy, ...state.policies.filter((p) => p.id !== id)] });
      if (state.pendingId === id) clear();
    } catch (error) {
      if (current(ticket)) emit({ error: failed(error) });
    } finally {
      if (current(ticket)) emit({ busy: false });
    }
  }
  return {
    getState: () => state,
    read,
    create,
    revoke,
    resume() {
      scope.resume();
      if (!allowed()) return;
      try {
        const id = memory().getItem(key);
        if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
          throw new Error('invalid metadata');
        emit({ pendingId: id || undefined });
      } catch {
        emit({ blocked: true, error: uiText('workspace:appPolicies.storageUnavailable') });
      }
      void read();
    },
    suspend() {
      sequence++;
      scope.suspend();
    },
  };
}
