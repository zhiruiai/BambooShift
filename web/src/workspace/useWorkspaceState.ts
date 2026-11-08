import type { CustomAppProposalEntry } from '../appProposalEntry';
import { useRef, useState } from 'react';
import type { Bootstrap, WorkspaceFile } from '../../../shared/types';
import { emptyComposer, type ComposerState, type SendAttempt } from '../chatDrafts';
import type { BotProfileDraft } from '../botProfiles';
import { type BotTemplateDialogRequest } from '../components/BotTemplateDialog';
import { type PrimaryBotMode } from '../components/PrimaryBotDialog';
import { type RosterDialogRequest } from '../components/SidebarRoster';
import { createMobileNavigation } from '../mobileNavigation';
import { type RoutineChatRequest } from '../routineChat';
import type { ConfirmedSharedBot } from '../sharedBots';
import type { PackagedSkillDraft } from '../skillWorkflowTemplates';
import type { DetailTab, Modal } from './types';
export function useWorkspaceState({
  selectionKey,
  canManage,
}: {
  selectionKey: string;
  canManage: boolean;
}) {
  const initialMessageLink = useRef(
    (() => {
      const query = new URLSearchParams(window.location.search);
      const conversationId = query.get('conversation'),
        messageId = query.get('message');
      return conversationId && messageId ? { conversationId, messageId } : null;
    })(),
  );
  const [data, setData] = useState<Bootstrap | null>(null),
    [selected, setSelected] = useState(() => {
      const linked = new URLSearchParams(window.location.search).get('conversation');
      if (linked) return linked;
      try {
        return localStorage.getItem(selectionKey) || '';
      } catch {
        return '';
      }
    });
  const [search, setSearch] = useState(''),
    [modal, setModal] = useState<Modal>(null),
    [detailTab, setDetailTab] = useState<DetailTab>('details');
  const [primaryMode, setPrimaryMode] = useState<PrimaryBotMode>();
  const [sharedNavigation, setSharedNavigation] = useState<ConfirmedSharedBot>();
  const [templateNavigation, setTemplateNavigation] = useState<string>();
  const [templateDialog, setTemplateDialog] = useState<BotTemplateDialogRequest>({
    kind: 'library',
  });
  const [rosterDialog, setRosterDialog] = useState<RosterDialogRequest>({ kind: 'hidden' });
  const selectionInitialized = useRef(false),
    initialExplicitSelection = useRef(
      !!new URLSearchParams(window.location.search).get('conversation'),
    );
  const [appsShareId, setAppsShareId] = useState<string>();
  const [appsProviderId, setAppsProviderId] = useState<string>();
  const [appsCustomProposal, setAppsCustomProposal] = useState<CustomAppProposalEntry>();
  const [settingsInitialView, setSettingsInitialView] = useState<'general' | 'models'>('general');
  const [showDetail, setShowDetail] = useState(() => window.innerWidth > 1150),
    [mobileChat, setMobileChat] = useState(
      () => !!new URLSearchParams(window.location.search).get('conversation'),
    ),
    [toast, setToast] = useState(''),
    [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false),
    [unreadBelow, setUnreadBelow] = useState(false);
  const [teamPlanToOpen, setTeamPlanToOpen] = useState<string>();
  const [createMode, setCreateMode] = useState<'bot' | 'group' | 'team'>();
  const [createProfile, setCreateProfile] = useState<BotProfileDraft>();
  const [skillsAgentId, setSkillsAgentId] = useState<string>();
  const [packagedSkillDraft, setPackagedSkillDraft] = useState<
    PackagedSkillDraft & { scope: string }
  >();
  const [routineToEdit, setRoutineToEditState] = useState<string | null>(null);
  const [routineInitialAction, setRoutineInitialAction] = useState<'view' | 'edit' | 'delete'>(
    'view',
  );
  function setRoutineToEdit(id: string | null) {
    setRoutineToEditState(id);
    setRoutineInitialAction('view');
  }
  const [routineChatPending, setRoutineChatPending] = useState<{
    request: RoutineChatRequest;
    draft: ComposerState;
    agentName: string;
  }>();
  const [routineChatError, setRoutineChatError] = useState('');
  const [routineChatBusy, setRoutineChatBusy] = useState(false);
  const routineChatOpening = useRef(false);
  const routineChatFocus = useRef<string | undefined>(undefined);
  const routineChatInput = useRef({ dictationBusy: false });
  const [computerPanel, setComputerPanel] = useState<'screen' | 'files'>('screen');
  const [computerAgentId, setComputerAgentId] = useState<string>();
  const [computerConversation, setComputerConversation] = useState({
    id: '',
    title: '',
    scope: '',
  });
  const [conversationScreens, setConversationScreens] = useState<Record<string, string>>({});
  const [transferFile, setTransferFile] = useState<{
    file: WorkspaceFile;
    conversationId: string;
    conversationTitle: string;
  } | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileDragDepth = useRef(0);
  const [composers, setComposers] = useState<Record<string, ComposerState>>({}),
    [sending, setSending] = useState<Set<string>>(new Set()),
    [uploading, setUploading] = useState<Set<string>>(new Set());
  const composersRef = useRef(composers);
  composersRef.current = composers;
  const canManageRef = useRef(canManage);
  canManageRef.current = canManage;
  const [sendErrors, setSendErrors] = useState<
    Record<string, { message: string; attempt: SendAttempt; uncertain: boolean }>
  >({});
  const [reactionPicker, setReactionPicker] = useState<string | null>(null),
    [reactionPending, setReactionPending] = useState<Set<string>>(new Set());
  const [searchScope, setSearchScope] = useState<'all' | 'current'>('all'),
    [pendingJump, setPendingJump] = useState<{
      conversationId: string;
      messageId: string;
      token: number;
    } | null>(null),
    [highlightedMessage, setHighlightedMessage] = useState('');
  const emptyDraft = useRef(emptyComposer()),
    attempts = useRef(new Map<string, SendAttempt>()),
    sendingRef = useRef(new Set<string>()),
    uploadingRef = useRef(new Set<string>()),
    reactionRef = useRef(new Set<string>()),
    jumpRef = useRef<{ conversationId: string; messageId: string } | null>(
      initialMessageLink.current,
    );
  const selectedRef = useRef(selected),
    modalRef = useRef(modal);
  selectedRef.current = selected;
  modalRef.current = modal;
  const mobileNavigation = useRef<ReturnType<typeof createMobileNavigation> | null>(null);
  const mobileNavigationScope = useRef('');
  const navigationLatest = useRef({ data, selected, mobileChat });
  navigationLatest.current = { data, selected, mobileChat };
  const [inspected, setInspected] = useState<string>('');
  const [clockNow, setClockNow] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null),
    fileRef = useRef<HTMLInputElement>(null),
    composerRef = useRef<HTMLTextAreaElement>(null),
    nearBottom = useRef(true);
  return {
    initialMessageLink,
    data,
    setData,
    selected,
    setSelected,
    search,
    setSearch,
    modal,
    setModal,
    detailTab,
    setDetailTab,
    primaryMode,
    setPrimaryMode,
    sharedNavigation,
    setSharedNavigation,
    templateNavigation,
    setTemplateNavigation,
    templateDialog,
    setTemplateDialog,
    rosterDialog,
    setRosterDialog,
    selectionInitialized,
    initialExplicitSelection,
    appsShareId,
    setAppsShareId,
    appsProviderId,
    setAppsProviderId,
    appsCustomProposal,
    setAppsCustomProposal,
    settingsInitialView,
    setSettingsInitialView,
    showDetail,
    setShowDetail,
    mobileChat,
    setMobileChat,
    toast,
    setToast,
    busy,
    setBusy,
    menuOpen,
    setMenuOpen,
    unreadBelow,
    setUnreadBelow,
    teamPlanToOpen,
    setTeamPlanToOpen,
    createMode,
    setCreateMode,
    createProfile,
    setCreateProfile,
    skillsAgentId,
    setSkillsAgentId,
    packagedSkillDraft,
    setPackagedSkillDraft,
    routineToEdit,
    setRoutineToEdit,
    routineInitialAction,
    setRoutineInitialAction,
    routineChatPending,
    setRoutineChatPending,
    routineChatError,
    setRoutineChatError,
    routineChatBusy,
    setRoutineChatBusy,
    routineChatOpening,
    routineChatFocus,
    routineChatInput,
    computerPanel,
    setComputerPanel,
    computerAgentId,
    setComputerAgentId,
    computerConversation,
    setComputerConversation,
    conversationScreens,
    setConversationScreens,
    transferFile,
    setTransferFile,
    draggingFiles,
    setDraggingFiles,
    fileDragDepth,
    composers,
    setComposers,
    sending,
    setSending,
    uploading,
    setUploading,
    composersRef,
    canManageRef,
    sendErrors,
    setSendErrors,
    reactionPicker,
    setReactionPicker,
    reactionPending,
    setReactionPending,
    searchScope,
    setSearchScope,
    pendingJump,
    setPendingJump,
    highlightedMessage,
    setHighlightedMessage,
    emptyDraft,
    attempts,
    sendingRef,
    uploadingRef,
    reactionRef,
    jumpRef,
    selectedRef,
    modalRef,
    mobileNavigation,
    mobileNavigationScope,
    navigationLatest,
    inspected,
    setInspected,
    clockNow,
    setClockNow,
    scrollRef,
    fileRef,
    composerRef,
    nearBottom,
  };
}
