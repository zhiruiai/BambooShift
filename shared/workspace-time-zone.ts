export interface WorkspaceTimeZoneState {
  timeZone: string;
  revision: string;
  updatedAt?: string;
}

export interface UpdateWorkspaceTimeZone {
  expectedRevision: string;
  timeZone: string;
}
