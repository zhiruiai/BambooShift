import type { Routine, BotAgent, Conversation } from '../../shared/types';
import type {
  TransferRoutineRequest,
  RoutineTransferReceipt,
  RoutineTransferResolution,
} from '../../shared/routine-transfers';
import { routineConfigSnapshot } from '../../shared/routine-operations';
import { isSharedBot } from '../../shared/shared-bots';
import { createPrimaryBotScope, type PrimaryBotIdentity } from './primaryBot';
import { ApiError } from './api';
import { uiText } from './i18n';
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
export function routineTransferTargets(
  agents: BotAgent[],
  conversations: Conversation[],
  source: string,
) {
  return agents
    .filter((a) => a.id !== source && !isSharedBot(a))
    .flatMap((agent) => {
      const chats = conversations.filter(
        (c) => !c.isGroup && c.agentIds.length === 1 && c.agentIds[0] === agent.id,
      );
      return chats.length === 1 ? [{ agent, conversation: chats[0] }] : [];
    });
}
export type TransferState = {
  busy: boolean;
  error: string;
  requestId?: string;
  checked: boolean;
  receipt?: RoutineTransferReceipt;
};
export function createRoutineTransferClient(
  options: PrimaryBotIdentity & {
    routineId: string;
    identity: () => PrimaryBotIdentity;
    locationWorkspace?: () => string | undefined;
    fetch?: typeof fetch;
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    onState?: (value: TransferState) => void;
    onTransferred?: (value: RoutineTransferReceipt) => Promise<void> | void;
  },
) {
  const scope = createPrimaryBotScope(options);
  const key = `openbot-routine-transfer:${JSON.stringify([options.workspaceId, options.userId, options.routineId])}`;
  let state: TransferState = { busy: false, error: '', checked: false };
  let body: TransferRoutineRequest | undefined,
    storage = options.storage,
    loaded = false;
  const current = () => !!options.workspaceId && !!options.userId && scope.current(scope.ticket());
  const publish = (patch: Partial<TransferState>) => {
    state = { ...state, ...patch };
    if (current()) options.onState?.({ ...state });
  };
  const keep = (id?: string) => {
    if (!storage) throw Error(uiText('workspace:routineTransferStorage'));
    if (id) storage.setItem(key, id);
    else storage.removeItem(key);
  };
  const ensureCurrent = () => {
    if (!current()) throw new DOMException('Stale transfer scope', 'AbortError');
  };
  const load = () => {
    if (loaded) return;
    storage ||= typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
    const id = storage?.getItem(key);
    if (id && !uuid.test(id)) throw Error(uiText('workspace:routineTransferInvalid'));
    publish({ requestId: id || undefined });
    loaded = true;
  };
  const valid = (value: RoutineTransferReceipt) => {
    if (
      value.requestId !== state.requestId ||
      value.routineId !== options.routineId ||
      value.userId !== options.userId ||
      value.workspaceId !== options.workspaceId ||
      !['transferred', 'missing'].includes(value.status) ||
      !uuid.test(value.requestId) ||
      !value.targetAgentId ||
      !value.targetConversationId ||
      !value.sourceAgentId ||
      !value.sourceConversationId ||
      !/^[a-f\d]{64}$/.test(value.appliedRevision) ||
      (value.status === 'transferred' && value.routine?.id !== value.routineId)
    )
      throw Error(uiText('workspace:routineTransferInvalid'));
    return value;
  };
  async function accept(value: RoutineTransferReceipt) {
    ensureCurrent();
    valid(value);
    body = undefined;
    publish({ receipt: value, error: '', checked: true });
    await options.onTransferred?.(value);
  }
  async function work(task: () => Promise<void>) {
    if (!current() || state.busy) return false;
    publish({ busy: true, error: '' });
    try {
      await task();
      return current();
    } catch (error) {
      if (current()) publish({ error: (error as Error).message });
      return false;
    } finally {
      if (current()) publish({ busy: false });
    }
  }
  async function read() {
    if (!state.requestId) return;
    try {
      await accept(
        await scope.request<RoutineTransferReceipt>(`/routine-transfers/${state.requestId}`),
      );
    } catch (error) {
      ensureCurrent();
      if (
        error instanceof ApiError &&
        error.status === 410 &&
        error.code === 'ROUTINE_TRANSFER_CLOSED'
      ) {
        keep();
        body = undefined;
        publish({ requestId: undefined, checked: false, receipt: undefined, error: '' });
        return;
      }
      if (error instanceof ApiError && error.status === 404) publish({ checked: true });
      throw error;
    }
  }
  return {
    get state() {
      return { ...state };
    },
    get canRetry() {
      return !!body && state.checked && !state.receipt;
    },
    current,
    resume() {
      scope.resume();
    },
    close() {
      scope.suspend();
      body = undefined;
    },
    check() {
      return work(async () => {
        load();
        await read();
      });
    },
    start(routine: Routine, targetAgentId: string, targetConversationId: string) {
      if (state.requestId || routine.id !== options.routineId) return Promise.resolve(false);
      return work(async () => {
        load();
        if (state.requestId) throw Error(uiText('workspace:routineTransferUnknown'));
        const requestId = crypto.randomUUID();
        keep(requestId);
        body = {
          requestId,
          expectedRoutine: routineConfigSnapshot(routine),
          targetAgentId,
          targetConversationId,
        };
        publish({ requestId, checked: false });
        await accept(
          await scope.request<RoutineTransferReceipt>(
            `/routines/${encodeURIComponent(options.routineId)}/transfer`,
            'POST',
            body,
          ),
        );
      });
    },
    retry() {
      if (!body || !state.checked || state.receipt) return Promise.resolve(false);
      return work(async () => {
        publish({ checked: false });
        await accept(
          await scope.request<RoutineTransferReceipt>(
            `/routines/${encodeURIComponent(options.routineId)}/transfer`,
            'POST',
            body,
          ),
        );
      });
    },
    cancel() {
      return work(async () => {
        if (!state.requestId) return;
        const result = await scope.request<RoutineTransferResolution>(
          `/routine-transfers/${state.requestId}/cancel`,
          'POST',
          {},
        );
        ensureCurrent();
        if (result.status === 'not_transferred') {
          if (
            result.requestId !== state.requestId ||
            result.userId !== options.userId ||
            result.workspaceId !== options.workspaceId
          )
            throw Error(uiText('workspace:routineTransferInvalid'));
          keep();
          body = undefined;
          publish({ requestId: undefined, receipt: undefined, checked: false });
        } else await accept(result);
      });
    },
    acknowledge() {
      if (!current() || state.busy || !state.receipt) return false;
      try {
        keep();
        body = undefined;
        publish({ requestId: undefined, receipt: undefined, checked: false });
        return true;
      } catch (error) {
        publish({ error: (error as Error).message });
        return false;
      }
    },
  };
}
