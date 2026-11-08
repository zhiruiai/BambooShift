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
  text,
  all,
  component,
  workspaceId,
  userId,
  routine,
  createBody,
  storage,
  receipt,
  client,
  submit,
  dialog,
  icon,
  enterEdit,
  fill,
} from './testSupport/routineOperationsFixture';

test('actual unknown create preserves its draft, requires GET before same-request retry, and warns before close', async () => {
  const posts: string[] = [];
  let closed = 0;
  const h = await dialog(
    async (_url, init) => {
      if (init?.method === 'GET') return json({}, 404);
      posts.push(String(init?.body));
      return posts.length === 1
        ? json({ error: '响应未知' }, 503)
        : json(receipt(JSON.parse(String(init?.body))));
    },
    { onClose: () => closed++ },
  );
  try {
    fill(h);
    await h.flush();
    await submit(h);
    await h.flush();
    assert.equal(h.field('任务名称').props.value, createBody.title);
    assert.equal(
      all(h.tree, (node) => node.type === 'button' && text(node) === '重试原请求').length,
      0,
    );
    component(h.tree, 'Dialog').props.onClose();
    await h.flush();
    assert.equal(closed, 0);
    assert.match(h.copy, /提交内容不会保留/);
    h.button('继续编辑').props.onClick();
    await h.flush();
    await h.button('检查原请求').props.onClick();
    await h.flush();
    await h.button('重试原请求').props.onClick();
    // The transport records dispatch synchronously; then flush the real promise/effect updates.
    await h.flush();
    assert.equal(posts.length, 2);
    assert.equal(posts[0], posts[1]);
    assert.match(h.copy, /例行任务已创建/);
  } finally {
    h.dispose();
  }
});

test('actual run preserves an unrelated edit draft and opening its result requires the existing dirty confirmation', async () => {
  const dispatched = deferred<void>();
  let request!: RoutineOperationRequest,
    opened = 0;
  const h = await dialog(
    async (_url, init) => {
      request = JSON.parse(String(init?.body));
      dispatched.resolve();
      return json(receipt(request));
    },
    {
      initialRoutineId: routine.id,
      onOpenConversation: async () => {
        opened++;
      },
    },
  );
  try {
    h.field('任务名称').props.onChange({ target: { value: '尚未保存的名称' } });
    await h.flush();
    icon(h, '立即运行').props.onClick();
    await dispatched.promise;
    await h.flush();
    assert.equal(h.field('任务名称').props.value, '尚未保存的名称');
    assert.equal(request.kind, 'run');
    if (request.kind === 'run') assert.equal(request.expectedRoutine.title, routine.title);
    assert.match(h.copy, /已提交这次运行/);
    assert.doesNotMatch(h.copy, /这次运行已完成/);
    h.button('查看所属会话').props.onClick();
    await h.flush();
    assert.equal(opened, 0);
    h.button('放弃更改并继续').props.onClick();
    await h.flush();
    assert.equal(opened, 1);
  } finally {
    h.dispose();
  }
});

test('actual handlers cannot send after the account changes, nor after a pending digest is cancelled on unmount', async () => {
  for (const mode of ['account', 'unmount'] as const) {
    const digest = deferred<ArrayBuffer>(),
      hashing = deferred<void>();
    let calls = 0;
    const h = await dialog(
      async () => {
        calls++;
        return json({});
      },
      {},
      {
        crypto: {
          randomUUID: () => webcrypto.randomUUID(),
          subtle: {
            digest: () => {
              hashing.resolve();
              return digest.promise;
            },
          },
        },
      },
    );
    fill(h);
    await h.flush();
    const handler = all(h.tree, (node) => node.type === 'form')[0].props.onSubmit;
    const pending = handler({ preventDefault() {} });
    await hashing.promise;
    if (mode === 'unmount') h.dispose();
    else {
      h.setProps({ userId: 'user-b' });
      await h.flush();
    }
    digest.resolve(new ArrayBuffer(32));
    await pending;
    assert.equal(calls, 0);
    await handler({ preventDefault() {} });
    assert.equal(calls, 0);
    if (mode !== 'unmount') h.dispose();
  }
});

