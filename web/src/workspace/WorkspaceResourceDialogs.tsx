import { useMemo, useRef, useState } from 'react';
import { uiText } from '../i18n';
import { isSharedBot } from '../../../shared/shared-bots';
import { AppsDialog } from '../components/AppsDialog';
import { BotTemplateDialog } from '../components/BotTemplateDialog';
import { ComputerSettingsPanel } from '../components/ComputerDialog';
import { ConversationSearch } from '../components/ConversationSearch';
import { FilePreviewDialog } from '../components/FilePreviewDialog';
import { Dialog } from '../components/UI';
import { WorkspaceSettingsDialog } from '../components/WorkspaceSettingsDialog';
import { previewFilePath } from '../filePreview';
import { currentWorkspaceId, workspaceApiUrl } from '../workspace-scope';
import type { OpenWebsiteProject } from '../websiteProjects';
import type { WorkspaceModel } from './types';

export function WorkspaceResourceDialogs({
  modal,
  data,
  selected,
  searchScope,
  setModal,
  jumpToMessage,
  setRoutineToEdit,
  openCreate,
  canManage,
  settingsInitialView,
  account,
  currentUserId,
  personalSpace,
  setData,
  refresh,
  sendScope,
  sync,
  openMemoryImport,
  navigationScope,
  appsShareId,
  appsProviderId,
  appsCustomProposal,
  setSkillsAgentId,
  setPackagedSkillDraft,
  members,
  openTemplates,
  fileRef,
  openComputer,
  openSettings,
  selectedComputerAgentId,
  busy,
  action,
  templateDialog,
  navigateTemplatePage,
  openConversation,
  setToast,
  templateNavigation,
  setTemplateNavigation,
  receipts,
  sending,
  uploading,
  openWebsiteSearchResult,
}: Pick<
  WorkspaceModel,
  | 'modal'
  | 'data'
  | 'selected'
  | 'searchScope'
  | 'setModal'
  | 'jumpToMessage'
  | 'setRoutineToEdit'
  | 'openCreate'
  | 'canManage'
  | 'settingsInitialView'
  | 'account'
  | 'currentUserId'
  | 'personalSpace'
  | 'setData'
  | 'refresh'
  | 'sendScope'
  | 'sync'
  | 'openMemoryImport'
  | 'navigationScope'
  | 'appsShareId'
  | 'appsProviderId'
  | 'appsCustomProposal'
  | 'setSkillsAgentId'
  | 'setPackagedSkillDraft'
  | 'members'
  | 'openTemplates'
  | 'fileRef'
  | 'openComputer'
  | 'openSettings'
  | 'selectedComputerAgentId'
  | 'busy'
  | 'action'
  | 'templateDialog'
  | 'navigateTemplatePage'
  | 'openConversation'
  | 'setToast'
  | 'templateNavigation'
  | 'setTemplateNavigation'
  | 'receipts'
  | 'sending'
  | 'uploading'
> & { openWebsiteSearchResult?: OpenWebsiteProject }) {
  const [searchFile, setSearchFile] = useState<{ id: string; scope: string }>();
  const identity = useMemo(
    () => ({
      userId: currentUserId,
      workspaceId: account?.workspace.id || currentWorkspaceId(),
      pathname: window.location.pathname,
    }),
    [currentUserId, account?.workspace.id, navigationScope],
  );
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const readIdentity = useRef(() => ({
    ...latestIdentity.current,
    pathname: window.location.pathname,
  }));
  const filePath = (id: string) =>
    previewFilePath(workspaceApiUrl(`/api/files/${id}/download`), identity);
  const preview =
    modal === 'search-file' && searchFile?.scope === navigationScope
      ? data.files.find((file) => file.id === searchFile.id)
      : undefined;
  const previewPath = preview && filePath(preview.id);
  return (
    <>
      {modal === 'search' && (
        <ConversationSearch
          key={navigationScope}
          data={data}
          currentConversationId={selected}
          initialScope={searchScope}
          onClose={() => setModal(null)}
          onJump={jumpToMessage}
          onOpenWebsite={openWebsiteSearchResult}
          onOpenFile={(file) => {
            if (!sendScope.current(sendScope.ticket()) || !filePath(file.id)) return;
            setSearchFile({ id: file.id, scope: navigationScope });
            setModal('search-file');
          }}
          onOpenRoutine={(routine) => {
            if (!sendScope.current(sendScope.ticket())) return;
            const chat = data.conversations.find((item) => item.id === routine.conversationId);
            if (!chat?.agentIds.includes(routine.agentId)) return;
            openConversation(chat);
            setRoutineToEdit(routine.id);
            setModal('routine');
          }}
          commands={[
            {
              id: 'new-group',
              title: uiText('workspace:text_20b5097291cb'),
              description: uiText('workspace:text_433419d14279'),
              keywords: uiText('workspace:text_bb3ab6efa45f'),
              shortcut: '⌘/Ctrl ⇧ N',
              run: () => openCreate(undefined, 'group'),
            },
            ...(canManage
              ? [
                  {
                    id: 'smart-team',
                    title: uiText('workspace:text_5ed92ff52716'),
                    description: uiText('workspace:text_aee7a6498ec5'),
                    keywords: uiText('workspace:text_744b93c9b24f'),
                    run: () => openCreate(undefined, 'team'),
                  },
                  {
                    id: 'new-bot',
                    title: uiText('workspace:text_a25af04e6a9b'),
                    description: uiText('workspace:text_bb77dd0127a0'),
                    keywords: uiText('workspace:text_0e104b082921'),
                    run: () => openCreate(undefined, 'bot'),
                  },
                ]
              : []),
          ]}
        />
      )}
      {modal === 'search-file' &&
        (preview && previewPath ? (
          <FilePreviewDialog
            key={`${navigationScope}:${preview.id}`}
            name={preview.name}
            href={previewPath}
            identity={identity}
            currentIdentity={readIdentity.current}
            onClose={() => setModal(null)}
          />
        ) : (
          <Dialog title={uiText('common:searchFile')} onClose={() => setModal(null)}>
            <p role="status">{uiText('workspace:filePreviewError_access')}</p>
          </Dialog>
        ))}
      {modal === 'settings' && (
        <WorkspaceSettingsDialog
          initialView={settingsInitialView}
          computerSettings={(onBusyChange, navigate) => (
            <ComputerSettingsPanel
              key={`${navigationScope}:${selectedComputerAgentId || ''}`}
              data={data}
              agentId={selectedComputerAgentId}
              busy={busy}
              onAction={action}
              refresh={refresh}
              onBusyChange={onBusyChange}
              onWatch={() => navigate(() => openComputer())}
            />
          )}
          data={data}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          canManage={canManage}
          team={account?.workspace.kind === 'team'}
          personalHref={personalSpace ? `/w/${personalSpace.id}` : account ? '/account' : undefined}
          onClose={() => setModal(null)}
          onSettingsChanged={(settings) => {
            setData((previous) => (previous ? { ...previous, settings } : previous));
            void refresh();
          }}
          onPrimaryChanged={(state, confirmed) => {
            if (!sendScope.current(sendScope.ticket())) return;
            sync.written();
            setData((previous) =>
              previous
                ? {
                    ...previous,
                    primaryBot: state,
                    primaryCheckIn: undefined,
                    ...(confirmed
                      ? {
                          agents: [
                            ...previous.agents.filter((item) => item.id !== confirmed.agent.id),
                            confirmed.agent,
                          ],
                          conversations: [
                            ...previous.conversations.filter(
                              (item) => item.id !== confirmed.conversation.id,
                            ),
                            confirmed.conversation,
                          ],
                        }
                      : {}),
                  }
                : previous,
            );
            void refresh();
          }}
          onImported={openMemoryImport}
          onTimeZoneChanged={() => {
            if (!sendScope.current(sendScope.ticket())) return;
            sync.written();
            void refresh();
          }}
        />
      )}
      {modal === 'apps' && (
        <AppsDialog
          key={navigationScope}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          workspaceName={account?.workspace.name || uiText('workspace:text_e30e9ba009e8')}
          team={account?.workspace.kind === 'team'}
          canManage={canManage}
          initialSharedBotId={appsShareId}
          initialProviderId={appsProviderId}
          initialCustomProposal={appsCustomProposal}
          sharedAgents={data.agents.filter(
            (agent) =>
              isSharedBot(agent) &&
              (members.some((member) => member.id === agent.id) ||
                agent.sharedBot?.shareId === appsShareId),
          )}
          computerConnected={data.computer.connected}
          modelLabel={`${data.settings.profileName || data.settings.provider} · ${data.settings.model || uiText('workspace:text_e2c498da30fc')}`}
          modelConfigured={data.settings.configured}
          onTemplates={() => openTemplates({ kind: 'library' })}
          packagedSkills={{
            bots: canManage ? data.agents.filter((agent) => !isSharedBot(agent)) : [],
            onEdit: (draft) => {
              if (
                !canManage ||
                !currentUserId ||
                !sendScope.current(sendScope.ticket()) ||
                !data.agents.some((agent) => agent.id === draft.agentId && !isSharedBot(agent))
              )
                return;
              setSkillsAgentId(draft.agentId);
              setPackagedSkillDraft({ ...draft, scope: navigationScope });
              setModal('skills');
            },
          }}
          onClose={() => setModal(null)}
          onFiles={() => {
            setModal(null);
            fileRef.current?.click();
          }}
          onComputer={() => openSettings('computer')}
          onSettings={() => openSettings('models')}
          onChanged={() => {
            sync.written();
            void refresh();
          }}
        />
      )}
      {modal === 'templates' && (
        <BotTemplateDialog
          key={`${navigationScope}:${JSON.stringify(templateDialog)}`}
          request={templateDialog}
          onOpenPublic={navigateTemplatePage}
          onTeamTemplates={() => openCreate(undefined, 'team')}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          owner={canManage}
          team={account?.workspace.kind === 'team'}
          onClose={() => setModal(null)}
          onChanged={() => {
            sync.written();
            void refresh();
          }}
          onCreated={(confirmed) => {
            if (!sendScope.current(sendScope.ticket())) return;
            sync.written();
            setData((previous) =>
              previous
                ? {
                    ...previous,
                    agents: [
                      ...previous.agents.filter((item) => item.id !== confirmed.agent.id),
                      confirmed.agent,
                    ],
                    conversations: [
                      ...previous.conversations.filter(
                        (item) => item.id !== confirmed.conversation.id,
                      ),
                      confirmed.conversation,
                    ],
                  }
                : previous,
            );
            openConversation(confirmed.conversation);
            setModal(null);
            void refresh();
            setToast(uiText('workspace:text_d516034aa424'));
          }}
        />
      )}
      {templateNavigation && (
        <Dialog
          title={uiText('workspace:text_ed4233f5226a')}
          onClose={() => setTemplateNavigation(undefined)}
        >
          {receipts.pending() > 0 || sending.size > 0 || uploading.size > 0 ? (
            <>
              <p className="field-help">{uiText('workspace:text_14ecc82b7aed')}</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setTemplateNavigation(undefined)}
              >
                {uiText('workspace:text_e15c839260eb')}
              </button>
            </>
          ) : (
            <>
              <p className="field-help">{uiText('workspace:text_e94ac9a3da9c')}</p>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setTemplateNavigation(undefined)}
                >
                  {uiText('workspace:text_b2304c6c8169')}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => navigateTemplatePage(templateNavigation, true)}
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
