import { useEffect, useRef, useState } from 'react';
import {
  libraryItemKey,
  readLibraryPins,
  type LibraryItem,
  type LibraryPin,
} from '../../conversationLibrary';
import type { FixedWorkspaceApi } from '../../fixedWorkspaceApi';

export function useLibraryPins(
  api: FixedWorkspaceApi,
  id: string,
  syncRevision?: string,
  enabled = true,
) {
  const path = `/conversations/${encodeURIComponent(id)}/library/pins`;
  const [pins, setPins] = useState<LibraryPin[]>([]);
  const [pinState, setPinState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = useState<string>();
  const [reload, setReload] = useState(0);
  const activeWrite = useRef(false);
  const lifecycle = useRef(0);
  const reads = useRef(0);
  const currentApi = useRef(api);
  currentApi.current = api;
  useEffect(() => {
    lifecycle.current++;
    return () => {
      lifecycle.current++;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const read = ++reads.current;
    let current = true;
    const timer = window.setTimeout(() => {
      if (activeWrite.current) return;
      void currentApi
        .current(path)
        .then(readLibraryPins)
        .then((value) => {
          if (!current || read !== reads.current) return;
          setPins(value);
          setPinState('ready');
        })
        .catch(() => {
          if (current && read === reads.current) setPinState('error');
        });
    }, 120);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [enabled, path, reload, syncRevision]);

  function onRetry() {
    setPinState('loading');
    setReload((value) => value + 1);
  }

  async function onPin(item: LibraryItem, pinned: boolean) {
    if (!enabled || pinState !== 'ready' || activeWrite.current) return;
    const current = lifecycle.current;
    const key = libraryItemKey(item);
    reads.current++;
    activeWrite.current = true;
    setSaving(key);
    try {
      const pins = readLibraryPins(
        await api(path, 'PUT', {
          kind: item.kind,
          target: item.target,
          pinned,
          ...(item.kind === 'link' && pinned ? { messageId: item.messageId } : {}),
        }),
      );
      if (pins.some((pin) => libraryItemKey(pin) === key) !== pinned)
        throw new Error('Unexpected library pin response');
      if (lifecycle.current === current) {
        setPins(pins);
        setReload((value) => value + 1);
      }
    } catch {
      if (lifecycle.current === current) setPinState('error');
    } finally {
      activeWrite.current = false;
      if (lifecycle.current === current) setSaving(undefined);
    }
  }

  return { pins, pinState, saving, onPin, onRetry };
}
