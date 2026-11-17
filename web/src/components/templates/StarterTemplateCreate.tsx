import type { BotProfileDraft } from '../../botProfiles';
import { CreateDialog } from '../CreateDialog';
import type { Common } from './types';
import type { CreationStarter } from '../../../../shared/creation-requests';
export function StarterTemplateCreate({
  profile,
  starter,
  onBack,
  ...props
}: Common & { profile: BotProfileDraft; starter?: CreationStarter }) {
  return (
    <CreateDialog
      agents={[]}
      canCreateBot={props.owner}
      botOnly
      initialProfile={profile}
      initialStarter={starter}
      workspaceId={props.workspaceId}
      userId={props.userId}
      onClose={onBack}
      onCreated={(conversation, agents = []) => {
        if (!props.owner || !props.scope.current(props.scope.ticket())) return;
        const agent = agents.find(
          (item) => conversation.agentIds.length === 1 && conversation.agentIds[0] === item.id,
        );
        if (agent && !conversation.isGroup) props.onCreated({ agent, conversation });
      }}
    />
  );
}
