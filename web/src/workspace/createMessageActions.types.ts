import type { Bootstrap, Conversation, Message } from '../../../shared/types';
import { type ComposerState, type SendAttempt } from '../chatDrafts';
import { type DictationCapture } from '../dictation';
import type { Modal } from './types';
export interface MessageActionsContext {
  api: import('../fixedWorkspaceApi').FixedWorkspaceApi;
  setData: import('react').Dispatch<import('react').SetStateAction<Bootstrap | null>>;
  reactionRef: import('react').RefObject<Set<string>>;
  setReactionPending: import('react').Dispatch<import('react').SetStateAction<Set<string>>>;
  sync: {
    refresh: () => Promise<void>;
    written: () => void | undefined;
    phase: 'connecting' | 'syncing' | 'online' | 'offline';
    error: string;
  };
  setReactionPicker: import('react').Dispatch<import('react').SetStateAction<string | null>>;
  refresh: () => Promise<void>;
  setToast: import('react').Dispatch<import('react').SetStateAction<string>>;
  attempts: import('react').RefObject<Map<string, SendAttempt>>;
  setSendErrors: import('react').Dispatch<
    import('react').SetStateAction<
      Record<string, { message: string; attempt: SendAttempt; uncertain: boolean }>
    >
  >;
  setComposers: import('react').Dispatch<
    import('react').SetStateAction<Record<string, ComposerState>>
  >;
  selectedRef: import('react').RefObject<string>;
  nearBottom: import('react').RefObject<boolean>;
  jumpRef: import('react').RefObject<{ conversationId: string; messageId: string } | null>;
  setPendingJump: import('react').Dispatch<
    import('react').SetStateAction<{
      conversationId: string;
      messageId: string;
      token: number;
    } | null>
  >;
  setHighlightedMessage: import('react').Dispatch<import('react').SetStateAction<string>>;
  receipts: {
    readonly persistent: boolean;
    prepare(attempt: SendAttempt): Promise<SendAttempt>;
    reject(attempt: SendAttempt): void;
    confirm(message: Message): SendAttempt | undefined;
    wasConfirmed(attempt: SendAttempt): boolean;
    pending(conversationId?: string, threadRootId?: string): number;
  };
  setReceiptCount: import('react').Dispatch<import('react').SetStateAction<number>>;
  sendScope: {
    current: (ticket: number) => boolean;
    ticket: () => number;
    resume(): void;
    suspend(): void;
    request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  };
  sendingRef: import('react').RefObject<Set<string>>;
  selected: string;
  composerKey?: string;
  composerKeyRef?: import('react').RefObject<string>;
  threadRootId?: string;
  dictation: {
    state: import('../dictation').DictationState;
    readonly busy: boolean;
    start(capture: DictationCapture): void;
    finish: () => undefined;
    cancel: () => void;
    dismiss: () => void;
    retryStatus: () => void;
  };
  setSending: import('react').Dispatch<import('react').SetStateAction<Set<string>>>;
  modalRef: import('react').RefObject<Modal>;
  composerRef: import('react').RefObject<HTMLTextAreaElement | null>;
  conversation: Conversation | undefined;
  compositionRef: import('react').RefObject<boolean>;
  pendingDictation: import('react').RefObject<{ capture: DictationCapture; text: string } | null>;
  uploadingRef: import('react').RefObject<Set<string>>;
  currentComposer: ComposerState;
}
