import type { AppSettings, ComputerState, Message, ModelProfilesResponse } from './types.js';

export interface AdminExecutionRecord {
  id: string;
  conversationId: string;
  conversationTitle: string;
  agentId?: string;
  agentName: string;
  kind: 'text' | 'activity' | 'computer' | 'approval';
  status: NonNullable<Message['status']>;
  createdAt: string;
  summary: string;
  tool?: string;
}
export interface AdminRunningConversation {
  id: string;
  title: string;
  isGroup: boolean;
  agentIds: string[];
  /** First currently running message, when available; not an inferred task start. */
  startedAt?: string;
}
export interface AdminOverview {
  generatedAt: string;
  resources: {
    bots: number;
    conversations: number;
    demoConversations: number;
    /** Registered library entries and their recorded byte sizes. */
    files: number;
    fileBytes: number;
    memories: number;
    routines: number;
    enabledRoutines: number;
    pendingSkills: number;
    activeSkills: number;
  };
  execution: {
    runningConversations: AdminRunningConversation[];
    queuedMessages: number;
    /** A task can produce many execution messages; these are not task counts. */
    recentRecords: AdminExecutionRecord[];
    recentErrors: AdminExecutionRecord[];
    recordLimit: 20;
    recordScope: 'stored-execution-messages';
  };
  settings: AppSettings;
  models: ModelProfilesResponse;
  computer: ComputerState;
  deployment: {
    mode: 'local' | 'remote';
    bindHost: string;
    publicOrigin?: string;
    storage: 'sqlite';
    runtime: 'pi';
    access: 'single-owner' | 'workspace-members';
    authentication: 'local-origin' | 'paired-devices' | 'accounts';
    schedulerEnabled: boolean;
    computerStatusSource: 'last-known';
  };
}
