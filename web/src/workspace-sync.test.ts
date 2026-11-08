import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bootstrap, Message } from '../../shared/types.js';
import { createWorkspaceSync, eventToken, syncToken, type SyncState } from './workspaceSync.js';

const snapshot = (revision: number, epoch = 'server-a') =>
  ({ sync: { epoch, revision }, messages: [] }) as unknown as Bootstrap;
const message = (id: string) =>
  ({ id, conversationId: 'chat', role: 'assistant', content: id }) as Message;
function fixture() {
  let serial = 0;
  const timers = new Map<number, { fn: () => void; delay: number }>();
  const requests: {
    resolve: (value: Bootstrap) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
  }[] = [];
  const snapshots: Bootstrap[] = [],
    messages: Message[] = [],
    states: SyncState[] = [];
  const sync = createWorkspaceSync({
    fetch: (signal) => new Promise((resolve, reject) => requests.push({ resolve, reject, signal })),
    snapshot: (data) => snapshots.push(data),
    message: (data) => messages.push(data),
    status: (state) => states.push(state),
    schedule: (fn, delay) => {
      const id = ++serial;
      timers.set(id, { fn, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (id) => {
      timers.delete(id as unknown as number);
    },
  });
  const tick = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const runTimer = (delay: number) => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(
      entry,
      `expected timer ${delay}, got ${JSON.stringify([...timers.values()].map((t) => t.delay))}`,
    );
    timers.delete(entry[0]);
    entry[1].fn();
  };
  return { sync, requests, snapshots, messages, states, timers, tick, runTimer };
}

test('a stale HTTP response cannot roll back newer stream messages; reconnect is syncing until its snapshot', async () => {
  const f = fixture();
  f.sync.opened();
  f.sync.handshake({ epoch: 'server-a', revision: 3 });
  assert.equal(f.requests.length, 1);
  assert.equal(f.states.at(-1)?.phase, 'syncing');
  f.sync.event('message', 'server-a:4', message('new'));
  f.requests[0].resolve(snapshot(3));
  await f.tick();
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.messages[0].id, 'new');
  f.runTimer(750);
  f.requests[1].resolve(snapshot(4));
  await f.tick();
  assert.equal(f.snapshots[0].sync.revision, 4);
  assert.equal(f.states.at(-1)?.phase, 'online');
  f.sync.disconnected();
  f.sync.opened();
  assert.equal(f.states.at(-1)?.phase, 'syncing');
  f.sync.handshake({ epoch: 'server-a', revision: 7 });
  f.requests[2].resolve(snapshot(7));
  await f.tick();
  assert.equal(f.states.at(-1)?.phase, 'online');
  assert.equal(f.snapshots.at(-1)?.sync.revision, 7);
  f.sync.stop();
});

test('server restart invalidates old requests, while duplicated stream messages and wrong epochs do not mutate data', async () => {
  const f = fixture();
  f.sync.handshake({ epoch: 'server-a', revision: 10 });
  f.sync.disconnected();
  f.sync.opened();
  f.sync.handshake({ epoch: 'server-b', revision: 0 });
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].resolve(snapshot(50));
  await f.tick();
  assert.equal(f.snapshots.length, 0);
  f.runTimer(150);
  f.requests[1].resolve(snapshot(0, 'server-b'));
  await f.tick();
  f.sync.event('message', 'server-a:51', message('old-instance'));
  assert.equal(f.messages.length, 0);
  f.sync.event('message', 'server-b:1', message('first'));
  f.sync.event('message', 'server-b:1', message('duplicate'));
  assert.deepEqual(
    f.messages.map((m) => m.id),
    ['first'],
  );
  f.sync.stop();
  f.requests.at(-1)!.resolve(snapshot(60, 'server-a'));
  await f.tick();
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.timers.size, 0);
});

test('failed GET keeps prior state and retries with bounded backoff; updates cannot defeat the backoff', async () => {
  const f = fixture();
  f.sync.handshake({ epoch: 'server-a', revision: 0 });
  f.requests[0].resolve(snapshot(0));
  await f.tick();
  void f.sync.refresh();
  for (const [index, delay] of [750, 1500, 3000, 6000, 12000].entries()) {
    f.requests.at(-1)!.reject(new Error('network down'));
    await f.tick();
    assert.equal(f.states.at(-1)?.phase, 'offline');
    assert.equal(f.states.at(-1)?.error, 'network down');
    assert.equal(f.snapshots.length, 1);
    const count = f.requests.length;
    f.sync.event('update', `server-a:${index + 1}`);
    assert.equal(f.requests.length, count);
    f.runTimer(delay);
  }
  f.requests.at(-1)!.reject(new Error('still down'));
  await f.tick();
  assert.equal(f.timers.size, 0);
  const attempts = f.requests.length;
  f.sync.event('update', 'server-a:6');
  assert.equal(f.requests.length, attempts);
  void f.sync.refresh();
  f.requests.at(-1)!.resolve(snapshot(6));
  await f.tick();
  assert.equal(f.states.at(-1)?.phase, 'online');
  f.sync.stop();
});

