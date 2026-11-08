import { useEffect, useRef, useState } from 'react';
import { createPrimaryBotScope } from './primaryBot';
import { notificationKey, notificationPreferences } from './notificationPreferences';
import { createNotificationEvents } from './notificationEvents';
import type { NotificationIdentity } from './notificationTransport';

export function useNotificationSettings(props: NotificationIdentity & { active?: boolean }) {
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createPrimaryBotScope({ ...props, identity: () => latest.current }),
  );
  const [store] = useState(() => notificationPreferences(props));
  const [snapshot, setSnapshot] = useState(store.getSnapshot);
  useEffect(() => {
    scope.resume();
    const release = store.subscribe(() => {
      if (scope.current(scope.ticket())) setSnapshot(store.getSnapshot());
    });
    setSnapshot(store.getSnapshot());
    return () => {
      release();
      scope.suspend();
    };
  }, [scope, store, props.userId, props.workspaceId]);
  const current = () => scope.current(scope.ticket()) && latest.current.active !== false;
  return {
    ...snapshot,
    store,
    current,
    update: (value: Parameters<typeof store.update>[0]) => {
      if (current()) store.update(value);
    },
    requestPermission: () => store.requestPermission(current),
    refresh: () => {
      if (current()) store.refresh();
    },
  };
}
export function useWorkspaceNotifications(props: NotificationIdentity & { isOwner: boolean }) {
  const settings = useNotificationSettings(props);
  const latest = useRef(props);
  latest.current = props;
  const [events] = useState(() =>
    createNotificationEvents({
      identity: props,
      preferences: settings.store,
      current: settings.current,
      isOwner: () => latest.current.isOwner,
      exclusive:
        typeof navigator !== 'undefined' && navigator.locks
          ? (work) => navigator.locks.request(notificationKey(props), work)
          : undefined,
      background: () =>
        document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus()),
    }),
  );
  useEffect(() => {
    events.resume();
    const names = ['openbot:account-expired', 'openbot:unpaired', 'openbot:revalidate'];
    names.forEach((name) => window.addEventListener?.(name, events.invalidate));
    return () => {
      events.suspend();
      names.forEach((name) => window.removeEventListener?.(name, events.invalidate));
    };
  }, [events, props.userId, props.workspaceId]);
  return events;
}
