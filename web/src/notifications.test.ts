import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fixture,
  storage,
  snapshot,
  input,
  completed,
  approval,
  identity,
} from './testSupport/notificationsFixture';
import { createNotificationPreferences, notificationKey } from './notificationPreferences';
import { initializeLanguage } from './i18n';
import { createNotificationEvents } from './notificationEvents';
import { deferred } from './testSupport/memoryImportSettingsFixture';

test('disabled by default; history and repeated tool turns never produce catch-up or duplicate notifications', async () => {
  const f = await fixture();
  try {
    f.events.baseline(snapshot([input(), completed('history')]));
    f.events.receive(completed('history'));
    f.events.receive(completed('off'));
    assert.equal(f.notices.length, 0);
    assert.equal(f.requested, 0);
    f.prefs.update({ enabled: true });
    f.events.receive(completed('off'));
    f.events.receive(completed('live'));
    f.events.receive({ ...completed('live'), id: 'another-tool-turn' });
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0].title, /Synthetic Bot.*任务完成/);
    assert.equal(f.notices[0].body, '');
    assert.doesNotMatch(
      JSON.stringify(f.notices) + [...f.saved.values.values()].join(''),
      /PRIVATE|SECRET/,
    );
  } finally {
    f.dispose();
  }
});

test('only a requester can receive pending approval alerts, including computer cards without an embedded conversation ID', async () => {
  for (const owner of [false, true]) {
    const f = await fixture({ owner });
    try {
      f.prefs.update({ enabled: true });
      f.events.baseline(snapshot());
      f.events.receive(approval('other-user'));
      f.events.receive(approval(null, true));
      assert.equal(f.notices.length, 0);
      f.events.receive({
        ...approval(identity.userId),
        metadata: { appAction: { ...(approval().metadata!.appAction as object), id: 'own-app' } },
      });
      f.events.receive({
        ...approval(identity.userId, true),
        metadata: {
          action: {
            ...(approval(identity.userId, true).metadata!.action as object),
            id: 'own-computer',
          },
        },
      });
      assert.equal(f.notices.length, 2);
      assert.ok(f.notices.every((n) => n.title.includes('需要你确认')));
    } finally {
      f.dispose();
    }
  }
});

test('legacy background approvals use owner fallback, while root completion never alerts other people or child delegations', async () => {
  for (const owner of [false, true]) {
    const f = await fixture({ owner });
    try {
      f.prefs.update({ enabled: true });
      f.events.baseline(snapshot([input('other-user')]));
      const old = approval();
      delete (old.metadata!.appAction as Record<string, unknown>).requester;
      f.events.receive(old);
      assert.equal(f.notices.length, owner ? 1 : 0);
      f.events.receive(completed());
      assert.equal(f.notices.length, owner ? 1 : 0);
      f.events.receive(input());
      f.events.receive({
        ...completed('child'),
        metadata: { ...completed('child').metadata, delegation: { rootRunId: 'run-a' } },
      });
      assert.equal(f.notices.length, owner ? 1 : 0);
      f.events.receive({ ...completed('failed'), status: 'error' });
      assert.equal(f.notices.length, owner ? 1 : 0);
    } finally {
      f.dispose();
    }
  }
});

test('foreground, missing permission and muted Bots are suppressed permanently instead of resurfacing later', async () => {
  const f = await fixture({ permission: 'denied' });
  try {
    f.prefs.update({ enabled: true });
    f.events.baseline(snapshot());
    f.events.receive(completed('denied'));
    f.setPermission('granted');
    await f.prefs.refreshPermission();
    f.setBackground(false);
    f.events.receive(completed('foreground'));
    f.setBackground(true);
    f.prefs.update({ mutedBots: ['bot-a'] });
    f.events.receive(completed('muted'));
    f.prefs.update({ mutedBots: [] });
    for (const id of ['denied', 'foreground', 'muted']) f.events.receive(completed(id));
    assert.equal(f.notices.length, 0);
    assert.equal(f.requested, 0);
    f.events.receive(completed('new'));
    assert.equal(f.notices.length, 1);
  } finally {
    f.dispose();
  }
});

