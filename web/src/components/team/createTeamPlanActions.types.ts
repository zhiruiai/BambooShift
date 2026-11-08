import type {
  BotTeamDraft,
  BotTeamPlan,
  CommitBotTeamPlan,
  CreateBotTeamPlan,
  NewTeamMember,
} from '../../../../shared/bot-team-plans';
import { type CatalogRequest } from '../../teamCatalogReview';
import '../SmartTeamPanel.css';
import type { SmartTeamProps as Props } from './types';
export interface TeamPlanActionsContext {
  invalidateCatalogPreview: () => void;
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
  newMemberDrafts: import('react').RefObject<Map<string, NewTeamMember>>;
  setPlan: import('react').Dispatch<import('react').SetStateAction<BotTeamPlan | undefined>>;
  latest: import('react').RefObject<{
    props: Props;
    plan: BotTeamPlan | undefined;
    draft: BotTeamDraft | undefined;
    goal: string;
  }>;
  setGoal: import('react').Dispatch<import('react').SetStateAction<string>>;
  setDraft: import('react').Dispatch<import('react').SetStateAction<BotTeamDraft | undefined>>;
  draftRevision: import('react').RefObject<string | undefined>;
  setError: import('react').Dispatch<import('react').SetStateAction<string>>;
  running: import('react').RefObject<boolean>;
  scope: {
    ticket: () => number;
    current: (ticket: number) => boolean;
    resume(): void;
    suspend(): void;
    request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  };
  sequence: import('react').RefObject<number>;
  setLoading: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  catalogRequestRef: import('react').RefObject<CatalogRequest | undefined>;
  checkCatalogRequest: () => Promise<void>;
  requestedPlan: import('react').RefObject<string | undefined>;
  setOpening: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setShowHistory: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  startRequest: import('react').RefObject<CreateBotTeamPlan | undefined>;
  setHistory: import('react').Dispatch<import('react').SetStateAction<BotTeamPlan[]>>;
  uncertainRef: import('react').RefObject<boolean>;
  setUncertain: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  commitRequest: import('react').RefObject<CommitBotTeamPlan | undefined>;
  setBusy: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  setNotice: import('react').Dispatch<import('react').SetStateAction<string>>;
  locked: boolean;
  entered: import('react').RefObject<boolean>;
  dirty: boolean;
  goalChanged: boolean;
  setDiscard: import('react').Dispatch<import('react').SetStateAction<(() => void) | null>>;
}
