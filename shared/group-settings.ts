import type { Conversation } from './types.js';
import { GROUP_MAX_MEMBERS } from './group-members.js';

export const GROUP_SETTINGS_LIMITS = Object.freeze({
  title: 100,
  members: GROUP_MAX_MEMBERS,
  goal: 6000,
  summary: 2000,
  assignment: 2000,
});
export interface GroupSettingsSnapshot {
  conversation: Conversation;
  /** Hash of group configuration only; messages/read status do not change it. */
  revision: string;
}
export interface UpdateGroupSettings {
  expectedRevision: string;
  title: string;
  /** The first member is the group leader, even for a one-member group. */
  agentIds: string[];
  /** Existing plans must be submitted in full; omitted manual plans remain absent. */
  teamBrief?: NonNullable<Conversation['teamBrief']>;
}
