import catalog from './app-providers.json';
import type { Message } from './types';

type AppProposalContext = {
  reason: string;
  runId: string;
  toolCallId: string;
  requester: { userId: string; messageId: string };
};
export type CatalogAppConnectionProposal = AppProposalContext & {
  providerId: string;
  kind?: never;
};
export type CustomAppConnectionProposal = AppProposalContext & {
  kind: 'custom_mcp';
  url: string;
  name: string;
  providerId?: never;
};
export type AppConnectionProposal = CatalogAppConnectionProposal | CustomAppConnectionProposal;

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const contextKeys = ['reason', 'runId', 'toolCallId', 'requester'];
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

export function isCustomAppConnectionProposal(
  proposal: AppConnectionProposal | undefined,
): proposal is CustomAppConnectionProposal {
  return proposal?.kind === 'custom_mcp';
}

const stripTerminalSlash = (value: string) => (value.endsWith('/') ? value.slice(0, -1) : value);

function matchesCanonicalEndpoint(value: unknown, name: unknown): value is string {
  if (
    typeof value !== 'string' ||
    typeof name !== 'string' ||
    name.length > 253 ||
    new TextEncoder().encode(value).length > 2048 ||
    /[?#\p{Cc}]/u.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.href === value &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.hostname === name &&
      url.hostname !== 'localhost' &&
      !url.hostname.endsWith('.localhost') &&
      !catalog.some((entry) => stripTerminalSlash(entry.url) === stripTerminalSlash(value))
    );
  } catch {
    return false;
  }
}

export function parseAppConnectionProposal(message: unknown): AppConnectionProposal | undefined {
  if (
    !object(message) ||
    message.role !== 'assistant' ||
    message.kind !== 'app_connection_proposal' ||
    message.status !== 'done' ||
    !identifier(message.id) ||
    !identifier(message.agentId) ||
    !identifier(message.conversationId) ||
    !object(message.metadata)
  )
    return;
  const value = message.metadata.appConnectionProposal;
  if (
    !object(value) ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    value.reason.length > 300 ||
    value.reason.includes('\0') ||
    !identifier(value.runId) ||
    !identifier(value.toolCallId) ||
    !object(value.requester) ||
    !only(value.requester, ['userId', 'messageId']) ||
    !identifier(value.requester.userId) ||
    !identifier(value.requester.messageId)
  )
    return;
  if (value.kind === 'custom_mcp') {
    if (
      !only(value, [...contextKeys, 'kind', 'url', 'name']) ||
      !matchesCanonicalEndpoint(value.url, value.name)
    )
      return;
    return value as CustomAppConnectionProposal;
  }
  if (
    !only(value, [...contextKeys, 'providerId']) ||
    !catalog.some((item) => item.id === value.providerId)
  )
    return;
  return value as CatalogAppConnectionProposal;
}

export function sameAppConnectionProposal(left: Message, right: Message) {
  const a = parseAppConnectionProposal(left),
    b = parseAppConnectionProposal(right);
  if (!a || !b) return false;
  const target = isCustomAppConnectionProposal(a)
    ? isCustomAppConnectionProposal(b) && a.url === b.url && a.name === b.name
    : !isCustomAppConnectionProposal(b) && a.providerId === b.providerId;
  return (
    target &&
    left.id === right.id &&
    left.agentId === right.agentId &&
    left.conversationId === right.conversationId &&
    left.threadRootId === right.threadRootId &&
    a.reason === b.reason &&
    a.runId === b.runId &&
    a.toolCallId === b.toolCallId &&
    a.requester.userId === b.requester.userId &&
    a.requester.messageId === b.requester.messageId
  );
}
