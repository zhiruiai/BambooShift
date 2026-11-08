export interface WorkspaceActionsContext {
  setBusy: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  sync: {
    refresh: () => Promise<void>;
    written: () => void | undefined;
    phase: 'connecting' | 'syncing' | 'online' | 'offline';
    error: string;
  };
  setToast: import('react').Dispatch<import('react').SetStateAction<string>>;
  sendScope: {
    current: (ticket: number) => boolean;
    ticket: () => number;
    resume(): void;
    suspend(): void;
    request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  };
  selected: string;
  composerKey?: string;
  threadRootId?: string;
  stopState: import('react').RefObject<{
    selected: string;
    working: boolean;
    threadRootId?: string;
    requests:
      | { conversationId: string; requester?: import('../../../shared/approvals').ActionRequester }[]
      | undefined;
    userId: string | undefined;
    owner: boolean;
    busy: boolean;
  }>;
  stopping: import('react').RefObject<boolean>;
  setMenuOpen: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  roster: import('../useSidebarRoster').SidebarRosterController;
}
