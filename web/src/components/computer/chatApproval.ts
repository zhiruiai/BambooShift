import type { Message } from '../../../../shared/types';
import { canDecideAction, type ApprovalActor } from '../../../../shared/approvals';
import { remoteShellRequestReadable } from '../RemoteShellDetails';

export type ChatComputerAction = Record<string, unknown> & {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
};
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

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
          'requester',
          'agentId',
          'conversationId',
          'createdAt',
          'expiresAt',
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

export function mayDecideComputerAction(
  message: Message,
  action: ChatComputerAction | undefined,
  actor: ApprovalActor,
) {
  return (
    !!action &&
    message.status !== 'error' &&
    action.status === 'pending' &&
    !!computerApprovalPath(message, action) &&
    canDecideAction(action.requester, actor)
  );
}

export function mayAllowComputerAction(action: ChatComputerAction) {
  return (
    (action.type !== 'remote_shell' || remoteShellRequestReadable(action.payload)) &&
    (action.expiresAt === undefined ||
      (typeof action.expiresAt === 'string' && Date.parse(action.expiresAt) > Date.now()))
  );
}
