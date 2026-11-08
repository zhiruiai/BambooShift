import { uiText } from './i18n';
import type { Bootstrap, Conversation } from '../../shared/types';
import type { PrimaryBotState } from '../../shared/primary-bot';
import { createAppConnectionScope } from './appConnections';
import { currentWorkspaceId } from './workspace-scope';
import { isConversationHidden } from './sidebarRoster';
import { isSharedBot } from '../../shared/shared-bots';

export type PrimaryBotIdentity = { workspaceId?: string; userId?: string };
export function conversationSelectionKey(identity: PrimaryBotIdentity) {
  return `openbot-selected:${identity.userId || 'local'}:${identity.workspaceId || 'local'}`;
}
export function primaryConversation(
  data: Pick<Bootstrap, 'agents' | 'conversations'>,
  state?: PrimaryBotState,
) {
  if (
    !state?.available ||
    !state.agentId ||
    !state.conversationId ||
    !data.agents.some((agent) => agent.id === state.agentId && !isSharedBot(agent))
  )
    return undefined;
  return data.conversations.find(
    (conversation) =>
      conversation.id === state.conversationId &&
      !conversation.isGroup &&
      conversation.agentIds.length === 1 &&
      conversation.agentIds[0] === state.agentId,
  );
}
export function defaultConversation(
  current: string,
  data: Pick<Bootstrap, 'agents' | 'conversations' | 'sidebarRoster'> & {
    primaryBot?: PrimaryBotState;
  },
  options: { preserveHidden?: boolean } = {},
) {
  const visible = data.conversations.filter(
    (conversation) => !isConversationHidden(conversation, data.sidebarRoster),
  );
  if (
    (options.preserveHidden ? data.conversations : visible).some(
      (conversation) => conversation.id === current,
    )
  )
    return current;
  const primary = primaryConversation(data, data.primaryBot);
  if (primary && !isConversationHidden(primary, data.sidebarRoster)) return primary.id;
  if (data.primaryBot?.available && !data.primaryBot.agentId) return '';
  return visible.find((conversation) => conversation.isGroup)?.id || visible[0]?.id || '';
}
export function confirmedPrimary(
  data: Bootstrap,
  state: PrimaryBotState,
): { agent: Bootstrap['agents'][number]; conversation: Conversation } {
  if (
    data.primaryBot?.revision !== state.revision ||
    data.primaryBot.agentId !== state.agentId ||
    data.primaryBot.conversationId !== state.conversationId
  )
    throw new Error(uiText('bots:text_81ee8f11646e'));
  const conversation = primaryConversation(data, state),
    agent = data.agents.find((item) => item.id === state.agentId);
  if (!conversation || !agent) throw new Error(uiText('bots:text_24f256656385'));
  return { agent, conversation };
}
export function createPrimaryBotScope(
  options: PrimaryBotIdentity & {
    identity: () => PrimaryBotIdentity;
    fetch?: typeof fetch;
    locationWorkspace?: () => string | undefined;
  },
) {
  const sameIdentity = () => {
    const value = options.identity();
    return (
      value.userId === options.userId &&
      value.workspaceId === options.workspaceId &&
      (options.locationWorkspace || currentWorkspaceId)() === options.workspaceId
    );
  };
  const scope = createAppConnectionScope({
    ...options,
    fetch: (url, init) => {
      if (!sameIdentity()) throw new DOMException(uiText('bots:text_75d366e971e2'), 'AbortError');
      return (options.fetch || fetch)(url, init);
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
