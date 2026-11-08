import { Monitor } from 'lucide-react';
import { uiText } from '../../i18n';
import { botScreenLabel, BotScreenPicker, botTaskLabel } from '../../components/BotScreenPicker';
import { ComputerPreview } from '../../components/ComputerPreview';
import { currentWorkspaceId } from '../../workspace-scope';
import type { WorkspaceModel } from '../types';

export function ConversationComputer(
  props: Pick<
    WorkspaceModel,
    | 'conversation'
    | 'members'
    | 'sidebarComputer'
    | 'selectedComputerAgent'
    | 'selectedComputerAgentId'
    | 'setConversationScreens'
    | 'navigationScope'
    | 'selected'
    | 'account'
    | 'currentUserId'
    | 'modal'
    | 'openComputer'
  >,
) {
  const {
    conversation,
    members,
    sidebarComputer,
    selectedComputerAgent,
    selectedComputerAgentId,
    setConversationScreens,
    navigationScope,
    selected,
    account,
    currentUserId,
    modal,
    openComputer,
  } = props;
  return (
    <section className="detail-section detail-computer-section">
      <div className="section-label">
        <span>{uiText('workspace:text_d48f1dcf88d2')}</span>
        <span className="subtle-status">
          {botTaskLabel(sidebarComputer.computer?.botScreen) ||
            (selectedComputerAgent
              ? botScreenLabel(sidebarComputer.computer?.botScreen)
              : uiText('workspace:text_c15b9e74e7bd'))}
        </span>
      </div>
      {conversation?.isGroup && (
        <BotScreenPicker
          agents={members}
          selected={selectedComputerAgentId}
          inventory={sidebarComputer.inventory}
          onSelect={(id) =>
            setConversationScreens((all) => ({ ...all, [`${navigationScope}:${selected}`]: id }))
          }
        />
      )}
      {sidebarComputer.computer ? (
        <ComputerPreview
          key={`${navigationScope}:${selectedComputerAgentId || ''}`}
          computer={sidebarComputer.computer}
          agentName={selectedComputerAgent?.name}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          active={modal === null}
          onOpen={() => openComputer()}
        />
      ) : (
        <div className="detail-empty">
          <Monitor size={30} />
          <p>{uiText('workspace:detailComputerEmpty')}</p>
          <button type="button" className="secondary-button" onClick={() => openComputer()}>
            {uiText('workspace:detailOpenComputer')}
          </button>
        </div>
      )}
      <p className="section-help">
        {sidebarComputer.error || uiText('workspace:text_632cbf37135f')}
      </p>
    </section>
  );
}
