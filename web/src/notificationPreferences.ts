import {
  browserNotificationTransport,
  type NotificationIdentity,
  type NotificationPermissionState,
} from './notificationTransport';

export type NotificationPreferences = {
  enabled: boolean;
  completed: boolean;
  approvals: boolean;
  mutedBots: string[];
};
export type NotificationSettings = NotificationPreferences & {
  storageAvailable: boolean;
  permission: NotificationPermissionState;
  requesting: boolean;
  failed: boolean;
};
const defaults = (): NotificationPreferences => ({
  enabled: false,
  completed: true,
  approvals: true,
  mutedBots: [],
});
export const notificationKey = (identity: NotificationIdentity) =>
  `openbot-notifications:v1:${encodeURIComponent(identity.userId || '')}:${encodeURIComponent(identity.workspaceId || '')}`;
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function parse(raw: string | null): NotificationPreferences {
  if (!raw) return defaults();
  try {
    const value = JSON.parse(raw);
    if (
      value.version !== 1 ||
      ['enabled', 'completed', 'approvals'].some((key) => typeof value[key] !== 'boolean') ||
      !Array.isArray(value.mutedBots) ||
      value.mutedBots.length > 5000 ||
      !value.mutedBots.every(id)
    )
      return defaults();
    return {
      enabled: value.enabled,
      completed: value.completed,
      approvals: value.approvals,
      mutedBots: [...new Set<string>(value.mutedBots)],
    };
  } catch {
    return defaults();
  }
}
export function createNotificationPreferences(options: {
  identity: NotificationIdentity;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  transport: ReturnType<typeof browserNotificationTransport>;
}) {
  const key = notificationKey(options.identity),
    seenKey = `${key}:seen`;
  const listeners = new Set<() => void>();
  let snapshot: NotificationSettings = {
    ...defaults(),
    storageAvailable: !!options.storage,
    permission: 'default',
    requesting: false,
    failed: false,
  };
  let epoch = 0,
    permissionSequence = 0;
  const publish = (update: Partial<NotificationSettings>) => {
    snapshot = { ...snapshot, ...update };
    listeners.forEach((listener) => listener());
  };
  const read = () => {
    try {
      if (!options.storage) throw Error();
      publish({ ...parse(options.storage.getItem(key)) });
    } catch {
      publish({ storageAvailable: false });
    }
  };
  async function permission() {
    if (snapshot.requesting) return;
    const version = epoch,
      sequence = ++permissionSequence;
    try {
      const value = await options.transport.permission();
      if (version === epoch && sequence === permissionSequence) publish({ permission: value });
    } catch {
      if (version === epoch && sequence === permissionSequence)
        publish({ permission: 'default', failed: true });
    }
  }
  const onStorage = (event: Event) => {
    const change = event as StorageEvent;
    if (change.key !== null && change.key !== key) return;
    if (change.storageArea && change.storageArea !== options.storage) return;
    read();
    if (!snapshot.enabled) options.transport.clear();
  };
  const onFocus = () => {
    read();
    void permission();
  };
  read();
  return {
    transport: options.transport,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        epoch++;
        options.events?.addEventListener('storage', onStorage);
        options.events?.addEventListener('focus', onFocus);
        onFocus();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          epoch++;
          options.events?.removeEventListener('storage', onStorage);
          options.events?.removeEventListener('focus', onFocus);
          snapshot = { ...snapshot, requesting: false };
        }
      };
    },
    update(update: Partial<NotificationPreferences>) {
      const next = {
        enabled: snapshot.enabled,
        completed: snapshot.completed,
        approvals: snapshot.approvals,
        mutedBots: snapshot.mutedBots,
        ...update,
      };
      try {
        if (!options.storage) throw Error();
        options.storage.setItem(key, JSON.stringify({ version: 1, ...next }));
        publish({ ...next, storageAvailable: true, failed: false });
        if (!next.enabled) void options.transport.clear().then(() => permission());
        return true;
      } catch {
        publish({ storageAvailable: false });
        return false;
      }
    },
    async requestPermission(current: () => boolean) {
      if (
        !current() ||
        snapshot.requesting ||
        !snapshot.enabled ||
        !snapshot.storageAvailable ||
        ['granted', 'unsupported'].includes(snapshot.permission)
      )
        return;
      const version = epoch,
        sequence = ++permissionSequence;
      publish({ requesting: true, failed: false });
      try {
        const value = await options.transport.requestPermission();
        if (current() && version === epoch && sequence === permissionSequence)
          publish({ permission: value });
      } catch {
        if (current() && version === epoch) publish({ failed: true });
      } finally {
        if (version === epoch) publish({ requesting: false });
      }
    },
    claim(eventId: string) {
      try {
        if (!options.storage) throw Error();
        const raw = options.storage.getItem(seenKey);
        const value = raw ? JSON.parse(raw) : { version: 1, events: [] };
        if (
          value.version !== 1 ||
          !Array.isArray(value.events) ||
          value.events.some((event: unknown) => typeof event !== 'string' || event.length > 600)
        )
          throw Error();
        if (value.events.includes(eventId)) return false;
        if (value.events.length >= 10000) throw Error();
        options.storage.setItem(
          seenKey,
          JSON.stringify({ version: 1, events: [...value.events, eventId] }),
        );
        return true;
      } catch {
        publish({ storageAvailable: false });
        return false;
      }
    },
    failure() {
      publish({ failed: true });
    },
    refresh() {
      read();
      try {
        if (!options.storage) throw Error();
        options.storage.setItem(
          key,
          JSON.stringify({
            version: 1,
            enabled: snapshot.enabled,
            completed: snapshot.completed,
            approvals: snapshot.approvals,
            mutedBots: snapshot.mutedBots,
          }),
        );
        publish({ storageAvailable: true });
      } catch {
        publish({ storageAvailable: false });
      }
      void permission();
    },
    refreshPermission: permission,
    dispose() {
      epoch++;
      options.events?.removeEventListener('storage', onStorage);
      options.events?.removeEventListener('focus', onFocus);
      listeners.clear();
      options.transport.clear();
    },
  };
}
const stores = new Map<string, ReturnType<typeof createNotificationPreferences>>();
export function notificationPreferences(identity: NotificationIdentity) {
  const key = notificationKey(identity);
  if (!stores.has(key)) {
    let storage: Storage | undefined;
    try {
      storage = typeof window === 'undefined' ? undefined : window.localStorage;
    } catch {
      /* Device storage can be unavailable. */
    }
    stores.set(
      key,
      createNotificationPreferences({
        identity,
        storage,
        events:
          typeof window === 'undefined' || typeof window.addEventListener !== 'function'
            ? undefined
            : window,
        transport: browserNotificationTransport(identity),
      }),
    );
  }
  return stores.get(key)!;
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stores.forEach((store) => store.dispose());
    stores.clear();
  });