test('account A to B to A and replayed SSE preserve deduplication without keeping private message content', async () => {
  const saved = storage();
  const a = await fixture({ storage: saved });
  a.prefs.update({ enabled: true });
  a.events.baseline(snapshot());
  a.events.receive(completed());
  assert.equal(a.notices.length, 1);
  a.setActive(false);
  a.events.receive(completed('late'));
  a.dispose();
  const b = await fixture({ storage: saved, userId: 'user-b' });
  assert.equal(b.prefs.getSnapshot().enabled, false);
  b.events.baseline(snapshot());
  b.events.receive(completed());
  assert.equal(b.notices.length, 0);
  b.dispose();
  const again = await fixture({ storage: saved });
  try {
    again.events.baseline(snapshot());
    again.events.receive(completed());
    assert.equal(again.notices.length, 0);
    again.events.suspend();
    again.events.receive(completed('after-unmount'));
    assert.equal(again.notices.length, 0);
  } finally {
    again.dispose();
  }
  assert.doesNotMatch([...saved.values.values()].join(''), /PRIVATE|SECRET|Synthetic Bot/);
});

test('localization is resolved at delivery time, not saved with a private event', async () => {
  const f = await fixture();
  try {
    f.prefs.update({ enabled: true });
    f.events.baseline(snapshot());
    initializeLanguage().setLanguage('en');
    f.events.receive(completed());
    assert.match(f.notices[0].title, /Task complete/);
  } finally {
    initializeLanguage().setLanguage('zh-CN');
    f.dispose();
  }
});

test('storage failure blocks delivery; delayed storage events read the current preference and subscription cleanup removes listeners', async () => {
  const saved = storage();
  const events = new EventTarget();
  let listeners = 0;
  const add = events.addEventListener.bind(events),
    remove = events.removeEventListener.bind(events);
  events.addEventListener = (...args: Parameters<typeof add>) => {
    listeners++;
    add(...args);
  };
  events.removeEventListener = (...args: Parameters<typeof remove>) => {
    listeners--;
    remove(...args);
  };
  const prefs = createNotificationPreferences({
    identity,
    storage: saved,
    events: events as Window,
    transport: {
      permission: async () => 'granted',
      requestPermission: async () => 'granted',
      show: async () => {},
      clear: async () => {},
    },
  });
  const release = prefs.subscribe(() => {});
  prefs.update({ enabled: true });
  prefs.update({ enabled: false });
  events.dispatchEvent(
    Object.assign(new Event('storage'), {
      key: notificationKey(identity),
      newValue: JSON.stringify({
        version: 1,
        enabled: true,
        completed: true,
        approvals: true,
        mutedBots: [],
      }),
    }),
  );
  assert.equal(prefs.getSnapshot().enabled, false);
  saved.setItem = () => {
    throw Error('blocked');
  };
  assert.equal(prefs.update({ enabled: true }), false);
  assert.equal(prefs.claim('event-a'), false);
  assert.equal(prefs.getSnapshot().storageAvailable, false);
  events.dispatchEvent(new Event('focus'));
  assert.equal(
    prefs.getSnapshot().storageAvailable,
    false,
    'a readable store does not prove that writes recovered',
  );
  release();
  assert.equal(listeners, 0);
  prefs.dispose();
});

test('a late permission read cannot overwrite an explicit permission grant', async () => {
  const old = deferred<NotificationPermission>();
  let requests = 0;
  const prefs = createNotificationPreferences({
    identity,
    storage: storage(),
    transport: {
      permission: () => old.promise,
      requestPermission: async () => {
        requests++;
        return 'granted';
      },
      show: async () => {},
      clear: async () => {},
    },
  });
  const release = prefs.subscribe(() => {});
  prefs.update({ enabled: true });
  await prefs.requestPermission(() => true);
  old.resolve('default');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(prefs.getSnapshot().permission, 'granted');
  assert.equal(requests, 1);
  release();
  prefs.dispose();
});

test('a queued cross-window claim checks the live scope before storing or sending the notification', async () => {
  const saved = storage(),
    f = await fixture({ storage: saved });
  let work: (() => void) | undefined;
  const events = createNotificationEvents({
    identity,
    current: () => true,
    isOwner: () => false,
    background: () => true,
    preferences: f.prefs,
    exclusive: async (callback) => {
      work = callback;
    },
  });
  try {
    f.prefs.update({ enabled: true });
    events.baseline(snapshot());
    events.receive(completed());
    assert.equal(f.notices.length, 0);
    events.suspend();
    work!();
    assert.equal(f.notices.length, 0);
    f.events.baseline(snapshot());
    f.events.receive(completed());
    assert.equal(f.notices.length, 1);
  } finally {
    events.suspend();
    f.dispose();
  }
});
