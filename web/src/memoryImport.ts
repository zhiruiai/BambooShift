import { uiText } from './i18n';
import {
  MEMORY_IMPORT_MAX_BYTES,
  MEMORY_IMPORT_MAX_CHARS,
  type CreateMemoryImport,
  type MemoryImportReceipt,
} from '../../shared/memory-imports';
import { ApiError } from './api';
import { createPrimaryBotScope, type PrimaryBotIdentity } from './primaryBot';

export type MemoryImportActivity = { dirty: boolean; busy: boolean; pending: boolean };
type PendingImport = Pick<CreateMemoryImport, 'requestId' | 'expectedPrimaryRevision'>;
export type MemoryImportClientState = {
  busy: boolean;
  request?: PendingImport;
  receipt?: MemoryImportReceipt;
  error: string;
  canRetry: boolean;
  originalAvailable: boolean;
  blocked?: boolean;
};
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function memoryImportProblem(content: string) {
  if (!content.trim()) return uiText('common:text_ffe68c314c86');
  if (
    content.length > MEMORY_IMPORT_MAX_CHARS ||
    new TextEncoder().encode(content).byteLength > MEMORY_IMPORT_MAX_BYTES
  )
    return uiText('common:text_2321aa6d553d');
  return '';
}
export const memoryImportStatus = (status: MemoryImportReceipt['status']) =>
  ({
    queued: uiText('common:text_55c2a40162bb'),
    delivered: uiText('common:text_d6bcb7add78d'),
    running: uiText('common:text_2015e614d61c'),
    completed: uiText('common:text_df8c4c637d1e'),
    error: uiText('common:text_d59c24501e7e'),
    cancelled: uiText('common:text_c12ffcc5dbc0'),
    interrupted: uiText('common:text_68c2b87a8740'),
    missing: uiText('common:text_86187ea5ffdd'),
  })[status];
export const memoryImportFinished = (receipt?: MemoryImportReceipt) =>
  !!receipt &&
  ['completed', 'error', 'cancelled', 'interrupted', 'missing'].includes(receipt.status);

