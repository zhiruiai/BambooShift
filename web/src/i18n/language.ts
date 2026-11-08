export const LANGUAGE_STORAGE_KEY = 'openbot-language';
export const LANGUAGES = ['zh-CN', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export type LanguageState = { locale: Language; storageAvailable: boolean };
export function supportedLanguage(value: unknown): value is Language {
  return value === 'zh-CN' || value === 'en';
}
function decode(raw: string | null): Language {
  try {
    const value = raw ? JSON.parse(raw) : undefined;
    return value?.version === 1 && supportedLanguage(value.locale) ? value.locale : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}
export function createLanguageController(options: {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  apply?: (language: Language) => void;
}) {
  const listeners = new Set<() => void>();
  let disposed = false;
  let state: LanguageState = { locale: 'zh-CN', storageAvailable: !!options.storage };
  try {
    state.locale = decode(options.storage?.getItem(LANGUAGE_STORAGE_KEY) ?? null);
  } catch {
    state.storageAvailable = false;
  }
  state = Object.freeze(state);
  const publish = (locale: Language, storageAvailable: boolean) => {
    if (disposed) return;
    if (locale === state.locale && storageAvailable === state.storageAvailable) return;
    state = Object.freeze({ locale, storageAvailable });
    options.apply?.(locale);
    for (const listener of listeners) listener();
  };
  const onStorage = (event: Event) => {
    const change = event as StorageEvent;
    if (change.key !== null && change.key !== LANGUAGE_STORAGE_KEY) return;
    if (change.storageArea && change.storageArea !== options.storage) return;
    try {
      if (!options.storage) return;
      publish(decode(options.storage.getItem(LANGUAGE_STORAGE_KEY)), true);
    } catch {
      publish(state.locale, false);
    }
  };
  options.events?.addEventListener('storage', onStorage);
  options.apply?.(state.locale);
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      const subscription = () => listener();
      listeners.add(subscription);
      return () => listeners.delete(subscription);
    },
    setLanguage(locale: Language) {
      if (disposed || !supportedLanguage(locale)) return;
      let stored = !!options.storage;
      try {
        options.storage?.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify({ version: 1, locale }));
      } catch {
        stored = false;
      }
      publish(locale, stored);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      options.events?.removeEventListener('storage', onStorage);
    },
  };
}
