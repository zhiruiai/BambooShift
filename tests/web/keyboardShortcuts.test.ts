import assert from 'node:assert/strict';
import test from 'node:test';
import { searchShortcutLabel } from '../../web/src/keyboardShortcuts';

test('search shortcut uses the Mac or Windows modifier displayed by the client', () => {
  assert.equal(searchShortcutLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), '⌘ K');
  assert.equal(searchShortcutLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Ctrl K');
  assert.equal(searchShortcutLabel('Mozilla/5.0 (X11; Linux x86_64)'), 'Ctrl K');
});

test('search shortcut can render without a browser navigator', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Reflect.deleteProperty(globalThis, 'navigator');
  try {
    assert.equal(searchShortcutLabel(), 'Ctrl K');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
  }
});
