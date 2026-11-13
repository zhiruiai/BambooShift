import { AVATAR_THEMES, avatarTheme, type AvatarTheme } from './avatarThemes';
import { generatedAvatarTheme, type GeneratedAvatarTheme } from './creationPreview';
import { managedAppearanceStorage, type AppearanceStorage } from './managedAppearance';

export type AppearancePreferences = {
  theme: 'system' | 'light' | 'dark';
  accent: 'bot' | 'neutral';
  spellCheck: boolean;
  avatarTheme: AvatarTheme;
  customAvatarTheme?: GeneratedAvatarTheme;
  useCustomAvatarTheme?: boolean;
};
export type AppearanceSnapshot = Readonly<
  AppearancePreferences & {
    resolvedTheme: 'light' | 'dark';
    storageAvailable: boolean;
  }
>;
export const APPEARANCE_STORAGE_KEY = 'openbot-appearance';
const defaults: Readonly<AppearancePreferences> = Object.freeze({
  theme: 'system',
  accent: 'bot',
  spellCheck: true,
  avatarTheme: 'companions',
});
const serverSnapshot: AppearanceSnapshot = Object.freeze({
  ...defaults,
  resolvedTheme: 'light',
  storageAvailable: false,
});
type StorageAccess = AppearanceStorage;
type AppearanceMedia = {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
};
type AppearanceRoot = {
  dataset: { theme?: string; accent?: string };
  style: Pick<CSSStyleDeclaration, 'colorScheme'>;
  spellcheck: boolean;
};
type AppearanceEnvironment = {
  storage?: StorageAccess;
  storageEvents?: EventTarget;
  media?: AppearanceMedia;
  root?: AppearanceRoot;
  themeColor?: Pick<HTMLMetaElement, 'content'>;
};
function preferences(value: unknown): AppearancePreferences | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  const custom = generatedAvatarTheme(data.customAvatarTheme);
  if (
    typeof data.theme !== 'string' ||
    !['system', 'light', 'dark'].includes(data.theme) ||
    typeof data.accent !== 'string' ||
    !['bot', 'neutral'].includes(data.accent) ||
    typeof data.spellCheck !== 'boolean' ||
    (data.avatarTheme !== undefined && !AVATAR_THEMES.includes(data.avatarTheme as AvatarTheme))
  )
    return;
  return {
    theme: data.theme as AppearancePreferences['theme'],
    accent: data.accent as AppearancePreferences['accent'],
    spellCheck: data.spellCheck,
    avatarTheme: avatarTheme(data.avatarTheme),
    ...(custom
      ? { customAvatarTheme: custom, useCustomAvatarTheme: data.useCustomAvatarTheme === true }
      : {}),
  };
}
function parseStored(raw: string | null): AppearancePreferences {
  if (!raw || raw.length > 2048) return { ...defaults };
  try {
    const data = JSON.parse(raw);
    if (data?.version !== 1) return { ...defaults };
    return preferences(data) || { ...defaults };
  } catch {
    return { ...defaults };
  }
}
function validStored(raw: string): boolean {
  try {
    const value = JSON.parse(raw);
    return (
      value?.version === 1 &&
      Object.keys(value).every((key) =>
        [
          'version',
          'theme',
          'accent',
          'spellCheck',
          'avatarTheme',
          'customAvatarTheme',
          'useCustomAvatarTheme',
        ].includes(key),
      ) &&
      (value.customAvatarTheme === undefined || !!generatedAvatarTheme(value.customAvatarTheme)) &&
      (value.useCustomAvatarTheme === undefined ||
        typeof value.useCustomAvatarTheme === 'boolean') &&
      !!preferences(value)
    );
  } catch {
    return false;
  }
}

