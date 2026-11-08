import { uiText } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type {
  CreationBotProfile,
  CreationReceipt,
  CreationRequest,
  CreationResolution,
} from '../../shared/creation-requests';
import { ApiError } from './api';
import { createPrimaryBotScope, type PrimaryBotIdentity } from './primaryBot';

export type CreationIntent = {
  version: 1;
  kind: CreationRequest['kind'];
  requestId: string;
  digest: string;
};
export type CreationRequestState = {
  busy: boolean;
  request?: CreationIntent;
  receipt?: CreationReceipt;
  canRetry: boolean;
  originalAvailable: boolean;
  error: string;
  message?: string;
  blocked?: boolean;
};
type Options = PrimaryBotIdentity & {
  identity: () => PrimaryBotIdentity;
  locationWorkspace?: () => string | undefined;
  fetch?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  onState?: (state: CreationRequestState) => void;
  onChanged?: (receipt: CreationReceipt) => void | Promise<void>;
};
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const initialState = (): CreationRequestState => ({
  busy: false,
  canRetry: false,
  originalAvailable: false,
  error: '',
});
export function creationRequestLabel(receipt: CreationReceipt) {
  if (receipt.status === 'missing') return uiText('bots:text_43d719410d2d');
  return receipt.kind === 'bot'
    ? uiText('bots:text_01573beec5a1')
    : uiText('bots:text_53da6eca9038');
}
export function createCreationRequestClient(options: Options) {
  const scope = createPrimaryBotScope(options);
  const key = `openbot-creation-request:${JSON.stringify([options.userId || null, options.workspaceId || null])}`;
  let storage = options.storage;
  let state = initialState();
  let body: CreationRequest | undefined;
  let sequence = 0;
  try {
    storage ||= typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
    if (!storage) throw Error('Storage unavailable');
    const raw = storage.getItem(key);
    if (raw) {
      if (raw.length > 1024) throw Error('Invalid recovery record');
      const value = JSON.parse(raw);
      if (
        !value ||
        value.version !== 1 ||
        !['bot', 'group'].includes(value.kind) ||
        !uuid.test(value.requestId) ||
        !/^[a-f\d]{64}$/.test(value.digest) ||
        Object.keys(value).some(
          (field) => !['version', 'kind', 'requestId', 'digest'].includes(field),
        )
      )
        throw Error('Invalid recovery record');
      state.request = value;
    }
  } catch {
    state.blocked = true;
    state.error = uiText('bots:text_7c68b61157ed');
  }
  const current = (ticket = scope.ticket()) => scope.current(ticket);
  const publish = (patch: Partial<CreationRequestState>) => {
    state = { ...state, ...patch };
    if (current()) options.onState?.({ ...state });
  };
  function validate(value: CreationReceipt, intent: CreationIntent) {
    const bad = () => {
      throw Error(uiText('bots:text_7fd6ae263445'));
    };
    if (
      !value ||
      value.kind !== intent.kind ||
      value.requestId !== intent.requestId ||
      value.userId !== options.userId ||
      value.workspaceId !== options.workspaceId ||
      !identifier(value.conversationId) ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !['created', 'missing'].includes(value.status) ||
      !Array.isArray(value.agentIds) ||
      !value.agentIds.length ||
      value.agentIds.some((id) => !identifier(id)) ||
      new Set(value.agentIds).size !== value.agentIds.length ||
      (value.kind === 'bot' && value.agentIds.length !== 1) ||
      !Array.isArray(value.agents)
    )
      return bad();
    if (body?.kind === 'group' && JSON.stringify(body.agentIds) !== JSON.stringify(value.agentIds))
      return bad();
    if (value.status === 'missing') {
      if (value.conversation !== undefined || value.agents.length) return bad();
      return value;
    }
    const conversation = value.conversation;
    if (
      !conversation ||
      conversation.id !== value.conversationId ||
      conversation.isGroup !== (value.kind === 'group') ||
      !Array.isArray(conversation.agentIds) ||
      !conversation.agentIds.length ||
      conversation.agentIds.some((id) => !identifier(id)) ||
      new Set(conversation.agentIds).size !== conversation.agentIds.length ||
      value.agents.length !== conversation.agentIds.length ||
      value.agents.some(
        (agent) => !agent || !identifier(agent.id) || !conversation.agentIds.includes(agent.id),
      ) ||
      new Set(value.agents.map((agent) => agent.id)).size !== value.agents.length ||
      (value.kind === 'bot' &&
        (conversation.agentIds.length !== 1 || conversation.agentIds[0] !== value.agentIds[0]))
    )
      return bad();
    return value;
  }
  function clear() {
    body = undefined;
    try {
      if (!storage) throw Error('Storage unavailable');
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw Error('Recovery record remains');
    } catch {
      publish({
        blocked: true,
        canRetry: false,
        originalAvailable: false,
        error: uiText('bots:text_94448e7af8f8'),
      });
      return false;
    }
    publish({
      request: undefined,
      receipt: undefined,
      blocked: false,
      canRetry: false,
      originalAvailable: false,
      error: '',
      message: '',
    });
    return true;
  }
  function notify(receipt: CreationReceipt, ticket: number) {
    if (!current(ticket)) return;
    const failed = () => {
      if (current(ticket) && state.receipt?.requestId === receipt.requestId)
        publish({ error: uiText('bots:text_e7a0e7e1b9c6') });
    };
    try {
      void Promise.resolve(options.onChanged?.(receipt)).catch(failed);
    } catch {
      failed();
    }
  }
  async function perform(mode: 'read' | 'write' | 'close'): Promise<CreationReceipt | undefined> {
    const ticket = scope.ticket(),
      intent = state.request;
    if (
      !current(ticket) ||
      state.busy ||
      !intent ||
      (mode === 'write' && (state.blocked || !body || !state.canRetry || !!state.receipt)) ||
      (mode === 'close' && !!state.receipt)
    )
      return;
    const order = ++sequence;
    publish({ busy: true, canRetry: false, error: '', message: '' });
    try {
      const resolution = await scope.request<CreationResolution>(
        `/creation-requests${mode !== 'write' ? `/${encodeURIComponent(intent.requestId)}` : ''}${mode === 'close' ? '/cancel' : ''}`,
        mode === 'read' ? 'GET' : 'POST',
        mode === 'write' ? body : mode === 'close' ? {} : undefined,
      );
      if (!current(ticket) || order !== sequence) return;
      if (resolution?.status === 'not_submitted') {
        if (
          mode !== 'close' ||
          resolution.requestId !== intent.requestId ||
          resolution.userId !== options.userId ||
          resolution.workspaceId !== options.workspaceId
        )
          throw Error(uiText('bots:text_6471bd627010'));
        if (clear()) publish({ message: uiText('bots:text_4204fef8a33e') });
        return;
      }
      const receipt = validate(resolution, intent);
      body = undefined;
      publish({ receipt, canRetry: false, originalAvailable: false });
      notify(receipt, ticket);
      return receipt;
    } catch (cause) {
      if (!current(ticket) || order !== sequence) return;
      if (
        mode === 'read' &&
        cause instanceof ApiError &&
        cause.status === 410 &&
        cause.code === 'CREATION_REQUEST_CLOSED'
      ) {
        if (clear()) publish({ message: uiText('bots:text_4204fef8a33e') });
        return;
      }
      const notFound = mode === 'read' && cause instanceof ApiError && cause.status === 404;
      publish({
        error: notFound
          ? body
            ? uiText('bots:text_e9189cd5b657')
            : uiText('bots:text_6e64f342101c')
          : cause instanceof Error
            ? cause.message
            : uiText('bots:text_a7b7c732fb20'),
        canRetry: notFound && !!body && !state.receipt && !state.blocked,
      });
    } finally {
      if (current(ticket) && order === sequence) publish({ busy: false });
    }
  }
  async function start(
    input:
      | Omit<Extract<CreationRequest, { kind: 'bot' }>, 'requestId'>
      | Omit<Extract<CreationRequest, { kind: 'group' }>, 'requestId'>,
  ): Promise<CreationReceipt | undefined> {
    const ticket = scope.ticket();
    if (!current(ticket) || state.busy || state.request || state.blocked) return;
    const order = ++sequence;
    publish({ busy: true, error: '', message: '' });
    try {
      const candidate = structuredClone({
        ...input,
        requestId: crypto.randomUUID(),
      }) as CreationRequest;
      const hash = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(candidate)),
      );
      if (!current(ticket) || order !== sequence) return;
      const intent: CreationIntent = {
        version: 1,
        kind: candidate.kind,
        requestId: candidate.requestId,
        digest: [...new Uint8Array(hash)]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join(''),
      };
      if (!storage) throw Error('Storage unavailable');
      const metadata = JSON.stringify(intent);
      storage.setItem(key, metadata);
      if (storage.getItem(key) !== metadata) throw Error('Recovery record was not saved');
      body = candidate;
      publish({ request: intent, busy: false, canRetry: true, originalAvailable: true });
      return perform('write');
    } catch {
      if (current(ticket) && order === sequence)
        publish({ busy: false, error: uiText('bots:text_7a99081e3b36') });
    }
  }
  return {
    scope,
    state: () => ({ ...state }),
    resume() {
      scope.resume();
      publish({});
    },
    suspend() {
      scope.suspend();
      sequence++;
      body = undefined;
      state = { ...state, busy: false, canRetry: false, originalAvailable: false };
    },
    createBot: (profile: CreationBotProfile) => start({ kind: 'bot', profile }),
    createGroup: (input: { title: string; agentIds: string[] }) =>
      start({ ...input, kind: 'group' }),
    check: () => perform('read'),
    retry: () => perform('write'),
    closeRequest: () => perform('close'),
    finish() {
      if (!current() || state.busy || !state.receipt) return false;
      return clear();
    },
  };
}
export function useCreationRequests(
  options: PrimaryBotIdentity & {
    onChanged?: (receipt: CreationReceipt) => void | Promise<void>;
  },
) {
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState(initialState);
  const [client] = useState(() =>
    createCreationRequestClient({
      ...options,
      identity: () => latest.current,
      onState: setState,
      onChanged: (receipt) => latest.current.onChanged?.(receipt),
    }),
  );
  useEffect(() => {
    client.resume();
    if (client.state().request) void client.check();
    return () => client.suspend();
  }, [client]);
  return { ...client, getState: client.state, state };
}
