import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import { createRoutineOperationClient } from './routineOperations';
import { routineConfigSnapshot } from '../../shared/routine-operations';
import type { Routine } from '../../shared/types';
import type { RoutineOperationRequest } from '../../shared/routine-operations';
import {
  json,
  deferred,
  all,
  workspaceId,
  userId,
  routine,
  createBody,
  storage,
  receipt,
  client,
  submit,
  dialog,
  fill,
} from './testSupport/routineOperationsFixture';

test('create recovers a lost response using the same ID and immutable original body; storage contains no content', async () => {
  const store = storage(),
    calls: any[] = [];
  let lost = true;
  const c = client(
    async (url, init) => {
      calls.push({ url, init });
      if (init?.method === 'GET') return json({ error: '暂未找到' }, 404);
      if (lost) {
        lost = false;
        throw new TypeError('connection lost');
      }
      return json(receipt(JSON.parse(String(init?.body))));
    },
    { storage: store },
  );
  const draft = { ...createBody };
  await c.create(draft);
  draft.prompt = 'changed later';
  assert.equal(c.state().canRetry, false);
  assert.equal(c.state().receipt, undefined);
  assert.equal(c.finish(), false);
  await c.create({ ...draft, title: 'another' });
  assert.equal(calls.length, 1, 'unknown result cannot create a fresh request');
  const stored = [...store.values.values()].join('');
  assert.doesNotMatch(stored, /独立草稿|仅保存在内存|changed later|prompt|schedule/);
  assert.match(stored, /"digest":"[a-f0-9]{64}"/);
  await c.check();
  assert.equal(c.state().canRetry, true);
  await c.retry();
  assert.equal(calls[0].init.body, calls[2].init.body);
  assert.equal(calls[0].url, `/api/workspaces/${workspaceId}/routine-operations`);
  assert.equal(calls[0].init.headers['X-OpenBot-Expected-User'], userId);
  assert.equal(c.state().receipt?.status, 'created');
  assert.equal(c.finish(), true);
  assert.equal(store.values.size, 0);
});

test('run snapshots only editable configuration and never changes the retried content after the routine changes', async () => {
  const requests: any[] = [];
  let first = true;
  const c = client(async (_url, init) => {
    if (init?.method === 'GET') return json({}, 404);
    const value = JSON.parse(String(init?.body));
    requests.push(value);
    if (first) {
      first = false;
      return json({ error: '暂时未知' }, 503);
    }
    return json(receipt(value));
  });
  const original = { ...routine };
  await c.run(original);
  original.prompt = 'new prompt';
  original.nextRunAt = '2040-01-01T00:00:00Z';
  await c.check();
  await c.retry();
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[0].expectedRoutine, routineConfigSnapshot(routine));
  assert.equal('nextRunAt' in requests[0].expectedRoutine, false);
  assert.equal(c.state().receipt?.status, 'submitted');
});

test('only an explicit proven NOT_STARTED refusal unlocks a new intention; auth and ambiguous 4xx remain recoverable', async () => {
  for (const [status, code, clears] of [
    [409, 'ROUTINE_OPERATION_NOT_STARTED', true],
    [400, undefined, false],
    [409, undefined, false],
    [403, 'ROUTINE_OPERATION_NOT_STARTED', false],
    [401, undefined, false],
    [500, 'ROUTINE_OPERATION_NOT_STARTED', false],
  ] as const) {
    const c = client(async () => json({ error: '未能处理', code }, status));
    await c.create(createBody);
    assert.equal(!c.state().request, clears, `${status}/${code}`);
    assert.equal(c.state().canRetry, false);
  }
});

test('remount restores only the original request ID and checks it, never reconstructs or resends content', async () => {
  const store = storage();
  let original!: RoutineOperationRequest;
  const a = client(
    async (_url, init) => {
      original = JSON.parse(String(init?.body));
      throw new TypeError('lost');
    },
    { storage: store },
  );
  await a.create(createBody);
  a.suspend();
  const methods: string[] = [];
  const b = client(
    async (_url, init) => {
      methods.push(init!.method!);
      return json({}, 404);
    },
    { storage: store },
  );
  await b.check();
  await b.retry();
  assert.deepEqual(methods, ['GET']);
  assert.equal(b.state().originalAvailable, false);
  assert.equal(b.state().canRetry, false);
  assert.equal(b.finish(), false);
  const c = client(
    async (_url, init) => {
      methods.push(init!.method!);
      return json(receipt(original, { status: 'missing' }));
    },
    { storage: store },
  );
  await c.check();
  assert.equal(c.state().receipt?.status, 'missing');
  assert.equal(c.finish(), true);
  assert.equal(store.values.size, 0);
});

