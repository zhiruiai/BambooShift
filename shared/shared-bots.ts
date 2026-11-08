import type { BotAgent } from './types.js';
import type { ConnectedApp, ConnectedAppTool } from './app-connections.js';

export const SHARED_APP_CONNECTIONS = 20;
export const SHARED_APP_TOOLS = 64;
export const SHARED_APP_METADATA_BYTES = 512 * 1024;
export interface SharedBotAppToolSelection {
  name: string;
  revision: string;
}
export interface SharedBotAppSelection {
  connectionId: string;
  connectionRevision: string;
  tools: SharedBotAppToolSelection[];
}
export interface SharedBotAppGrant extends SharedBotAppSelection {
  name: string;
}
export interface SharedBotAppView extends SharedBotAppGrant {
  status: 'available' | 'changed' | 'missing' | 'unavailable';
  reason?: string;
}
export interface SharedBotAppCandidate {
  connectionId: string;
  name: string;
  status: ConnectedApp['status'];
  toolCount: number;
}
export interface SharedBotAppOptions {
  apps: SharedBotAppCandidate[];
  selected: SharedBotAppView[];
}
export interface SharedBotAppCatalog {
  connectionId: string;
  name: string;
  connectionRevision: string;
  tools: Array<ConnectedAppTool & { revision: string }>;
}

export type SharedBotAudience = 'team' | 'selected';
export interface SharedBotFileSelection {
  fileId: string;
  revision: string;
}
export interface SharedBotFileCandidate {
  fileId: string;
  name: string;
  size: number;
  type: string;
}
export interface SharedBotFileGrant extends SharedBotFileSelection, SharedBotFileCandidate {}
export interface SharedBotFileView extends SharedBotFileGrant {
  status: 'available' | 'changed' | 'missing' | 'unavailable';
  reason?: string;
}
export interface SharedBotFileOptions {
  files: SharedBotFileCandidate[];
  selected: SharedBotFileView[];
  truncated: boolean;
}
export interface SharedBotShare {
  id: string;
  sourceWorkspaceId: string;
  sourceAgentId: string;
  createdBy: string;
  targetTeamId: string;
  audience: SharedBotAudience;
  memberIds: string[];
  status: 'active' | 'revoked';
  revision: string;
  accessRevision: string;
  createdAt: string;
  updatedAt: string;
  /** Omitted legacy records grant no source files. */
  files?: SharedBotFileGrant[];
  /** Lightweight exact tool grants. Schemas and credentials remain at the source. */
  apps?: SharedBotAppGrant[];
}
export interface UpdateSharedBot {
  requestId: string;
  expectedRevision: string;
  targetTeamId: string;
  audience: SharedBotAudience;
  memberIds: string[];
  /** An omitted field preserves existing grants; an explicit empty array clears them. */
  files?: SharedBotFileSelection[];
  /** An omitted field preserves existing grants; an explicit empty array clears them. */
  apps?: SharedBotAppSelection[];
}
export interface RevokeSharedBot {
  requestId: string;
  expectedRevision: string;
}
/** Public metadata on a local managed reference; never an authorization capability. */
export interface SharedBotReference {
  shareId: string;
  sourceRevision: string;
  ownerName: string;
  sourceWorkspaceName: string;
  teamName: string;
  status: 'active' | 'revoked' | 'unavailable';
  reason?: string;
  avatarPath?: string;
  fileCount?: number;
  filesRevision?: string;
  appCount?: number;
  appsRevision?: string;
}
export interface SharedBotAddReceipt {
  requestId: string;
  shareId: string;
  actorId: string;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  createdAt: string;
}
export interface SharedBotCard {
  id: string;
  name: string;
  role: string;
  description: string;
  avatar: BotAgent['avatar'];
  color: string;
  avatarPath?: string;
  ownerName: string;
  sourceWorkspaceName: string;
  teamName: string;
  targetTeamId: string;
  sourceRevision: string;
  skillCount: number;
  fileCount?: number;
  appCount?: number;
  appsRevision?: string;
  joined?: Pick<SharedBotAddReceipt, 'workspaceId' | 'agentId' | 'conversationId'> & {
    hidden: boolean;
  };
}
export interface SharedBotTeamOption {
  id: string;
  name: string;
  members: Array<{ userId: string; name: string }>;
}
export interface SharedBotSharingState {
  share: SharedBotShare | null;
  teams: SharedBotTeamOption[];
}
/** A malformed managed marker is still managed; domains must never fall back to local. */
export function isSharedBot(agent: unknown): boolean {
  return !!agent && typeof agent === 'object' && Object.hasOwn(agent, 'sharedBot');
}
export const SHARED_BOT_ID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
export function parseSharedBotPath(path: string): string | undefined {
  const match = /^\/shared-bots\/([a-f\d-]{36})$/.exec(path);
  return match && SHARED_BOT_ID.test(match[1]) ? match[1] : undefined;
}
