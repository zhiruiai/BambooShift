import type { ConnectedAppTool } from './app-connections.js';

export interface AppReadPolicy {
  id: string;
  issuerUserId: string;
  routineId: string;
  routineTitle: string;
  routineRevision: string;
  connectionId: string;
  connectionRevision: string;
  toolName: string;
  toolRevision: string;
  arguments: Record<string, unknown>;
  status: 'active' | 'invalidated' | 'revoked';
  createdAt: string;
}
export interface AppPolicyOptions {
  connectionId: string;
  connectionRevision: string;
  catalogRevision: string;
  routines: Array<{
    id: string;
    title: string;
    revision: string;
    schedule: string;
    timeZone?: string;
  }>;
  tools: Array<{ tool: ConnectedAppTool; revision: string; eligible: boolean }>;
}
