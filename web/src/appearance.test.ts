import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { APPEARANCE_STORAGE_KEY, createAppearanceStore } from './appearance';

class EventHub extends EventTarget {
  count = 0;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ) {
    this.count++;
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ) {
    this.count--;
    super.removeEventListener(type, listener, options);
  }
}
class Media extends EventHub {
  constructor(public matches = false) {
    super();
  }
  change(matches: boolean) {
    this.matches = matches;
    this.dispatchEvent(new Event('change'));
  }
}
function storage(raw: string | null = null) {
  const values = new Map<string, string>();
  if (raw !== null) values.set(APPEARANCE_STORAGE_KEY, raw);
  const writes: string[] = [];
  return {
    values,
    writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      writes.push(value);
      values.set(key, value);
    },
  };
}
function root() {
  return {
    dataset: {} as { theme?: string; accent?: string },
    style: { colorScheme: '' },
    spellcheck: false,
  };
}
function fixture(raw: string | null = null, dark = false) {
  const media = new Media(dark),
    target = root(),
    saved = storage(raw),
    events = new EventHub();
  const themeColor = { content: '#f7f7f8' };
  const store = createAppearanceStore({
    storage: saved,
    storageEvents: events,
    media,
    root: target,
    themeColor,
  });
  return { store, media, target, saved, events, themeColor };
}
function storageEvent(
  events: EventTarget,
  value: string | null,
  area: ReturnType<typeof storage>,
  key: string | null = APPEARANCE_STORAGE_KEY,
) {
  // A browser storage event follows an actual mutation by another document.
  if (key === null) area.values.clear();
  else if (value === null) area.values.delete(key);
  else area.values.set(key, value);
  events.dispatchEvent(
    Object.assign(new Event('storage'), { key, newValue: value, storageArea: area }),
  );
}

test('device preferences synchronously style html before subscribing, and persistence is versioned with no account data', () => {
  const f = fixture(
    JSON.stringify({ version: 1, theme: 'system', accent: 'neutral', spellCheck: false }),
    true,
  );
  try {
    assert.equal(f.target.dataset.theme, 'dark');
    assert.equal(f.target.dataset.accent, 'neutral');
    assert.equal(f.target.style.colorScheme, 'dark');
    assert.equal(f.themeColor.content, '#141318');
    assert.equal(f.target.spellcheck, false);
    assert.equal(f.store.getSnapshot().theme, 'system');
    assert.equal(f.saved.writes.length, 0, 'initial reads must not rewrite preferences');
    f.store.update({ theme: 'light', spellCheck: true });
    assert.equal(f.target.dataset.theme, 'light');
    assert.equal(f.themeColor.content, '#f4f5f6');
    assert.equal(f.target.spellcheck, true);
    assert.deepEqual(JSON.parse(f.saved.writes[0]), {
      version: 1,
      theme: 'light',
      accent: 'neutral',
      spellCheck: true,
      avatarTheme: 'companions',
    });
    assert.equal(Object.isFrozen(f.store.getSnapshot()), true);
  } finally {
    f.store.dispose();
  }
});

