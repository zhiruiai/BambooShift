import { uiText } from '../i18n';
import { fixedWorkspaceApi } from '../fixedWorkspaceApi';
import { useEffect, useRef, useState } from 'react';
import { isSharedBot } from '../../../shared/shared-bots';
import type { Message } from '../../../shared/types';
import { useAccount } from '../AccountContext';
import { canStopConversation } from '../approvalUi';
import { createChatSendScope } from '../chatSendScope';
import { composerScopeKey } from '../chatDrafts';
import { useMobileHome } from '../components/MobileHome';
import { type DictationCapture } from '../dictation';
import { createPendingSubmissions } from '../pendingSubmissions';
import { conversationSelectionKey, defaultConversation, primaryConversation } from '../primaryBot';
import { conversationRosterEntry, projectSidebar } from '../sidebarRoster';
import { useAppearance } from '../useAppearance';
import { useBotComputer } from '../useBotComputer';
import { useDictation } from '../useDictation';
import { useSidebarRoster } from '../useSidebarRoster';
import { useWorkspaceSync } from '../useWorkspaceSync';
import { useConversationReads } from '../useConversationReads';
import { useWorkspaceNotifications } from '../useNotifications';
import { useWorkspaceVoice } from '../useVoice';
import { currentWorkspaceId } from '../workspace-scope';
import { createChatNavigation } from './createChatNavigation';
import type { ChatNavigationContext } from './createChatNavigation.types';
import { createComposerActions } from './createComposerActions';
import type { ComposerActionsContext } from './createComposerActions.types';
import { createMessageActions } from './createMessageActions';
import type { MessageActionsContext } from './createMessageActions.types';
import { createRoutineNavigation } from './createRoutineNavigation';
import type { RoutineNavigationContext } from './createRoutineNavigation.types';
import { createWorkspaceActions } from './createWorkspaceActions';
import type { WorkspaceActionsContext } from './createWorkspaceActions.types';
import { createWorkspaceDialogs } from './createWorkspaceDialogs';
import type { WorkspaceDialogsContext } from './createWorkspaceDialogs.types';
import { useWorkspaceEffects } from './useWorkspaceEffects';
import { useWorkspaceState } from './useWorkspaceState';
import { threadWorking, useReplyThread } from './useReplyThread';
export function useWorkspaceController() {
  const readActionContext = (): WorkspaceDialogsContext &
    RoutineNavigationContext &
    ChatNavigationContext &
    MessageActionsContext &
    ComposerActionsContext &
    WorkspaceActionsContext => actionContext;

  const appearance = useAppearance();
  const mobileHome = useMobileHome();
  const account = useAccount();
  const canManage = !account || account.workspace.role === 'owner';
  const currentUserId = account?.session.user?.id;
  const selectionKey = conversationSelectionKey({
    userId: currentUserId,
    workspaceId: account?.workspace.id || currentWorkspaceId(),
  });
  const sendIdentity = useRef({
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: currentUserId,
  });
  sendIdentity.current = {
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: currentUserId,
  };
  const [sendScope] = useState(() =>
    createChatSendScope({ ...sendIdentity.current, identity: () => sendIdentity.current }),
  );
  useEffect(() => {
    sendScope.resume();
    return () => sendScope.suspend();
  }, [sendScope]);

  const api = fixedWorkspaceApi(sendScope);

  const [receipts] = useState(() =>
    createPendingSubmissions({
      userId: currentUserId,
      workspaceId: account?.workspace.id || window.location.pathname,
    }),
  );
  const [, setReceiptCount] = useState(() => receipts.pending());
  const ownMessage = (message: Message) => !message.userId || message.userId === currentUserId;
  const userName = (message: Message) => {
    const author = message.metadata?.author as { name?: unknown } | undefined;
    return ownMessage(message)
      ? uiText('workspace:text_b70bb4acc048')
      : typeof author?.name === 'string'
        ? author.name
        : uiText('workspace:text_2e6bfec616ad');
  };
  const workspaceState = useWorkspaceState({ selectionKey, canManage });
  const notifications = useWorkspaceNotifications({ ...sendIdentity.current, isOwner: canManage });

  const {
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
  } = createWorkspaceDialogs(readActionContext);

  const { openRoutineOperation, openRoutineRun, openMemoryImport, openRoutineChat } =
    createRoutineNavigation(readActionContext);

  const navigationScope = `${account?.session.user?.id || 'local'}:${account?.workspace.id || window.location.pathname}`;
  const thread = useReplyThread(workspaceState.data, workspaceState.selected, navigationScope);
  const threadRootId = thread.root?.id;
  const composerKey = composerScopeKey(workspaceState.selected, threadRootId);
  const composerKeyRef = useRef(composerKey);
  composerKeyRef.current = composerKey;

  const currentComposer =
      workspaceState.composers[composerKey] || workspaceState.emptyDraft.current,
    draft = currentComposer.text,
    attachments = currentComposer.attachments,
    replyTo = currentComposer.replyTo,
    deliveryMode = currentComposer.mode;
  const {
    updateComposer,
    setDraft,
    setAttachments,
    rememberSelection,
    insertDictation,
    toggleDictation,
    hasFiles,
    enterFiles,
    leaveFiles,
    dropFiles,
    pasteFiles,
    upload,
    copy,
  } = createComposerActions(readActionContext);

  const shortcutActions = useRef({
    search: () => openSearch('all'),
    group: () => openCreate(undefined, 'group'),
    settings: () => openSettings(),
  });
  shortcutActions.current = {
    search: () => openSearch('all'),
    group: () => openCreate(undefined, 'group'),
    settings: () => openSettings(),
  };

  const sync = useWorkspaceSync({
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: currentUserId,
    snapshot: (b) => {
      notifications.baseline(b);
      voice.baseline(b);
      reconcileReceipts(b.messages);
      workspaceState.setData(b);
      const preserveHidden =
        workspaceState.selectionInitialized.current ||
        workspaceState.initialExplicitSelection.current;
      workspaceState.selectionInitialized.current = true;
      workspaceState.setSelected((s) => defaultConversation(s, b, { preserveHidden }));
    },
    message: (m) => {
      notifications.receive(m);
      voice.receive(m);
      reconcileReceipts([m]);
      workspaceState.setData((d) =>
        d
          ? {
              ...d,
              messages: d.messages.some((x) => x.id === m.id)
                ? d.messages.map((x) => (x.id === m.id ? m : x))
                : [...d.messages, m],
            }
          : d,
      );
    },
  });
  const roster = useSidebarRoster({
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: currentUserId,
    state: workspaceState.data?.sidebarRoster,
    onChanged: (state, expectedRevision, written) => {
      if (!sendScope.current(sendScope.ticket())) return;
      if (written) sync.written();
      workspaceState.setData((previous) =>
        previous &&
        (previous.sidebarRoster?.revision === expectedRevision ||
          previous.sidebarRoster?.revision === state.revision)
          ? { ...previous, sidebarRoster: state }
          : previous,
      );
    },
  });
  const { formAction, action, stopCurrentTask, changeRoster, refresh } =
    createWorkspaceActions(readActionContext);
  const online = sync.phase === 'online',
    loadError = sync.error;
  const connectionLabel =
    sync.error ||
    (sync.phase === 'syncing'
      ? uiText('workspace:text_0b4dfbc8c90c')
      : uiText('workspace:text_ee5304101fa5'));

  const conversation = workspaceState.data?.conversations.find(
      (c) => c.id === workspaceState.selected,
    ),
    members =
      workspaceState.data?.agents.filter((a) => conversation?.agentIds.includes(a.id)) || [];
  useConversationReads({
    conversation,
    viewport: workspaceState.scrollRef,
    enabled: !threadRootId && !workspaceState.modal && (!mobileHome || workspaceState.mobileChat),
    current: () => sendScope.current(sendScope.ticket()),
    acknowledge: (id, readThrough) =>
      api(`/conversations/${id}`, 'PATCH', { read: true, readThrough }),
    changed: () => sync.written(),
  });
  const lead = members[0],
    messages = thread.messages;
  const activeAgent = workspaceState.inspected
    ? workspaceState.data?.agents.find((a) => a.id === workspaceState.inspected)
    : lead;
  const sharedUnavailable =
    !conversation?.isGroup && isSharedBot(lead) && lead?.sharedBot?.status !== 'active';
  const selectedComputerAgentId = !conversation?.isGroup
    ? lead?.id
    : members.some(
          (a) =>
            a.id ===
            workspaceState.conversationScreens[`${navigationScope}:${workspaceState.selected}`],
        )
      ? workspaceState.conversationScreens[`${navigationScope}:${workspaceState.selected}`]
      : undefined;
  const selectedComputerAgent = members.find((a) => a.id === selectedComputerAgentId);
  const sidebarComputer = useBotComputer({
    machine: workspaceState.data?.computer,
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: currentUserId,
    agentId: selectedComputerAgentId,
    active:
      workspaceState.showDetail &&
      workspaceState.detailTab === 'computer' &&
      workspaceState.modal === null,
  });

  function conversationWorking(id: string) {
    return workspaceState.data?.runningConversationIds !== undefined
      ? workspaceState.data.runningConversationIds.includes(id)
      : !!workspaceState.data?.messages.some(
          (m) =>
            m.conversationId === id && (m.status === 'running' || m.delivery?.state === 'queued'),
        );
  }
  const working = conversationWorking(workspaceState.selected);
  const timelineWorking = threadWorking(
    working,
    workspaceState.selected,
    thread.all,
    workspaceState.data?.runningRequests,
    threadRootId,
  );
  const stopState = useRef({
    selected: workspaceState.selected,
    working: timelineWorking,
    threadRootId,
    requests: workspaceState.data?.runningRequests,
    userId: currentUserId,
    owner: canManage,
    busy: workspaceState.busy,
  });
  stopState.current = {
    selected: workspaceState.selected,
    working: timelineWorking,
    threadRootId,
    requests: workspaceState.data?.runningRequests,
    userId: currentUserId,
    owner: canManage,
    busy: workspaceState.busy,
  };
  const stopping = useRef(false);
  const canStop =
    working &&
    canStopConversation(workspaceState.data?.runningRequests, workspaceState.selected, {
      userId: currentUserId,
      isOwner: canManage,
    });
  const dictationScope = `${navigationScope}:${composerKey}:${currentComposer.agentId || conversation?.agentIds[0] || ''}`;
  const dictationScopeRef = useRef(dictationScope);
  dictationScopeRef.current = dictationScope;
  const compositionRef = useRef(false);
  const selectionRef = useRef({
    conversationId: workspaceState.selected,
    start: 0,
    end: 0,
    version: 0,
  });
  const pendingDictation = useRef<{ capture: DictationCapture; text: string } | null>(null);

  const dictation = useDictation({
    scope: dictationScope,
    enabled: !!conversation && !workspaceState.modal && (!mobileHome || workspaceState.mobileChat),
    onInvalidate: () => {
      pendingDictation.current = null;
      compositionRef.current = false;
    },
    onTranscript: (capture, text) => {
      if (compositionRef.current) {
        pendingDictation.current = { capture, text };
        return uiText('workspace:text_6e4d07863d5b');
      }
      insertDictation(capture, text);
      return uiText('workspace:text_c0348872bf3c');
    },
  });
  workspaceState.routineChatInput.current.dictationBusy = dictation.busy;
  const voice = useWorkspaceVoice({
    ...sendIdentity.current,
    conversationId: workspaceState.selected,
    agentId: currentComposer.agentId || conversation?.agentIds[0],
    enabled: !!conversation && !workspaceState.modal && (!mobileHome || workspaceState.mobileChat),
    blocked: dictation.busy,
  });
  useEffect(() => {
    voice.stop();
  }, [threadRootId]);

  const currentWorkerId =
    [...messages].reverse().find((m) => m.status === 'running' && m.agentId)?.agentId ||
    [...messages].reverse().find((m) => m.delivery?.state === 'queued')?.delivery?.agentId;
  const currentWorker = workspaceState.data?.agents.find((a) => a.id === currentWorkerId) || lead;
  const routines =
      workspaceState.data?.routines.filter(
        (r) => r.conversationId === conversation?.id && conversation.agentIds.includes(r.agentId),
      ) || [],
    memories =
      workspaceState.data?.memories.filter((m) => conversation?.agentIds.includes(m.agentId)) || [];
  const skills =
      workspaceState.data?.skills.filter((s) => conversation?.agentIds.includes(s.agentId)) || [],
    files =
      workspaceState.data?.files.filter(
        (f) => !f.conversationId || f.conversationId === workspaceState.selected,
      ) || [];

  const {
    showChat,
    toggleDetails,
    showConversationList,
    openConversation,
    jumpToMessage,
    beginReply,
    openThread,
    closeThread,
  } = createChatNavigation(readActionContext);

  const { upsertMessage, reactToMessage, settleAttempt, reconcileReceipts, submitAttempt, send } =
    createMessageActions(readActionContext);

  const primary = workspaceState.data
    ? primaryConversation(workspaceState.data, workspaceState.data.primaryBot)
    : undefined;
  const personalSpace = account?.session.workspaces.find(
    (workspace) => workspace.kind === 'personal' && workspace.status === 'active',
  );
  const sidebar = workspaceState.data
    ? projectSidebar(workspaceState.data, workspaceState.search, mobileHome)
    : undefined;
  const currentRosterEntry = conversation
    ? conversationRosterEntry(conversation, workspaceState.data?.sidebarRoster)
    : undefined;
  const rosterLocked = !roster.state || roster.busy || roster.needsSync;

  const actionContext = {
    api,
    ...workspaceState,
    sendScope,
    currentUserId,
    personalSpace,
    receipts,
    dictation,
    pendingDictation,
    account,
    sync,
    openConversation,
    refresh,
    canManage,
    selectedComputerAgentId,
    conversation,
    navigationScope,
    sendIdentity,
    compositionRef,
    updateComposer,
    userName,
    setReceiptCount,
    currentComposer,
    composerKey,
    composerKeyRef,
    threadRootId,
    setOpenThread: thread.setOpenThread,
    selectionRef,
    dictationScopeRef,
    sharedUnavailable,
    dictationScope,
    stopState,
    stopping,
    roster,
  };
  useWorkspaceEffects({
    workspaceState,
    navigationScope,
    mobileHome,
    sendScope,
    shortcutActions,
    jumpToMessage,
    messages,
    selectionKey,
    composerKey,
  });
  return {
    voice,
    ...workspaceState,
    ...actionContext,
    mobileHome,
    openSettings,
    openApps,
    openAppProposal,
    online,
    connectionLabel,
    openSearch,
    openCreate,
    sidebar,
    primary,
    conversationWorking,
    openRoster,
    openPrimary,
    showConversationList,
    toggleDetails,
    members,
    lead,
    working,
    timelineWorking,
    threadRoot: thread.root,
    threadReplies: thread.replies,
    openThread,
    closeThread,
    currentRosterEntry,
    openComputer,
    rosterLocked,
    changeRoster,
    messages,
    setDraft,
    ownMessage,
    appearance,
    jumpToMessage,
    openTemplates,
    navigateTemplatePage,
    acceptConfirmedTeam,
    copy,
    beginReply,
    reactToMessage,
    currentWorker,
    replyTo,
    submitAttempt,
    deliveryMode,
    attachments,
    setAttachments,
    send,
    draft,
    rememberSelection,
    insertDictation,
    pasteFiles,
    toggleDictation,
    canStop,
    stopCurrentTask,
    upload,
    sidebarComputer,
    selectedComputerAgent,
    routines,
    action,
    memories,
    skills,
    files,
    showChat,
    openMemoryImport,
    activeAgent,
    openSharedConversation,
    formAction,
    openRoutineOperation,
    openRoutineRun,
    openRoutineChat,
    enterFiles,
    leaveFiles,
    dropFiles,
    hasFiles,
    loadError,
  };
}
