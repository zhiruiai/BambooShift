import { uiText } from '../i18n';
import { isSharedBot } from '../../../shared/shared-bots';
import { AgentDialog } from '../components/AgentDialog';
import { ManageSharedBotDialog, SharedBotsDialog } from '../components/SharedBotsDialog';
import { Dialog } from '../components/UI';
import { currentWorkspaceId } from '../workspace-scope';
import type { WorkspaceModel } from './types';

export function WorkspaceSharingDialogs({
  modal,
  activeAgent,
  navigationScope,
  account,
  data,
  currentUserId,
  openComputer,
  openApps,
  canManage,
  sendScope,
  setToast,
  openConversation,
  setModal,
  openTemplates,
  setSkillsAgentId,
  selectedRef,
  setSelected,
  showChat,
  setDetailTab,
  setShowDetail,
  mobileNavigation,
  sync,
  setInspected,
  refresh,
  busy,
  setData,
  personalSpace,
  openSharedConversation,
  sharedNavigation,
  setSharedNavigation,
  receipts,
  sending,
  uploading,
  dictation,
  pendingDictation,
}: Pick<
  WorkspaceModel,
  | 'modal'
  | 'activeAgent'
  | 'navigationScope'
  | 'account'
  | 'data'
  | 'currentUserId'
  | 'openComputer'
  | 'openApps'
  | 'canManage'
  | 'sendScope'
  | 'setToast'
  | 'openConversation'
  | 'setModal'
  | 'openTemplates'
  | 'setSkillsAgentId'
  | 'selectedRef'
  | 'setSelected'
  | 'showChat'
  | 'setDetailTab'
  | 'setShowDetail'
  | 'mobileNavigation'
  | 'sync'
  | 'setInspected'
  | 'refresh'
  | 'busy'
  | 'setData'
  | 'personalSpace'
  | 'openSharedConversation'
  | 'sharedNavigation'
  | 'setSharedNavigation'
  | 'receipts'
  | 'sending'
  | 'uploading'
  | 'dictation'
  | 'pendingDictation'
>) {
  return (
    <>
      {modal === 'agent' && activeAgent && (
        <AgentDialog
          key={`${navigationScope}:${activeAgent.id}`}
          agent={activeAgent}
          workspaceKind={account?.workspace.kind}
          computer={data.computer}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          onComputer={() => openComputer(activeAgent.id)}
          onSharedApps={
            isSharedBot(activeAgent) ? () => openApps(activeAgent.sharedBot?.shareId) : undefined
          }
          readOnly={!canManage}
          onOpenConversation={() => {
            if (!sendScope.current(sendScope.ticket())) return;
            const direct = data.conversations.find(
              (item) =>
                !item.isGroup && item.agentIds.length === 1 && item.agentIds[0] === activeAgent.id,
            );
            if (!direct) {
              setToast(uiText('workspace:text_17c278c5931d'));
              return;
            }
            openConversation(direct);
            setModal(null);
          }}
          conversationAvailable={data.conversations.some(
            (item) =>
              !item.isGroup && item.agentIds.length === 1 && item.agentIds[0] === activeAgent.id,
          )}
          onManageSharing={
            account && canManage && !isSharedBot(activeAgent)
              ? () => setModal('sharing')
              : undefined
          }
          onCopy={() => {
            const direct = data.conversations.find(
              (item) =>
                !item.isGroup && item.agentIds.length === 1 && item.agentIds[0] === activeAgent.id,
            );
            if (!direct) {
              setToast(uiText('workspace:text_57870d9bdbaf'));
              return;
            }
            openTemplates({ kind: 'copy', agentId: activeAgent.id, conversationId: direct.id });
          }}
          onShare={() => {
            const direct = data.conversations.find(
              (item) =>
                !item.isGroup && item.agentIds.length === 1 && item.agentIds[0] === activeAgent.id,
            );
            if (!direct) {
              setToast(uiText('workspace:text_db0999cc5957'));
              return;
            }
            openTemplates({ kind: 'share', agentId: activeAgent.id, conversationId: direct.id });
          }}
          skillCount={data.skills.filter((item) => item.agentId === activeAgent.id).length}
          fileCount={
            data.files.filter(
              (file) =>
                !file.conversationId ||
                data.conversations.some(
                  (item) =>
                    !item.isGroup &&
                    item.agentIds.includes(activeAgent.id) &&
                    item.id === file.conversationId,
                ),
            ).length
          }
          onSkills={() => {
            setSkillsAgentId(activeAgent.id);
            setModal('skills');
          }}
          onFiles={() => {
            const direct = data.conversations.find(
              (item) => !item.isGroup && item.agentIds.includes(activeAgent.id),
            );
            if (!direct) {
              setToast(uiText('workspace:text_17c278c5931d'));
              return;
            }
            selectedRef.current = direct.id;
            setSelected(direct.id);
            showChat(direct.id);
            setDetailTab('files');
            setShowDetail(true);
            mobileNavigation.current?.move({ view: 'details', conversationId: direct.id });
            setModal(null);
          }}
          deleteBlocked={
            data.agents.length <= 1
              ? uiText('workspace:text_64c28a319fd2')
              : activeAgent.status === 'working'
                ? uiText('workspace:text_14a02cf1019c')
                : data.conversations.some(
                      (c) =>
                        c.isGroup && c.agentIds.length === 1 && c.agentIds[0] === activeAgent.id,
                    )
                  ? uiText('workspace:text_fa4523cb0c62')
                  : ''
          }
          onDeleted={() => {
            sync.written();
            setModal(null);
            setInspected('');
            void refresh();
            setToast(uiText('workspace:text_f5cb23e58fa7'));
          }}
          busy={busy}
          onClose={() => setModal(null)}
          onSaved={(agent) => {
            setData((previous) =>
              previous
                ? {
                    ...previous,
                    agents: previous.agents.map((item) => (item.id === agent.id ? agent : item)),
                  }
                : previous,
            );
            sync.written();
            void refresh();
          }}
        />
      )}
      {modal === 'shared-bots' && account?.session.user && (
        <SharedBotsDialog
          userId={account.session.user.id}
          personalWorkspace={personalSpace}
          teams={account.session.workspaces.filter(
            (item) => item.kind === 'team' && item.status === 'active',
          )}
          initialTeamId={account.workspace.kind === 'team' ? account.workspace.id : undefined}
          onClose={() => setModal(null)}
          onOpen={openSharedConversation}
        />
      )}
      {modal === 'sharing' &&
        account?.session.user &&
        activeAgent &&
        canManage &&
        !isSharedBot(activeAgent) && (
          <ManageSharedBotDialog
            userId={account.session.user.id}
            workspaceId={account.workspace.id}
            workspaceKind={account.workspace.kind}
            agentId={activeAgent.id}
            agentName={activeAgent.name}
            onClose={() => setModal(null)}
            onChanged={async () => {
              sync.written();
              await refresh();
            }}
          />
        )}
      {sharedNavigation && (
        <Dialog
          title={uiText('workspace:text_a88158b8268a')}
          subtitle={uiText('workspace:text_3ab77ff39221')}
          onClose={() => setSharedNavigation(undefined)}
        >
          {receipts.pending() > 0 ||
          sending.size > 0 ||
          uploading.size > 0 ||
          dictation.busy ||
          !!pendingDictation.current ? (
            <>
              <p>{uiText('workspace:text_77429233b9a9')}</p>
              <button className="secondary-button" onClick={() => setSharedNavigation(undefined)}>
                {uiText('workspace:text_168344321f27')}
              </button>
            </>
          ) : (
            <>
              <p>{uiText('workspace:text_886fb9eb50a0')}</p>
              <div className="dialog-actions">
                <button className="secondary-button" onClick={() => setSharedNavigation(undefined)}>
                  {uiText('workspace:text_2ba6d0fbc74f')}
                </button>
                <button
                  className="primary-button"
                  onClick={() => openSharedConversation(sharedNavigation, true)}
                >
                  {uiText('workspace:text_2edb1662a635')}
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
