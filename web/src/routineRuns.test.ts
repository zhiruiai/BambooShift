import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutineRunsClient, routineRunLabel, routineRunTime } from './routineRuns';
import type { RoutineRun } from '../../shared/routine-runs';

const workspaceId = '11111111-1111-4111-8111-111111111111',
  userId = 'owner-a';
const run: RoutineRun = {
  runId: 'run-a',
  routineId: 'routine-a',
  agentId: 'bot-a',
  conversationId: 'chat-a',
  inputMessageId: 'input-a',
  resultMessageId: 'result-a',
  trigger: 'scheduled',
  status: 'completed',
  startedAt: '2030-11-05T01:00:00Z',
  finishedAt: '2030-11-05T01:02:00Z',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function client(
  transport: typeof fetch,
  extra: Partial<Parameters<typeof createRoutineRunsClient>[0]> = {},
) {
  return createRoutineRunsClient({
    workspaceId,
    userId,
    routineId: run.routineId,
    identity: () => ({ workspaceId, userId }),
    locationWorkspace: () => workspaceId,
    fetch: transport,
    ...extra,
  });
}

test('history and exact result reads bind actor/workspace and never issue mutations', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const c = client(async (url, init) => {
    requests.push({ url: String(url), init });
    return json(String(url).endsWith('/run-a') ? run : { routineId: run.routineId, runs: [run] });
  });
  await c.read();
  assert.equal(c.state().loaded, true);
  assert.deepEqual(c.state().runs, [run]);
  assert.deepEqual(await c.get(run.runId), run);
  assert.deepEqual(
    requests.map((r) => r.url),
    [
      `/api/workspaces/${workspaceId}/routines/routine-a/runs`,
      `/api/workspaces/${workspaceId}/routines/routine-a/runs/run-a`,
    ],
  );
  assert.ok(
    requests.every(
      (r) =>
        r.init?.method === 'GET' &&
        new Headers(r.init.headers).get('X-OpenBot-Expected-User') === userId &&
        r.init.body === undefined,
    ),
  );
  c.suspend();
});

test('Webhook deliveries are valid entries in routine history', async () => {
  const delivery: RoutineRun = { ...run, trigger: 'webhook' };
  const c = client(async (url) =>
    json(
      String(url).endsWith('/run-a')
        ? delivery
        : {
            routineId: run.routineId,
            runs: [delivery],
          },
    ),
  );
  await c.read();
  assert.deepEqual(c.state().runs, [delivery]);
  assert.deepEqual(await c.get(run.runId), delivery);
});

test('delayed older lists cannot replace a newer refresh and read errors retain real history', async () => {
  const first = deferred<Response>();
  let reads = 0;
  const c = client(async () => {
    reads++;
    return reads === 1
      ? first.promise
      : reads === 2
        ? json({ routineId: run.routineId, runs: [run] })
        : json({ error: '暂时无法读取记录' }, 503);
  });
  const old = c.read();
  await c.read();
  first.resolve(json({ routineId: run.routineId, runs: [{ ...run, status: 'running' }] }));
  await old;
  assert.equal(c.state().runs[0].status, 'completed');
  await c.read();
  assert.match(c.state().error, /暂时无法读取/);
  assert.equal(c.state().runs[0].status, 'completed');
  c.suspend();
});

test('identity change, URL change and unmount discard late list bodies and old callbacks', async () => {
  for (const mode of ['identity', 'location', 'unmount']) {
    const response = deferred<Response>();
    let identity = { workspaceId, userId },
      location = workspaceId,
      updates = 0,
      reads = 0;
    const c = client(
      async () => {
        reads++;
        return response.promise;
      },
      {
        identity: () => identity,
        locationWorkspace: () => location,
        onState: () => {
          updates++;
        },
      },
    );
    const pending = c.read(),
      before = updates;
    if (mode === 'identity') identity = { workspaceId, userId: 'other-user' };
    if (mode === 'location') location = '22222222-2222-4222-8222-222222222222';
    if (mode === 'unmount') c.suspend();
    response.resolve(json({ routineId: run.routineId, runs: [run] }));
    await pending;
    await c.read();
    assert.equal(updates, before);
    assert.equal(reads, 1);
    assert.equal(c.state().loaded, false);
    c.suspend();
  }
});

test('malformed or cross-routine responses do not manufacture an empty history', async () => {
  for (const value of [
    [],
    { routineId: 'other', runs: [] },
    { routineId: run.routineId, runs: [{ ...run, routineId: 'other' }] },
    { routineId: run.routineId, runs: [run, run] },
  ]) {
    const c = client(async () => json(value));
    await c.read();
    assert.equal(c.state().loaded, false);
    assert.ok(c.state().error);
    c.suspend();
  }
});

test('fresh run can retain status but lose a deleted result; wrong run IDs are rejected', async () => {
  let value: RoutineRun = { ...run, resultMessageId: undefined };
  const c = client(async () => json(value));
  assert.equal((await c.get(run.runId))?.resultMessageId, undefined);
  value = { ...run, runId: 'other' };
  await assert.rejects(c.get(run.runId), /核对/);
  c.suspend();
});

test('run states and actual timestamps distinguish completion from attempted work and honor saved zones', () => {
  assert.deepEqual(
    ['running', 'completed', 'error', 'cancelled', 'interrupted'].map((status) =>
      routineRunLabel(status as RoutineRun['status']),
    ),
    ['正在运行', '已完成', '运行失败', '已取消', '已中断'],
  );
  assert.match(routineRunTime(run.startedAt), /09:00:00.*北京时间/);
  assert.match(routineRunTime(run.startedAt, 'America/New_York'), /20:00:00.*America\/New_York/);
  assert.equal(routineRunTime(run.startedAt, 'bad/zone'), '计划时区暂不可用');
});
