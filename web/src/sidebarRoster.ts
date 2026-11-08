import {
  sidebarTargetForConversation,
  type SidebarRosterEntry,
  type SidebarRosterState,
  type SidebarTarget,
} from '../../shared/sidebar-roster';
import type { Bootstrap, Conversation } from '../../shared/types';
import { isSharedBot } from '../../shared/shared-bots';
import { timestamp } from './dates';

export const sidebarTargetKey = (target: SidebarTarget) => `${target.kind}:${target.id}`;
export function rosterEntry(
  state: SidebarRosterState | undefined,
  target: SidebarTarget,
): SidebarRosterEntry {
  return (
    state?.entries.find((entry) => sidebarTargetKey(entry.target) === sidebarTargetKey(target)) || {
      target,
      pinned: false,
      hidden: false,
      sectionId: null,
    }
  );
}
export function conversationRosterEntry(conversation: Conversation, state?: SidebarRosterState) {
  const entry = rosterEntry(state, sidebarTargetForConversation(conversation));
  return state ? entry : { ...entry, pinned: conversation.pinned };
}
export const isConversationHidden = (conversation: Conversation, state?: SidebarRosterState) =>
  conversationRosterEntry(conversation, state).hidden;
export function rosterConversationOrder(
  left: Conversation,
  right: Conversation,
  state?: SidebarRosterState,
  primaryId?: string,
) {
  return (
    Number(right.id === primaryId) - Number(left.id === primaryId) ||
    Number(conversationRosterEntry(right, state).pinned) -
      Number(conversationRosterEntry(left, state).pinned) ||
    timestamp(right.updatedAt) - timestamp(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}
export function projectSidebar(
  data: Pick<Bootstrap, 'agents' | 'conversations' | 'primaryBot' | 'sidebarRoster'>,
  query = '',
  mobile = false,
) {
  const state = data.sidebarRoster;
  const entries = new Map(
    (state?.entries || []).map((entry) => [sidebarTargetKey(entry.target), entry]),
  );
  const agents = new Map(data.agents.map((agent) => [agent.id, agent]));
  const preference = new Map(
    data.conversations.map((conversation) => {
      const target = sidebarTargetForConversation(conversation);
      return [
        conversation.id,
        entries.get(sidebarTargetKey(target)) || {
          target,
          pinned: state ? false : conversation.pinned,
          hidden: false,
          sectionId: null,
        },
      ];
    }),
  );
  const primaryState = data.primaryBot;
  const primaryId =
    primaryState?.available &&
    primaryState.agentId &&
    agents.has(primaryState.agentId) &&
    !isSharedBot(agents.get(primaryState.agentId))
      ? primaryState.conversationId
      : null;
  const primary = data.conversations.find(
    (conversation) =>
      conversation.id === primaryId &&
      !conversation.isGroup &&
      conversation.agentIds.length === 1 &&
      conversation.agentIds[0] === primaryState?.agentId,
  );
  const dates = new Map(
    data.conversations.map((conversation) => [conversation.id, timestamp(conversation.updatedAt)]),
  );
  const sort = (items: Conversation[]) =>
    items.sort(
      (a, b) =>
        Number(b.id === primary?.id) - Number(a.id === primary?.id) ||
        Number(preference.get(b.id)!.pinned) - Number(preference.get(a.id)!.pinned) ||
        dates.get(b.id)! - dates.get(a.id)! ||
        a.id.localeCompare(b.id),
    );
  const searchActive = !mobile && !!query.trim();
  const sections = (state?.sections || []).map((section) => ({
    ...section,
    conversations: [] as Conversation[],
    expanded: !section.collapsed || searchActive,
  }));
  const sectionMap = new Map(sections.map((section) => [section.id, section]));
  const visible: Conversation[] = [],
    pinned: Conversation[] = [],
    ungrouped: Conversation[] = [];
  const hidden = new Map<
    string,
    { target: SidebarTarget; conversation: Conversation; primary: boolean }
  >();
  let standalone: Conversation | undefined,
    matchCount = 0;
  for (const conversation of data.conversations) {
    const entry = preference.get(conversation.id)!;
    if (entry.hidden) {
      const key = sidebarTargetKey(entry.target),
        prior = hidden.get(key);
      if (
        !prior ||
        conversation.id === primary?.id ||
        (prior.conversation.id !== primary?.id &&
          dates.get(conversation.id)! > dates.get(prior.conversation.id)!)
      )
        hidden.set(key, {
          target: entry.target,
          conversation,
          primary:
            !!primary && entry.target.kind === 'bot' && entry.target.id === primaryState?.agentId,
        });
      continue;
    }
    visible.push(conversation);
    const matches =
      mobile ||
      [
        conversation.title,
        ...conversation.agentIds.map((id) => {
          const agent = agents.get(id);
          return agent ? `${agent.name} ${agent.role}` : '';
        }),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase());
    if (!matches) continue;
    matchCount++;
    if (conversation.id === primary?.id && !entry.pinned && !entry.sectionId) {
      standalone = conversation;
      continue;
    }
    if (entry.pinned) pinned.push(conversation);
    else if (entry.sectionId && sectionMap.has(entry.sectionId))
      sectionMap.get(entry.sectionId)!.conversations.push(conversation);
    else ungrouped.push(conversation);
  }
  for (const section of sections) sort(section.conversations);
  return {
    standalone,
    primary,
    pinned: sort(pinned),
    sections,
    ungrouped: sort(ungrouped),
    hidden: [...hidden.values()],
    visible,
    matchCount,
    total: data.conversations.length,
  };
}
