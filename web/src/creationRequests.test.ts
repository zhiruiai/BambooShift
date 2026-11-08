import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  CreationBotProfile,
  CreationReceipt,
  CreationRequest,
} from '../../shared/creation-requests';
import type { BotAgent } from '../../shared/types';
import { createCreationRequestClient } from './creationRequests';

const workspaceId = '11111111-1111-4111-8111-111111111111',
  userId = 'user-a';
const profile: CreationBotProfile = {
  name: '保留原名字',
  role: '协调',
  description: '私有简介',
  instructions: '不要写入恢复存储的指令',
  color: '#9363ed',
  avatar: 'orb',
  avatarImageId: '22222222-2222-4222-8222-222222222222',
};
const group = { title: '原工作组名称', agentIds: ['a', 'b'] };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function receipt(body: CreationRequest, changes: Partial<CreationReceipt> = {}): CreationReceipt {
  const ids = body.kind === 'bot' ? ['created-bot'] : [...body.agentIds];
  return {
    requestId: body.requestId,
    kind: body.kind,
    status: 'created',
    agentIds: ids,
    conversationId: 'created-chat',
    createdAt: '2026-11-05T00:00:00Z',
    userId,
    workspaceId,
    conversation: {
      id: 'created-chat',
      title: body.kind === 'bot' ? body.profile.name : body.title,
      isGroup: body.kind === 'group',
      agentIds: ids,
      updatedAt: '2026-11-05T00:00:00Z',
      unread: 0,
      pinned: false,
    },
    agents: ids.map((id) => ({ ...profile, id, status: 'idle' })),
    ...changes,
  };
}
type Call = { path: string; method: string; body?: any; headers: Headers };
function fixture(
  transport: (call: Call) => Promise<Response> | Response,
  extra: Record<string, any> = {},
) {
  const memory = storage(),
    calls: Call[] = [],
    updates: CreationReceipt[] = [];
  const client = createCreationRequestClient({
    workspaceId,
    userId,
    identity: () => ({ workspaceId, userId }),
    locationWorkspace: () => workspaceId,
    storage: memory,
    onChanged: (value) => {
      updates.push(value);
    },
    fetch: (async (url, init) => {
      const call = {
        path: String(url),
        method: init?.method || 'GET',
        body: init?.body && JSON.parse(String(init.body)),
        headers: new Headers(init?.headers),
      };
      calls.push(call);
      return transport(call);
    }) as typeof fetch,
    ...extra,
  });
  return { client, calls, memory, updates };
}

test('creation binds the account and freezes the original profile before asynchronous preparation', async () => {
  const f = fixture((call) => json(receipt(call.body)));
  const input = structuredClone(profile);
  const pending = f.client.createBot(input);
  input.name = '后来改名';
  input.instructions = '后来指令';
  await f.client.createBot({ ...profile, name: '重复点击' });
  const result = await pending;
  assert.equal(result?.status, 'created');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, `/api/workspaces/${workspaceId}/creation-requests`);
  assert.equal(f.calls[0].headers.get('X-OpenBot-Expected-User'), userId);
  assert.equal(f.calls[0].body.profile.name, profile.name);
  assert.equal(f.calls[0].body.profile.instructions, profile.instructions);
  assert.equal(f.client.state().originalAvailable, false);
  assert.equal(f.client.state().canRetry, false);
  const stored = [...f.memory.values.values()][0];
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), [
    'digest',
    'kind',
    'requestId',
    'version',
  ]);
  assert.doesNotMatch(stored, /保留|私有|指令|avatar|profile/);
  assert.equal(f.client.finish(), true);
  assert.equal(f.memory.values.size, 0);
});

test('lost response requires a read before an explicit same-body same-ID retry', async () => {
  let attempts = 0;
  const f = fixture((call) => {
    if (call.method === 'GET') return json({ error: '尚无回执' }, 404);
    if (++attempts === 1) throw new TypeError('lost response');
    return json(receipt(call.body));
  });
  await f.client.createGroup(group);
  assert.equal(f.client.state().originalAvailable, true);
  await f.client.retry();
  await f.client.createBot(profile);
  assert.equal(f.calls.length, 1);
  assert.equal(await f.client.check(), undefined);
  assert.equal(f.client.state().canRetry, true);
  const result = await f.client.retry();
  assert.equal(result?.kind, 'group');
  assert.deepEqual(f.calls[0].body, f.calls[2].body);
  assert.equal(f.client.state().originalAvailable, false);
  await f.client.retry();
  assert.equal(f.calls.length, 3);
});

