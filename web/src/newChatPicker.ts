import type { Bootstrap, BotAgent, Conversation } from '../../shared/types';
import { isSharedBot } from '../../shared/shared-bots';
import { isConversationHidden } from './sidebarRoster';

export type NewChatSnapshot = Pick<
  Bootstrap,
  'agents' | 'conversations' | 'primaryBot' | 'sidebarRoster'
>;
export type NewChatChoice = {
  conversation: Conversation;
  agents: BotAgent[];
  title: string;
  detail: string;
  hidden: boolean;
};

/** Only existing, currently usable conversations are navigation targets. */
export function newChatChoices(data: NewChatSnapshot, query = ''): NewChatChoice[] {
  const available = new Map(
    data.agents
      .filter((agent) => !isSharedBot(agent) || agent.sharedBot?.status === 'active')
      .map((agent) => [agent.id, agent]),
  );
  const canonical = data.primaryBot?.available ? data.primaryBot.conversationId : undefined;
  const conversations = [...data.conversations].sort(
    (a, b) =>
      Number(b.id === canonical) - Number(a.id === canonical) ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.id.localeCompare(b.id),
  );
  const seen = new Set<string>();
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const choices: NewChatChoice[] = [];
  for (const conversation of conversations) {
    const ids = conversation.agentIds;
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      (!conversation.isGroup && ids.length !== 1)
    )
      continue;
    const agents = ids.map((id) => available.get(id));
    if (agents.some((agent) => !agent)) continue;
    const members = agents as BotAgent[];
    const key = conversation.isGroup ? `group:${conversation.id}` : `bot:${ids[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = conversation.isGroup ? conversation.title : members[0].name;
    const detail = conversation.isGroup
      ? members.map((agent) => agent.name).join(' · ')
      : members[0].role;
    const searchable = `${title} ${conversation.title} ${detail}`.toLocaleLowerCase();
    if (!words.every((word) => searchable.includes(word))) continue;
    choices.push({
      conversation,
      agents: members,
      title,
      detail,
      hidden: isConversationHidden(conversation, data.sidebarRoster),
    });
  }
  if (words.length) {
    const normalized = query.trim().toLocaleLowerCase();
    const rank = (choice: NewChatChoice) => {
      const title = choice.title.toLocaleLowerCase();
      return title === normalized
        ? 0
        : title.startsWith(normalized)
          ? 1
          : title.includes(normalized)
            ? 2
            : 3;
    };
    choices.sort((left, right) => rank(left) - rank(right));
  }
  return choices;
}
