import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutineTransferClient, routineTransferTargets } from './routineTransfers';
import type { Routine, Conversation } from '../../shared/types';
import type { RoutineTransferReceipt, TransferRoutineRequest } from '../../shared/routine-transfers';
import { routineConfigSnapshot } from '../../shared/routine-operations';
import {
  agent,
  peer,
  workspaceId,
  userId,
  storage,
  json,
  deferred,
  harness,
  all,
  click,
} from './testSupport/creationFlowFixture';
const routine: Routine = {
  id: 'routine-a',
  agentId: agent.id,
  conversationId: 'chat-a',
  title: 'Synthetic routine',
  prompt: 'SYNTHETIC_PRIVATE_PROMPT',
  schedule: 'daily:09:30',
  timeZone: 'Asia/Shanghai',
  enabled: true,
  nextRunAt: '2026-11-08T01:30:00Z',
};
const chat = (id: string, aid: string): Conversation => ({
  id,
  title: id,
  agentIds: [aid],
  isGroup: false,
  updatedAt: '2026-11-07T00:00:00Z',
  unread: 0,
  pinned: false,
});
const conversations = [chat('chat-a', agent.id), chat('chat-b', peer.id)];
function receipt(body: TransferRoutineRequest): RoutineTransferReceipt {
  return {
    requestId: body.requestId,
    routineId: routine.id,
    userId,
    workspaceId,
    sourceAgentId: agent.id,
    sourceConversationId: 'chat-a',
    targetAgentId: body.targetAgentId,
    targetConversationId: body.targetConversationId,
    appliedRevision: 'a'.repeat(64),
    createdAt: '2026-11-07T00:00:00Z',
    status: 'transferred',
    routine: { ...routine, agentId: body.targetAgentId, conversationId: body.targetConversationId },
  };
}
type Call = { path: string; method: string; body?: any; headers: Headers; signal?: AbortSignal };
function fixture(
  transport?: (call: Call, fallback: () => Response) => Response | Promise<Response>,
  memory = storage(),
) {
  const calls: Call[] = [],
    accepted: RoutineTransferReceipt[] = [];
  let identity = { userId, workspaceId },
    location = workspaceId,
    saved: RoutineTransferReceipt | undefined;
  const client = createRoutineTransferClient({
    userId,
    workspaceId,
    routineId: routine.id,
    identity: () => identity,
    locationWorkspace: () => location,
    storage: memory,
    onTransferred: (r) => {
      accepted.push(r);
    },
    fetch: async (path, init) => {
      const call = {
        path: String(path),
        method: init?.method || 'GET',
        body: init?.body && JSON.parse(String(init.body)),
        headers: new Headers(init?.headers),
        signal: init?.signal || undefined,
      };
      calls.push(call);
      const fallback = () => {
        if (call.path.endsWith('/transfer')) {
          saved = receipt(call.body);
          return json(saved);
        }
        if (call.path.endsWith('/cancel'))
          return json(
            saved || {
              requestId: call.path.split('/').at(-2),
              userId,
              workspaceId,
              status: 'not_transferred',
            },
          );
        return saved ? json(saved) : json({ error: 'No receipt' }, 404);
      };
      return transport ? transport(call, fallback) : fallback();
    },
  });
  return {
    client,
    calls,
    memory,
    accepted,
    changeActor() {
      identity = { ...identity, userId: 'another-actor' };
    },
    changeLocation() {
      location = 'another-space';
    },
  };
}
test('only other local Bots with one direct chat are selectable', () => {
  const shared = { ...peer, id: 'shared', sharedBot: {} } as typeof peer;
  const duplicate = { ...peer, id: 'duplicate' },
    groupOnly = { ...peer, id: 'group-only' };
  const candidates = routineTransferTargets(
    [agent, peer, shared, duplicate, groupOnly],
    [
      ...conversations,
      chat('shared-chat', shared.id),
      chat('duplicate-one', duplicate.id),
      chat('duplicate-two', duplicate.id),
      { ...chat('group', groupOnly.id), isGroup: true },
    ],
    agent.id,
  );
  assert.deepEqual(
    candidates.map((c) => [c.agent.id, c.conversation.id]),
    [[peer.id, 'chat-b']],
  );
});
test('explicit confirmation binds exact config and actor, preserves recovery ID, and never starts a run', async () => {
  const f = fixture();
  await f.client.check();
  assert.equal(await f.client.start(routine, peer.id, 'chat-b'), true);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.path, `/api/workspaces/${workspaceId}/routines/${routine.id}/transfer`);
  assert.equal(call.headers.get('X-OpenBot-Expected-User'), userId);
  assert.deepEqual(call.body.expectedRoutine, routineConfigSnapshot(routine));
  assert.equal(f.accepted[0].routine?.nextRunAt, routine.nextRunAt);
  assert.deepEqual([...f.memory.values.values()], [call.body.requestId]);
  assert.equal([...f.memory.values.values()].join('').includes(routine.prompt), false);
  assert.equal(await f.client.start(routine, peer.id, 'chat-b'), false);
  f.client.acknowledge();
  assert.equal(f.memory.values.size, 0);
});
test('failed recovery cleanup keeps the accepted receipt and can be retried without another transfer', async () => {
  let denied = true;
  const memory = storage(),
    f = fixture(undefined, {
      ...memory,
      removeItem(key) {
        if (denied) throw Error('Storage unavailable');
        memory.removeItem(key);
      },
    });
  await f.client.check();
  await f.client.start(routine, peer.id, 'chat-b');
  assert.equal(f.client.acknowledge(), false);
  assert.equal(f.client.state.receipt?.status, 'transferred');
  assert.equal(memory.values.size, 1);
  denied = false;
  assert.equal(f.client.acknowledge(), true);
  assert.equal(memory.values.size, 0);
  assert.equal(f.calls.length, 1);
});

