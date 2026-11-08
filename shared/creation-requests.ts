import type { BotAgent, Conversation } from './types.js';

export type CreationBotProfile = Pick<
  BotAgent,
  'name' | 'role' | 'description' | 'instructions' | 'avatar' | 'color' | 'avatarImageId'
>;
export type CreationRequest =
  | { kind: 'bot'; requestId: string; profile: CreationBotProfile }
  | { kind: 'group'; requestId: string; title: string; agentIds: string[] };

export interface CreationReceipt {
  requestId: string;
  kind: 'bot' | 'group';
  status: 'created' | 'missing';
  /** Original binding, never changed by later edits to a Bot or group. */
  agentIds: string[];
  conversationId: string;
  createdAt: string;
  userId?: string;
  workspaceId?: string;
  /** Current entities for the original result. Missing results have no navigable chat. */
  conversation?: Conversation;
  agents: BotAgent[];
}
export type CreationResolution =
  | CreationReceipt
  | {
      requestId: string;
      status: 'not_submitted';
      userId?: string;
      workspaceId?: string;
    };
