import type { Conversation } from '../../../shared/types';
import { type ComposerState, type SendAttempt } from '../chatDrafts';
import { type DictationCapture } from '../dictation';
import type { Modal } from './types';
export interface ComposerActionsContext {
  sendScope: ReturnType<typeof import('../chatSendScope').createChatSendScope>;
  api: import('../fixedWorkspaceApi').FixedWorkspaceApi;
  setComposers: import('react').Dispatch<
    import('react').SetStateAction<Record<string, ComposerState>>
  >;
  emptyDraft: import('react').RefObject<ComposerState>;
  attempts: import('react').RefObject<Map<string, SendAttempt>>;
  selected: string;
  composerKey?: string;
  composerRef: import('react').RefObject<HTMLTextAreaElement | null>;
  selectionRef: import('react').RefObject<{
    conversationId: string;
    start: number;
    end: number;
    version: number;
  }>;
  dictationScopeRef: import('react').RefObject<string>;
  compositionRef: import('react').RefObject<boolean>;
  pendingDictation: import('react').RefObject<{ capture: DictationCapture; text: string } | null>;
  dictation: {
    state: import('../dictation').DictationState;
    readonly busy: boolean;
    start(capture: DictationCapture): void;
    finish: () => undefined;
    cancel: () => void;
    dismiss: () => void;
    retryStatus: () => void;
  };
  conversation: Conversation | undefined;
  sharedUnavailable: boolean;
  sendingRef: import('react').RefObject<Set<string>>;
  uploadingRef: import('react').RefObject<Set<string>>;
  dictationScope: string;
  currentUserId: string | undefined;
  currentComposer: ComposerState;
  modal: Modal;
  fileDragDepth: import('react').RefObject<number>;
  setDraggingFiles: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setToast: import('react').Dispatch<import('react').SetStateAction<string>>;
  fileRef: import('react').RefObject<HTMLInputElement | null>;
  setUploading: import('react').Dispatch<import('react').SetStateAction<Set<string>>>;
  refresh: () => Promise<void>;
}
