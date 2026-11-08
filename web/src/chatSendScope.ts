import { uiText } from './i18n';
import { ApiError } from './api';
import { createAppConnectionScope } from './appConnections';
import { currentWorkspaceId } from './workspace-scope';
export type ChatSendIdentity = { workspaceId?: string; userId?: string };

/** A send keeps its original identity across receipt hashing, HTTP and UI settlement. */
export function createChatSendScope(
  options: ChatSendIdentity & {
    identity: () => ChatSendIdentity;
    locationWorkspace?: () => string | undefined;
    fetch?: typeof fetch;
  },
) {
  const locationWorkspace = options.locationWorkspace || currentWorkspaceId;
  const sameIdentity = () => {
    const current = options.identity();
    return (
      current.workspaceId === options.workspaceId &&
      current.userId === options.userId &&
      locationWorkspace() === options.workspaceId
    );
  };
  const scope = createAppConnectionScope({
    workspaceId: options.workspaceId,
    userId: options.userId,
    fetch: async (url, init) => {
      if (!sameIdentity()) throw new DOMException(uiText('common:text_75d366e971e2'), 'AbortError');
      const timeout = AbortSignal.timeout(30_000);
      try {
        return await (options.fetch || fetch)(url, {
          ...init,
          signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), timeout]),
        });
      } catch (cause) {
        if (timeout.aborted) throw new ApiError(uiText('common:text_43822dbc3b5a'), 0, 'TIMEOUT');
        throw cause;
      }
    },
    onAuthFailure: (status) => {
      if (scope.current(scope.ticket()) && sameIdentity() && typeof window !== 'undefined')
        window.dispatchEvent(
          new Event(
            status === 403
              ? 'openbot:revalidate'
              : options.workspaceId
                ? 'openbot:account-expired'
                : 'openbot:unpaired',
          ),
        );
    },
  });
  return { ...scope, current: (ticket: number) => scope.current(ticket) && sameIdentity() };
}