test('delayed cross-window changes and clear events read current shared storage; read failures preserve the local choice', () => {
  const shared = storage(),
    firstEvents = new EventHub(),
    secondEvents = new EventHub();
  const first = createAppearanceStore({
    storage: shared,
    storageEvents: firstEvents,
    media: new Media(),
    root: root(),
  });
  const target = root();
  const second = createAppearanceStore({
    storage: shared,
    storageEvents: secondEvents,
    media: new Media(),
    root: target,
  });
  const dispatch = (events: EventTarget, key: string | null, oldValue: string | null) => {
    events.dispatchEvent(
      Object.assign(new Event('storage'), { key, newValue: oldValue, storageArea: shared }),
    );
  };
  try {
    first.update({ theme: 'dark' });
    const queuedDark = shared.getItem(APPEARANCE_STORAGE_KEY);
    second.update({ theme: 'light' });
    const latestLight = shared.getItem(APPEARANCE_STORAGE_KEY);
    dispatch(secondEvents, APPEARANCE_STORAGE_KEY, queuedDark);
    assert.equal(second.getSnapshot().theme, 'light');
    assert.equal(target.dataset.theme, 'light');
    dispatch(firstEvents, APPEARANCE_STORAGE_KEY, latestLight);
    assert.equal(first.getSnapshot().theme, 'light');
    assert.equal(shared.writes.length, 2, 'handling external events must not write back');

    shared.values.clear();
    second.update({ theme: 'dark', accent: 'neutral', spellCheck: false });
    dispatch(secondEvents, null, null);
    assert.equal(second.getSnapshot().theme, 'dark', 'an old clear cannot erase a later choice');
    assert.equal(second.getSnapshot().accent, 'neutral');
    assert.equal(target.spellcheck, false);

    const read = shared.getItem;
    shared.getItem = () => {
      throw Error('Storage access revoked');
    };
    assert.doesNotThrow(() => dispatch(secondEvents, APPEARANCE_STORAGE_KEY, latestLight));
    assert.equal(second.getSnapshot().theme, 'dark');
    assert.equal(second.getSnapshot().accent, 'neutral');
    assert.equal(second.getSnapshot().storageAvailable, false);
    assert.equal(target.spellcheck, false);
    shared.getItem = read;
    dispatch(secondEvents, APPEARANCE_STORAGE_KEY, queuedDark);
    assert.equal(second.getSnapshot().storageAvailable, true);
    assert.equal(shared.writes.length, 3);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test('system changes update effective colors without replacing system preference or writing storage; explicit light/dark ignore them', () => {
  const f = fixture();
  let notices = 0;
  const unsubscribe = f.store.subscribe(() => {
    notices++;
  });
  try {
    const initial = f.store.getSnapshot();
    assert.equal(f.store.getSnapshot(), initial, 'external-store snapshots must be stable');
    f.media.change(true);
    assert.equal(f.store.getSnapshot().resolvedTheme, 'dark');
    assert.equal(f.store.getSnapshot().theme, 'system');
    assert.equal(f.saved.writes.length, 0);
    assert.equal(notices, 1);
    f.store.update({ theme: 'light' });
    const explicit = f.store.getSnapshot(),
      writes = f.saved.writes.length;
    f.media.change(false);
    f.media.change(true);
    assert.equal(f.store.getSnapshot(), explicit);
    assert.equal(f.saved.writes.length, writes);
    assert.equal(notices, 2);
    f.store.update({ theme: 'dark' });
    f.media.change(false);
    assert.equal(f.target.dataset.theme, 'dark');
    f.store.update({ theme: 'system' });
    assert.equal(f.target.dataset.theme, 'light');
    assert.equal(JSON.parse(f.saved.writes.at(-1)!).theme, 'system');
  } finally {
    unsubscribe();
    f.store.dispose();
  }
});

test('real storage events synchronize all preferences, ignore other stores and keys, and handle reset without write loops', () => {
  const a = fixture(),
    b = fixture();
  try {
    a.store.update({ theme: 'dark', accent: 'neutral', spellCheck: false });
    const serialized = a.saved.writes.at(-1)!;
    storageEvent(b.events, serialized, b.saved);
    assert.equal(b.target.dataset.theme, 'dark');
    assert.equal(b.target.dataset.accent, 'neutral');
    assert.equal(b.target.spellcheck, false);
    assert.equal(b.saved.writes.length, 0);
    const snapshot = b.store.getSnapshot();
    storageEvent(b.events, null, b.saved, 'other-setting');
    storageEvent(b.events, null, storage());
    assert.equal(b.store.getSnapshot(), snapshot);
    storageEvent(b.events, null, b.saved, null);
    assert.equal(b.store.getSnapshot().theme, 'system');
    assert.equal(b.store.getSnapshot().accent, 'bot');
    assert.equal(b.target.spellcheck, true);
    assert.equal(b.saved.writes.length, 0);
  } finally {
    a.store.dispose();
    b.store.dispose();
  }
});

test('malformed or unsupported stored versions fall back safely, including external changes, and invalid updates are ignored', () => {
  const invalid = [
    'not JSON',
    'null',
    '{}',
    JSON.stringify({ version: 2, theme: 'dark', accent: 'neutral', spellCheck: false }),
    JSON.stringify({ version: 1, theme: 'dark', accent: 'neutral', spellCheck: 'false' }),
    JSON.stringify({
      version: 1,
      theme: 'url(javascript:bad)',
      accent: 'neutral',
      spellCheck: false,
    }),
    ' '.repeat(2049),
  ];
  for (const raw of invalid) {
    const f = fixture(raw, true);
    try {
      assert.equal(f.store.getSnapshot().theme, 'system');
      assert.equal(f.target.dataset.theme, 'dark');
      assert.equal(f.target.spellcheck, true);
      assert.equal(f.saved.writes.length, 0);
      f.store.update({ theme: 'light' });
      storageEvent(f.events, raw, f.saved);
      assert.equal(f.store.getSnapshot().theme, 'system');
      assert.equal(f.target.dataset.theme, 'dark');
      const before = f.store.getSnapshot(),
        count = f.saved.writes.length;
      f.store.update({ theme: { toString: () => 'dark' } } as any);
      f.store.update({ arbitrary: true } as any);
      assert.equal(f.store.getSnapshot(), before);
      assert.equal(f.saved.writes.length, count);
    } finally {
      f.store.dispose();
    }
  }
});

test('storage access rejection keeps local controls and media usable and reports persistence recovery honestly', () => {
  const media = new Media(),
    target = root(),
    events = new EventHub();
  let rejected = true;
  const writes: string[] = [];
  const saved = {
    getItem() {
      throw Error('SecurityError');
    },
    setItem(_: string, value: string) {
      if (rejected) throw Error('QuotaExceeded');
      writes.push(value);
    },
  };
  const store = createAppearanceStore({
    storage: saved,
    storageEvents: events,
    media,
    root: target,
  });
  try {
    assert.equal(store.getSnapshot().storageAvailable, false);
    store.update({ theme: 'dark', spellCheck: false });
    assert.equal(target.dataset.theme, 'dark');
    assert.equal(target.spellcheck, false);
    assert.equal(store.getSnapshot().storageAvailable, false);
    rejected = false;
    store.update({ accent: 'neutral' });
    assert.equal(store.getSnapshot().storageAvailable, true);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0]).theme, 'dark');
    assert.equal(JSON.parse(writes[0]).spellCheck, false);
    store.update({ theme: 'system' });
    media.change(true);
    assert.equal(target.dataset.theme, 'dark');
  } finally {
    store.dispose();
  }
});

