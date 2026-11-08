import { uiText } from './i18n';
import type { createChatSendScope } from './chatSendScope';

export type FixedWorkspaceApi = <T = unknown>(
  path: string,
  method?: string,
  body?: unknown,
) => Promise<T>;

/** Bind ordinary workspace requests to the same immutable identity as chat sends. */
export function fixedWorkspaceApi(
  scope: ReturnType<typeof createChatSendScope>,
): FixedWorkspaceApi {
  return async <T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const ticket = scope.ticket();
    const assertCurrent = () => {
      if (!scope.current(ticket))
        throw new DOMException(uiText('common:text_75d366e971e2'), 'AbortError');
    };
    assertCurrent();
    const result = await scope.request<T>(path, method, body);
    assertCurrent();
    return result;
  };
}
