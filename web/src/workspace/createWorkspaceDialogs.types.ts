import type { CustomAppProposalEntry } from '../appProposalEntry';
import type { Bootstrap, Conversation, Message } from '../../../shared/types';
import { type ComposerState, type SendAttempt } from '../chatDrafts';
import { type BotTemplateDialogRequest } from '../components/BotTemplateDialog';
import { type PrimaryBotMode } from '../components/PrimaryBotDialog';
import { type RosterDialogRequest } from '../components/SidebarRoster';
import { type DictationCapture } from '../dictation';
import type { ConfirmedSharedBot } from '../sharedBots';
import type { Modal } from './types';
export interface WorkspaceDialogsContext {
  sendScope: {
    current: (ticket: number) => boolean;
    ticket: () => number;
    resume(): void;
    suspend(): void;
    request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  };
  currentUserId: string | undefined;
  personalSpace: import('../../../shared/platform').WorkspaceSummary | undefined;
  receipts: {
    readonly persistent: boolean;
    prepare(attempt: SendAttempt): Promise<SendAttempt>;
    reject(attempt: SendAttempt): void;
    confirm(message: Message): SendAttempt | undefined;
    wasConfirmed(attempt: SendAttempt): boolean;
    pending(conversationId?: string): number;
  };
  sendingRef: import('react').RefObject<Set<string>>;
  uploadingRef: import('react').RefObject<Set<string>>;
  dictation: {
    state: import('../dictation').DictationState;
    readonly busy: boolean;
    start(capture: DictationCapture): void;
    finish: () => undefined;
    cancel: () => void;
    dismiss: () => void;
    retryStatus: () => void;
  };
  pendingDictation: import('react').RefObject<{ capture: DictationCapture; text: string } | null>;
  composers: Record<string, ComposerState>;
  account: {
    session: import('../../../shared/platform').AccountSession;
    workspace: import('../../../shared/platform').WorkspaceSummary;
  } | null;
  setSharedNavigation: import('react').Dispatch<
    import('react').SetStateAction<ConfirmedSharedBot | undefined>
  >;
  sync: {
    refresh: () => Promise<void>;
    written: () => void | undefined;
    phase: 'connecting' | 'syncing' | 'online' | 'offline';
    error: string;
  };
  setData: import('react').Dispatch<import('react').SetStateAction<Bootstrap | null>>;
  openConversation: (c: Conversation) => void;
  setModal: import('react').Dispatch<import('react').SetStateAction<Modal>>;
  modal: Modal;
  refresh: () => Promise<void>;
  uploading: Set<string>;
  setTemplateNavigation: import('react').Dispatch<
    import('react').SetStateAction<string | undefined>
  >;
  data: Bootstrap | null;
  setToast: import('react').Dispatch<import('react').SetStateAction<string>>;
  setTemplateDialog: import('react').Dispatch<
    import('react').SetStateAction<BotTemplateDialogRequest>
  >;
  setRosterDialog: import('react').Dispatch<import('react').SetStateAction<RosterDialogRequest>>;
  setMenuOpen: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setSettingsInitialView: import('react').Dispatch<
    import('react').SetStateAction<'general' | 'models'>
  >;
  canManage: boolean;
  setAppsCustomProposal: import('react').Dispatch<
    import('react').SetStateAction<CustomAppProposalEntry | undefined>
  >;
  setAppsProviderId: import('react').Dispatch<import('react').SetStateAction<string | undefined>>;
  setAppsShareId: import('react').Dispatch<import('react').SetStateAction<string | undefined>>;
  setPrimaryMode: import('react').Dispatch<
    import('react').SetStateAction<PrimaryBotMode | undefined>
  >;
  setTeamPlanToOpen: import('react').Dispatch<import('react').SetStateAction<string | undefined>>;
  setCreateMode: import('react').Dispatch<
    import('react').SetStateAction<'team' | 'group' | 'bot' | undefined>
  >;
  setCreateProfile: import('react').Dispatch<
    import('react').SetStateAction<import('../botProfiles').BotProfileDraft | undefined>
  >;
  selectedComputerAgentId: string | undefined;
  setComputerAgentId: import('react').Dispatch<import('react').SetStateAction<string | undefined>>;
  setComputerConversation: import('react').Dispatch<
    import('react').SetStateAction<{ id: string; title: string; scope: string }>
  >;
  selected: string;
  conversation: Conversation | undefined;
  navigationScope: string;
  setComputerPanel: import('react').Dispatch<import('react').SetStateAction<'screen' | 'files'>>;
  setSearchScope: import('react').Dispatch<import('react').SetStateAction<'all' | 'current'>>;
}