test('initial GET may display data but needs handshake; isolated coordinators never share state; reads time out', async () => {
  const a = fixture(),
    b = fixture();
  void a.sync.refresh();
  void b.sync.refresh();
  a.requests[0].resolve(snapshot(8));
  await a.tick();
  assert.equal(a.states.at(-1)?.phase, 'offline');
  assert.equal(b.snapshots.length, 0);
  b.runTimer(15000);
  assert.equal(b.requests[0].signal.aborted, true);
  b.requests[0].reject(new DOMException('aborted', 'AbortError'));
  await b.tick();
  assert.match(b.states.at(-1)!.error, /超时/);
  a.sync.opened();
  a.sync.handshake({ epoch: 'server-a', revision: 8 });
  a.requests[1].resolve(snapshot(8));
  await a.tick();
  assert.equal(a.states.at(-1)?.phase, 'online');
  a.sync.stop();
  b.sync.stop();
});

test('malformed version IDs are rejected', () => {
  for (const value of [
    undefined,
    null,
    {},
    { epoch: '', revision: 1 },
    { epoch: 'a', revision: -1 },
    { epoch: 'a', revision: 1.1 },
  ])
    assert.equal(syncToken(value), null);
  for (const value of ['', 'a', 'a:', 'a:-1', 'a:1e3', 'a:1.1', 'a:9007199254740992'])
    assert.equal(eventToken(value), null);
  assert.deepEqual(eventToken('a:3'), { epoch: 'a', revision: 3 });
});

test('a committed POST invalidates a previously started GET before its SSE receipt arrives', async () => {
  const f = fixture();
  f.sync.handshake({ epoch: 'server-a', revision: 0 });
  f.requests[0].resolve(snapshot(0));
  await f.tick();
  void f.sync.refresh();
  // App has displayed the POST receipt and cleared its draft. Invalidate the
  // old read before confirming that receipt; a failed new GET must retain it.
  f.sync.written();
  assert.equal(f.requests[1].signal.aborted, true);
  f.requests[1].resolve(snapshot(0));
  await f.tick();
  assert.equal(f.snapshots.length, 1);
  f.runTimer(150);
  f.requests[2].reject(new Error('network down'));
  await f.tick();
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.states.at(-1)?.phase, 'offline');
  f.runTimer(750);
  f.requests[3].resolve(snapshot(2));
  await f.tick();
  assert.equal(f.snapshots.length, 2);
  assert.equal(f.snapshots.at(-1)?.sync.revision, 2);
  assert.equal(f.states.at(-1)?.phase, 'online');
  f.sync.stop();
});

test('a delayed handshake cannot lower the same-epoch revision already displayed from GET', async () => {
  const f = fixture();
  void f.sync.refresh();
  f.requests[0].resolve(snapshot(10));
  await f.tick();
  f.sync.opened();
  f.sync.handshake({ epoch: 'server-a', revision: 3 });
  f.sync.event('message', 'server-a:4', message('obsolete'));
  assert.equal(f.messages.length, 0);
  f.requests[1].resolve(snapshot(10));
  await f.tick();
  assert.equal(f.states.at(-1)?.phase, 'online');
  f.sync.event('message', 'server-a:11', message('latest'));
  assert.deepEqual(
    f.messages.map((value) => value.id),
    ['latest'],
  );
  f.sync.stop();
});

test('new-epoch GETs before reconnect and continuously stale snapshots use bounded backoff', async () => {
  for (const differentEpoch of [false, true]) {
    const f = fixture();
    f.sync.handshake({ epoch: 'server-a', revision: 10 });
    f.requests[0].resolve(snapshot(10));
    await f.tick();
    if (differentEpoch) f.sync.disconnected();
    else f.sync.event('message', 'server-a:11', message('new'));
    void f.sync.refresh();
    for (const delay of [750, 1500, 3000, 6000, 12000]) {
      f.requests
        .at(-1)!
        .resolve(snapshot(differentEpoch ? 0 : 10, differentEpoch ? 'server-b' : 'server-a'));
      await f.tick();
      assert.equal(f.snapshots.length, 1);
      assert.equal(
        [...f.timers.values()].some((t) => t.delay === 150),
        false,
      );
      f.runTimer(delay);
    }
    f.requests.at(-1)!.resolve(snapshot(0, 'server-b'));
    await f.tick();
    assert.equal(f.timers.size, 0);
    f.sync.opened();
    f.sync.handshake({ epoch: 'server-b', revision: 0 });
    f.requests.at(-1)!.resolve(snapshot(0, 'server-b'));
    await f.tick();
    assert.equal(f.states.at(-1)?.phase, 'online');
    f.sync.stop();
  }
});
