import { uiText } from '../../i18n';
import { GROUP_MAX_MEMBERS, canEditGroupMembers } from '../../../../shared/group-members';
import { GROUP_SETTINGS_LIMITS, type UpdateGroupSettings } from '../../../../shared/group-settings';
import type { BotAgent, Conversation } from '../../../../shared/types';
import '../GroupSettingsDialog.css';
export type GroupDraft = Pick<UpdateGroupSettings, 'title' | 'agentIds' | 'teamBrief'>;
export const toDraft = (conversation: Conversation): GroupDraft => ({
  title: conversation.title,
  agentIds: [...conversation.agentIds],
  ...(conversation.teamBrief
    ? {
        teamBrief: {
          ...conversation.teamBrief,
          assignments: conversation.teamBrief.assignments.map((item) => ({ ...item })),
        },
      }
    : {}),
});
export function payload(draft: GroupDraft): GroupDraft {
  return {
    ...draft,
    ...(draft.teamBrief
      ? {
          teamBrief: {
            ...draft.teamBrief,
            leadAgentId: draft.agentIds[0] || '',
            assignments: draft.agentIds.map((agentId) => ({
              agentId,
              assignment:
                draft.teamBrief!.assignments.find((item) => item.agentId === agentId)?.assignment ||
                '',
            })),
          },
        }
      : {}),
  };
}
export function problem(draft: GroupDraft, agents: BotAgent[], original: string[]): string {
  if (
    !draft.title.trim() ||
    draft.title.trim().length > GROUP_SETTINGS_LIMITS.title ||
    /[\r\n\x00-\x1f\x7f\u2028\u2029]/.test(draft.title)
  )
    return uiText('settings:text_3eba4b70963f');
  if (!canEditGroupMembers(original, draft.agentIds))
    return original.length > GROUP_MAX_MEMBERS
      ? uiText('settings:text_34e3e8f27da9')
      : uiText('settings:text_cde9b9029f20');
  if (
    new Set(draft.agentIds).size !== draft.agentIds.length ||
    draft.agentIds.some((id) => !agents.some((agent) => agent.id === id))
  )
    return uiText('settings:text_dee49a82f445');
  if (draft.teamBrief) {
    const brief = payload(draft).teamBrief!;
    if (!brief.goal.trim() || brief.goal.length > GROUP_SETTINGS_LIMITS.goal)
      return uiText('settings:text_b823b99d12d4');
    if (!brief.summary.trim() || brief.summary.length > GROUP_SETTINGS_LIMITS.summary)
      return uiText('settings:text_3829ac2af93a');
    if (
      brief.assignments.some(
        (item) =>
          !item.assignment.trim() || item.assignment.length > GROUP_SETTINGS_LIMITS.assignment,
      )
    )
      return uiText('settings:text_f5fd9a8ba069');
  }
  return '';
}
export type Props = {
  conversation: Conversation;
  agents: BotAgent[];
  workspaceId?: string;
  userId?: string;
  onClose: () => void;
  onSaved: (conversation: Conversation) => void;
};
