import { isSharedBot } from '../../../shared/shared-bots';
import { botDeletionScreenReason } from '../computerLifecycle';
import { useBotComputer } from '../useBotComputer';
import { AgentSettingsContentView } from './agent/AgentSettingsContentView';
import { Props } from './agent/parts';
import { useAgentSettingsContent } from './agent/useAgentSettingsContent';
import './BotProfiles.css';
export function AgentDialog(props: Props) {
  props = { ...props, readOnly: props.readOnly || isSharedBot(props.agent) };
  const screen = useBotComputer({
    machine: props.computer,
    workspaceId: props.workspaceId,
    userId: props.userId,
    agentId: props.agent.id,
    active: !props.readOnly,
  });
  const blocked =
    props.deleteBlocked ||
    botDeletionScreenReason(screen.computer?.botScreen, screen.loaded, screen.error);
  return (
    <AgentSettingsContent
      {...props}
      deleteBlocked={blocked}
      boundScreen={!!screen.computer?.botScreen?.screenId}
    />
  );
}
function AgentSettingsContent(props: Parameters<typeof useAgentSettingsContent>[0]) {
  const model = useAgentSettingsContent(props);
  return <AgentSettingsContentView {...model} />;
}