test('actual reopened dialog only checks stored receipt IDs, cannot retry missing original content, and cannot replace an editing draft', async () => {
  const store = storage(),
    original = client(
      async () => {
        throw new TypeError('lost response');
      },
      { storage: store },
    );
  await original.create(createBody);
  original.suspend();
  const saved = original.state().request!,
    methods: string[] = [];
  const delayed = deferred<Response>(),
    started = deferred<void>();
  const h = await dialog(
    async (_url, init) => {
      methods.push(init!.method!);
      started.resolve();
      return delayed.promise;
    },
    { initialRoutineId: routine.id },
    { sessionStorage: store },
  );
  try {
    await started.promise;
    delayed.resolve(json({}, 404));
    await h.flush();
    assert.deepEqual(methods, ['GET']);
    assert.match(h.copy, /原提交内容未保存在此页面/);
    assert.equal(
      all(h.tree, (node) => node.type === 'button' && text(node) === '重试原请求').length,
      0,
    );
    await enterEdit(h);
    h.field('任务名称').props.onChange({ target: { value: '保留我的编辑' } });
    await h.flush();
    assert.equal(h.field('任务名称').props.value, '保留我的编辑');
    assert.equal(saved.kind, 'create');
  } finally {
    h.dispose();
  }
  const recovered = await dialog(
    async (_url, init) => {
      methods.push(init!.method!);
      return json(receipt({ ...createBody, kind: 'create', requestId: saved.requestId }));
    },
    { initialRoutineId: routine.id },
    { sessionStorage: store },
  );
  try {
    await recovered.flush();
    assert.match(recovered.copy, /例行任务已创建/);
    assert.equal(recovered.field('任务名称').props.value, routine.title);
    assert.deepEqual(methods, ['GET', 'GET']);
  } finally {
    recovered.dispose();
  }
});

test('actual explicit safe refusal preserves the visible create draft and allows a new corrected request', async () => {
  const ids: string[] = [];
  const h = await dialog(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    ids.push(request.requestId);
    return ids.length === 1
      ? json({ error: '请检查任务内容', code: 'ROUTINE_OPERATION_NOT_STARTED' }, 409)
      : json(receipt(request));
  });
  try {
    fill(h);
    await h.flush();
    await submit(h);
    await h.flush();
    assert.equal(h.field('任务名称').props.value, createBody.title);
    assert.equal(h.button('创建任务').props.disabled, false);
    h.field('任务名称').props.onChange({ target: { value: '明确修正后的任务' } });
    await h.flush();
    await submit(h);
    await h.flush();
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    assert.match(h.copy, /例行任务已创建/);
  } finally {
    h.dispose();
  }
});

test('a reopened request can be durably closed without its original body and without creating or running anything', async () => {
  const store = storage();
  const original = client(
    async () => {
      throw new TypeError('lost');
    },
    { storage: store },
  );
  await original.create(createBody);
  const intent = original.state().request!;
  original.suspend();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const restored = client(
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (init?.method === 'GET') return json({}, 404);
      return json({ requestId: intent.requestId, status: 'not_submitted', userId, workspaceId });
    },
    { storage: store },
  );
  await restored.check();
  await restored.closeRequest();
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].url,
    `/api/workspaces/${workspaceId}/routine-operations/${intent.requestId}/cancel`,
  );
  assert.equal(calls[1].init?.method, 'POST');
  assert.equal(calls[1].init?.body, undefined);
  assert.equal(new Headers(calls[1].init?.headers).get('X-OpenBot-Expected-User'), userId);
  assert.equal(restored.state().request, undefined);
  assert.equal(store.values.size, 0);
  assert.match(restored.state().message!, /原请求未被接纳，现已关闭/);
});

test('closing an already accepted run recovers its original receipt and never represents it as stopped', async () => {
  let request!: RoutineOperationRequest,
    notified = 0;
  const paths: string[] = [];
  const c = client(
    async (url, init) => {
      paths.push(String(url));
      if (String(url).endsWith('/cancel')) return json(receipt(request));
      request = JSON.parse(String(init?.body));
      throw new TypeError('lost');
    },
    {
      onChanged: () => {
        notified++;
      },
    },
  );
  await c.run(routine);
  await c.closeRequest();
  assert.equal(c.state().receipt?.status, 'submitted');
  assert.equal(notified, 1);
  assert.equal(c.state().message, '');
  assert.equal(paths.length, 2);
  await c.closeRequest();
  assert.equal(paths.length, 2, 'stale close callback cannot hide a known receipt');
});