test('reload restores metadata only and reads the current group instead of immutable original membership', async () => {
  let original!: CreationRequest;
  const f = fixture((call) => {
    original = call.body;
    throw new TypeError('lost response');
  });
  await f.client.createGroup(group);
  f.client.suspend();
  const originalReceipt = receipt(original);
  const currentAgent: BotAgent = { ...profile, id: 'c', name: '后来成员', status: 'idle' };
  const currentReceipt = {
    ...originalReceipt,
    conversation: { ...originalReceipt.conversation!, title: '后来改名的群', agentIds: ['c'] },
    agents: [currentAgent],
  };
  const restored = fixture(() => json(currentReceipt), { storage: f.memory });
  assert.equal(restored.client.state().originalAvailable, false);
  await restored.client.retry();
  assert.equal(restored.calls.length, 0);
  const result = await restored.client.check();
  assert.deepEqual(result?.agentIds, ['a', 'b']);
  assert.deepEqual(result?.conversation?.agentIds, ['c']);
  assert.equal(result?.conversation?.title, '后来改名的群');
  assert.ok(restored.calls.every((call) => call.method === 'GET'));
});

test('a missing original result is a receipt, never a reason to recreate', async () => {
  let saved!: CreationReceipt;
  const f = fixture((call) =>
    call.method === 'POST'
      ? json((saved = receipt(call.body)))
      : json({ ...saved, status: 'missing', conversation: undefined, agents: [] }),
  );
  await f.client.createBot(profile);
  const result = await f.client.check();
  assert.equal(result?.status, 'missing');
  await f.client.retry();
  await f.client.createBot(profile);
  assert.equal(f.calls.length, 2);
  assert.equal(f.client.finish(), true);
});

test('404 cannot clear an unknown request and explicit cancellation fences a late server submission', async () => {
  let late!: CreationRequest;
  const closed = new Set<string>();
  let created = 0;
  const acceptLate = () => {
    if (closed.has(late.requestId)) return 'closed';
    created++;
    return 'created';
  };
  const f = fixture((call) => {
    if (call.path.endsWith('/cancel')) {
      assert.deepEqual(call.body, {});
      closed.add(late.requestId);
      return json({ requestId: late.requestId, status: 'not_submitted', userId, workspaceId });
    }
    if (call.method === 'GET') return json({ error: '尚无回执' }, 404);
    late = call.body;
    throw new TypeError('request remains in transit');
  });
  await f.client.createBot(profile);
  await f.client.check();
  assert.ok(f.client.state().request);
  assert.equal(f.client.finish(), false);
  await f.client.closeRequest();
  assert.equal(acceptLate(), 'closed');
  assert.equal(created, 0);
  assert.equal(f.client.state().request, undefined);
  assert.equal(f.client.state().originalAvailable, false);
  assert.match(f.client.state().message!, /草稿仍保留/);
  assert.equal(f.memory.values.size, 0);
});

test('cancelling an already accepted creation returns the original current result', async () => {
  let saved!: CreationReceipt;
  const f = fixture((call) => {
    if (call.path.endsWith('/cancel')) return json(saved);
    saved = receipt(call.body);
    throw new TypeError('receipt lost');
  });
  await f.client.createBot(profile);
  const result = await f.client.closeRequest();
  assert.equal(result?.requestId, saved.requestId);
  assert.equal(result?.status, 'created');
  assert.ok(f.client.state().request);
  assert.equal(f.client.state().originalAvailable, false);
  assert.equal(f.updates.length, 1);
});

test('unknown cancellation keeps the same ID until an exact closed GET result arrives', async () => {
  let closed = false;
  const f = fixture((call) => {
    if (call.path.endsWith('/cancel')) {
      closed = true;
      throw new TypeError('cancel response lost');
    }
    if (call.method === 'GET')
      return json({ error: 'closed', code: closed ? 'CREATION_REQUEST_CLOSED' : 'UNRELATED' }, 410);
    throw new TypeError('create lost');
  });
  await f.client.createGroup(group);
  const id = f.client.state().request!.requestId;
  await f.client.check();
  assert.equal(f.client.state().request?.requestId, id);
  await f.client.closeRequest();
  assert.equal(f.client.state().request?.requestId, id);
  await f.client.check();
  assert.equal(f.client.state().request, undefined);
  assert.equal(f.memory.values.size, 0);
});

test('all ordinary HTTP errors retain the request, including explicit rejection and closed POST', async () => {
  for (const status of [400, 401, 403, 404, 409, 410, 413, 422, 500]) {
    const f = fixture(() => json({ error: '拒绝', code: 'CREATION_REQUEST_CLOSED' }, status));
    await f.client.createBot(profile);
    assert.ok(f.client.state().request, String(status));
    assert.equal(f.client.state().originalAvailable, true);
    assert.equal(f.client.state().canRetry, false);
    assert.equal(f.memory.values.size, 1);
  }
});

test('late identity, workspace or disposal changes cannot publish a successful response', async () => {
  for (const change of ['identity', 'workspace', 'suspend']) {
    let identity = { workspaceId, userId },
      path: string | undefined = workspaceId;
    const response = deferred<Response>(),
      dispatched = deferred<CreationRequest>();
    const f = fixture(
      (call) => {
        dispatched.resolve(call.body);
        return response.promise;
      },
      {
        identity: () => identity,
        locationWorkspace: () => path,
      },
    );
    const work = f.client.createBot(profile),
      original = await dispatched.promise;
    if (change === 'identity') identity = { ...identity, userId: 'user-b' };
    if (change === 'workspace') path = 'another-workspace';
    if (change === 'suspend') f.client.suspend();
    response.resolve(json(receipt(original)));
    assert.equal(await work, undefined);
    assert.equal(f.updates.length, 0);
    assert.equal(f.client.state().receipt, undefined);
    assert.equal(f.memory.values.size, 1);
    await f.client.check();
    await f.client.closeRequest();
    assert.equal(f.calls.length, 1);
  }
});

