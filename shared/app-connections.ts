import type { ActionRequester } from './approvals.js';
/** Public application metadata. Credentials must never be added to these types. */
export interface ConnectedApp {
  id: string;
  name: string;
  url: string;
  revision: string;
  authType: 'none' | 'bearer' | 'oauth';
  hasCredential: boolean;
  status: 'connected' | 'disconnected' | 'needs_auth' | 'error';
  toolCount: number;
  toolAccessSupported?: true;
  checkedAt?: string;
  error?: string;
  createdAt: string;
  authorization?: { issuer: string; scopes: string[] };
  revocation?: 'pending' | 'revoked' | 'unavailable' | 'failed';
}

export interface ChatAppSelection {
  connectionId: string;
  revision: string;
}

export interface ChatAppContext extends ChatAppSelection {
  name: string;
}

export interface ConnectedAppTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** The workspace access projection is separate from the connector's tool schema. */
export interface AppToolAccess {
  enabled: boolean;
  revision: string;
}

export interface ManagedAppTool extends ConnectedAppTool {
  access?: AppToolAccess;
}

export interface AddAppConnection {
  name: string;
  url: string;
  authType: 'none' | 'bearer' | 'oauth';
  token?: string;
  /** The owner explicitly shares this connection with this workspace's Bots. */
  shared: true;
}

/** A frozen request for approval, bound to both credentials and discovered schema. */
export interface PreparedAppCall {
  connectionId: string;
  connectionRevision: string;
  appName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  schemaHash: string;
}

export interface ConnectedAppResult {
  isError: boolean;
  text: string;
}

/** Display-only provenance. The actual execution service remains server memory only. */
export interface AppActionSource {
  kind: 'shared_bot';
  shareId: string;
  botName: string;
  ownerName: string;
}

export interface ExactAppApprovalInput {
  method: 'get';
  owner: string;
  repo: string;
  issue_number: number;
}

export interface InteractiveAppApproval {
  eligible: boolean;
  agentName: string;
  conversationTitle: string;
  ruleId?: string;
  usage?: 'saved' | 'reused';
}

export interface AppApprovalRule {
  id: string;
  agentId: string;
  agentName: string;
  conversationId: string;
  conversationTitle: string;
  connectionId: string;
  connectionName: string;
  toolName: string;
  input: ExactAppApprovalInput;
  createdAt: string;
}

export interface AppAction {
  id: string;
  conversationId: string;
  agentId: string;
  requester?: ActionRequester;
  source?: AppActionSource;
  interactiveApproval?: InteractiveAppApproval;
  policy?: {
    kind: 'routine_read';
    policyId: string;
    issuerUserId: string;
    routineId: string;
    routineTitle: string;
    issuedAt: string;
  };
  connectionId: string;
  appName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'rejected' | 'cancelled' | 'error';
  createdAt: string;
  expiresAt: string;
  error?: string;
  result?: ConnectedAppResult;
}
