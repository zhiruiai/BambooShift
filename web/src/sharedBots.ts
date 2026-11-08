import { uiText } from './i18n';
import type { Bootstrap, BotAgent, Conversation } from '../../shared/types';
import type {
  SharedBotAddReceipt,
  SharedBotSharingState,
  UpdateSharedBot,
  RevokeSharedBot,
} from '../../shared/shared-bots';
import { isSharedBot, SHARED_BOT_ID } from '../../shared/shared-bots';
import { createAppConnectionScope } from './appConnections';
import { ApiError } from './api';
import { sharedFileSelections } from './sharedBotFiles';
import { sharedAppSelections } from './sharedBotApps';

export function createSharedBotClient(options: {
  userId: string;
  identity: () => string | undefined;
  fetch?: typeof fetch;
}) {
  return createAppConnectionScope({
    userId: options.userId,
    identity: () => ({ userId: options.identity() }),
    fetch: options.fetch,
    onAuthFailure: (status) => {
      if (options.identity() === options.userId && typeof window !== 'undefined')
        window.dispatchEvent(
          new Event(status === 403 ? 'openbot:revalidate' : 'openbot:account-expired'),
        );
    },
  });
}
export type SharedBotClient = ReturnType<typeof createSharedBotClient>;
export function sharedAvatarPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const match = /^\/api\/shared-bots\/([a-f\d-]{36})\/avatar\?revision=([a-f\d]{64})$/.exec(value);
  return match && SHARED_BOT_ID.test(match[1]) ? value : undefined;
}
export type ConfirmedSharedBot = {
  receipt: SharedBotAddReceipt;
  agent: BotAgent;
  conversation: Conversation;
};
export async function confirmSharedBot(
  client: SharedBotClient,
  receipt: SharedBotAddReceipt,
  expected: { userId: string; workspaceId: string; shareId: string; requestId: string },
): Promise<ConfirmedSharedBot> {
  if (
    receipt.actorId !== expected.userId ||
    receipt.workspaceId !== expected.workspaceId ||
    receipt.shareId !== expected.shareId ||
    receipt.requestId !== expected.requestId ||
    !SHARED_BOT_ID.test(receipt.agentId) ||
    !SHARED_BOT_ID.test(receipt.conversationId)
  )
    throw new Error(uiText('bots:text_122155bd6939'));
  const snapshot = await client.request<Bootstrap>(
    `/workspaces/${encodeURIComponent(expected.workspaceId)}/bootstrap`,
  );
  const agent = snapshot.agents.find(
    (item) =>
      item.id === receipt.agentId &&
      isSharedBot(item) &&
      item.sharedBot?.shareId === receipt.shareId,
  );
  const conversation = snapshot.conversations.find(
    (item) =>
      item.id === receipt.conversationId &&
      !item.isGroup &&
      item.agentIds.length === 1 &&
      item.agentIds[0] === receipt.agentId,
  );
  if (!agent || !conversation) throw new Error(uiText('bots:text_008d6255c55d'));
  return { receipt, agent, conversation };
}
const safeRejection = (error: unknown, code: string) =>
  error instanceof ApiError && error.code === code && [400, 409, 413, 422].includes(error.status);
