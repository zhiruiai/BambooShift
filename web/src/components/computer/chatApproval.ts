import type { Message } from '../../../../shared/types';
import { canDecideAction, type ApprovalActor } from '../../../../shared/approvals';
import { remoteShellRequestReadable } from '../RemoteShellDetails';
import { skillScriptRequest } from '../SkillScriptDetails';

export type ChatComputerAction = Record<string, unknown> & {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  authorization?: unknown;
};
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const revisionId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

// The API persists a pending record just before starting these read-only actions.
const autoStartedActions = new Set([
  'list_files',
  'read_file',
  'download_file',
  'terminal_command',
  'browser_screenshot',
  'desktop_screenshot',
  'desktop_ax_inspect',
]);

export function computerActionNeedsApproval(type: unknown) {
  return typeof type === 'string' && !autoStartedActions.has(type);
}

export function isMacAppsTargetAction(type: string) {
  return (
    type === 'desktop_ax_press' || type === 'desktop_ax_set_text' || type === 'desktop_ax_open'
  );
}

export function macAppsActionTarget(
  type: string,
  target: unknown,
  payload: Record<string, unknown>,
) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  const { app, bundleId, windowTitle, role, label } = target as Record<string, unknown>;
  if (typeof app !== 'string' || !app.trim()) return;
  if (type === 'desktop_ax_open') {
    if (
      typeof bundleId !== 'string' ||
      bundleId.length > 300 ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(bundleId) ||
      bundleId.trim() !== bundleId ||
      payload.type !== type ||
      typeof payload.bundleId !== 'string' ||
      bundleId.toLowerCase() !== payload.bundleId.toLowerCase()
    )
      return;
    return `${app.trim()} · ${bundleId}`;
  }
  const control =
    typeof label === 'string' && label.trim()
      ? label.trim()
      : typeof role === 'string' && role.trim()
        ? role.trim()
        : '';
  if (control)
    return [
      ...new Set([app.trim(), typeof windowTitle === 'string' ? windowTitle.trim() : '', control]),
    ]
      .filter(Boolean)
      .join(' · ');
}

/** Persisted by the server only for actions started under a full grant. */
export function computerActionFullyAuthorized(action: { authorization?: unknown }) {
  const value = action.authorization;
  return (
    !!value &&
    typeof value === 'object' &&
    'mode' in value &&
    value.mode === 'full' &&
    'scope' in value &&
    value.scope === 'current-user-current-computer' &&
    'grantedAt' in value &&
    typeof value.grantedAt === 'string'
  );
}

export function parseChatComputerAction(value: unknown): ChatComputerAction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const action = value as ChatComputerAction;
  if (
    !identifier(action.id) ||
    typeof action.type !== 'string' ||
    !action.type ||
    !['pending', 'running', 'done', 'error', 'rejected', 'cancelled'].includes(action.status) ||
    !action.payload ||
    typeof action.payload !== 'object' ||
    Array.isArray(action.payload)
  )
    return;
  return action;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, ordered(child)]),
    );
  return value;
}

/** A decision applies only to the request the person has actually reviewed. */
export function computerApprovalFingerprint(action: ChatComputerAction) {
  return JSON.stringify(
    ordered(
      Object.fromEntries(
        [
          'id',
          'type',
          'payload',
          'target',
          'requester',
          'agentId',
          'conversationId',
          'createdAt',
          'expiresAt',
          'execution',
          'screenBinding',
          'desktopSession',
          'targetRevision',
        ].map((key) => [key, action[key]]),
      ),
    ),
  );
}

export function computerApprovalPath(message: Message, action: ChatComputerAction) {
  if (
    message.role !== 'assistant' ||
    message.kind !== 'computer' ||
    (action.agentId !== undefined && action.agentId !== message.agentId) ||
    (action.conversationId !== undefined && action.conversationId !== message.conversationId)
  )
    return;
  if (['upload_file', 'download_file'].includes(action.type)) return '/computer';
  return identifier(message.agentId)
    ? `/computer/bots/${encodeURIComponent(message.agentId)}`
    : undefined;
}

export function hasAssignedComputerScreen(message: Message, action?: ChatComputerAction) {
  if (!action || !identifier(action.agentId) || action.agentId !== message.agentId) return false;
  const binding = action.screenBinding as Record<string, unknown> | undefined;
  return (
    !!computerApprovalPath(message, action) &&
    identifier(binding?.screenId) &&
    revisionId(binding?.assignmentRevision)
  );
}

export function computerReceiptExecution(message: Message, action?: ChatComputerAction) {
  if (
    !action ||
    (action.agentId !== undefined && action.agentId !== message.agentId) ||
    (action.conversationId !== undefined && action.conversationId !== message.conversationId) ||
    !action.execution ||
    typeof action.execution !== 'object' ||
    Array.isArray(action.execution)
  )
    return;
  const { location, surface, targetRevision } = action.execution as Record<string, unknown>;
  if (
    (location === 'server' || location === 'cloud' || location === 'remote') &&
    (surface === 'browser' || surface === 'desktop' || surface === 'accessibility') &&
    revisionId(targetRevision)
  )
    return { location, surface } as const;
}

export function mayDecideComputerAction(
  message: Message,
  action: ChatComputerAction | undefined,
  actor: ApprovalActor,
) {
  return (
    !!action &&
    message.status !== 'error' &&
    action.status === 'pending' &&
    !computerActionFullyAuthorized(action) &&
    computerActionNeedsApproval(action.type) &&
    !!computerApprovalPath(message, action) &&
    canDecideAction(action.requester, actor)
  );
}

export function mayAllowComputerAction(
  action: Pick<ChatComputerAction, 'type' | 'payload'> & { target?: unknown; expiresAt?: unknown },
) {
  return (
    (!['remote_shell', 'local_shell'].includes(action.type) ||
      remoteShellRequestReadable(action.payload)) &&
    (action.type !== 'local_skill_script' || !!skillScriptRequest(action.payload)) &&
    (!isMacAppsTargetAction(action.type) ||
      !!macAppsActionTarget(action.type, action.target, action.payload)) &&
    (action.type !== 'desktop_ax_set_text' ||
      (typeof action.payload.text === 'string' && action.payload.text.length > 0)) &&
    (action.expiresAt === undefined ||
      (typeof action.expiresAt === 'string' && Date.parse(action.expiresAt) > Date.now()))
  );
}