export function createMemoryImportClient(
  options: PrimaryBotIdentity & {
    identity: () => PrimaryBotIdentity;
    enabled?: () => boolean;
    fetch?: typeof fetch;
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    onState: (state: MemoryImportClientState) => void;
  },
) {
  const scope = createPrimaryBotScope(options);
  const key = `openbot-memory-import:${JSON.stringify([options.userId || null, options.workspaceId || null])}`;
  let storage = options.storage;
  let state: MemoryImportClientState = {
    busy: false,
    error: '',
    canRetry: false,
    originalAvailable: false,
  };
  let body: CreateMemoryImport | undefined;
  let operation = 0;
  try {
    storage ||= typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
    if (!storage) throw Error('Storage unavailable');
    const raw = storage.getItem(key);
    if (raw) {
      if (raw.length > 1024) throw Error('Invalid receipt');
      const value = JSON.parse(raw);
      if (
        !value ||
        typeof value !== 'object' ||
        Object.keys(value).some(
          (name) => !['requestId', 'expectedPrimaryRevision'].includes(name),
        ) ||
        !uuid.test(value.requestId) ||
        !identifier(value.expectedPrimaryRevision)
      )
        throw Error('Invalid receipt');
      state.request = {
        requestId: value.requestId,
        expectedPrimaryRevision: value.expectedPrimaryRevision,
      };
    }
  } catch {
    state = { ...state, blocked: true, error: uiText('common:text_d1180915b2de') };
  }
  const current = (ticket: number) => scope.current(ticket);
  const enabled = () => !options.enabled || options.enabled();
  const publish = () => {
    if (current(scope.ticket())) options.onState({ ...state });
  };
  function validate(receipt: MemoryImportReceipt, request: PendingImport) {
    if (
      !receipt ||
      receipt.requestId !== request.requestId ||
      receipt.primaryRevision !== request.expectedPrimaryRevision ||
      receipt.userId !== options.userId ||
      receipt.workspaceId !== options.workspaceId ||
      !identifier(receipt.agentId) ||
      !identifier(receipt.conversationId) ||
      !identifier(receipt.messageId) ||
      !Number.isFinite(Date.parse(receipt.createdAt)) ||
      ![
        'queued',
        'delivered',
        'running',
        'completed',
        'error',
        'cancelled',
        'interrupted',
        'missing',
      ].includes(receipt.status)
    )
      throw Error(uiText('common:text_dca994723c8a'));
    return receipt;
  }
  function persist(request: PendingImport) {
    if (!storage) throw Error(uiText('common:text_e4700c855fda'));
    storage.setItem(key, JSON.stringify(request));
    state.request = request;
  }
  async function execute(read: boolean): Promise<MemoryImportReceipt | undefined> {
    const ticket = scope.ticket(),
      request = state.request;
    if (
      !current(ticket) ||
      !enabled() ||
      state.busy ||
      state.blocked ||
      !request ||
      (!read && (!body || !state.canRetry))
    )
      return;
    const order = ++operation;
    state = { ...state, busy: true, error: '', canRetry: false };
    publish();
    try {
      const value = validate(
        await scope.request<MemoryImportReceipt>(
          `/memory-imports${read ? `/${encodeURIComponent(request.requestId)}` : ''}`,
          read ? 'GET' : 'POST',
          read ? undefined : body,
        ),
        request,
      );
      if (!current(ticket) || order !== operation) return;
      state = { ...state, receipt: value, error: '', canRetry: false };
      return value;
    } catch (cause) {
      if (!current(ticket) || order !== operation) return;
      if (
        !read &&
        cause instanceof ApiError &&
        cause.code === 'MEMORY_IMPORT_NOT_STARTED' &&
        [400, 409, 413, 422].includes(cause.status)
      ) {
        try {
          storage?.removeItem(key);
        } catch {
          state.error = uiText('common:text_e6c9b4730ec2');
          return;
        }
        state.request = undefined;
        body = undefined;
        state.originalAvailable = false;
      }
      const missing = read && cause instanceof ApiError && cause.status === 404;
      state = {
        ...state,
        error: missing && !body ? uiText('common:text_631bf2ab3410') : (cause as Error).message,
        canRetry: missing && !!body,
      };
    } finally {
      if (order === operation) {
        state.busy = false;
        if (current(ticket)) publish();
      }
    }
  }
  return {
    scope,
    state: () => ({ ...state }),
    resume() {
      scope.resume();
      publish();
    },
    suspend() {
      scope.suspend();
      operation++;
      state.busy = false;
      state.canRetry = false;
    },
    async start(content: string, expectedPrimaryRevision: string) {
      if (!current(scope.ticket()) || !enabled() || state.busy || state.request || state.blocked)
        return;
      const issue = memoryImportProblem(content);
      if (issue || !identifier(expectedPrimaryRevision)) {
        state.error = issue || uiText('common:text_5ebd161ab6a1');
        publish();
        return;
      }
      body = { requestId: crypto.randomUUID(), expectedPrimaryRevision, content };
      try {
        persist({ requestId: body.requestId, expectedPrimaryRevision });
      } catch {
        body = undefined;
        state.error = uiText('common:text_e4700c855fda');
        publish();
        return;
      }
      state = { ...state, originalAvailable: true, canRetry: true };
      return execute(false);
    },
    check: () => execute(true),
    retry: () => execute(false),
    finish() {
      if (
        !current(scope.ticket()) ||
        !enabled() ||
        state.busy ||
        !memoryImportFinished(state.receipt)
      )
        return false;
      try {
        storage?.removeItem(key);
      } catch {
        state.error = uiText('common:text_9f1be0eb849c');
        publish();
        return false;
      }
      body = undefined;
      state = { busy: false, error: '', canRetry: false, originalAvailable: false };
      publish();
      return true;
    },
    acknowledged() {
      if (!state.receipt) return;
      // Only receipt metadata is removed; source content is never stored on disk.
      try {
        storage?.removeItem(key);
      } catch {
        /* Accepted request is still known in this instance. */
      }
    },
  };
}
