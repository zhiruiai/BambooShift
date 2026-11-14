import type { PrimaryBotState, PrimaryCheckInStatus } from './primary-bot.js';
import type { SidebarRosterState } from './sidebar-roster.js';
import type { SharedBotReference } from './shared-bots.js';
import type { WorkspaceTimeZoneState } from './workspace-time-zone.js';
import type { ChatAppContext, ConnectedApp } from './app-connections.js';

export type AgentStatus = 'idle' | 'working' | 'needs_input';
export interface BotAgent {
  id: string;
  name: string;
  role: string;
  description: string;
  color: string;
  avatar: 'orb' | 'drop' | 'leaf' | 'spark' | 'gem' | 'arch';
  /** Immutable workspace avatar asset; null explicitly restores the generated shape. */
  avatarImageId?: string | null;
  instructions: string;
  /** Workspace-local model choice; null or absent inherits the execution workspace default. */
  modelProfileId?: string | null;
  /** Read-only availability of this Bot's effective model in the current execution workspace. */
  modelConfigured?: boolean;
  status: AgentStatus;
  /** Server-issued configuration revision; older stored records are projected compatibly. */
  configRevision?: string;
  /** Managed definition; personal conversations and memory remain in this workspace. */
  sharedBot?: SharedBotReference;
}
export interface Conversation {
  id: string;
  title: string;
  agentIds: string[];
  isGroup: boolean;
  updatedAt: string;
  unread: number;
  /** Latest durable delivery observed in this snapshot; acknowledgements are actor scoped. */
  readThrough?: number;
  pinned: boolean;
  demo?: boolean;
  teamBrief?: {
    goal: string;
    summary: string;
    leadAgentId: string;
    assignments: Array<{ agentId: string; assignment: string }>;
  };
}
export interface VoiceMemo {
  transcript: string;
  durationMs: number;
}
export interface Message {
  id: string;
  conversationId: string;
  userId?: string;
  agentId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  kind?:
    | 'text'
    | 'computer'
    | 'file'
    | 'activity'
    | 'approval'
    | 'app_connection_proposal'
    | 'creation_preview'
    | 'question'
    | 'voice_call'
    | 'website_project'
    | 'web_research';
  status?: 'running' | 'done' | 'error';
  metadata?: Record<string, unknown>;
  appContext?: ChatAppContext;
  /** The exact approved skill version selected for this human message. */
  skillId?: string;
  mentions?: import('./chat-mentions').ResolvedChatMentions;
  threadRootId?: string;
  replyTo?: {
    id: string;
    agentId?: string;
    author: string;
    content: string;
    kind?: Message['kind'];
  };
  reactions?: string[];
  reactionMembers?: Record<string, string[]>;
  delivery?: {
    state: 'queued' | 'delivered' | 'cancelled' | 'interrupted';
    mode: 'steer' | 'followUp';
    agentId?: string;
    /** Validated explicit recipient of a human chat submission, separate from automatic routing. */
    explicitAgentId?: string;
    reason?: string;
    runId?: string;
    clientId?: string;
    mentionTargets?: import('./chat-mentions').MentionDelivery[];
  };
}
export const MESSAGE_REACTIONS = ['👍', '❤️', '🎉', '👀', '✅'] as const;
/** The image bytes are served by the workspace-scoped computer frame endpoint. */
export interface ComputerFrame {
  id: string;
  createdAt: string;
  width: number;
  height: number;
  mimeType: 'image/webp';
}
export interface Memory {
  id: string;
  agentId: string;
  content: string;
  category: 'preference' | 'context' | 'learning';
  createdAt: string;
}
export interface Routine {
  id: string;
  agentId: string;
  conversationId: string;
  title: string;
  prompt: string;
  schedule: string;
  /** A saved plan's IANA timezone; legacy records without one retain Asia/Shanghai. */
  timeZone?: string;
  /** Exact owner-approved public queries for this routine only. */
  publicSearchQueries?: string[];
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
}
export interface Skill {
  id: string;
  agentId: string;
  name: string;
  description: string;
  content: string;
  version: number;
  status: 'active' | 'proposed' | 'archived' | 'disabled';
  createdAt: string;
  previousVersion?: number;
  approvedAt?: string;
  activatedAt?: string;
  deactivatedAt?: string;
  teamSource?: import('./team-skills.js').TeamSkillSource;
}
export interface WorkspaceFile {
  id: string;
  name: string;
  size: number;
  type: string;
  sha256?: string;
  createdAt: string;
  conversationId?: string;
  source?: {
    kind: 'computer';
    computerName: string;
    path: string;
    importedAt: string;
  };
}
export interface AppSettings {
  profileId: string;
  profileName: string;
  hasApiKey: boolean;
  provider: string;
  model: string;
  baseUrl?: string;
  vision?: boolean;
  configured: boolean;
  runtime: 'pi';
  workspace: string;
  language: string;
}
export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  vision: boolean;
  hasApiKey: boolean;
  configured: boolean;
  credentialSource: 'saved' | 'environment' | 'pi' | 'none';
}
export interface ModelProfilesResponse {
  activeProfileId: string;
  profiles: ModelProfile[];
}
export interface ModelProfileMutationResult {
  profile: ModelProfile;
  settings: AppSettings;
}
export interface ComputerState {
  botScreen?: {
    agentId: string;
    shared?: boolean;
    screenId?: string;
    assignmentRevision?: string;
    status: 'unassigned' | 'ready' | 'unavailable';
    reason?: string;
    lifecycle?: {
      state: 'ready' | 'changing' | 'blocked';
      operation?: { id: string; kind: 'release' | 'reset' };
      releaseAllowed: boolean;
      resetAllowed: boolean;
      reason?: string;
    };
    task?: {
      status: 'idle' | 'running' | 'waiting_cleanup' | 'blocked' | 'maintenance';
      queued: number;
      conversationId?: string;
    };
  };
  savedRemote?: { name: string; url: string };
  executionLocation?: 'server' | 'cloud' | 'remote' | 'none';
  targetRevision?: string;
  connected: boolean;
  name: string;
  platform: string;
  mode: 'local' | 'remote';
  surface: 'browser' | 'desktop';
  desktop?: {
    kind?: 'host' | 'virtual';
    session?: { id: string; generation: string };
    available: boolean;
    authorized: boolean;
    enabled: boolean;
    reason?: string;
    width: number;
    height: number;
    permissions: {
      screenRecording: 'granted' | 'denied' | 'unknown';
      accessibility: 'granted' | 'denied' | 'unknown';
    };
  };
  status: string;
  capabilities: string[];
}
/** Version of one running workspace context. Revisions are comparable only within an epoch. */
export interface SyncToken {
  epoch: string;
  revision: number;
}
export interface Bootstrap {
  sync: SyncToken;
  agents: BotAgent[];
  conversations: Conversation[];
  messages: Message[];
  memories: Memory[];
  routines: Routine[];
  skills: Skill[];
  files: WorkspaceFile[];
  apps?: ConnectedApp[];
  settings: AppSettings;
  computer: ComputerState;
  runningConversationIds?: string[];
  runningRequests?: {
    conversationId: string;
    threadRootId?: string;
    requester?: import('./approvals.js').ActionRequester;
  }[];
  primaryBot?: PrimaryBotState;
  primaryCheckIn?: PrimaryCheckInStatus;
  sidebarRoster?: SidebarRosterState;
  workspaceTimeZone?: WorkspaceTimeZoneState;
  voiceMemo?: { available: boolean };
}
