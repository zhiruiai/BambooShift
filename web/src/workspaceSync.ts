import { uiText } from './i18n';
import type { Bootstrap, Message, SyncToken } from '../../shared/types';

export type SyncState = { phase: 'connecting' | 'syncing' | 'online' | 'offline'; error: string };
export function syncToken(value: unknown): SyncToken | null {
  if (!value || typeof value !== 'object') return null;
  const token = value as SyncToken;
  return typeof token.epoch === 'string' &&
    token.epoch.length > 0 &&
    token.epoch.length <= 80 &&
    Number.isSafeInteger(token.revision) &&
    token.revision >= 0
    ? { epoch: token.epoch, revision: token.revision }
    : null;
}
export function eventToken(id: string): SyncToken | null {
  const split = id.lastIndexOf(':');
  if (split < 1 || !/^\d+$/.test(id.slice(split + 1))) return null;
  return syncToken({ epoch: id.slice(0, split), revision: Number(id.slice(split + 1)) });
}

/** One workspace subscription. Stream IDs protect GET snapshots; they are not a replay log. */
export function createWorkspaceSync(options: {
  fetch: (signal: AbortSignal) => Promise<Bootstrap>;
  snapshot: (data: Bootstrap) => void;
  message: (message: Message) => void;
  status: (state: SyncState) => void;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const schedule = options.schedule || setTimeout,
    cancel = options.cancel || clearTimeout;
  let stopped = false,
    connected = false,
    handshaken = false,
    generation = 0;
  let latest: SyncToken | null = null,
    snapshotRevision = -1,
    hasSnapshot = false;
  let inflight: Promise<void> | null = null,
    controller: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined,
    failures = 0,
    dirty = false,
    exhausted = false;
  let state: SyncState = { phase: 'connecting', error: '' };
  const publish = (phase: SyncState['phase'], error = '') => {
    state = { phase, error };
    if (!stopped) options.status(state);
  };
  const clearRetry = () => {
    if (retry !== undefined) cancel(retry);
    retry = undefined;
  };
  const later = (delay: number) => {
    if (stopped || retry !== undefined) return;
    retry = schedule(() => {
      retry = undefined;
      void refresh(false);
    }, delay);
  };
  function refresh(manual = true): Promise<void> {
    if (stopped) return Promise.resolve();
    if (manual) {
      failures = 0;
      exhausted = false;
      clearRetry();
    }
    if (!manual && exhausted) return Promise.resolve();
    if (inflight) {
      dirty = true;
      return inflight;
    }
    if (!manual && retry !== undefined) return Promise.resolve();
    clearRetry();
    dirty = false;
    const requestGeneration = generation;
    const abort = new AbortController();
    controller = abort;
    const timeout = schedule(() => abort.abort(), 15000);
    if (state.phase !== 'online') publish(connected ? 'syncing' : 'connecting', state.error);
    inflight = (async () => {
      try {
        const data = await options.fetch(abort.signal);
        if (stopped || requestGeneration !== generation) return;
        const token = syncToken(data.sync);
        if (!token) throw new Error(uiText('common:text_2b2eb00f54d0'));
        // A fresh handshake is the authority after a server restart. An old HTTP
        // response must neither change epochs nor overwrite a newer stream delta.
        if (latest && (latest.epoch !== token.epoch || latest.revision > token.revision)) {
          throw new Error(
            latest.epoch !== token.epoch
              ? uiText('common:text_4592a970a45e')
              : uiText('common:text_83711b70b1a8'),
          );
        }
        latest = token;
        snapshotRevision = token.revision;
        hasSnapshot = true;
        failures = 0;
        options.snapshot(data);
        publish(connected && handshaken ? 'online' : 'offline');
      } catch (error) {
        if (stopped || requestGeneration !== generation) return;
        const message = abort.signal.aborted
          ? uiText('common:text_5f7889656010')
          : (error as Error).message;
        publish('offline', message || uiText('common:text_1e861520e421'));
        // Only reads are retried. A mutation is never replayed by this coordinator.
        dirty = false;
        if (failures < 5) later([750, 1500, 3000, 6000, 12000][failures++]);
        else exhausted = true;
      } finally {
        cancel(timeout);
        if (controller === abort) controller = null;
        inflight = null;
        if (!stopped && dirty) later(150);
      }
    })();
    return inflight;
  }
  return {
    refresh,
    written() {
      if (stopped) return;
      // A mutation receipt has no stream revision. A GET started before it may
      // omit this committed write even when no SSE event has reached us yet.
      generation++;
      controller?.abort();
      publish(connected && handshaken ? 'syncing' : 'offline', state.error);
      void refresh();
    },
    opened() {
      if (!stopped) {
        connected = true;
        handshaken = false;
        publish('syncing');
      }
    },
    handshake(value: unknown) {
      if (stopped) return;
      const token = syncToken(value);
      if (!token) {
        publish('offline', uiText('common:text_8af133b51dfa'));
        return;
      }
      generation++;
      latest = latest?.epoch === token.epoch && latest.revision > token.revision ? latest : token;
      snapshotRevision = -1;
      connected = true;
      handshaken = true;
      publish('syncing');
      controller?.abort();
      void refresh();
    },
    event(kind: 'message' | 'update', id: string, message?: Message) {
      if (stopped || !handshaken) return;
      const token = eventToken(id);
      if (!token || !latest || token.epoch !== latest.epoch) {
        publish('offline', uiText('common:text_6f55b2b9740f'));
        void refresh(false);
        return;
      }
      if (token.revision <= latest.revision) return;
      const gap = token.revision > latest.revision + 1;
      latest = token;
      if (kind === 'message' && message) options.message(message);
      if (gap) publish('syncing', uiText('common:text_005ba2559638'));
      if (kind === 'update' || gap || !hasSnapshot || snapshotRevision < 0) void refresh(false);
    },
    disconnected() {
      if (stopped) return;
      connected = false;
      handshaken = false;
      generation++;
      controller?.abort();
      publish('offline', uiText('common:text_ee5304101fa5'));
    },
    stop() {
      stopped = true;
      generation++;
      clearRetry();
      controller?.abort();
    },
  };
}
