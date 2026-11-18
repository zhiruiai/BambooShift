import i18next, { type Resource } from 'i18next';
import { createLanguageController, type Language } from './language';
import type { UiTextKey } from './index';

const i18n = i18next.createInstance();
void i18n.init({
  resources: {},
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  defaultNS: 'common',
  supportedLngs: ['zh-CN', 'en'],
  interpolation: { escapeValue: false },
  initAsync: false,
});

const loaded = new WeakSet<object>();

export function registerCatalog(catalog: Resource, locale: Language) {
  const namespaces = catalog[locale];
  if (loaded.has(namespaces)) return;
  for (const [name, messages] of Object.entries(namespaces)) {
    i18n.addResourceBundle(locale, name, messages);
  }
  loaded.add(namespaces);
}

export function translate(catalog: Resource, key: UiTextKey, values?: Record<string, unknown>) {
  const lng = currentLanguage();
  registerCatalog(catalog, lng);
  return i18n.t(key, { ...values, lng }) as string;
}

export type CatalogKey<T> = {
  [N in keyof T & string]: `${N}:${keyof T[N] & string}`;
}[keyof T & string];

let controller: ReturnType<typeof createLanguageController> | undefined;
export function initializeLanguage() {
  if (controller) return controller;
  let storage: Storage | undefined;
  try {
    storage = typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    // Device storage may be blocked; in-memory language selection remains available.
  }
  controller = createLanguageController({
    storage,
    events:
      typeof window !== 'undefined' && typeof window.addEventListener === 'function'
        ? window
        : undefined,
    apply: (locale) => {
      if (typeof document !== 'undefined' && document.documentElement)
        document.documentElement.lang = locale;
      void i18n.changeLanguage(locale);
    },
  });
  return controller;
}
export const currentLanguage = (): Language => initializeLanguage().getSnapshot().locale;
export const languageHeaders = () => ({ 'Accept-Language': currentLanguage() });
export function formatDate(value: Date | string | number, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(currentLanguage(), options).format(new Date(value));
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(currentLanguage(), options).format(value);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    controller?.dispose();
    controller = undefined;
  });
}

/** Resolve static UI option catalogs at render time without altering stored domain values. */
export function localizedData<T extends object>(factory: () => T): T {
  const sample = factory();
  const target = Array.isArray(sample) ? [] : {};
  return new Proxy(target, {
    get: (_target, property) => {
      const value = factory();
      const member = Reflect.get(value, property);
      return typeof member === 'function' ? member.bind(value) : member;
    },
    ownKeys: () => Reflect.ownKeys(factory()),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Object.getOwnPropertyDescriptor(factory(), property);
      return descriptor && { ...descriptor, configurable: property !== 'length' };
    },
  }) as T;
}
