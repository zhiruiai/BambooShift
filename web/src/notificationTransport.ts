export type NotificationIdentity = { userId?: string; workspaceId?: string };
export type NotificationPermissionState = NotificationPermission | 'unsupported';
export type NotificationNotice = { eventId: string; title: string; body: '' };
export type NativeNotificationScope = { workspaceId: string; expectedUser: string };
export interface NativeNotifications {
  permission(
    scope: NativeNotificationScope,
  ): Promise<'prompt' | 'granted' | 'denied' | 'unsupported'>;
  requestPermission(
    scope: NativeNotificationScope,
  ): Promise<'prompt' | 'granted' | 'denied' | 'unsupported'>;
  show(notice: NativeNotificationScope & NotificationNotice): Promise<boolean>;
  clear(scope: NativeNotificationScope): Promise<unknown>;
}
declare global {
  interface Window {
    openbotNotifications?: NativeNotifications;
  }
}
export function browserNotificationTransport(identity: NotificationIdentity) {
  const native = typeof window !== 'undefined' ? window.openbotNotifications : undefined;
  const BrowserNotification = typeof Notification === 'undefined' ? undefined : Notification;
  const scope = { workspaceId: identity.workspaceId || '', expectedUser: identity.userId || '' };
  const shown = new Set<Notification>();
  return {
    async permission(): Promise<NotificationPermissionState> {
      const permission = native
        ? await native.permission(scope)
        : BrowserNotification?.permission || 'unsupported';
      return permission === 'prompt' ? 'default' : permission;
    },
    async requestPermission(): Promise<NotificationPermissionState> {
      const permission = native
        ? await native.requestPermission(scope)
        : BrowserNotification
          ? await BrowserNotification.requestPermission()
          : 'unsupported';
      return permission === 'prompt' ? 'default' : permission;
    },
    async show(notice: NotificationNotice, current: () => boolean) {
      if (!current()) return;
      if (native) {
        if (!(await native.show({ ...scope, ...notice })) && current())
          throw Error('Notification unavailable');
        return;
      }
      if (!BrowserNotification || BrowserNotification.permission !== 'granted') return;
      const notification = new BrowserNotification(notice.title, { body: '', tag: notice.eventId });
      shown.add(notification);
      notification.onclick = () => {
        if (current()) window.focus();
        notification.close();
      };
      notification.onclose = () => shown.delete(notification);
      notification.onerror = () => shown.delete(notification);
    },
    clear() {
      shown.forEach((notification) => notification.close());
      shown.clear();
      return native
        ? native.clear(scope).then(
            () => {},
            () => {},
          )
        : Promise.resolve();
    },
  };
}
