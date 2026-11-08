import { useEffect, useRef, useState } from 'react';
import type { Bootstrap, Message } from '../../shared/types';
import { createWorkspaceSnapshotSource } from './workspaceSnapshot';
import { createWorkspaceSync, type SyncState } from './workspaceSync';

export function useWorkspaceSync(callbacks: {
  workspaceId?: string;
  userId?: string;
  snapshot: (data: Bootstrap) => void;
  message: (message: Message) => void;
}) {
  const latest = useRef(callbacks);
  latest.current = callbacks;
  const controller = useRef<ReturnType<typeof createWorkspaceSync> | null>(null);
  const [state, setState] = useState<SyncState>({ phase: 'connecting', error: '' });
  useEffect(() => {
    const workspaceId = callbacks.workspaceId;
    const source = createWorkspaceSnapshotSource({
      workspaceId,
      userId: callbacks.userId,
      identity: () => latest.current,
      onAuthFailure: (status) => {
        if (status === 401)
          window.dispatchEvent(
            new Event(workspaceId ? 'openbot:account-expired' : 'openbot:unpaired'),
          );
        if (status === 403 && workspaceId) window.dispatchEvent(new Event('openbot:revalidate'));
      },
    });
    const sync = createWorkspaceSync({
      fetch: source.read,
      snapshot: (data) => {
        if (source.current()) latest.current.snapshot(data);
      },
      message: (message) => {
        if (source.current()) latest.current.message(message);
      },
      status: (value) => {
        if (source.current()) setState(value);
      },
    });
    controller.current = sync;
    void sync.refresh();
    const stream = new EventSource(
      workspaceId ? `/api/workspaces/${encodeURIComponent(workspaceId)}/events` : '/api/events',
    );
    stream.onopen = () => sync.opened();
    stream.addEventListener('sync', (event) => {
      try {
        sync.handshake(JSON.parse(event.data));
      } catch {
        sync.handshake(null);
      }
    });
    stream.addEventListener('update', (event) => sync.event('update', event.lastEventId));
    stream.addEventListener('message', (event) => {
      try {
        sync.event('message', event.lastEventId, JSON.parse(event.data) as Message);
      } catch {
        void sync.refresh();
      }
    });
    stream.onerror = () => {
      sync.disconnected();
      if (source.current()) window.dispatchEvent(new Event('openbot:revalidate'));
    };
    let lastRefresh = 0;
    const resume = () => {
      if (!source.current() || document.hidden || Date.now() - lastRefresh < 5000) return;
      lastRefresh = Date.now();
      void sync.refresh();
    };
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      sync.stop();
      stream.close();
      controller.current = null;
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  return {
    ...state,
    refresh: () => controller.current?.refresh() || Promise.resolve(),
    written: () => controller.current?.written(),
  };
}
