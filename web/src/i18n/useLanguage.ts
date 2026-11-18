import { useSyncExternalStore } from 'react';
import { initializeLanguage } from './index';

export function useLanguage() {
  const store = initializeLanguage();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...state, setLanguage: store.setLanguage };
}