export type SharedJoinAttempt = { requestId: string; shareId: string; workspaceId: string };
export type SharedJoinState = {
  busy: boolean;
  error: string;
  pending?: SharedJoinAttempt;
  receipt?: SharedBotAddReceipt;
  confirmed?: ConfirmedSharedBot;
  retryAllowed?: boolean;
  recoveryBlocked?: boolean;
};
export function createSharedBotJoin(options: {
  client: SharedBotClient;
  userId: string;
  workspaceId: string;
  onChange: (state: SharedJoinState) => void;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}) {
  let storage = options.storage;
  const key = `openbot-shared-join:${options.userId}:${options.workspaceId}`;
  let state: SharedJoinState = { busy: false, error: '' },
    active = true;
  try {
    storage ||= typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
    const saved = storage?.getItem(key);
    if (saved) {
      const pending = JSON.parse(saved);
      if (
        pending.workspaceId === options.workspaceId &&
        SHARED_BOT_ID.test(pending.requestId) &&
        SHARED_BOT_ID.test(pending.shareId)
      )
        state.pending = pending;
      else throw new Error('Invalid stored request');
    }
  } catch {
    state.error = uiText('bots:text_1ff0f1cbfb76');
    state.recoveryBlocked = true;
  }
  const publish = () => {
    if (active) options.onChange({ ...state });
  };
  function save(pending?: SharedJoinAttempt) {
    if (!storage) throw new Error(uiText('bots:text_eefd482f96a3'));
    pending ? storage.setItem(key, JSON.stringify(pending)) : storage.removeItem(key);
    state.pending = pending;
  }
  async function execute(read: boolean) {
    const ticket = options.client.ticket(),
      pending = state.pending;
    if (!active || state.busy || !pending || !options.client.current(ticket)) return;
    state = { ...state, busy: true, error: '', retryAllowed: false };
    publish();
    try {
      const receipt =
        state.receipt ||
        (await options.client.request<SharedBotAddReceipt>(
          `/workspaces/${encodeURIComponent(options.workspaceId)}/shared-bot-references${read ? `/${encodeURIComponent(pending.requestId)}` : ''}`,
          read ? 'GET' : 'POST',
          read ? undefined : { requestId: pending.requestId, shareId: pending.shareId },
        ));
      if (!active || !options.client.current(ticket)) return;
      state.receipt = receipt;
      const confirmed = await confirmSharedBot(options.client, receipt, {
        ...pending,
        userId: options.userId,
      });
      if (!active || !options.client.current(ticket)) return;
      save(undefined);
      state = { busy: false, error: '', receipt, confirmed };
    } catch (error) {
      if (!active || !options.client.current(ticket)) return;
      if (safeRejection(error, 'SHARED_BOT_NOT_ADDED') && !state.receipt) save(undefined);
      state = {
        ...state,
        error: error instanceof Error ? error.message : uiText('bots:text_9d7a002c17fa'),
        retryAllowed: read && error instanceof ApiError && error.status === 404 && !state.receipt,
      };
    } finally {
      state.busy = false;
      if (active && options.client.current(ticket)) publish();
    }
  }
  return {
    state: () => ({ ...state }),
    resume() {
      active = true;
      publish();
    },
    suspend() {
      active = false;
    },
    async start(shareId: string) {
      if (
        !active ||
        state.busy ||
        state.pending ||
        state.recoveryBlocked ||
        !options.client.current(options.client.ticket()) ||
        !SHARED_BOT_ID.test(shareId)
      )
        return;
      try {
        state = { busy: false, error: '' };
        save({ requestId: crypto.randomUUID(), shareId, workspaceId: options.workspaceId });
      } catch (error) {
        state.error = (error as Error).message;
        publish();
        return;
      }
      await execute(false);
    },
    check: () => execute(true),
    retry: () => (state.retryAllowed ? execute(false) : Promise.resolve()),
  };
}
export type SharingAttempt = { method: 'PUT' | 'POST'; body: UpdateSharedBot | RevokeSharedBot };
export function validSharingAttempt(value: unknown): value is SharingAttempt {
  if (!value || typeof value !== 'object') return false;
  const attempt = value as SharingAttempt,
    body = attempt.body;
  if (
    !body ||
    typeof body !== 'object' ||
    !SHARED_BOT_ID.test(body.requestId) ||
    !(body.expectedRevision === 'unset' || SHARED_BOT_ID.test(body.expectedRevision))
  )
    return false;
  if (attempt.method === 'POST')
    return Object.keys(body).every((key) => ['requestId', 'expectedRevision'].includes(key));
  if (attempt.method !== 'PUT' || !('targetTeamId' in body)) return false;
  return (
    Object.keys(body).every((key) =>
      [
        'requestId',
        'expectedRevision',
        'targetTeamId',
        'audience',
        'memberIds',
        'files',
        'apps',
      ].includes(key),
    ) &&
    typeof body.targetTeamId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(body.targetTeamId) &&
    (body.audience === 'team' || body.audience === 'selected') &&
    Array.isArray(body.memberIds) &&
    body.memberIds.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) &&
    (body.files === undefined || sharedFileSelections(body.files)) &&
    (body.apps === undefined || sharedAppSelections(body.apps))
  );
}
export function sharingStorageKey(userId: string, workspaceId: string, agentId: string) {
  return `openbot-sharing:${userId}:${workspaceId}:${agentId}`;
}
export const sharingNotApplied = (error: unknown) => safeRejection(error, 'SHARED_BOT_NOT_APPLIED');
export const sharingPath = (workspaceId: string, agentId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/sharing`;
export function sharingDraft(state: SharedBotSharingState) {
  const share = state.share;
  return {
    targetTeamId: share?.targetTeamId || state.teams[0]?.id || '',
    audience: share?.audience || ('team' as const),
    memberIds: share?.memberIds || [],
    files: share?.files || [],
    apps: share?.apps || [],
  };
}
