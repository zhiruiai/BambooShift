import type { BotAgent } from './types.js';
import type { SharedBotReference } from './shared-bots.js';

export interface ReusedTeamMember {
  key: string;
  kind: 'reuse';
  agentId: string;
  assignment: string;
}
export interface NewTeamMember {
  key: string;
  kind: 'create';
  name: string;
  role: string;
  description: string;
  instructions: string;
  color: string;
  avatar: BotAgent['avatar'];
  avatarImageId?: string | null;
  assignment: string;
}
export interface BotTeamDraft {
  title: string;
  summary: string;
  leadKey: string;
  members: Array<ReusedTeamMember | NewTeamMember>;
}
export interface BotTeamResult {
  conversationId: string;
  createdAgentIds: string[];
  memberAgentIds: string[];
  leadAgentId: string;
}
export interface BotTeamPlanSource {
  kind: 'conversation';
  conversationId: string;
  agentId: string;
  messageId: string;
  userId?: string;
}
/** Safe chat projection. Bot instructions and runtime identifiers stay private. */
export interface BotTeamProposalCard {
  planId: string;
  revision: string;
  status: BotTeamPlan['status'];
  goal: string;
  title: string;
  summary: string;
  leadKey: string;
  members: Array<{
    key: string;
    kind: 'reuse' | 'create';
    agentId?: string;
    name: string;
    role: string;
    assignment: string;
  }>;
  result?: BotTeamResult;
  error?: string;
}
export interface BotTeamPlan {
  id: string;
  requestId: string;
  revision: string;
  goal: string;
  status: 'generating' | 'ready' | 'error' | 'cancelled' | 'committed';
  draft?: BotTeamDraft;
  error?: string;
  result?: BotTeamResult;
  source?: BotTeamPlanSource;
  createdAt: string;
  updatedAt: string;
}
export interface CreateBotTeamPlan {
  requestId: string;
  goal: string;
  template?: { id: string; language: 'zh-CN' | 'en' };
}
export interface CommitBotTeamPlan {
  requestId: string;
  expectedRevision: string;
  draft: BotTeamDraft;
}
export interface ReviseBotTeamPlan {
  expectedRevision: string;
  draft: BotTeamDraft;
}

export interface ReviewBotTeamCatalog {
  expectedRevision: string;
  draft: BotTeamDraft;
}
export interface BotTeamCatalogMember {
  key: string;
  agentId: string;
  version: string;
  state: 'unchanged' | 'changed' | 'added';
  profile: Pick<
    BotAgent,
    'name' | 'role' | 'description' | 'instructions' | 'avatar' | 'color' | 'avatarImageId'
  > & {
    /** Public reference metadata for the exact reviewed source avatar, never a source capability. */
    sharedBot?: Pick<
      SharedBotReference,
      | 'shareId'
      | 'sourceRevision'
      | 'ownerName'
      | 'sourceWorkspaceName'
      | 'teamName'
      | 'status'
      | 'avatarPath'
    >;
  };
}
export interface BotTeamCatalogReview {
  planId: string;
  expectedRevision: string;
  reviewToken: string;
  draftDigest: string;
  members: BotTeamCatalogMember[];
}
export interface RefreshBotTeamCatalog extends ReviewBotTeamCatalog {
  requestId: string;
  reviewToken: string;
}
export interface BotTeamCatalogRefreshResult {
  requestId: string;
  planId: string;
  appliedRevision: string;
  /** Current authoritative plan; it may have changed since this request was applied. */
  plan: BotTeamPlan;
}

export {
  GROUP_MIN_MEMBERS as BOT_TEAM_MIN_MEMBERS,
  GROUP_MAX_MEMBERS as BOT_TEAM_MAX_MEMBERS,
} from './group-members.js';
