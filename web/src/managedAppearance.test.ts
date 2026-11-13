import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPEARANCE_STORAGE_KEY as key, createAppearanceStore } from './appearance';

const { createManagedAppearance } = createRequire(import.meta.url)(
  '../../desktop/appearance.cjs',
) as {
  createManagedAppearance(path: string): {
    read(): { value: string | null; available: boolean };
    write(value: string): { available: boolean };
  };
};
const raw = (avatarTheme = 'pandas') =>
  JSON.stringify({ version: 1, theme: 'dark', accent: 'neutral', spellCheck: false, avatarTheme });
function legacy(value: string | null = null) {
  const values = new Map(value ? [[key, value]] : []);
  values.set('private-session', 'synthetic-do-not-migrate');
  const reads: string[] = [],
    writes: string[] = [];
  return {
    values,
    reads,
    writes,
    getItem(name: string) {
      reads.push(name);
      return values.get(name) ?? null;
    },
    setItem(name: string, content: string) {
      writes.push(name);
      values.set(name, content);
    },
  };
}
type Bridge = NonNullable<Window['openbotAppearance']>;
function open(
  storage: ReturnType<typeof legacy>,
  bridge?: Bridge,
  origin = 'http://127.0.0.1:43171',
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const environment = Object.assign(new EventTarget(), {
    localStorage: storage,
    openbotAppearance: bridge,
    location: { origin },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: environment });
  const store = createAppearanceStore();
  return {
    store,
    close() {
      store.dispose();
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}

test('managed preferences migrate only their fixed key and survive a new origin and reopened native store', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'appearance-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const firstStorage = legacy(raw()),
    first = open(firstStorage, createManagedAppearance(dir));
  try {
    assert.equal(first.store.getSnapshot().avatarTheme, 'pandas');
    assert.equal(first.store.getSnapshot().storageAvailable, true);
    assert.deepEqual(firstStorage.reads, [key]);
    assert.deepEqual(firstStorage.writes, []);
    first.store.update({ avatarTheme: 'elephants' });
  } finally {
    first.close();
  }
  const nextStorage = legacy(raw('chicks'));
  const second = open(nextStorage, createManagedAppearance(dir), 'http://127.0.0.1:43172');
  try {
    const saved = second.store.getSnapshot();
    assert.equal(saved.avatarTheme, 'elephants');
    assert.equal(saved.theme, 'dark');
    assert.equal(saved.accent, 'neutral');
    assert.equal(saved.spellCheck, false);
    assert.deepEqual(nextStorage.reads, [], 'native choice wins; no other origin storage is read');
    assert.equal(nextStorage.values.get('private-session'), 'synthetic-do-not-migrate');
  } finally {
    second.close();
  }
  const remoteStorage = legacy(raw('dinosaurs')),
    remote = open(remoteStorage, undefined, 'https://remote.example.test');
  try {
    remote.store.update({ avatarTheme: 'chicks' });
    assert.equal(JSON.parse(remoteStorage.values.get(key)!).avatarTheme, 'chicks');
    assert.equal(JSON.parse(createManagedAppearance(dir).read().value!).avatarTheme, 'elephants');
  } finally {
    remote.close();
  }
});

test('legacy appearance without an avatar migrates without changing non-avatar preferences', () => {
  let value: string | null = null;
  const old = JSON.stringify({ version: 1, theme: 'light', accent: 'neutral', spellCheck: false });
  const current = open(legacy(old), {
    read: () => ({ value, available: true }),
    write: (raw) => {
      value = raw;
      return { available: true };
    },
  });
  try {
    assert.equal(current.store.getSnapshot().avatarTheme, 'classic');
    assert.equal(current.store.getSnapshot().theme, 'light');
    assert.equal(current.store.getSnapshot().spellCheck, false);
    assert.equal(value, old);
  } finally {
    current.close();
  }
});

test('malformed, oversized and credential-bearing legacy records never reach native IPC', () => {
  for (const stored of [
    'broken',
    raw() + ' '.repeat(2048),
    JSON.stringify({ ...JSON.parse(raw()), token: 'synthetic' }),
  ]) {
    let writes = 0;
    const current = open(legacy(stored), {
      read: () => ({ value: null, available: true }),
      write: () => {
        writes++;
        return { available: true };
      },
    });
    try {
      assert.equal(writes, 0);
      assert.equal(current.store.getSnapshot().avatarTheme, 'classic');
    } finally {
      current.close();
    }
  }
});

test('native write failure is visible and keeps the session choice without falling back to port storage', () => {
  let persist = false;
  const storage = legacy(),
    current = open(storage, {
      read: () => ({ value: raw(), available: true }),
      write: () => ({ available: persist }),
    });
  try {
    current.store.update({ avatarTheme: 'chicks' });
    assert.equal(current.store.getSnapshot().avatarTheme, 'chicks');
    assert.equal(current.store.getSnapshot().storageAvailable, false);
    assert.deepEqual(storage.writes, []);
    persist = true;
    current.store.update({ avatarTheme: 'pandas' });
    assert.equal(current.store.getSnapshot().storageAvailable, true);
  } finally {
    current.close();
  }
});

test('blocked origin storage does not disable a usable native store, and a malformed native response is unavailable', () => {
  const blocked = legacy();
  blocked.getItem = () => {
    throw Error('Denied');
  };
  const current = open(blocked, {
    read: () => ({ value: null, available: true }),
    write: () => ({ available: true }),
  });
  try {
    assert.equal(current.store.getSnapshot().storageAvailable, true);
  } finally {
    current.close();
  }
  for (const response of [
    { value: raw() },
    { value: 5, available: true },
    { value: 'bad', available: true },
  ]) {
    const malformed = open(legacy(raw()), {
      read: () => response,
      write: () => ({ available: true }),
    });
    try {
      assert.equal(malformed.store.getSnapshot().storageAvailable, false);
      assert.equal(malformed.store.getSnapshot().avatarTheme, 'classic');
    } finally {
      malformed.close();
    }
  }
});
