export const MAX_GROUP_MENTIONS = 6;

export type ChatMentions = { agentIds: string[] } | { everyone: true };
export type ResolvedChatMentions = { agentIds: string[]; everyone?: true };
export type MentionDelivery = {
  agentId: string;
  state: 'queued' | 'delivered' | 'cancelled' | 'interrupted';
  runId?: string;
  reason?: string;
};

const mentionId = /^[a-zA-Z0-9_-]{1,128}$/;
const validIds = (ids: unknown): ids is string[] =>
  Array.isArray(ids) &&
  ids.length > 0 &&
  ids.length <= MAX_GROUP_MENTIONS &&
  new Set(ids).size === ids.length &&
  ids.every((id) => typeof id === 'string' && mentionId.test(id));

export function validChatMentions(value: unknown): value is ChatMentions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return (
    Object.keys(intent).length === 1 && (intent.everyone === true || validIds(intent.agentIds))
  );
}

export function sameChatMentions(left?: ChatMentions, right?: ChatMentions): boolean {
  if (!left || !right) return left === right;
  if ('everyone' in left || 'everyone' in right) return 'everyone' in left && 'everyone' in right;
  return (
    left.agentIds.length === right.agentIds.length &&
    left.agentIds.every((id, index) => id === right.agentIds[index])
  );
}

export function matchesChatMentionReceipt(
  intent?: ChatMentions,
  received?: ResolvedChatMentions,
): boolean {
  if (!intent || !received) return !intent && !received;
  if (!validIds(received.agentIds)) return false;
  return 'everyone' in intent
    ? received.everyone === true
    : received.everyone === undefined && sameChatMentions(intent, { agentIds: received.agentIds });
}
