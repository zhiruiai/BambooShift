import { uiText, currentLanguage } from './i18n';
import { ApiError } from './api';
import type { ComputerState } from '../../shared/types';

export type BotScreenInventory = {
  capacity: { max: number; configured: number; ready: number; assigned: number };
  bots: Array<NonNullable<ComputerState['botScreen']>>;
  shared?: boolean;
  reason?: string;
};

export function screenIdentity(state: ComputerState) {
  return JSON.stringify([
    state.botScreen?.agentId,
    state.botScreen?.shared,
    state.botScreen?.screenId,
    state.botScreen?.assignmentRevision,
    state.botScreen?.lifecycle?.state,
    state.botScreen?.lifecycle?.operation?.id,
    state.desktop?.session?.id,
    state.desktop?.session?.generation,
    state.connected,
    state.surface,
    state.executionLocation,
    state.targetRevision,
  ]);
}

export function unpreparedScreen(machine: ComputerState, agentId?: string): ComputerState {
  return {
    ...machine,
    connected: false,
    capabilities: [],
    desktop: undefined,
    surface: 'browser',
    botScreen: undefined,
    status: agentId ? uiText('computer:text_a7684f9e81d5') : uiText('computer:text_32857e41c3a0'),
    ...(agentId ? { botScreen: { agentId, status: 'unassigned' as const } } : {}),
  };
}

/** Capture the workspace URL once. A late reply or cleanup never follows a new route. */
export function createComputerScope(options: {
  workspaceId?: string;
  userId?: string;
  agentId?: string;
  fetch?: typeof fetch;
  onAuthFailure?: (status: number) => void;
  identity?: () => { workspaceId?: string; userId?: string; agentId?: string };
}) {
  const root = options.workspaceId
    ? `/api/workspaces/${encodeURIComponent(options.workspaceId)}`
    : '/api';
  const machineUrl = `${root}/computer`;
  const baseUrl = options.agentId
    ? `${machineUrl}/bots/${encodeURIComponent(options.agentId)}`
    : undefined;
  const key = JSON.stringify([options.userId, options.workspaceId, options.agentId]);
  const transport: typeof fetch = (...args) => (options.fetch || globalThis.fetch)(...args);
  const controllers = new Set<AbortController>();
  let epoch = 0,
    active = true,
    disposed = false;
  const ticket = () => epoch;
  const openingPath = typeof window === 'undefined' ? undefined : window.location?.pathname;
  const current = (value: number) => {
    const identity = options.identity?.();
    return (
      active &&
      epoch === value &&
      (!options.identity ||
        (identity?.userId === options.userId &&
          identity?.workspaceId === options.workspaceId &&
          (!identity || !('agentId' in identity) || identity.agentId === options.agentId) &&
          (typeof window === 'undefined' ? undefined : window.location?.pathname) === openingPath))
    );
  };
  function headers(value?: HeadersInit) {
    const result = new Headers(value);
    result.set('Accept-Language', currentLanguage());
    if (options.userId) result.set('X-OpenBot-Expected-User', options.userId);
    return result;
  }
  const stale = () => new DOMException(uiText('computer:text_84de3b5933e0'), 'AbortError');
  function invalidate() {
    epoch++;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }
  async function response(path: string, init: RequestInit = {}, machine = false) {
    const version = ticket();
    if (!current(version) || (!machine && !baseUrl)) throw stale();
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const result = await transport(`${machine ? machineUrl : baseUrl}${path}`, {
        ...init,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: headers(init.headers),
        signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
      });
      if (!current(version)) throw stale();
      if (!result.ok) {
        const body = await result.json().catch(() => ({}));
        if (!current(version)) throw stale();
        if (result.status === 401 || result.status === 403) {
          if (options.onAuthFailure) options.onAuthFailure(result.status);
          else if (typeof window !== 'undefined')
            window.dispatchEvent(
              new Event(
                result.status === 403
                  ? 'openbot:revalidate'
                  : options.workspaceId
                    ? 'openbot:account-expired'
                    : 'openbot:unpaired',
              ),
            );
        }
        throw new ApiError(
          body.error ||
            body.message ||
            uiText('computer:text_c8d0b7d4cd0d', { value0: result.status }),
          result.status,
          body.code,
        );
      }
      return result;
    } catch (error) {
      if (!current(version)) throw stale();
      if (error instanceof TypeError)
        throw new ApiError(uiText('computer:text_95f9cfeae5a8'), 0, 'NETWORK_ERROR');
      throw error;
    } finally {
      controllers.delete(controller);
    }
  }
  async function request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    machine = false,
  ): Promise<T> {
    const version = ticket();
    const result = await response(
      path,
      {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      },
      machine,
    );
    const value = result.status === 204 ? undefined : await result.json();
    if (!current(version)) throw stale();
    return value;
  }
  return {
    key,
    baseUrl,
    machineUrl,
    ticket,
    current,
    invalidate,
    response,
    request,
    privateScreenshot(leaseId: string, signal: AbortSignal) {
      if (!options.userId || !leaseId) throw stale();
      return response(
        '/takeover/screenshot',
        {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', 'X-OpenBot-Computer-Lease': leaseId },
          body: '{}',
          signal,
        },
        !baseUrl,
      );
    },
    /** Reusable effects may suspend and resume; captured work keeps its original epoch. */
    suspend() {
      active = false;
      invalidate();
    },
    resume() {
      if (disposed) throw stale();
      active = true;
    },
    guard<T>(work: () => Promise<T>, allowed: () => boolean = () => true) {
      const version = ticket();
      return async () => {
        if (!current(version) || !allowed()) throw stale();
        return work();
      };
    },
    dispose() {
      disposed = true;
      active = false;
      invalidate();
    },
    async endLease(leaseId: string) {
      if (!baseUrl) return;
      // Cleanup is deliberately allowed after disposal, with the captured URL.
      const response = await transport(`${baseUrl}/takeover/end`, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ leaseId }),
      });
      if (!response.ok) throw new ApiError(uiText('computer:text_79ac1e5e0426'), response.status);
      const receipt = await response.json().catch(() => undefined);
      if (receipt?.active !== false) throw new ApiError(uiText('computer:text_aa064e276176'), 409);
    },
    async startLease<T extends { leaseId: string }>(): Promise<T> {
      const version = ticket();
      if (!current(version) || !baseUrl) throw stale();
      // Do not abort a start whose server-created lease still needs a cleanup receipt.
      const result = await transport(`${baseUrl}/takeover/start`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: headers(),
      });
      const value = await result.json();
      if (!current(version)) {
        if (result.ok && typeof value.leaseId === 'string') await this.endLease(value.leaseId);
        throw stale();
      }
      if (!result.ok) {
        if (result.status === 401 || result.status === 403) {
          if (options.onAuthFailure) options.onAuthFailure(result.status);
          else if (typeof window !== 'undefined')
            window.dispatchEvent(
              new Event(
                result.status === 403
                  ? 'openbot:revalidate'
                  : options.workspaceId
                    ? 'openbot:account-expired'
                    : 'openbot:unpaired',
              ),
            );
        }
        throw new ApiError(
          value.error || uiText('computer:text_0ff02bdcc897'),
          result.status,
          value.code,
        );
      }
      return value as T;
    },
  };
}
