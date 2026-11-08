import type { Bootstrap, Message } from '../../../shared/types';
import { type ComposerState } from '../chatDrafts';
import { type MobilePage } from '../mobileNavigation';
import type { Modal } from './types';
export interface ChatNavigationContext {
  api: import('../fixedWorkspaceApi').FixedWorkspaceApi;
  mobileNavigation: import('react').RefObject<{
    activate(page: MobilePage): void;
    deactivate(): void;
    move: (page: MobilePage) => boolean;
    pop(): void;
  } | null>;
  setMobileChat: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  showDetail: boolean;
  selected: string;
  threadRootId?: string;
  setOpenThread?: (conversationId: string, rootId?: string) => void;
  setShowDetail: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  jumpRef: import('react').RefObject<{ conversationId: string; messageId: string } | null>;
  setPendingJump: import('react').Dispatch<
    import('react').SetStateAction<{
      conversationId: string;
      messageId: string;
      token: number;
    } | null>
  >;
  setHighlightedMessage: import('react').Dispatch<import('react').SetStateAction<string>>;
  selectedRef: import('react').RefObject<string>;
  setSelected: import('react').Dispatch<import('react').SetStateAction<string>>;
  setMenuOpen: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  data: Bootstrap | null;
  setToast: import('react').Dispatch<import('react').SetStateAction<string>>;
  nearBottom: import('react').RefObject<boolean>;
  setReactionPicker: import('react').Dispatch<import('react').SetStateAction<string | null>>;
  setModal: import('react').Dispatch<import('react').SetStateAction<Modal>>;
  userName: (message: Message) => string;
  updateComposer: (
    conversationId: string,
    update: (previous: ComposerState) => ComposerState,
  ) => void;
  composerRef: import('react').RefObject<HTMLTextAreaElement | null>;
}
