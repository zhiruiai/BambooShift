export type VoiceIdentity = { userId?: string; workspaceId?: string };
export type VoicePreferences = { voiceURI: string; rate: number; autoRead: boolean };
export const voicePreferenceKey = (identity: VoiceIdentity) =>
  `openbot-voice:v1:${identity.userId || 'local'}:${identity.workspaceId || 'local'}`;
const defaults = (): VoicePreferences => ({ voiceURI: '', rate: 1, autoRead: false });
function parse(raw: string | null): VoicePreferences {
  try {
    const value = raw ? JSON.parse(raw) : undefined;
    if (
      value?.version === 1 &&
      typeof value.voiceURI === 'string' &&
      value.voiceURI.length <= 1000 &&
      typeof value.rate === 'number' &&
      value.rate >= 0.5 &&
      value.rate <= 2 &&
      typeof value.autoRead === 'boolean'
    )
      return { voiceURI: value.voiceURI, rate: value.rate, autoRead: value.autoRead };
  } catch {
    /* Invalid device data never enables playback. */
  }
  return defaults();
}
export function createVoicePreferences(options: {
  identity: VoiceIdentity;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}) {
  const key = voicePreferenceKey(options.identity),
    listeners = new Set<() => void>();
  let snapshot = { ...defaults(), storageAvailable: !!options.storage };
  function read() {
    try {
      if (!options.storage) throw Error();
      snapshot = { ...parse(options.storage.getItem(key)), storageAvailable: true };
    } catch {
      snapshot = { ...snapshot, storageAvailable: false };
    }
    listeners.forEach((listener) => listener());
  }
  function onStorage(event: Event) {
    const change = event as StorageEvent;
    if (
      (change.key === null || change.key === key) &&
      (!change.storageArea || change.storageArea === options.storage)
    )
      read();
  }
  read();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) options.events?.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) options.events?.removeEventListener('storage', onStorage);
      };
    },
    update(value: Partial<VoicePreferences>) {
      const next = parse(JSON.stringify({ version: 1, ...snapshot, ...value }));
      let storageAvailable = false;
      try {
        if (!options.storage) throw Error();
        options.storage.setItem(key, JSON.stringify({ version: 1, ...next }));
        storageAvailable = true;
      } catch {
        /* Explicit preferences still work in this page only. */
      }
      snapshot = { ...next, storageAvailable };
      listeners.forEach((listener) => listener());
    },
  };
}