test('lost responses retain the original body only in memory; exact retry is possible after read-only 404', async () => {
  let attempts = 0;
  const f = fixture((call, fallback) => {
    if (call.path.endsWith('/transfer') && ++attempts === 1) throw new TypeError('Lost response');
    return fallback();
  });
  await f.client.check();
  assert.equal(await f.client.start(routine, peer.id, 'chat-b'), false);
  const first = f.calls[0].body;
  assert.equal(f.client.canRetry, false);
  assert.equal(await f.client.retry(), false);
  await f.client.check();
  assert.equal(f.client.canRetry, true);
  assert.equal(await f.client.retry(), true);
  assert.deepEqual(
    f.calls.filter((c) => c.path.endsWith('/transfer')).map((c) => c.body),
    [first, first],
  );
});
test('remount with ID and no body cannot resend; durable cancellation safely frees a new intent', async () => {
  const old = fixture((call) =>
    call.method === 'POST'
      ? Promise.reject(new TypeError('Lost'))
      : json({ error: 'No receipt' }, 404),
  );
  await old.client.check();
  await old.client.start(routine, peer.id, 'chat-b');
  const original = old.client.state.requestId;
  old.client.close();
  const recovered = fixture(undefined, old.memory);
  await recovered.client.check();
  assert.equal(recovered.client.state.requestId, original);
  assert.equal(recovered.client.canRetry, false);
  assert.equal(await recovered.client.retry(), false);
  assert.equal(await recovered.client.start(routine, peer.id, 'chat-b'), false);
  assert.ok(recovered.calls.every((c) => c.method === 'GET'));
  assert.equal(await recovered.client.cancel(), true);
  assert.equal(recovered.memory.values.size, 0);
  assert.equal(await recovered.client.start(routine, peer.id, 'chat-b'), true);
  assert.notEqual(recovered.client.state.requestId, original);
});
test('accepted cancellation only recovers the real receipt; closed IDs and forged receipts stay distinct', async () => {
  const f = fixture();
  await f.client.check();
  await f.client.start(routine, peer.id, 'chat-b');
  const id = f.client.state.requestId;
  await f.client.cancel();
  assert.equal(f.client.state.requestId, id);
  assert.equal(f.client.state.receipt?.status, 'transferred');
  const lost = fixture((call) =>
    call.method === 'POST'
      ? Promise.reject(new TypeError('Lost'))
      : json({ error: 'Closed', code: 'ROUTINE_TRANSFER_CLOSED' }, 410),
  );
  await lost.client.check();
  await lost.client.start(routine, peer.id, 'chat-b');
  await lost.client.check();
  assert.equal(lost.client.state.requestId, undefined);
  const forged = fixture((call, fallback) =>
    call.path.endsWith('/transfer') ? json({ ...receipt(call.body), userId: 'other' }) : fallback(),
  );
  await forged.client.check();
  assert.equal(await forged.client.start(routine, peer.id, 'chat-b'), false);
  assert.equal(forged.accepted.length, 0);
  assert.ok(forged.client.state.requestId);
});
test('late receipt cannot notify or clear recovery after actor, location, or unmount changes', async () => {
  for (const mode of ['actor', 'location', 'unmount']) {
    const pending = deferred<Response>();
    const f = fixture(() => pending.promise);
    await f.client.check();
    const running = f.client.start(routine, peer.id, 'chat-b');
    const body = f.calls[0].body;
    if (mode === 'actor') f.changeActor();
    else if (mode === 'location') f.changeLocation();
    else f.client.close();
    pending.resolve(json(receipt(body)));
    assert.equal(await running, false);
    assert.equal(f.accepted.length, 0);
    assert.equal(f.memory.values.size, 1);
    assert.equal(await f.client.cancel(), false);
    assert.equal(f.calls.length, 1);
  }
});
test('existing pending ID is never overwritten before initial load and denied storage never dispatches', async () => {
  const memory = storage();
  memory.setItem(
    `openbot-routine-transfer:${JSON.stringify([workspaceId, userId, routine.id])}`,
    crypto.randomUUID(),
  );
  const f = fixture(undefined, memory);
  assert.equal(await f.client.start(routine, peer.id, 'chat-b'), false);
  assert.equal(f.calls.length, 0);
  const denied = fixture(undefined, {
    ...storage(),
    setItem() {
      throw Error('Storage unavailable');
    },
  });
  await denied.client.check();
  assert.equal(await denied.client.start(routine, peer.id, 'chat-b'), false);
  assert.equal(denied.calls.length, 0);
});
test('the actual transfer dialog keeps selection across configuration changes and requires explicit refreshed confirmation', async () => {
  const calls: Call[] = [],
    accepted: RoutineTransferReceipt[] = [];
  let closed = 0;
  const ui = await harness(
    'web/src/components/RoutineTransferDialog.tsx',
    'TransferView',
    {
      routine,
      currentRoutine: routine,
      agents: [agent, peer],
      conversations,
      userId,
      workspaceId,
      onClose() {
        closed++;
      },
      onTransferred(r: RoutineTransferReceipt) {
        accepted.push(r);
      },
    },
    {
      window: { location: { pathname: `/w/${workspaceId}/` }, dispatchEvent() {} },
      sessionStorage: storage(),
      TextEncoder,
      Event,
      fetch: async (path: string, init: any) => {
        const call = {
          path,
          method: init.method,
          body: init.body && JSON.parse(init.body),
          headers: new Headers(init.headers),
        };
        calls.push(call);
        return json(receipt(call.body));
      },
    },
  );
  try {
    await ui.flush();
    assert.equal(calls.length, 0);
    assert.equal(ui.button('确认转交').props.disabled, true);
    all(ui.tree, (n) => n.type === 'select')[0].props.onChange({ target: { value: peer.id } });
    await ui.flush();
    assert.equal(ui.button('确认转交').props.disabled, false);
    ui.setProps({ currentRoutine: { ...routine, prompt: 'Changed explicitly' } });
    await ui.flush();
    assert.equal(ui.button('确认转交').props.disabled, true);
    assert.equal(all(ui.tree, (n) => n.type === 'select')[0].props.value, peer.id);
    await click(ui, '载入当前计划');
    await click(ui, '确认转交');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.expectedRoutine.prompt, 'Changed explicitly');
    assert.equal(accepted.length, 1);
    await click(ui, '完成');
    assert.equal(closed, 1);
  } finally {
    ui.dispose();
  }
});
test('retained dialog confirmation cannot dispatch after a current account change', async () => {
  let calls = 0;
  const ui = await harness(
    'web/src/components/RoutineTransferDialog.tsx',
    'TransferView',
    {
      routine,
      currentRoutine: routine,
      agents: [agent, peer],
      conversations,
      userId,
      workspaceId,
      onClose() {},
    },
    {
      window: { location: { pathname: `/w/${workspaceId}/` }, dispatchEvent() {} },
      sessionStorage: storage(),
      TextEncoder,
      Event,
      fetch: async () => {
        calls++;
        return json({});
      },
    },
  );
  try {
    await ui.flush();
    all(ui.tree, (n) => n.type === 'select')[0].props.onChange({ target: { value: peer.id } });
    await ui.flush();
    const click = ui.button('确认转交').props.onClick;
    ui.setProps({ userId: 'another-actor' });
    await ui.flush();
    click();
    await ui.flush();
    assert.equal(calls, 0);
  } finally {
    ui.dispose();
  }
});

test('the workspace entry enables transfer only in the current personal space, not merely when the user owns one', async () => {
  const ui = await harness('web/src/workspace/WorkspaceTaskDialogs.tsx', 'WorkspaceTaskDialogs', {
    modal: 'routine',
    canManage: true,
    account: { workspace: { id: workspaceId, kind: 'team' } },
    personalSpace: { id: 'another-personal-space', kind: 'personal' },
    sendIdentity: { current: { userId, workspaceId } },
    currentUserId: userId,
    data: { agents: [agent, peer], conversations, routines: [routine] },
    routines: [routine],
    members: [agent, peer],
  });
  try {
    await ui.flush();
    const form = () => all(ui.tree, (n) => n.type?.name === 'RoutineDialog')[0];
    assert.equal(form().props.canTransferRoutines, false);
    ui.setProps({ account: { workspace: { id: workspaceId, kind: 'personal' } } });
    await ui.flush();
    assert.equal(form().props.canTransferRoutines, true);
    ui.setProps({ canManage: false });
    await ui.flush();
    assert.equal(form(), undefined);
  } finally {
    ui.dispose();
  }
});
