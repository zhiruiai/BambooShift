import assert from 'node:assert/strict';
import test from 'node:test';
import { createLanguageController, LANGUAGE_STORAGE_KEY } from './i18n/language';

class EventHub extends EventTarget {
  count = 0;
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    this.count++;
    super.addEventListener(type, callback);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    this.count--;
    super.removeEventListener(type, callback);
  }
}
function storage(raw?: string) {
  const values = new Map<string, string>(raw ? [[LANGUAGE_STORAGE_KEY, raw]] : []);
  const writes: string[] = [];
  return {
    values,
    writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      values.set(key, value);
      writes.push(value);
    },
  };
}
function dispatch(
  events: EventHub,
  area: ReturnType<typeof storage>,
  key: string | null,
  newValue: string | null,
) {
  events.dispatchEvent(Object.assign(new Event('storage'), { key, newValue, storageArea: area }));
}

test('language is applied synchronously and persists only a versioned device preference', () => {
  const saved = storage(JSON.stringify({ version: 1, locale: 'en' }));
  const applied: string[] = [];
  const store = createLanguageController({
    storage: saved,
    apply: (locale) => applied.push(locale),
  });
  assert.deepEqual(applied, ['en']);
  assert.deepEqual(store.getSnapshot(), { locale: 'en', storageAvailable: true });
  assert.equal(saved.writes.length, 0);
  store.setLanguage('zh-CN');
  assert.deepEqual(JSON.parse(saved.writes[0]), { version: 1, locale: 'zh-CN' });
  assert.equal(Object.isFrozen(store.getSnapshot()), true);
  store.dispose();
});

test('cross-window events read current storage, including delayed changes and delayed clear events', () => {
  const saved = storage(),
    eventsA = new EventHub(),
    eventsB = new EventHub();
  const a = createLanguageController({ storage: saved, events: eventsA });
  const b = createLanguageController({ storage: saved, events: eventsB });
  a.setLanguage('en');
  const old = saved.getItem(LANGUAGE_STORAGE_KEY);
  b.setLanguage('zh-CN');
  dispatch(eventsB, saved, LANGUAGE_STORAGE_KEY, old);
  assert.equal(b.getSnapshot().locale, 'zh-CN');
  dispatch(eventsA, saved, LANGUAGE_STORAGE_KEY, old);
  assert.equal(a.getSnapshot().locale, 'zh-CN');
  saved.values.clear();
  b.setLanguage('en');
  dispatch(eventsB, saved, null, null);
  assert.equal(b.getSnapshot().locale, 'en');
  dispatch(eventsA, saved, null, null);
  assert.equal(a.getSnapshot().locale, 'en');
  assert.equal(saved.writes.length, 3, 'storage events must not write back');
  const snapshot = b.getSnapshot();
  dispatch(eventsB, saved, 'other-key', null);
  dispatch(eventsB, storage(), LANGUAGE_STORAGE_KEY, null);
  assert.equal(b.getSnapshot(), snapshot);
  saved.values.clear();
  dispatch(eventsB, saved, null, null);
  assert.equal(b.getSnapshot().locale, 'zh-CN');
  a.dispose();
  b.dispose();
});

test('storage rejection keeps the chosen language usable and never applies a stale event value', () => {
  const saved = storage(),
    events = new EventHub();
  let denied = true;
  const read = saved.getItem,
    write = saved.setItem;
  saved.getItem = (key) => {
    if (denied) throw Error('denied');
    return read(key);
  };
  saved.setItem = (key, value) => {
    if (denied) throw Error('denied');
    write(key, value);
  };
  const store = createLanguageController({ storage: saved, events });
  assert.equal(store.getSnapshot().storageAvailable, false);
  store.setLanguage('en');
  assert.equal(store.getSnapshot().locale, 'en');
  assert.doesNotThrow(() => dispatch(events, saved, LANGUAGE_STORAGE_KEY, null));
  assert.equal(store.getSnapshot().locale, 'en');
  denied = false;
  store.setLanguage('en');
  assert.equal(store.getSnapshot().storageAvailable, true);
  assert.deepEqual(JSON.parse(saved.writes[0]), { version: 1, locale: 'en' });
  store.dispose();
});

test('malformed data and unsupported locales safely default without rewriting storage', () => {
  for (const raw of [
    'bad',
    'null',
    '[]',
    '{}',
    '{"version":2,"locale":"en"}',
    '{"version":1,"locale":"xx"}',
  ]) {
    const saved = storage(raw),
      store = createLanguageController({ storage: saved });
    assert.equal(store.getSnapshot().locale, 'zh-CN');
    store.setLanguage('xx' as any);
    assert.equal(saved.writes.length, 0);
    store.dispose();
  }
});

test('subscriptions are independent and disposal removes the real storage listener and stale setters', () => {
  const saved = storage(),
    events = new EventHub();
  const store = createLanguageController({ storage: saved, events });
  let calls = 0;
  const listener = () => calls++;
  const first = store.subscribe(listener),
    second = store.subscribe(listener);
  first();
  first();
  store.setLanguage('en');
  assert.equal(calls, 1);
  second();
  store.setLanguage('zh-CN');
  assert.equal(calls, 1);
  assert.equal(events.count, 1);
  const before = store.getSnapshot(),
    writes = saved.writes.length;
  store.dispose();
  store.dispose();
  assert.equal(events.count, 0);
  store.setLanguage('en');
  dispatch(events, saved, LANGUAGE_STORAGE_KEY, null);
  assert.equal(store.getSnapshot(), before);
  assert.equal(saved.writes.length, writes);
});
