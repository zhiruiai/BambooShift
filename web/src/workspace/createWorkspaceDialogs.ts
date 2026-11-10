import { providerDraft } from '../appProviders';
import { canReviewCustomApp, type AppProposalEntry } from '../appProposalEntry';
import {
  isCustomAppConnectionProposal,
  parseAppConnectionProposal,
} from '../../../shared/app-proposals';
import { uiText } from '../i18n';
import { parseBotTemplatePath } from '../../../shared/bot-templates';
import { isSharedBot } from '../../../shared/shared-bots';
import type { ConfirmedTeamConversation } from '../botTeamDraft';
import { type BotTemplateDialogRequest } from '../components/BotTemplateDialog';
import { type PrimaryBotMode } from '../components/PrimaryBotDialog';
import { type RosterDialogRequest } from '../components/SidebarRoster';
import type { ConfirmedSharedBot } from '../sharedBots';
import type { WorkspaceDialogsContext } from './createWorkspaceDialogs.types';
export function createWorkspaceDialogs(read: () => WorkspaceDialogsContext) {
  function openSharedConversation(value: ConfirmedSharedBot, confirmed = false) {
    const {
      sendScope,
      currentUserId,
      personalSpace,
      receipts,
      sendingRef,
      uploadingRef,
      dictation,
      pendingDictation,
      composers,
      account,
      setSharedNavigation,
      sync,
      setData,
      openConversation,
      setModal,
      refresh,
    } = read();

    if (
      !sendScope.current(sendScope.ticket()) ||
      value.receipt.actorId !== currentUserId ||
      value.receipt.workspaceId !== personalSpace?.id
    )
      return;
    const pending =
      receipts.pending() > 0 ||
      sendingRef.current.size > 0 ||
      uploadingRef.current.size > 0 ||
      dictation.busy ||
      !!pendingDictation.current;
    const hasDraft = Object.values(composers).some(
      (item) =>
        item.text.length > 0 || item.attachments.length > 0 || !!item.replyTo || !!item.appContext,
    );
    if (
      pending ||
      (!confirmed && hasDraft && value.receipt.workspaceId !== account?.workspace.id)
    ) {
      setSharedNavigation(value);
      return;
    }
    setSharedNavigation(undefined);
    if (value.receipt.workspaceId === account?.workspace.id) {
      sync.written();
      setData((previous) =>
        previous
          ? {
              ...previous,
              agents: [
                ...previous.agents.filter((item) => item.id !== value.agent.id),
                value.agent,
              ],
              conversations: [
                ...previous.conversations.filter((item) => item.id !== value.conversation.id),
                value.conversation,
              ],
            }
          : previous,
      );
      openConversation(value.conversation);
      setModal(null);
      void refresh();
    } else
      window.location.assign(
        `/w/${encodeURIComponent(value.receipt.workspaceId)}?conversation=${encodeURIComponent(value.conversation.id)}`,
      );
  }
  function navigateTemplatePage(path: string, confirmed = false) {
    const { sendScope, receipts, sendingRef, uploading, composers, setTemplateNavigation } = read();

    if (!sendScope.current(sendScope.ticket()) || !parseBotTemplatePath(path)) return;
    const pending = receipts.pending() > 0 || sendingRef.current.size > 0 || uploading.size > 0;
    const hasDraft = Object.values(composers).some(
      (draft) =>
        draft.text.length > 0 ||
        draft.attachments.length > 0 ||
        !!draft.replyTo ||
        !!draft.appContext,
    );
    if (pending || (!confirmed && hasDraft)) {
      setTemplateNavigation(path);
      return;
    }
    setTemplateNavigation(undefined);
    window.location.assign(path);
  }
  function openTemplates(request: BotTemplateDialogRequest) {
    const { sendScope, data, setToast, setTemplateDialog, setModal } = read();

    if (!sendScope.current(sendScope.ticket())) return;
    if (
      (request.kind === 'copy' || request.kind === 'share') &&
      isSharedBot(data?.agents.find((agent) => agent.id === request.agentId))
    ) {
      setToast(uiText('workspace:text_1e2df92a30fe'));
      return;
    }
    setTemplateDialog(request);
    setModal('templates');
  }
  function openRoster(request: RosterDialogRequest) {
    const { sendScope, setRosterDialog, setMenuOpen, setModal } = read();

    if (!sendScope.current(sendScope.ticket())) return;
    setRosterDialog(request);
    setMenuOpen(false);
    setModal('roster');
  }
  function openSettings(view: 'general' | 'computer' | 'models' = 'general') {
    const { sendScope, setSettingsInitialView, canManage, setModal } = read();

    if (!sendScope.current(sendScope.ticket())) return;
    setSettingsInitialView(view === 'models' && !canManage ? 'general' : view);
    setModal('settings');
  }
  function openApps(shareId?: string) {
    const { sendScope, setAppsShareId, setAppsProviderId, setAppsCustomProposal, setModal } =
      read();

    if (!sendScope.current(sendScope.ticket())) return;
    setAppsProviderId(undefined);
    setAppsCustomProposal(undefined);
    setAppsShareId(shareId);
    setModal('apps');
  }
  function openAppProposal(entry: AppProposalEntry, agentId: string): boolean | void {
    const {
      sendScope,
      canManage,
      data,
      modal,
      setAppsShareId,
      setAppsProviderId,
      setAppsCustomProposal,
      setModal,
      account,
      conversation,
      currentUserId,
    } = read();
    if (
      modal ||
      !sendScope.current(sendScope.ticket()) ||
      !canManage ||
      !data?.agents.some((bot) => bot.id === agentId && !bot.sharedBot)
    )
      return false;
    if (typeof entry === 'string') {
      if (!providerDraft(entry)) return false;
      setAppsProviderId(entry);
      setAppsCustomProposal(undefined);
    } else {
      const message = data.messages.find((item) => item.id === entry.messageId);
      const proposal = parseAppConnectionProposal(message);
      if (
        account?.workspace.kind !== 'personal' ||
        !canReviewCustomApp(conversation, agentId) ||
        message?.agentId !== agentId ||
        message.conversationId !== conversation?.id ||
        !proposal ||
        !isCustomAppConnectionProposal(proposal) ||
        proposal.requester.userId !== currentUserId ||
        proposal.url !== entry.url ||
        proposal.name !== entry.name
      )
        return false;
      setAppsProviderId(undefined);
      setAppsCustomProposal(entry);
    }
    setAppsShareId(undefined);
    setModal('apps');
    return true;
  }
  function openPrimary(mode?: PrimaryBotMode) {
    const { sendScope, setPrimaryMode, setModal } = read();

    if (!sendScope.current(sendScope.ticket())) return;
    setPrimaryMode(mode);
    setModal('primary');
  }
  function acceptConfirmedTeam(confirmed: ConfirmedTeamConversation) {
    const { setData } = read();

    setData((previous) =>
      previous
        ? {
            ...previous,
            conversations: [
              ...previous.conversations.filter((item) => item.id !== confirmed.conversation.id),
              confirmed.conversation,
            ],
            agents: [
              ...previous.agents,
              ...confirmed.agents.filter(
                (agent) => !previous.agents.some((item) => item.id === agent.id),
              ),
            ],
          }
        : previous,
    );
  }
  function openCreate(
    planId?: string,
    mode?: 'bot' | 'group' | 'team',
    profile?: import('../botProfiles').BotProfileDraft,
  ) {
    const { sendScope, canManage, setTeamPlanToOpen, setCreateMode, setCreateProfile, setModal } =
      read();

    if (!sendScope.current(sendScope.ticket()) || ((planId || profile) && !canManage)) return;
    setTeamPlanToOpen(planId);
    setCreateMode(mode);
    setCreateProfile(profile);
    setModal('create');
  }
  function openComputer(agentId?: string | null, panel: 'screen' | 'files' = 'screen') {
    const {
      sendScope,
      selectedComputerAgentId,
      data,
      setToast,
      setComputerAgentId,
      setComputerConversation,
      selected,
      conversation,
      navigationScope,
      setComputerPanel,
      setModal,
    } = read();

    if (!sendScope.current(sendScope.ticket())) return;
    const chosen = agentId === null ? undefined : agentId || selectedComputerAgentId;
    if (agentId && !data?.agents.some((a) => a.id === agentId)) {
      setToast(uiText('workspace:text_d8b29de9e616'));
      return;
    }
    setComputerAgentId(chosen);
    setComputerConversation({
      id: selected,
      title: conversation?.title || uiText('workspace:text_9800a458c16b'),
      scope: navigationScope,
    });
    setComputerPanel(panel);
    setModal('computer');
  }
  function openSearch(scope: 'all' | 'current' = 'all') {
    const { setSearchScope, setModal, setMenuOpen } = read();

    setSearchScope(scope);
    setModal('search');
    setMenuOpen(false);
  }
  return {
    openSharedConversation,
    navigateTemplatePage,
    openTemplates,
    openRoster,
    openSettings,
    openApps,
    openAppProposal,
    openPrimary,
    acceptConfirmedTeam,
    openCreate,
    openComputer,
    openSearch,
  };
}