test('subscriptions clean up independently and disposal removes global listeners and rejects retained updates', () => {
  const f = fixture();
  let calls = 0;
  const listener = () => {
    calls++;
  };
  const first = f.store.subscribe(listener),
    second = f.store.subscribe(listener);
  assert.equal(f.events.count, 1);
  assert.equal(f.media.count, 1);
  first();
  first();
  f.media.change(true);
  assert.equal(calls, 1);
  second();
  f.media.change(false);
  assert.equal(calls, 1);
  assert.equal(
    f.target.dataset.theme,
    'light',
    'device theme also applies on pages without React subscribers',
  );
  const before = f.store.getSnapshot();
  f.store.dispose();
  f.store.dispose();
  assert.equal(f.events.count, 0);
  assert.equal(f.media.count, 0);
  f.store.update({ theme: 'dark' });
  f.media.change(true);
  storageEvent(f.events, null, f.saved);
  assert.equal(f.store.getSnapshot(), before);
  assert.equal(f.saved.writes.length, 0);
  f.store.subscribe(listener)();
  assert.equal(calls, 1);
});

test('actual appearance controls update the shared store and retained handlers stop when hidden or unmounted', async () => {
  const require = createRequire(import.meta.url),
    path = resolve('web/src/components/AppearanceSettings.tsx');
  const output = await build({
    stdin: { contents: await readFile(path, 'utf8'), resolveDir: dirname(path), loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*'],
    loader: { '.css': 'empty' },
  });
  const media = new Media(),
    target = root(),
    saved = storage(),
    events = new EventHub();
  const slots: any[] = [],
    cleanups: Array<() => void> = [];
  let cursor = 0;
  const hooks = {
    ...React,
    useContext: () => null,
    useRef(value: any) {
      const index = cursor++;
      return (slots[index] ||= { current: value });
    },
    useEffect(effect: () => () => void) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = true;
        cleanups.push(effect());
      }
    },
    useSyncExternalStore(subscribe: any, getSnapshot: any) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = true;
        cleanups.push(subscribe(() => {}));
      }
      return getSnapshot();
    },
  };
  const module = { exports: {} as any };
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name: string) => (name === 'react' ? hooks : require(name)),
    window: Object.assign(events, { localStorage: saved, matchMedia: () => media }),
    document: { documentElement: target },
  });
  function all(node: any, predicate: (item: any) => boolean): any[] {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap((child) => all(child, predicate));
    return [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)];
  }
  const render = (active: boolean) => {
    cursor = 0;
    return module.exports.AppearanceSettings({ active });
  };
  let tree = render(true);
  const select = all(
    tree,
    (node) => node.type === 'select' && node.props['aria-label'] === '外观',
  )[0];
  const checkbox = all(tree, (node) => node.type === 'input')[0];
  const panda = all(tree, (node) => node.type === 'button')[1];
  panda.props.onClick();
  assert.equal(JSON.parse(saved.writes.at(-1)!).avatarTheme, 'pandas');
  select.props.onChange({ target: { value: 'dark' } });
  checkbox.props.onChange({ target: { checked: false } });
  assert.equal(target.dataset.theme, 'dark');
  assert.equal(target.spellcheck, false);
  tree = render(false);
  assert.ok(
    all(tree, (node) => ['select', 'input', 'button'].includes(node.type)).every(
      (node) => node.props.disabled,
    ),
  );
  const count = saved.writes.length;
  select.props.onChange({ target: { value: 'light' } });
  panda.props.onClick();
  assert.equal(saved.writes.length, count);
  render(true);
  for (const cleanup of cleanups) cleanup();
  checkbox.props.onChange({ target: { checked: true } });
  assert.equal(saved.writes.length, count);
});
