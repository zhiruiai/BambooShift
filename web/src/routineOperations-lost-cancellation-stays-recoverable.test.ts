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
  require,
  json,
  deferred,
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

test('lost cancellation stays recoverable, and only a precise scoped CLOSED response unlocks the original slot', async () => {
  let getStatus = 404,
    getCode: string | undefined;
  const store = storage();
  let posts = 0;
  const c = client(
    async (_url, init) => {
      if (init?.method === 'GET') return json({ error: 'closed', code: getCode }, getStatus);
      posts++;
      throw new TypeError('lost');
    },
    { storage: store },
  );
  await c.create(createBody);
  const id = c.state().request?.requestId;
  await c.closeRequest();
  assert.equal(c.state().request?.requestId, id);
  await c.check();
  assert.equal(c.state().request?.requestId, id);
  getStatus = 410;
  await c.check();
  assert.equal(c.state().request?.requestId, id, 'generic 410 is not a durable closure proof');
  getCode = 'ROUTINE_OPERATION_CLOSED';
  await c.check();
  assert.equal(c.state().request, undefined);
  assert.equal(store.values.size, 0);
  assert.equal(posts, 2, 'checking never submits the task again');
});

test('close responses require the exact actor, workspace, and request; account changes and unmount discard late closure', async () => {
  for (const override of [{ userId: 'other' }, { workspaceId: 'other' }, { requestId: 'other' }]) {
    let requestId = '';
    const c = client(async (url, init) => {
      if (String(url).endsWith('/cancel'))
        return json({ requestId, status: 'not_submitted', userId, workspaceId, ...override });
      requestId = JSON.parse(String(init?.body)).requestId;
      throw new TypeError('lost');
    });
    await c.create(createBody);
    await c.closeRequest();
    assert.equal(c.state().request?.requestId, requestId);
    assert.equal(c.state().receipt, undefined);
  }
  for (const mode of ['account', 'unmount'] as const) {
    let identity = { userId, workspaceId },
      requestId = '',
      cancelledSignal: AbortSignal | undefined;
    const store = storage(),
      dispatched = deferred<void>(),
      response = deferred<Response>();
    const c = client(
      async (url, init) => {
        if (String(url).endsWith('/cancel')) {
          cancelledSignal = init?.signal as AbortSignal;
          dispatched.resolve();
          return response.promise;
        }
        requestId = JSON.parse(String(init?.body)).requestId;
        throw new TypeError('lost');
      },
      { storage: store, identity: () => identity },
    );
    await c.create(createBody);
    const pending = c.closeRequest();
    await dispatched.promise;
    if (mode === 'account') identity = { userId: 'other', workspaceId };
    else c.suspend();
    response.resolve(json({ requestId, status: 'not_submitted', userId, workspaceId }));
    await pending;
    assert.equal(c.state().request?.requestId, requestId);
    assert.equal(store.values.size, 1);
    if (mode === 'unmount') assert.equal(cancelledSignal?.aborted, true);
  }
});

test('actual recovery button closes only the original ID, is single-flight, and preserves the create draft', async () => {
  const dispatched = deferred<void>(),
    response = deferred<Response>();
  let requestId = '',
    mutations = 0;
  const h = await dialog(async (url, init) => {
    if (String(url).endsWith('/cancel')) {
      mutations++;
      dispatched.resolve();
      return response.promise;
    }
    mutations++;
    requestId = JSON.parse(String(init?.body)).requestId;
    throw new TypeError('lost');
  });
  try {
    fill(h);
    await h.flush();
    await submit(h);
    await h.flush();
    assert.match(h.copy, /若任务已接纳，将显示原结果/);
    const close = h.button('结束提交核对').props.onClick;
    close();
    await dispatched.promise;
    close();
    await h.flush();
    assert.equal(h.button('结束提交核对').props.disabled, true);
    assert.equal(mutations, 2);
    response.resolve(json({ requestId, status: 'not_submitted', userId, workspaceId }));
    await h.flush();
    assert.equal(h.field('任务名称').props.value, createBody.title);
    assert.equal(h.field('要完成什么').props.value, createBody.prompt);
    assert.equal(h.button('创建任务').props.disabled, false);
    assert.match(h.copy, /现已关闭。草稿仍保留/);
    assert.equal(mutations, 2);
  } finally {
    h.dispose();
  }
});

test('actual reopened recovery can close a missing request and preserves an unrelated existing edit', async () => {
  const store = storage(),
    original = client(
      async () => {
        throw new TypeError('lost');
      },
      { storage: store },
    );
  await original.create(createBody);
  const requestId = original.state().request!.requestId;
  original.suspend();
  const calls: string[] = [];
  const h = await dialog(
    async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return init?.method === 'GET'
        ? json({}, 404)
        : json({ requestId, status: 'not_submitted', userId, workspaceId });
    },
    { initialRoutineId: routine.id },
    { sessionStorage: store },
  );
  try {
    await h.flush();
    h.field('任务名称').props.onChange({ target: { value: '未保存的现有任务编辑' } });
    await h.flush();
    h.button('结束提交核对').props.onClick();
    await h.flush();
    assert.equal(h.field('任务名称').props.value, '未保存的现有任务编辑');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /\/cancel$/);
    assert.equal(store.values.size, 0);
    assert.equal(h.button('保存修改').props.disabled, false);
  } finally {
    h.dispose();
  }
});
