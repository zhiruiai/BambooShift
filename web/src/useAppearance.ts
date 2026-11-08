import { useSyncExternalStore } from 'react';
import { initializeAppearance } from './appearance';

export function useAppearance() {
  const store = initializeAppearance();
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return { ...snapshot, update: store.update };
}
