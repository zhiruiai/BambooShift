import { uiText, languageHeaders } from './i18n';
import { ApiError } from './api';
import type { ConnectedApp } from '../../shared/app-connections';

export const appConnectionStatus = (status: ConnectedApp['status']) =>
  ({
    connected: uiText('apps:text_5be0323e8adc'),
    disconnected: uiText('apps:text_1f0ac6953e04'),
    needs_auth: uiText('apps:text_2873504bb969'),
    error: uiText('apps:text_e0d53046f33b'),
  })[status] || uiText('apps:text_93e474c68ed5');

/** A request stays with the account and workspace that opened the view. */
export function createAppConnectionScope(options: {
  workspaceId?: string;
  userId?: string;
  fetch?: typeof fetch;
  onAuthFailure?: (status: number) => void;
  identity?: () => { workspaceId?: string; userId?: string };
}) {
  const root = options.workspaceId
    ? `/api/workspaces/${encodeURIComponent(options.workspaceId)}`
    : '/api';
  let active = true,
    epoch = 0;
  const pending = new Set<AbortController>();
  const openingPath = typeof window === 'undefined' ? undefined : window.location?.pathname;
  const current = (ticket: number) => {
    const identity = options.identity?.();
    return (
      active &&
      ticket === epoch &&
      (!options.identity ||
        (identity?.userId === options.userId &&
          identity?.workspaceId === options.workspaceId &&
          (typeof window === 'undefined' ? undefined : window.location?.pathname) === openingPath))
    );
  };
  const stale = () => new DOMException(uiText('apps:text_75d366e971e2'), 'AbortError');
  return {
    ticket: () => epoch,
    current,
    resume() {
      active = true;
    },
    suspend() {
      active = false;
      epoch++;
      for (const controller of pending) controller.abort();
      pending.clear();
    },
    async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      if (!current(epoch)) throw stale();
      const ticket = epoch,
        controller = new AbortController();
      pending.add(controller);
      try {
        const response = await (options.fetch || fetch)(`${root}${path}`, {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(100_000)]),
          headers: {
            ...languageHeaders(),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(options.userId ? { 'X-OpenBot-Expected-User': options.userId } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const value =
          response.status === 204
            ? undefined
            : await response.json().catch(() => {
                if (response.ok) throw new ApiError(uiText('apps:text_f2188b437214'), 502);
                return {};
              });
        if (!current(ticket)) throw stale();
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            if (options.onAuthFailure) options.onAuthFailure(response.status);
            else if (typeof window !== 'undefined')
              window.dispatchEvent(
                new Event(
                  response.status === 403
                    ? 'openbot:revalidate'
                    : options.workspaceId
                      ? 'openbot:account-expired'
                      : 'openbot:unpaired',
                ),
              );
          }
          throw new ApiError(
            value.error ||
              value.message ||
              uiText('apps:text_c8d0b7d4cd0d', { value0: response.status }),
            response.status,
            value.code,
          );
        }
        return value as T;
      } catch (error) {
        if (!current(ticket)) throw stale();
        if (error instanceof TypeError || (error as Error)?.name === 'TimeoutError')
          throw new ApiError(uiText('apps:text_e2f6ca20727a'), 0, 'NETWORK_ERROR');
        throw error;
      } finally {
        pending.delete(controller);
      }
    },
  };
}

export function validAppAddress(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      (!url.port || url.port === '443')
    );
  } catch {
    return false;
  }
}
