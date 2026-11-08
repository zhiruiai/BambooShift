import { uiText } from '../i18n';
import { emptyComposer, makeSendAttempt } from '../chatDrafts';
import { CreateDialog } from '../components/CreateDialog';
import { GroupSettingsDialog } from '../components/GroupSettingsDialog';
import { PrimaryBotDialog } from '../components/PrimaryBotDialog';
import { RosterManagementDialog } from '../components/SidebarRoster';
import { currentWorkspaceId } from '../workspace-scope';
import type { WorkspaceModel } from './types';

export function WorkspacePeopleDialogs({
  modal,
  rosterDialog,
  data,
  roster,
  account,
  currentUserId,
  setModal,
  sendScope,
  openConversation,
  setToast,
  openPrimary,
  conversation,
  navigationScope,
  sync,
  setData,
  refresh,
  canManage,
  teamPlanToOpen,
  createMode,
  createProfile,
  selectedRef,
  setSelected,
  showChat,
  acceptConfirmedTeam,
  attempts,
  submitAttempt,
  personalSpace,
  primaryMode,
}: Pick<
  WorkspaceModel,
  | 'modal'
  | 'rosterDialog'
  | 'data'
  | 'roster'
  | 'account'
  | 'currentUserId'
  | 'setModal'
  | 'sendScope'
  | 'openConversation'
  | 'setToast'
  | 'openPrimary'
  | 'conversation'
  | 'navigationScope'
  | 'sync'
  | 'setData'
  | 'refresh'
  | 'canManage'
  | 'teamPlanToOpen'
  | 'createMode'
  | 'createProfile'
  | 'selectedRef'
  | 'setSelected'
  | 'showChat'
  | 'acceptConfirmedTeam'
  | 'attempts'
  | 'submitAttempt'
  | 'personalSpace'
  | 'primaryMode'
>) {
  return (
    <>
      {modal === 'roster' && (
        <RosterManagementDialog
          request={rosterDialog}
          data={data}
          roster={roster}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          onClose={() => setModal(null)}
          onOpen={(target) => {
            if (sendScope.current(sendScope.ticket())) {
              setModal(null);
              openConversation(target);
            }
          }}
          onNotice={setToast}
          onPrimary={openPrimary}
        />
      )}
      {modal === 'group' && conversation?.isGroup && (
        <GroupSettingsDialog
          key={`${navigationScope}:${conversation.id}`}
          agents={data.agents}
          conversation={conversation}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          onClose={() => setModal(null)}
          onSaved={(updated) => {
            if (!sendScope.current(sendScope.ticket())) return;
            sync.written();
            // The settings receipt can be newer than the rendered messages.
            setData((previous) =>
              previous
                ? {
                    ...previous,
                    conversations: previous.conversations.map((item) =>
                      item.id === updated.id
                        ? { ...updated, unread: item.unread, readThrough: item.readThrough }
                        : item,
                    ),
                  }
                : previous,
            );
            void refresh();
          }}
        />
      )}
      {modal === 'create' && (
        <CreateDialog
          key={navigationScope}
          agents={data.agents}
          canCreateBot={canManage}
          initialPlanId={teamPlanToOpen}
          initialMode={createMode}
          initialProfile={createProfile}
          modelConfigured={data.settings.configured}
          modelLabel={data.settings.profileName || data.settings.model}
          settings={data.settings}
          onSettingsChanged={(settings) => {
            sync.written();
            setData((previous) => (previous ? { ...previous, settings } : previous));
            void refresh();
          }}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          onClose={() => setModal(null)}
          onBrowseShared={account ? () => setModal('shared-bots') : undefined}
          onCreated={(created, agents = []) => {
            if (!sendScope.current(sendScope.ticket())) return;
            sync.written();
            setData((previous) =>
              previous
                ? {
                    ...previous,
                    // An update may have arrived while the receipt was in flight.
                    // Add missing entities without replacing a newer live record.
                    agents: [
                      ...previous.agents,
                      ...agents.filter(
                        (agent) => !previous.agents.some((item) => item.id === agent.id),
                      ),
                    ],
                    conversations: previous.conversations.some((item) => item.id === created.id)
                      ? previous.conversations
                      : [...previous.conversations, created],
                  }
                : previous,
            );
            selectedRef.current = created.id;
            setSelected(created.id);
            showChat(created.id);
            setModal(null);
            setToast(
              created.isGroup
                ? uiText('workspace:text_911317d77e31')
                : uiText('workspace:text_ae08ce06f4b0'),
            );
            void refresh();
          }}
          onTeamCreated={(plan, start, confirmed) => {
            if (!plan.result || !plan.draft) return;
            const target = plan.result.conversationId;
            sync.written();
            acceptConfirmedTeam(confirmed);
            selectedRef.current = target;
            setSelected(target);
            showChat(target);
            setModal(null);
            void refresh();
            if (start) {
              const snapshot = { ...emptyComposer(), text: plan.goal };
              const attempt = { ...makeSendAttempt(target, snapshot), clientId: plan.id };
              attempts.current.set(target, attempt);
              void submitAttempt(attempt);
            }
          }}
        />
      )}
      {modal === 'primary' && (
        <PrimaryBotDialog
          key={navigationScope}
          state={data.primaryBot}
          defaultTimeZone={data.workspaceTimeZone?.timeZone}
          checkInStatus={data.primaryCheckIn}
          agents={data.agents}
          workspaceId={account?.workspace.id || currentWorkspaceId()}
          userId={currentUserId}
          team={account?.workspace.kind === 'team'}
          personalHref={personalSpace ? `/w/${personalSpace.id}` : account ? '/account' : undefined}
          initialMode={primaryMode}
          onClose={() => setModal(null)}
          onSaved={(state, confirmed) => {
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
            if (confirmed) {
              selectedRef.current = confirmed.conversation.id;
              setSelected(confirmed.conversation.id);
              showChat(confirmed.conversation.id);
            }
            setModal(null);
            setToast(
              state.agentId
                ? uiText('workspace:text_43d2a419cf60')
                : uiText('workspace:text_a3521172883c'),
            );
            void refresh();
          }}
        />
      )}
    </>
  );
}
