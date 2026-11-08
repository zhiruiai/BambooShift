import test from 'node:test';
import assert from 'node:assert/strict';
import { browserNotificationTransport } from './notificationTransport';

function install(name: string, value: unknown) {
  const old = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (old) Object.defineProperty(globalThis, name, old);
    else Reflect.deleteProperty(globalThis, name);
  };
}
const identity = { userId: 'user-a', workspaceId: '00000000-0000-4000-8000-000000000001' };
const notice = {
  eventId: 'bot-a:completed:run-a',
  title: 'Synthetic Bot · Task complete',
  body: '' as const,
};

test('browser notification transport requires a grant and active scope, never auto-requests, and clicks only focus the current page', async () => {
  let requested = 0,
    focused = 0,
    active = true;
  const displayed: FakeNotification[] = [];
  class FakeNotification {
    static permission: NotificationPermission = 'default';
    static async requestPermission() {
      requested++;
      return FakeNotification.permission;
    }
    onclick?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    closed = false;
    constructor(
      readonly title: string,
      readonly options: NotificationOptions,
    ) {
      displayed.push(this);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
  }
  const restoreNotification = install('Notification', FakeNotification),
    restoreWindow = install('window', { focus: () => focused++ });
  try {
    const transport = browserNotificationTransport(identity);
    assert.equal(await transport.permission(), 'default');
    assert.equal(requested, 0);
    await transport.show(notice, () => active);
    assert.equal(displayed.length, 0);
    FakeNotification.permission = 'granted';
    await transport.show(notice, () => active);
    assert.equal(displayed.length, 1);
    assert.deepEqual(displayed[0].options, { body: '', tag: notice.eventId });
    displayed[0].onclick?.();
    assert.equal(focused, 1);
    assert.equal(displayed[0].closed, true);
    await transport.show(notice, () => active);
    active = false;
    displayed[1].onclick?.();
    assert.equal(focused, 1);
    await transport.show(notice, () => active);
    assert.equal(displayed.length, 2);
    await transport.clear();
    assert.ok(displayed.every((n) => n.closed));
    assert.equal(requested, 0);
  } finally {
    restoreNotification();
    restoreWindow();
  }
});

test('native notification permission is explicit and scope-bound; a rejected native show cannot fall back to browser notification', async () => {
  let requests = 0,
    browserShows = 0,
    clears = 0;
  const calls: unknown[] = [];
  const restoreNotification = install(
    'Notification',
    class {
      static permission = 'granted';
      constructor() {
        browserShows++;
      }
    },
  );
  const restoreWindow = install('window', {
    openbotNotifications: {
      permission: async (scope: unknown) => {
        calls.push(scope);
        return 'prompt';
      },
      requestPermission: async (scope: unknown) => {
        requests++;
        calls.push(scope);
        return 'granted';
      },
      show: async (value: unknown) => {
        calls.push(value);
        return false;
      },
      clear: async (scope: unknown) => {
        clears++;
        calls.push(scope);
      },
    },
  });
  try {
    const transport = browserNotificationTransport(identity);
    assert.equal(await transport.permission(), 'default');
    assert.equal(requests, 0);
    assert.equal(await transport.requestPermission(), 'granted');
    assert.equal(requests, 1);
    await assert.rejects(transport.show(notice, () => true));
    assert.equal(browserShows, 0);
    assert.deepEqual(calls[2], {
      workspaceId: identity.workspaceId,
      expectedUser: identity.userId,
      ...notice,
    });
    await transport.clear();
    assert.equal(clears, 1);
  } finally {
    restoreNotification();
    restoreWindow();
  }
});
