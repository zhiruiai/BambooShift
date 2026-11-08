import type { BotTeamDraft, BotTeamPlan, CommitBotTeamPlan } from '../../../../shared/bot-team-plans';
import { type CatalogPreview, type CatalogRequest } from '../../teamCatalogReview';
import '../SmartTeamPanel.css';
import type { SmartTeamProps as Props } from './types';
export interface TeamCatalogReviewContext {
  catalogSequence: import('react').RefObject<number>;
  catalogPreviewRef: import('react').RefObject<CatalogPreview | undefined>;
  setCatalogPreview: import('react').Dispatch<
    import('react').SetStateAction<CatalogPreview | undefined>
  >;
  setCatalogLoading: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  storageKey: string;
  catalogRequestRef: import('react').RefObject<CatalogRequest | undefined>;
  setCatalogRequest: import('react').Dispatch<
    import('react').SetStateAction<CatalogRequest | undefined>
  >;
  latest: import('react').RefObject<{
    props: Props;
    plan: BotTeamPlan | undefined;
    draft: BotTeamDraft | undefined;
    goal: string;
  }>;
  setCatalogSavedPlan: import('react').Dispatch<
    import('react').SetStateAction<BotTeamPlan | undefined>
  >;
  commitRequest: import('react').RefObject<CommitBotTeamPlan | undefined>;
  uncertainRef: import('react').RefObject<boolean>;
  setUncertain: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  requestedPlan: import('react').RefObject<string | undefined>;
  setOpening: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setShowHistory: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  accept: (value: BotTeamPlan, replace?: boolean, keepNewMemberDrafts?: boolean) => void;
  setError: import('react').Dispatch<import('react').SetStateAction<string>>;
  setNotice: import('react').Dispatch<import('react').SetStateAction<string>>;
  setPlan: import('react').Dispatch<import('react').SetStateAction<BotTeamPlan | undefined>>;
  scope: {
    ticket: () => number;
    current: (ticket: number) => boolean;
    resume(): void;
    suspend(): void;
    request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  };
  running: import('react').RefObject<boolean>;
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
  sequence: import('react').RefObject<number>;
  setBusy: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setLoading: import('react').Dispatch<import('react').SetStateAction<boolean>>;
}
