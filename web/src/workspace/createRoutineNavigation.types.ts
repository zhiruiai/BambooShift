import type { Conversation, Message } from '../../../shared/types';
import { type ComposerState, type SendAttempt } from '../chatDrafts';
import { type DictationCapture } from '../dictation';
import { type RoutineChatRequest } from '../routineChat';
import type { Modal } from './types';
export interface RoutineNavigationContext {
  sendScope: {
    current: (ticket: number) => boolean;
    ticket: () => number;
    resume(): void;
    suspend(): void;
    request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  };
  currentUserId: string | undefined;
  sendIdentity: import('react').RefObject<{
    workspaceId: string | undefined;
    userId: string | undefined;
  }>;
  sync: {
    refresh: () => Promise<void>;
    written: () => void | undefined;
    phase: 'connecting' | 'syncing' | 'online' | 'offline';
    error: string;
  };
  refresh: () => Promise<void>;
  openConversation: (c: Conversation) => void;
  setModal: import('react').Dispatch<import('react').SetStateAction<Modal>>;
  jumpRef: import('react').RefObject<{ conversationId: string; messageId: string } | null>;
  setPendingJump: import('react').Dispatch<
    import('react').SetStateAction<{
      conversationId: string;
      messageId: string;
      token: number;
    } | null>
  >;
  nearBottom: import('react').RefObject<boolean>;
  setToast: import('react').Dispatch<import('react').SetStateAction<string>>;
  canManageRef: import('react').RefObject<boolean>;
  sendingRef: import('react').RefObject<Set<string>>;
  uploadingRef: import('react').RefObject<Set<string>>;
  receipts: {
    readonly persistent: boolean;
    prepare(attempt: SendAttempt): Promise<SendAttempt>;
    reject(attempt: SendAttempt): void;
    confirm(message: Message): SendAttempt | undefined;
    wasConfirmed(attempt: SendAttempt): boolean;
    pending(conversationId?: string): number;
  };
  routineChatInput: import('react').RefObject<{ dictationBusy: boolean }>;
  compositionRef: import('react').RefObject<boolean>;
  pendingDictation: import('react').RefObject<{ capture: DictationCapture; text: string } | null>;
  routineChatOpening: import('react').RefObject<boolean>;
  composersRef: import('react').RefObject<Record<string, ComposerState>>;
  emptyDraft: import('react').RefObject<ComposerState>;
  setRoutineChatBusy: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setRoutineChatError: import('react').Dispatch<import('react').SetStateAction<string>>;
  setRoutineChatPending: import('react').Dispatch<
    import('react').SetStateAction<
      { request: RoutineChatRequest; draft: ComposerState; agentName: string } | undefined
    >
  >;
  updateComposer: (
    conversationId: string,
    update: (previous: ComposerState) => ComposerState,
  ) => void;
  routineChatFocus: import('react').RefObject<string | undefined>;
}
