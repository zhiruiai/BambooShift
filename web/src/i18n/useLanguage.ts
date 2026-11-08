import { useSyncExternalStore } from 'react';
import { useTranslation as useReactTranslation } from 'react-i18next';
import { i18n, initializeLanguage, type UiNamespace } from './index';

export function useLanguage() {
  const store = initializeLanguage();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...state, setLanguage: store.setLanguage };
}
export function useTranslation<N extends UiNamespace>(namespace: N) {
  return useReactTranslation(namespace, { i18n });
}
