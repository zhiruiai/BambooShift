import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation } from '../../shared/types';
import { createConversationReads } from './conversationReads';
import { conversationViewportVisible } from './useConversationReads';

const chat = (readThrough = 1): Conversation => ({
  id: 'chat-a',
  title: 'Synthetic',
  agentIds: ['bot-a'],
  isGroup: false,
  updatedAt: '2026-11-07T00:00:00Z',
  unread: 1,
  pinned: false,
  readThrough,
});
test('history and hidden chats are never consumed; actual visible observation acknowledges one watermark', async () => {
  let visible = false,
    current = true,
    selected = chat(),
    refreshed = 0;
  const writes: unknown[] = [];
  const reads = createConversationReads({
    current: () => current,
    visible: () => visible,
    conversation: () => selected,
    acknowledge: async (id, through) => {
      writes.push({ id, through });
    },
    changed: () => {
      refreshed++;
    },
  });
  await reads.scan();
  assert.equal(writes.length, 0);
  visible = true;
  await reads.scan();
  assert.deepEqual(writes, [{ id: 'chat-a', through: 1 }]);
  await reads.scan();
  await reads.scan(true);
  assert.equal(writes.length, 1);
  assert.equal(refreshed, 1);
  selected = chat(2);
  visible = false;
  await reads.scan();
  assert.equal(writes.length, 1);
  visible = true;
  current = false;
  await reads.scan();
  assert.equal(writes.length, 1);
  current = true;
  await reads.scan();
  assert.deepEqual(writes.at(-1), { id: 'chat-a', through: 2 });
  reads.stop();
  selected = chat(3);
  await reads.scan();
  assert.equal(writes.length, 2);
});
test('a delayed read captures the observed watermark and ignores results after actor invalidation', async () => {
  let release!: () => void,
    selected = chat(1),
    current = true,
    refreshed = 0;
  const writes: number[] = [];
  const reads = createConversationReads({
    current: () => current,
    visible: () => true,
    conversation: () => selected,
    acknowledge: async (_, through) => {
      writes.push(through);
      await new Promise<void>((done) => {
        release = done;
      });
    },
    changed: () => {
      refreshed++;
    },
  });
  const pending = reads.scan();
  selected = chat(2);
  await reads.scan();
  assert.deepEqual(writes, [1]);
  current = false;
  release();
  await pending;
  assert.equal(refreshed, 0);
});
test('failed acknowledgements never consume newer messages and require another explicit observation to retry', async () => {
  let calls = 0;
  const reads = createConversationReads({
    current: () => true,
    visible: () => true,
    conversation: () => chat(4),
    acknowledge: async (_, through) => {
      assert.equal(through, 4);
      calls++;
      throw Error('Lost');
    },
    changed: () => assert.fail('no confirmed refresh'),
  });
  await reads.scan();
  await reads.scan();
  assert.equal(calls, 1);
  await reads.scan(true);
  assert.equal(calls, 2);
});
test('legacy snapshots without delivery watermarks never send unbounded read acknowledgements', async () => {
  const value = chat();
  delete value.readThrough;
  const reads = createConversationReads({
    current: () => true,
    visible: () => true,
    conversation: () => value,
    acknowledge: async () => assert.fail('no watermark'),
    changed() {},
  });
  await reads.scan();
});
test('viewport observation requires focused foreground, actual visible chat bounds and bottom reading position', () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  };
  let hidden = false,
    focus = true,
    connected = true,
    bottom = 200,
    top = 0,
    scrollTop = 800;
  install('document', {
    get hidden() {
      return hidden;
    },
    hasFocus: () => focus,
  });
  install('window', { innerHeight: 844, innerWidth: 390 });
  const node = {
    get isConnected() {
      return connected;
    },
    clientHeight: 200,
    scrollHeight: 1000,
    get scrollTop() {
      return scrollTop;
    },
    getClientRects: () => [1],
    getBoundingClientRect: () => ({ bottom, top, right: 390, left: 0 }),
  } as unknown as HTMLElement;
  try {
    assert.equal(conversationViewportVisible(node), true);
    hidden = true;
    assert.equal(conversationViewportVisible(node), false);
    hidden = false;
    focus = false;
    assert.equal(conversationViewportVisible(node), false);
    focus = true;
    connected = false;
    assert.equal(conversationViewportVisible(node), false);
    connected = true;
    top = 900;
    bottom = 1100;
    assert.equal(conversationViewportVisible(node), false);
    top = 0;
    bottom = 200;
    const originalRect = node.getBoundingClientRect;
    node.getBoundingClientRect = () => ({ ...originalRect(), right: 20, left: 20 });
    assert.equal(conversationViewportVisible(node), false);
    node.getBoundingClientRect = originalRect;
    scrollTop = 0;
    assert.equal(conversationViewportVisible(node), false);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('actual hook acknowledges visible mounted chat only and removes retained focus/scroll callbacks on disposal', async () => {
  const { harness } = await import('./testSupport/memoryImportSettingsFixture');
  let hidden = false,
    focused = false,
    current = true;
  const windowEvents = Object.assign(new EventTarget(), { innerHeight: 844, innerWidth: 390 });
  const documentEvents = Object.assign(new EventTarget(), {
    get hidden() {
      return hidden;
    },
    hasFocus: () => focused,
  });
  Object.defineProperty(documentEvents, 'hidden', { get: () => hidden });
  const viewport = Object.assign(new EventTarget(), {
    isConnected: true,
    clientHeight: 200,
    scrollHeight: 1000,
    scrollTop: 800,
    getClientRects: () => [1],
    getBoundingClientRect: () => ({ bottom: 200, top: 0, left: 0, right: 390 }),
  });
  const writes: number[] = [];
  const h = await harness(
    'web/src/useConversationReads.ts',
    'useConversationReads',
    {
      conversation: chat(1),
      viewport: { current: viewport },
      enabled: false,
      current: () => current,
      acknowledge: async (_: string, through: number) => {
        writes.push(through);
      },
      changed() {},
    },
    { window: windowEvents, document: documentEvents },
  );
  try {
    await h.flush();
    assert.equal(writes.length, 0);
    h.setProps({ enabled: true });
    await h.flush();
    assert.equal(writes.length, 0);
    focused = true;
    windowEvents.dispatchEvent(new Event('focus'));
    await h.flush();
    assert.deepEqual(writes, [1]);
    hidden = true;
    h.setProps({ conversation: chat(2) });
    await h.flush();
    assert.deepEqual(writes, [1]);
    hidden = false;
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    await h.flush();
    assert.deepEqual(writes, [1, 2]);
    current = false;
    h.setProps({ conversation: chat(3) });
    await h.flush();
    viewport.dispatchEvent(new Event('scroll'));
    await h.flush();
    assert.deepEqual(writes, [1, 2]);
    h.dispose();
    current = true;
    windowEvents.dispatchEvent(new Event('focus'));
    viewport.dispatchEvent(new Event('scroll'));
    await h.flush();
    assert.deepEqual(writes, [1, 2]);
  } finally {
    h.dispose();
  }
});

test('switching visible chats during a pending ACK drains the latest observed watermark without replaying A', async () => {
  const releases: Array<() => void> = [],
    writes: string[] = [];
  let selected = chat(1);
  const reads = createConversationReads({
    current: () => true,
    visible: () => true,
    conversation: () => selected,
    acknowledge: async (id) => {
      writes.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
    },
    changed() {},
  });
  const a = reads.scan();
  selected = { ...chat(2), id: 'chat-b' };
  await reads.scan();
  assert.deepEqual(writes, ['chat-a']);
  releases.shift()!();
  await a;
  assert.deepEqual(writes, ['chat-a', 'chat-b']);
  releases.shift()!();
  await Promise.resolve();
  await reads.scan();
  assert.deepEqual(writes, ['chat-a', 'chat-b']);
  reads.stop();
});
