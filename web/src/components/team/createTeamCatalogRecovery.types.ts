import type {
  BotTeamCatalogRefreshResult,
  BotTeamDraft,
  BotTeamPlan,
  CommitBotTeamPlan,
} from '../../../../shared/bot-team-plans';
import { type CatalogRequest } from '../../teamCatalogReview';
import '../SmartTeamPanel.css';
import type { SmartTeamProps as Props } from './types';
export interface TeamCatalogRecoveryContext {
  catalogRequestRef: import('react').RefObject<CatalogRequest | undefined>;
  scope: {
    ticket: () => number;
    current: (ticket: number) => boolean;
    resume(): void;
    suspend(): void;
    request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  };
  running: import('react').RefObject<boolean>;
  latest: import('react').RefObject<{
    props: Props;
    plan: BotTeamPlan | undefined;
    draft: BotTeamDraft | undefined;
    goal: string;
  }>;
  setBusy: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setError: import('react').Dispatch<import('react').SetStateAction<string>>;
  finishCatalog: (result: BotTeamCatalogRefreshResult, pending: CatalogRequest) => void;
  setCatalogSavedPlan: import('react').Dispatch<
    import('react').SetStateAction<BotTeamPlan | undefined>
  >;
  accept: (value: BotTeamPlan, replace?: boolean, keepNewMemberDrafts?: boolean) => void;
  requestedPlan: import('react').RefObject<string | undefined>;
  setOpening: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setShowHistory: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setLoading: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  catalogSavedPlan: BotTeamPlan | undefined;
  avatarEdits: {
    current: () => { pending: boolean; busy: boolean; changed: boolean };
    resetKey: number;
    markChanged(): void;
    reset(): void;
    set(key: string, value: import('../../avatarImages').AvatarEditActivity): void;
    pending: boolean;
    busy: boolean;
    changed: boolean;
  };
  retainCatalogRequest: (value?: CatalogRequest) => void;
  commitRequest: import('react').RefObject<CommitBotTeamPlan | undefined>;
  uncertainRef: import('react').RefObject<boolean>;
  setUncertain: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  invalidateCatalogPreview: () => void;
  setPlan: import('react').Dispatch<import('react').SetStateAction<BotTeamPlan | undefined>>;
  draftRevision: import('react').RefObject<string | undefined>;
  setNotice: import('react').Dispatch<import('react').SetStateAction<string>>;
}
