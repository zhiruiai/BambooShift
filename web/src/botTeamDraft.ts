import { uiText } from './i18n';
import type { Bootstrap, BotAgent, Conversation } from '../../shared/types';
import type { BotTeamDraft } from '../../shared/bot-team-plans';
import { botProfileProblem } from './botProfiles';
import { GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS } from '../../shared/group-members';
export interface ConfirmedTeamConversation {
  conversation: Conversation;
  agents: BotAgent[];
}
/** Read the actual current group; an old proposal receipt cannot recreate a deleted chat. */
export async function confirmTeamConversation(
  scope: { request<T>(path: string): Promise<T> },
  conversationId: string,
): Promise<ConfirmedTeamConversation> {
  const snapshot = await scope.request<Bootstrap>('/bootstrap');
  const conversation = snapshot.conversations?.find(
    (item) => item.id === conversationId && item.isGroup,
  );
  if (
    !conversation ||
    !conversation.agentIds.length ||
    !Array.isArray(snapshot.agents) ||
    conversation.agentIds.some((id) => !snapshot.agents.some((agent) => agent.id === id))
  )
    throw new Error(uiText('bots:text_03245b8f5fa0'));
  return {
    conversation,
    agents: snapshot.agents.filter((agent) => conversation.agentIds.includes(agent.id)),
  };
}
export function botTeamProblem(draft: BotTeamDraft, agents: BotAgent[], draftOnly = false) {
  if (!draft.title.trim() || draft.title.length > 100) return uiText('bots:text_94f819df3dbc');
  if (!draft.summary.trim() || draft.summary.length > 2000) return uiText('bots:text_6eea30156bda');
  if (
    draft.members.length < (draftOnly ? 1 : GROUP_MIN_MEMBERS) ||
    draft.members.length > GROUP_MAX_MEMBERS
  )
    return uiText('bots:text_6b92ff0ff760', {
      value0: GROUP_MIN_MEMBERS,
      value1: GROUP_MAX_MEMBERS,
    });
  if (!draft.members.some((member) => member.key === draft.leadKey))
    return uiText('bots:text_69f7f6611232');
  const used = new Set<string>(),
    names = new Set<string>();
  for (const member of draft.members) {
    if (!member.assignment.trim() || member.assignment.length > 2000)
      return uiText('bots:text_cb8811d72d41');
    const agent =
      member.kind === 'reuse' ? agents.find((item) => item.id === member.agentId) : member;
    if (member.kind === 'reuse' && used.has(member.agentId))
      return uiText('bots:text_6648b7968946');
    if (member.kind === 'reuse') used.add(member.agentId);
    if (!agent) {
      if (draftOnly) continue;
      return uiText('bots:text_273004b3ce0b');
    }
    if (!draftOnly && names.has(agent.name.trim().toLocaleLowerCase()))
      return uiText('bots:text_7af3f2486c1b');
    names.add(agent.name.trim().toLocaleLowerCase());
    if (member.kind === 'create') {
      const issue = botProfileProblem(member);
      if (issue) return issue;
    }
  }
  return '';
}
