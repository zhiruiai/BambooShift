import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextRoutineRun,
  normalizeRoutineSchedule,
  parseRoutineSchedule,
} from '../../shared/routine-schedule';
import { draftForRoutine, routineNextRunLabel, routineSaveBody } from './routineDraft';
import {
  createRoutineWebhookClient,
  routineWebhookEndpoint,
  type RoutineWebhookState,
} from './routineWebhooks';
import {
  client as operationClient,
  deferred,
  json,
  receipt,
  routine,
} from './testSupport/routineOperationsFixture';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = 'fixture-owner';
const routineId = 'fixture-routine';
const endpoint = `/api/routine-webhooks/${workspaceId}/${routineId}`;
const revisionA = '22222222-2222-4222-8222-222222222222';
const revisionB = '33333333-3333-4333-8333-333333333333';
const revisionC = '44444444-4444-4444-8444-444444444444';
const key = 'a'.repeat(43);

test('Webhook endpoint accepts safe legacy routine IDs in canonical workspace scope', () => {
  assert.equal(routineWebhookEndpoint(workspaceId, routineId), endpoint);
  for (const unsafe of ['../outside', 'unsafe%2Fid', 'unsafe.id', 'unsafe\n', 'a'.repeat(161), ''])
    assert.equal(routineWebhookEndpoint(workspaceId, unsafe), undefined);
  assert.equal(
    routineWebhookEndpoint('AA111111-1111-4111-8111-111111111111', routineId),
    undefined,
  );
});

function makeClient(fetch: typeof globalThis.fetch, identity = () => ({ workspaceId, userId })) {
  let state: RoutineWebhookState = { busy: false };
  const client = createRoutineWebhookClient({
    workspaceId,
    userId,
    routineId,
    identity,
    locationWorkspace: () => workspaceId,
    fetch,
    onState(next) {
      state = next;
    },
  });
  return { client, state: () => state };
}

test('event-only schedules round-trip without a time and manual run receipts preserve exact schedule checks', async () => {
  assert.deepEqual(parseRoutineSchedule('webhook'), { kind: 'webhook' });
  assert.equal(normalizeRoutineSchedule('webhook'), 'webhook');
  assert.equal(nextRoutineRun('webhook'), '');
  assert.throws(() => parseRoutineSchedule('webhook:09:00'));
  const eventOnly = { ...routine, schedule: 'webhook', nextRunAt: '' };
  const draft = draftForRoutine([], eventOnly);
  assert.equal(draft.mode, 'webhook');
  assert.equal(routineSaveBody(draft, routine.conversationId).schedule, 'webhook');
  assert.equal(routineSaveBody(draft, routine.conversationId, eventOnly).schedule, undefined);
  assert.match(routineNextRunLabel(eventOnly), /无定时执行/);
  const transport: typeof fetch = async (_url, init) =>
    json({ ...receipt(JSON.parse(String(init?.body))), nextRunAt: '' });
  const event = operationClient(transport);
  await event.run(eventOnly);
  assert.equal(event.state().receipt?.status, 'submitted');
  const scheduled = operationClient(transport);
  await scheduled.run(routine);
  assert.equal(scheduled.state().receipt, undefined);
});

test('key management binds owner and revision, shows a fresh key once, and rechecks an unknown rotation without replay', async () => {
  const requests: Array<{ method?: string; body?: unknown }> = [];
  let current: object = { enabled: false, revision: 'unset' };
  const { client, state } = makeClient(async (url, init) => {
    assert.equal(url, `/api/workspaces/${workspaceId}/routines/${routineId}/webhook`);
    assert.equal(new Headers(init?.headers).get('X-OpenBot-Expected-User'), userId);
    assert.equal(init?.cache, 'no-store');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method, body });
    if (init?.method === 'GET') return json(current);
    if (body.expectedRevision === 'unset') {
      current = { enabled: true, revision: revisionA, path: endpoint };
      return json({ ...current, secret: key });
    }
    if (body.expectedRevision === revisionA) {
      current = { enabled: true, revision: revisionB, path: endpoint };
      throw new TypeError('response lost after commit');
    }
    assert.equal(init?.method, 'DELETE');
    current = { enabled: false, revision: revisionC };
    return json(current);
  });
  await client.read();
  assert.deepEqual(state().config, current);
  await client.write('PUT', 'unset');
  assert.equal(state().secret, key);
  assert.equal(state().config?.revision, revisionA);
  client.discardSecret();
  assert.equal(state().secret, undefined);
  await client.write('PUT', 'unset');
  await client.write('PUT', revisionA);
  assert.equal(state().notice, 'unknown');
  assert.equal(state().config?.revision, revisionB);
  assert.equal(state().secret, undefined);
  await client.write('DELETE', revisionB);
  assert.equal(state().notice, 'revoked');
  assert.deepEqual(state().config, current);
  assert.deepEqual(requests, [
    { method: 'GET', body: undefined },
    { method: 'PUT', body: { expectedRevision: 'unset' } },
    { method: 'PUT', body: { expectedRevision: revisionA } },
    { method: 'GET', body: undefined },
    { method: 'DELETE', body: { expectedRevision: revisionB } },
  ]);
});

test('a stale revision and malformed status cannot expose a key or permit another write', async () => {
  let reads = 0,
    writes = 0;
  const { client, state } = makeClient(async (_url, init) => {
    if (init?.method === 'GET') {
      reads++;
      return reads === 1
        ? json({ enabled: false, revision: 'unset' })
        : json({ enabled: true, revision: revisionA, path: endpoint, secret: key });
    }
    writes++;
    return json({ code: 'ROUTINE_WEBHOOK_CHANGED' }, 409);
  });
  await client.read();
  await client.write('PUT', 'unset');
  assert.equal(state().notice, 'changed');
  assert.equal(state().config, undefined);
  assert.equal(state().secret, undefined);
  await client.write('PUT', 'unset');
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});

test('delayed key delivery is dropped after hiding, account changes, and panel close', async () => {
  for (const mode of ['hide', 'identity', 'close']) {
    let actor = userId;
    const late = deferred<Response>();
    const { client, state } = makeClient(
      async (_url, init) =>
        init?.method === 'GET' ? json({ enabled: false, revision: 'unset' }) : late.promise,
      () => ({ workspaceId, userId: actor }),
    );
    await client.read();
    const pending = client.write('PUT', 'unset');
    if (mode === 'hide') client.discardSecret();
    if (mode === 'identity') actor = 'another-actor';
    if (mode === 'close') client.suspend();
    late.resolve(json({ enabled: true, revision: revisionA, path: endpoint, secret: key }));
    await pending;
    assert.equal(state().secret, undefined, mode);
    if (mode === 'hide') assert.equal(state().config?.revision, revisionA);
  }
});
