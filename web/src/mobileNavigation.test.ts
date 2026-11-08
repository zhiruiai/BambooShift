import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMobileNavigation, type MobilePage } from './mobileNavigation';

function fixture(state: unknown = { existingRouterState: { key: 'preserved' } }) {
  const entries = [
    { state, url: '/before' },
    { state, url: '/w/space?conversation=a&message=m#target' },
  ];
  let index = 1;
  let currentScope = true;
  let pendingIndex: number | undefined;
  const changes: MobilePage[] = [];
  const history = {
    get state() {
      return entries[index].state;
    },
    replaceState(state: unknown, _unused: string, url?: string | URL | null) {
      entries[index] = { state, url: url === undefined ? entries[index].url : String(url) };
    },
    pushState(state: unknown, _unused: string, url?: string | URL | null) {
      entries.splice(index + 1, entries.length, {
        state,
        url: url === undefined ? entries[index].url : String(url),
      });
      index++;
    },
    go(delta: number) {
      pendingIndex = Math.max(0, Math.min(entries.length - 1, index + delta));
    },
  };
  const navigation = createMobileNavigation({
    history,
    scope: 'user:space',
    isCurrentScope: () => currentScope,
    onChange: (page) => changes.push(page),
  });
  function flush() {
    if (pendingIndex === undefined) return;
    index = pendingIndex;
    pendingIndex = undefined;
    navigation.pop();
  }
  return {
    history,
    entries,
    navigation,
    changes,
    flush,
    get index() {
      return index;
    },
    get page() {
      return changes.at(-1);
    },
    foreignScope() {
      currentScope = false;
    },
  };
}

test('home → chat → details has two owned back steps; repeated opens do not grow history', () => {
  const f = fixture();
  f.navigation.activate({ view: 'home' });
  f.navigation.move({ view: 'chat', conversationId: 'a' });
  f.navigation.move({ view: 'chat', conversationId: 'b' });
  f.navigation.move({ view: 'details', conversationId: 'b' });
  f.navigation.move({ view: 'details', conversationId: 'b' });
  assert.equal(f.entries.length, 4);
  f.history.go(-1);
  f.flush();
  assert.equal(f.page?.view, 'chat');
  assert.equal(f.page?.conversationId, 'b');
  f.history.go(-1);
  f.flush();
  assert.equal(f.page?.view, 'home');
  f.history.go(1);
  f.flush();
  assert.equal(f.page?.view, 'chat');
  f.history.go(1);
  f.flush();
  assert.equal(f.page?.view, 'details');
  f.navigation.move({ view: 'home' });
  f.flush();
  assert.equal(f.index, 1);
  assert.equal(f.page?.view, 'home');
});

test('initial deep link preserves URL, hash and other history state; has a list return', () => {
  const f = fixture();
  const url = f.entries[1].url;
  f.navigation.activate({ view: 'chat', conversationId: 'a' });
  assert.equal(f.entries.length, 3);
  assert.equal(f.entries[1].url, url);
  assert.equal(f.entries[2].url, url);
  assert.deepEqual((f.history.state as Record<string, unknown>).existingRouterState, {
    key: 'preserved',
  });
  f.navigation.move({ view: 'home' });
  f.flush();
  assert.equal(f.index, 1);
});

test('latest navigation intent wins while asynchronous browser back is pending', () => {
  const f = fixture();
  f.navigation.activate({ view: 'chat', conversationId: 'a' });
  f.navigation.move({ view: 'details', conversationId: 'a' });
  f.navigation.move({ view: 'home' });
  f.navigation.move({ view: 'chat', conversationId: 'b' });
  f.navigation.move({ view: 'details', conversationId: 'b' });
  f.flush();
  assert.equal(f.page?.view, 'details');
  assert.equal(f.page?.conversationId, 'b');
  assert.equal(f.entries.length, 4);
  f.history.go(-1);
  f.flush();
  assert.equal(f.page?.view, 'chat');
  assert.equal(f.page?.conversationId, 'b');
});

test('desktop round trips do not add entries and an outstanding back keeps the latest selected chat', () => {
  const f = fixture();
  f.navigation.activate({ view: 'chat', conversationId: 'a' });
  for (let i = 0; i < 5; i++) {
    f.navigation.deactivate();
    assert.equal(f.navigation.move({ view: 'details', conversationId: 'desktop' }), false);
    f.navigation.activate({ view: 'chat', conversationId: 'a' });
  }
  assert.equal(f.entries.length, 3);
  f.navigation.move({ view: 'details', conversationId: 'a' });
  f.navigation.move({ view: 'home' });
  f.navigation.deactivate();
  f.navigation.activate({ view: 'chat', conversationId: 'b' });
  f.flush();
  assert.equal(f.page?.view, 'chat');
  assert.equal(f.page?.conversationId, 'b');
  assert.equal(f.index, 2);
  f.history.go(-1);
  f.flush();
  assert.equal(f.page?.view, 'home');
});

test('leaving this workspace does not rewrite a foreign URL or pull the user back', () => {
  const f = fixture();
  f.navigation.activate({ view: 'chat', conversationId: 'a' });
  f.foreignScope();
  const snapshot = JSON.stringify(f.entries);
  const previousChanges = f.changes.length;
  assert.equal(f.navigation.move({ view: 'home' }), false);
  f.navigation.pop();
  assert.equal(JSON.stringify(f.entries), snapshot);
  assert.equal(f.changes.length, previousChanges);
});

test('old controller/account state is not treated as an owned back stack', () => {
  const f = fixture({
    other: 1,
    openbotMobileNavigation: { scope: 'old:space', session: 'old', depth: 2, view: 'details' },
  });
  f.navigation.activate({ view: 'home' });
  assert.equal(f.entries.length, 2);
  f.navigation.move({ view: 'home' });
  f.flush();
  assert.equal(f.index, 1);
  f.history.go(-1);
  f.flush();
  assert.equal(f.index, 0);
  assert.equal(f.entries.length, 2);
  assert.equal(f.page?.view, 'home');
});