test('malformed and cross-actor receipts remain unknown; refresh rejection does not discard an accepted receipt', async () => {
  for (const override of [
    { userId: 'other' },
    { workspaceId: 'other' },
    { requestId: 'other' },
    { status: 'running' },
  ]) {
    const c = client(async (_url, init) => json(receipt(JSON.parse(String(init?.body)), override)));
    await c.create(createBody);
    assert.equal(c.state().receipt, undefined);
    assert.ok(c.state().request);
  }
  const changed = deferred<void>();
  const c = client(async (_url, init) => json(receipt(JSON.parse(String(init?.body)))), {
    onChanged: async () => {
      changed.resolve();
      throw Error('refresh failed');
    },
  });
  await c.create(createBody);
  await changed.promise;
  await Promise.resolve();
  assert.equal(c.state().receipt?.status, 'created');
  assert.match(c.state().error, /列表暂未刷新/);
});

test('unmount, actor change, and workspace change discard late response bodies and do not notify the new scope', async () => {
  for (const mode of ['suspend', 'actor', 'workspace'] as const) {
    const started = deferred<void>(),
      body = deferred<any>();
    let identity = { workspaceId, userId },
      location = workspaceId,
      notified = 0,
      signal: AbortSignal | undefined;
    const c = client(
      async (_url, init) => {
        signal = init!.signal as AbortSignal;
        const request = JSON.parse(String(init?.body));
        started.resolve();
        return {
          ok: true,
          status: 200,
          json: async () => {
            await body.promise;
            return receipt(request);
          },
        } as Response;
      },
      { identity: () => identity, locationWorkspace: () => location, onChanged: () => notified++ },
    );
    const task = c.create(createBody);
    await started.promise;
    if (mode === 'suspend') c.suspend();
    if (mode === 'actor') identity = { workspaceId, userId: 'other' };
    if (mode === 'workspace') location = 'other';
    body.resolve(undefined);
    await task;
    assert.equal(c.state().receipt, undefined);
    assert.equal(notified, 0);
    if (mode === 'suspend') assert.equal(signal?.aborted, true);
    await c.retry();
    assert.equal(notified, 0);
  }
});

test('storage refusal sends nothing and a corrupt saved intent never becomes an automatic request', async () => {
  let calls = 0;
  const c = client(
    async () => {
      calls++;
      return json({});
    },
    {
      storage: {
        getItem: () => null,
        setItem: () => {
          throw Error('blocked');
        },
        removeItem() {},
      },
    },
  );
  await c.create(createBody);
  assert.equal(calls, 0);
  assert.equal(c.state().request, undefined);
  const corrupt = client(
    async () => {
      calls++;
      return json({});
    },
    { storage: { getItem: () => '{broken', setItem() {}, removeItem() {} } },
  );
  await corrupt.create(createBody);
  await corrupt.check();
  assert.equal(calls, 0);
  assert.equal(corrupt.state().blocked, true);
});

test('actual create submit is single-flight and uses operations; saved receipt is retained until explicit review completion', async () => {
  const dispatched = deferred<void>(),
    response = deferred<Response>();
  let calls = 0,
    oldSave = 0,
    original!: RoutineOperationRequest;
  const h = await dialog(
    async (_url, init) => {
      calls++;
      original = JSON.parse(String(init?.body));
      dispatched.resolve();
      return response.promise;
    },
    {
      onSave: async () => {
        oldSave++;
      },
    },
  );
  try {
    fill(h);
    await h.flush();
    const handler = all(h.tree, (node) => node.type === 'form')[0].props.onSubmit;
    const pending = handler({ preventDefault() {} });
    await dispatched.promise;
    await handler({ preventDefault() {} });
    await h.flush();
    assert.equal(calls, 1);
    assert.equal(oldSave, 0);
    assert.equal(h.field('任务名称').props.value, createBody.title);
    response.resolve(json(receipt(original)));
    await pending;
    await h.flush();
    assert.match(h.copy, /例行任务已创建/);
    assert.equal(h.field('任务名称').props.value, '');
    assert.equal(h.button('创建任务').props.disabled, true);
    h.button('完成查看').props.onClick();
    await h.flush();
    fill(h);
    await h.flush();
    assert.equal(h.button('创建任务').props.disabled, false);
  } finally {
    h.dispose();
  }
});
