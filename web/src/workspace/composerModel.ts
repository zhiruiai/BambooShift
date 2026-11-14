import { isSharedBot } from '../../../shared/shared-bots';
import type { Bootstrap, BotAgent, Conversation } from '../../../shared/types';
import type { ComposerState } from '../chatDrafts';

type RoutingContext = Partial<Pick<Bootstrap, 'messages' | 'runningRequests'>> & {
  threadRootId?: string;
};

/** Match known dispatch targets. An unpublished active target must not produce a false setup hint. */
export function composerModelConfigured(
  draft: Partial<Pick<ComposerState, 'agentId' | 'mentions' | 'text' | 'replyTo'>>,
  members: BotAgent[],
  conversation: Conversation | undefined,
  workspaceConfigured: boolean,
  context: RoutingContext = {},
): boolean | undefined {
  if (!conversation) return workspaceConfigured;
  const configured = (ids: string[]) =>
    ids.length > 0 &&
    ids.every((id) => {
      const bot = members.find((member) => member.id === id && conversation.agentIds.includes(id));
      if (!bot) return false;
      return isSharedBot(bot) ? workspaceConfigured : (bot.modelConfigured ?? workspaceConfigured);
    });
  if (draft.mentions)
    return configured(
      'everyone' in draft.mentions ? conversation.agentIds : draft.mentions.agentIds,
    );
  if (draft.agentId !== undefined) return configured([draft.agentId]);
  // The server's legacy text-mention routing uses stored Bot order and substring matching.
  const mentioned = members.find(
    (bot) => conversation.agentIds.includes(bot.id) && draft.text?.includes(`@${bot.name}`),
  );
  if (mentioned) return configured([mentioned.id]);
  const message = (id?: string) =>
    context.messages?.find((item) => item.id === id && item.conversationId === conversation.id);
  const root = message(context.threadRootId);
  const reply = message(draft.replyTo?.id || context.threadRootId);
  const replyAgent = reply?.agentId ?? draft.replyTo?.agentId;
  if (replyAgent && conversation.agentIds.includes(replyAgent)) return configured([replyAgent]);
  const active = context.runningRequests?.some(
    (run) => run.conversationId === conversation.id && run.threadRootId === context.threadRootId,
  );
  // Public run summaries do not expose the current recipient. A direct chat has only one option.
  if (active && conversation.agentIds.length > 1) return undefined;
  const rootAgent = root?.delivery?.agentId;
  if (rootAgent && conversation.agentIds.includes(rootAgent)) return configured([rootAgent]);
  if (context.threadRootId && !root) return undefined;
  return configured([conversation.agentIds[0]]);
}
