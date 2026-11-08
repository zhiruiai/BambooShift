import { uiText, languageHeaders } from './i18n';
import type { Bootstrap } from '../../shared/types';
import { ApiError } from './api';
import { currentWorkspaceId } from './workspace-scope';

type Identity = { workspaceId?: string; userId?: string };

/** A bootstrap contains private preferences, so it belongs to the identity that opened this view. */
export function createWorkspaceSnapshotSource(
  options: Identity & {
    identity: () => Identity;
    fetch?: typeof fetch;
    locationWorkspace?: () => string | undefined;
    onAuthFailure?: (status: number) => void;
  },
) {
  const url = options.workspaceId
    ? `/api/workspaces/${encodeURIComponent(options.workspaceId)}/bootstrap`
    : '/api/bootstrap';
  const current = () => {
    const identity = options.identity();
    return (
      identity.userId === options.userId &&
      identity.workspaceId === options.workspaceId &&
      (options.locationWorkspace || currentWorkspaceId)() === options.workspaceId
    );
  };
  return {
    current,
    async read(signal: AbortSignal): Promise<Bootstrap> {
      const check = () => {
        if (signal.aborted || !current())
          throw new DOMException(uiText('common:text_0781bffb4fcd'), 'AbortError');
      };
      check();
      try {
        const response = await (options.fetch || fetch)(url, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          signal,
          headers: {
            ...languageHeaders(),
            ...(options.userId ? { 'X-OpenBot-Expected-User': options.userId } : {}),
          },
        });
        check();
        const value = await response.json().catch(() => {
          if (response.ok) throw new ApiError(uiText('common:text_defda883a652'), 502);
          return {};
        });
        check();
        if (!response.ok) {
          if (response.status === 401 || response.status === 403)
            options.onAuthFailure?.(response.status);
          throw new ApiError(
            value.error ||
              value.message ||
              uiText('common:text_c8d0b7d4cd0d', { value0: response.status }),
            response.status,
            value.code,
          );
        }
        return value as Bootstrap;
      } catch (cause) {
        check();
        if (cause instanceof TypeError)
          throw new ApiError(uiText('common:text_95f9cfeae5a8'), 0, 'NETWORK_ERROR');
        throw cause;
      }
    },
  };
}