test('an account change during digest preparation prevents storage and dispatch', async () => {
  let currentUser = userId;
  const f = fixture((call) => json(receipt(call.body)), {
    identity: () => ({ workspaceId, userId: currentUser }),
  });
  const work = f.client.createBot(profile);
  currentUser = 'user-b';
  await work;
  assert.equal(f.calls.length, 0);
  assert.equal(f.memory.values.size, 0);
  assert.equal(f.updates.length, 0);
});

test('unreadable, corrupt or unwritable metadata prevents any creation dispatch', async () => {
  for (const variant of ['read', 'write', 'silent', 'corrupt']) {
    const memory = storage();
    if (variant === 'read')
      memory.getItem = () => {
        throw Error('denied');
      };
    if (variant === 'write')
      memory.setItem = () => {
        throw Error('denied');
      };
    if (variant === 'silent') memory.setItem = () => {};
    if (variant === 'corrupt')
      memory.getItem = () =>
        '{"version":1,"kind":"bot","requestId":"wrong","digest":"bad","profile":"forbidden"}';
    const f = fixture((call) => json(receipt(call.body)), { storage: memory });
    await f.client.createBot(profile);
    assert.equal(f.calls.length, 0, variant);
    assert.ok(f.client.state().error);
  }
});

test('cleanup failure blocks a new ID, while an explicit later finish can release the final receipt', async () => {
  const memory = storage();
  const remove = memory.removeItem;
  const f = fixture((call) => json(receipt(call.body)), { storage: memory });
  await f.client.createBot(profile);
  memory.removeItem = () => {
    throw new Error('denied');
  };
  assert.equal(f.client.finish(), false);
  assert.equal(f.client.state().blocked, true);
  assert.equal(f.client.state().originalAvailable, false);
  await f.client.createGroup(group);
  assert.equal(f.calls.length, 1);
  memory.removeItem = remove;
  assert.equal(f.client.finish(), true);
  assert.equal(f.client.state().blocked, false);
  assert.equal(memory.values.size, 0);
});

test('failed refresh does not erase a confirmed result and a later failed check does not return stale navigation data', async () => {
  const f = fixture(
    (call) => (call.method === 'POST' ? json(receipt(call.body)) : json({ error: 'offline' }, 503)),
    {
      onChanged: async () => {
        throw new Error('refresh failed');
      },
    },
  );
  assert.equal((await f.client.createBot(profile))?.status, 'created');
  assert.equal(f.client.state().receipt?.status, 'created');
  assert.equal(await f.client.check(), undefined);
  assert.equal(f.client.state().receipt?.status, 'created');
  await f.client.retry();
  assert.equal(f.calls.length, 2);
});

test('receipt identity, kind, current entities and original group binding must all match', async () => {
  for (const patch of [
    { userId: 'other' },
    { workspaceId: 'other' },
    { requestId: 'other' },
    { kind: 'bot' },
    { agentIds: ['b', 'a'] },
    { conversation: undefined },
    { agents: [] },
    { status: 'missing' },
  ]) {
    const f = fixture((call) => json(receipt(call.body, patch as Partial<CreationReceipt>)));
    assert.equal(await f.client.createGroup(group), undefined);
    assert.equal(f.client.state().receipt, undefined);
    assert.equal(f.client.state().originalAvailable, true);
    assert.ok(f.client.state().request);
  }
});

test('a wrong cancellation identity cannot release an unresolved body and cleanup can recover through a closed read', async () => {
  let request!: CreationRequest,
    wrong = true,
    closed = false;
  const memory = storage(),
    remove = memory.removeItem;
  const f = fixture(
    (call) => {
      if (call.path.endsWith('/cancel')) {
        closed = !wrong;
        return json({
          requestId: request.requestId,
          status: 'not_submitted',
          userId: wrong ? 'another-user' : userId,
          workspaceId,
        });
      }
      if (call.method === 'GET')
        return json({ error: 'closed', code: 'CREATION_REQUEST_CLOSED' }, closed ? 410 : 404);
      request = call.body;
      throw new TypeError('lost response');
    },
    { storage: memory },
  );
  await f.client.createBot(profile);
  await f.client.closeRequest();
  assert.equal(f.client.state().request?.requestId, request.requestId);
  assert.equal(f.client.state().originalAvailable, true);
  wrong = false;
  memory.removeItem = () => {
    throw new Error('denied');
  };
  await f.client.closeRequest();
  assert.equal(f.client.state().blocked, true);
  assert.equal(f.client.state().originalAvailable, false);
  memory.removeItem = remove;
  await f.client.check();
  assert.equal(f.client.state().request, undefined);
  assert.equal(f.client.state().blocked, false);
  assert.equal(memory.values.size, 0);
});
