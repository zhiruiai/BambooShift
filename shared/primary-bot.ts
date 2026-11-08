import type { BotAgent } from './types.js';

export interface PrimaryBotCheckIn {
  enabled: boolean;
  /** Daily wall-clock time, HH:mm. Missing timeZone retains historical Beijing time. */
  time: string;
  timeZone?: string;
}
export interface PrimaryBotState {
  available: boolean;
  reason?: 'team_workspace' | 'unknown_scope';
  revision: string;
  agentId: string | null;
  conversationId: string | null;
  checkIn: PrimaryBotCheckIn;
  updatedAt?: string;
}
export interface PrimaryCheckInStatus {
  status: 'disabled' | 'waiting' | 'running' | 'completed' | 'interrupted' | 'error' | 'no_model';
  nextRunAt?: string;
  lastRunAt?: string;
  lastMessageId?: string;
  reason?: string;
}
export type PrimaryBotSettings = Pick<
  BotAgent,
  'name' | 'role' | 'description' | 'instructions' | 'color' | 'avatar' | 'avatarImageId'
>;
export type UpdatePrimaryBot =
  | { mode: 'select'; expectedRevision: string; agentId: string; checkIn: PrimaryBotCheckIn }
  | {
      mode: 'create';
      expectedRevision: string;
      bot: PrimaryBotSettings;
      checkIn: PrimaryBotCheckIn;
    }
  | { mode: 'clear'; expectedRevision: string };
