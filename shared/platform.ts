export type AccountStatus = 'active' | 'suspended';
export type WorkspaceKind = 'personal' | 'team';
export type WorkspaceRole = 'owner' | 'member';

export interface PlatformUser {
  id: string;
  email: string;
  localOnly?: boolean;
  name: string;
  status: AccountStatus;
  createdAt: string;
}
export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
  status: AccountStatus;
  createdAt: string;
}
export interface AccountSession {
  authenticated: boolean;
  user?: PlatformUser;
  workspaces: WorkspaceSummary[];
}
export interface AccountAuthResult extends AccountSession {
  workspaceId: string;
}
export interface AccountDeviceSession {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}
export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  status: AccountStatus;
  joinedAt: string;
}
export interface TeamInvitation {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'used' | 'revoked' | 'expired';
}
export interface TeamDetails {
  workspace: WorkspaceSummary;
  members: TeamMember[];
  invitations: TeamInvitation[];
}
export interface InvitationPreview {
  workspaceName: string;
  expiresAt: string;
  available: boolean;
}
export interface OperatorSession {
  authenticated: boolean;
  setupRequired: boolean;
  user?: PlatformUser;
}
export interface PlatformWorkspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  status: AccountStatus;
  createdAt: string;
  memberCount: number;
  ownerName: string;
}
export interface PlatformOverview {
  generatedAt: string;
  counts: {
    users: number;
    activeUsers: number;
    suspendedUsers: number;
    personalWorkspaces: number;
    teams: number;
    suspendedWorkspaces: number;
  };
  recentUsers: PlatformUser[];
  recentWorkspaces: PlatformWorkspace[];
}
export interface PlatformPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
