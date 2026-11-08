import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bootstrap } from '../../shared/types';
import { ApiError } from './api';
import { createWorkspaceSnapshotSource } from './workspaceSnapshot';
import { createWorkspaceSync } from './workspaceSync';

const identity = { userId: 'owner-a', workspaceId: 'workspace-a' };
const snapshot = (name = 'owner-private'): Bootstrap =>
  ({
    sync: { epoch: 'server', revision: 1 },
    sidebarRoster: {
      revision: name,
      sections: [{ id: 'section', name, collapsed: false }],
      entries: [],
    },
  }) as unknown as Bootstrap;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('private bootstrap uses the opening identity, fixed workspace URL, no-store and the actual synchronization signal', async () => {
  const controller = new AbortController(),
    calls: { url: string; init: RequestInit }[] = [];
  const source = createWorkspaceSnapshotSource({
    ...identity,
    identity: () => identity,
    locationWorkspace: () => identity.workspaceId,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return json(snapshot());
    },
  });
  assert.deepEqual(await source.read(controller.signal), snapshot());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/workspaces/workspace-a/bootstrap');
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(new Headers(calls[0].init.headers).get('X-OpenBot-Expected-User'), identity.userId);
});

test('changing account, workspace, or URL before dispatch cannot use the new identity to read private state', async () => {
  for (const change of ['account', 'workspace', 'url']) {
    let latest = { ...identity },
      location = identity.workspaceId,
      requests = 0;
    const source = createWorkspaceSnapshotSource({
      ...identity,
      identity: () => latest,
      locationWorkspace: () => location,
      fetch: async () => {
        requests++;
        return json(snapshot('other-private'));
      },
    });
    if (change === 'account') latest = { ...latest, userId: 'member-b' };
    if (change === 'workspace') latest = { ...latest, workspaceId: 'workspace-b' };
    if (change === 'url') location = 'workspace-b';
    assert.equal(source.current(), false);
    await assert.rejects(source.read(new AbortController().signal), { name: 'AbortError' });
    assert.equal(requests, 0);
  }
});

test('identity is checked after response headers and after body parsing, without late auth effects', async () => {
  for (const phase of ['headers', 'body'])
    for (const change of ['account', 'workspace', 'url']) {
      let latest = { ...identity },
        location = identity.workspaceId,
        notices = 0;
      const response = deferred<Response>(),
        body = deferred<Bootstrap>();
      const source = createWorkspaceSnapshotSource({
        ...identity,
        identity: () => latest,
        locationWorkspace: () => location,
        onAuthFailure: () => {
          notices++;
        },
        fetch: async () =>
          phase === 'headers'
            ? response.promise
            : ({ ok: true, status: 200, json: () => body.promise } as Response),
      });
      const reading = source.read(new AbortController().signal);
      await new Promise((done) => setImmediate(done));
      if (change === 'account') latest = { ...latest, userId: 'member-b' };
      if (change === 'workspace') latest = { ...latest, workspaceId: 'workspace-b' };
      if (change === 'url') location = 'workspace-b';
      response.resolve(json({ error: 'new cookie account' }, 403));
      body.resolve(snapshot('other-private'));
      await assert.rejects(reading, { name: 'AbortError' });
      assert.equal(notices, 0, `${phase}/${change}`);
    }
});

test('another login changing only cookies receives the old fixed expected user and cannot publish its private preferences', async () => {
  const statuses: number[] = [],
    rendered: Bootstrap[] = [];
  let requests = 0;
  const source = createWorkspaceSnapshotSource({
    ...identity,
    identity: () => identity,
    locationWorkspace: () => identity.workspaceId,
    onAuthFailure: (status) => statuses.push(status),
    fetch: async (_url, init) => {
      requests++;
      const actualCookieUser = 'member-b',
        expected = new Headers(init?.headers).get('X-OpenBot-Expected-User');
      assert.equal(expected, 'owner-a');
      return String(expected) !== actualCookieUser
        ? json({ error: '当前登录账户已变化' }, 403)
        : json(snapshot('member-private'));
    },
  });
  const scheduled: Array<() => void> = [];
  const sync = createWorkspaceSync({
    fetch: source.read,
    snapshot: (value) => rendered.push(value),
    message() {},
    status() {},
    schedule: (fn) => {
      scheduled.push(fn);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel() {},
  });
  try {
    await sync.refresh();
    assert.equal(requests, 1);
    assert.deepEqual(statuses, [403]);
    assert.equal(rendered.length, 0);
  } finally {
    sync.stop();
  }
});

test('synchronization cancellation prevents both initial fetch and late successful snapshots', async () => {
  let calls = 0;
  const pending = deferred<Response>();
  const source = createWorkspaceSnapshotSource({
    ...identity,
    identity: () => identity,
    locationWorkspace: () => identity.workspaceId,
    fetch: async () => {
      calls++;
      return pending.promise;
    },
  });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(source.read(aborted.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
  const active = new AbortController(),
    reading = source.read(active.signal);
  active.abort();
  pending.resolve(json(snapshot()));
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('legacy remains unscoped without an account header and authentication failures keep their explicit status', async () => {
  const statuses: number[] = [];
  for (const status of [200, 401, 403]) {
    const source = createWorkspaceSnapshotSource({
      identity: () => ({}),
      locationWorkspace: () => undefined,
      onAuthFailure: (value) => statuses.push(value),
      fetch: async (url, init) => {
        assert.equal(url, '/api/bootstrap');
        assert.equal(new Headers(init?.headers).has('X-OpenBot-Expected-User'), false);
        return json(status === 200 ? snapshot() : { error: 'identity unavailable' }, status);
      },
    });
    if (status === 200)
      assert.deepEqual(await source.read(new AbortController().signal), snapshot());
    else
      await assert.rejects(
        source.read(new AbortController().signal),
        (error: unknown) => error instanceof ApiError && error.status === status,
      );
  }
  assert.deepEqual(statuses, [401, 403]);
});
