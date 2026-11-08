import type { Conversation } from './types.js';

export type SidebarTarget = { kind: 'bot' | 'conversation'; id: string };
export interface SidebarRosterSection {
  id: string;
  name: string;
  collapsed: boolean;
}
export interface SidebarRosterEntry {
  target: SidebarTarget;
  pinned: boolean;
  hidden: boolean;
  sectionId: string | null;
}
/** One user's view of one workspace; absent entries use the ordinary visible defaults. */
export interface SidebarRosterState {
  revision: string;
  sections: SidebarRosterSection[];
  entries: SidebarRosterEntry[];
}
export type SidebarRosterOperation =
  | {
      type: 'set-entry';
      target: SidebarTarget;
      pinned?: boolean;
      hidden?: boolean;
      sectionId?: string | null;
    }
  | { type: 'create-section'; name: string; target?: SidebarTarget }
  | { type: 'rename-section'; id: string; name: string }
  | { type: 'set-section-collapsed'; id: string; collapsed: boolean }
  | { type: 'delete-section'; id: string };
export interface UpdateSidebarRoster {
  expectedRevision: string;
  operation: SidebarRosterOperation;
}
export const SIDEBAR_MAX_SECTIONS = 100;
export const SIDEBAR_MAX_SECTION_NAME = 80;
export const SIDEBAR_MAX_ENTRIES = 5000;
/** A Bot preference applies to all of its private chats, never to its groups. */
export function sidebarTargetForConversation(
  conversation: Pick<Conversation, 'id' | 'isGroup' | 'agentIds'>,
): SidebarTarget {
  return !conversation.isGroup && conversation.agentIds.length === 1
    ? { kind: 'bot', id: conversation.agentIds[0] }
    : { kind: 'conversation', id: conversation.id };
}
