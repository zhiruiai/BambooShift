import { MAX_GROUP_MENTIONS, type ChatMentions } from '../../shared/chat-mentions';
import type { BotAgent } from '../../shared/types';
import { isSharedBot } from '../../shared/shared-bots';
import type { ComposerState } from './chatDrafts';

export const mentionBotAvailable = (agent: BotAgent) =>
  !isSharedBot(agent) || agent.sharedBot?.status === 'active';

export function groupMentionsUnavailable(
  mentions: ChatMentions | undefined,
  group: boolean,
  members: BotAgent[],
): boolean {
  if (!mentions) return false;
  if (!group || !members.length) return true;
  if ('everyone' in mentions)
    return (
      members.length > MAX_GROUP_MENTIONS || members.some((agent) => !mentionBotAvailable(agent))
    );
  return mentions.agentIds.some(
    (id) => !members.some((agent) => agent.id === id && mentionBotAvailable(agent)),
  );
}

export function selectBotMention(
  draft: ComposerState,
  agentId: string,
  group: boolean,
): ComposerState {
  if (!group || draft.appContext) return { ...draft, agentId, mentions: undefined };
  if (draft.mentions && 'everyone' in draft.mentions) return draft;
  const ids = draft.mentions?.agentIds ?? (draft.agentId ? [draft.agentId] : []);
  if (ids.includes(agentId) || ids.length >= MAX_GROUP_MENTIONS) return draft;
  const next = [...ids, agentId];
  return next.length === 1
    ? { ...draft, agentId }
    : { ...draft, agentId: undefined, mentions: { agentIds: next } };
}

function removeInlineLabel(text: string, name?: string): string {
  if (!name) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(
    new RegExp(
      `(?<![\\p{Script=Latin}\\p{N}._%+/@-])@${escaped}(?=$|[\\s，。！？、：；!?;:,()\\[\\]{}])`,
      'gu',
    ),
    () => name,
  );
}

export function removeMention(
  draft: ComposerState,
  id: string | undefined,
  name?: string,
): ComposerState {
  const text = removeInlineLabel(draft.text, name);
  if (!draft.mentions || 'everyone' in draft.mentions)
    return { ...draft, text, agentId: undefined, mentions: undefined };
  const remaining = draft.mentions.agentIds.filter((agentId) => agentId !== id);
  return remaining.length > 1
    ? { ...draft, text, mentions: { agentIds: remaining } }
    : { ...draft, text, agentId: remaining[0], mentions: undefined };
}