/** One device-wide store; callers own disposal when creating a non-singleton instance. */
export function createAppearanceStore(environment: AppearanceEnvironment = {}) {
  let storage: StorageAccess | undefined;
  let media: AppearanceMedia | undefined;
  let initial = { ...defaults },
    storageAvailable = false;
  try {
    storage =
      environment.storage ??
      managedAppearanceStorage(APPEARANCE_STORAGE_KEY, validStored) ??
      (typeof window === 'undefined' ? undefined : window.localStorage);
    if (storage) {
      initial = parseStored(storage.getItem(APPEARANCE_STORAGE_KEY));
      storageAvailable = storage.available !== false;
    }
  } catch {
    /* Storage can be denied while this page remains fully usable. */
  }
  try {
    media =
      environment.media ??
      (typeof window === 'undefined'
        ? undefined
        : window.matchMedia('(prefers-color-scheme: dark)'));
  } catch {
    /* An unsupported system preference falls back to light. */
  }
  const root =
    environment.root ?? (typeof document === 'undefined' ? undefined : document.documentElement);
  const themeColor =
    environment.themeColor ??
    (typeof document === 'undefined'
      ? undefined
      : document.querySelector?.<HTMLMetaElement>('meta[name="theme-color"]'));
  const events = environment.storageEvents ?? (typeof window === 'undefined' ? undefined : window);
  const listeners = new Set<() => void>();
  let disposed = false;
  const resolved = (theme: AppearancePreferences['theme']) =>
    theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme;
  let snapshot: AppearanceSnapshot = Object.freeze({
    ...initial,
    resolvedTheme: resolved(initial.theme),
    storageAvailable,
  });
  function apply() {
    if (!root) return;
    root.dataset.theme = snapshot.resolvedTheme;
    root.dataset.accent = snapshot.accent;
    root.style.colorScheme = snapshot.resolvedTheme;
    root.spellcheck = snapshot.spellCheck;
    // Match theme.css --bg-canvas so mobile browser chrome follows the current page.
    if (themeColor) themeColor.content = snapshot.resolvedTheme === 'dark' ? '#141318' : '#f4f5f6';
  }
  function publish(value: AppearancePreferences, available = snapshot.storageAvailable) {
    if (disposed) return;
    const next: AppearanceSnapshot = {
      ...value,
      resolvedTheme: resolved(value.theme),
      storageAvailable: available,
    };
    if (
      next.theme === snapshot.theme &&
      next.accent === snapshot.accent &&
      next.spellCheck === snapshot.spellCheck &&
      next.avatarTheme === snapshot.avatarTheme &&
      next.useCustomAvatarTheme === snapshot.useCustomAvatarTheme &&
      JSON.stringify(next.customAvatarTheme) === JSON.stringify(snapshot.customAvatarTheme) &&
      next.resolvedTheme === snapshot.resolvedTheme &&
      next.storageAvailable === snapshot.storageAvailable
    )
      return;
    snapshot = Object.freeze(next);
    apply();
    for (const listener of [...listeners]) listener();
  }
  const onMedia = () => publish(snapshot);
  const onStorage = (event: Event) => {
    const change = event as StorageEvent;
    if (
      (change.key !== APPEARANCE_STORAGE_KEY && change.key !== null) ||
      (change.storageArea && change.storageArea !== storage)
    )
      return;
    if (!storage) {
      publish(snapshot, false);
      return;
    }
    let latest: AppearancePreferences;
    try {
      // Events can be queued before a newer local write, including storage.clear().
      latest = parseStored(storage.getItem(APPEARANCE_STORAGE_KEY));
    } catch {
      publish(snapshot, false);
      return;
    }
    publish(latest, storage.available !== false);
  };
  apply();
  media?.addEventListener('change', onMedia);
  events?.addEventListener('storage', onStorage);
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      // Each registration has its own unsubscribe, even for repeated callbacks.
      const notify = () => listener();
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    update(patch: Partial<AppearancePreferences>) {
      if (
        disposed ||
        !patch ||
        typeof patch !== 'object' ||
        Object.keys(patch).some(
          (key) =>
            ![
              'theme',
              'accent',
              'spellCheck',
              'avatarTheme',
              'customAvatarTheme',
              'useCustomAvatarTheme',
            ].includes(key),
        )
      )
        return;
      if (patch.customAvatarTheme !== undefined && !generatedAvatarTheme(patch.customAvatarTheme))
        return;
      const next = preferences({ ...snapshot, ...patch });
      if (!next) return;
      let available = false;
      try {
        if (storage) {
          storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, ...next }));
          available = true;
        }
      } catch {
        /* Keep the chosen appearance in memory when persistence is unavailable. */
      }
      publish(next, available);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      media?.removeEventListener('change', onMedia);
      events?.removeEventListener('storage', onStorage);
      listeners.clear();
    },
  };
}
export type AppearanceStore = ReturnType<typeof createAppearanceStore>;
let singleton: AppearanceStore | undefined;
/** Call before the first React render so browser controls and page colors agree immediately. */
export function initializeAppearance() {
  return (singleton ||= createAppearanceStore());
}
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    singleton?.dispose();
    singleton = undefined;
  });
}
