import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { webcrypto } from 'node:crypto';
import {
  compile,
  json,
  deferred,
  text,
  userId,
  workspaceId,
  revision,
  requestId,
  metadata,
  storageFixture,
  windowFixture,
  ready,
  receipt,
  panel,
  input,
  paste,
} from './testSupport/memoryImportFixture';

test('explicitly ending a known terminal receipt clears submitted text and metadata without submitting again', async () => {
  for (const status of ['missing', 'completed', 'error', 'cancelled', 'interrupted']) {
    const saved = storageFixture(),
      calls: any[] = [];
    const ui = await panel(
      async (url, init) => {
        calls.push({ url, init });
        return init?.method === 'POST'
          ? json(receipt(JSON.parse(String(init.body)), { status }))
          : json(ready());
      },
      {
        onImported() {
          throw Error('先留在此页核对');
        },
      },
      { sessionStorage: saved },
    );
    try {
      await ui.flush();
      paste(ui, '已提交的摘要');
      await ui.flush();
      ui.button('添加到记忆').props.onClick();
      await ui.flush();
      assert.equal(input(ui).props.value, '已提交的摘要');
      assert.equal(saved.values.size, 1);
      assert.match(ui.copy, /不会删除已产生的记忆/);
      ui.button('结束查看').props.onClick();
      await ui.flush();
      assert.equal(saved.values.size, 0);
      assert.equal(input(ui).props.value, '');
      assert.equal(input(ui).props.disabled, false);
      assert.equal(ui.button('添加到记忆').props.disabled, true);
      assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1);
    } finally {
      ui.dispose();
    }
  }
});

test('late clipboard rejection cannot focus an old account and stale readiness cannot replace settings-return state', async () => {
  const first = deferred<Response>(),
    clipboard = deferred<void>();
  let reads = 0,
    focused = 0;
  const ui = await panel(
    async () => (++reads === 1 ? first.promise : json(ready())),
    {},
    {
      navigator: {
        clipboard: {
          writeText: () =>
            clipboard.promise.then(() => {
              throw Error('Denied');
            }),
        },
      },
    },
  );
  try {
    await ui.flush();
    ui.setProps({ active: false });
    await ui.flush();
    ui.setProps({ active: true });
    await ui.flush();
    paste(ui, '返回后的新草稿');
    await ui.flush();
    first.resolve(json(ready({ available: false, reason: 'model_required' })));
    await ui.flush();
    assert.equal(ui.button('添加到记忆').props.disabled, false);
    assert.equal(input(ui).props.value, '返回后的新草稿');
    ui.field('1. 复制').props.ref.current = {
      focus() {
        focused++;
      },
      select() {
        focused++;
      },
    };
    ui.button('复制提示词').props.onClick();
    ui.setProps({ userId: 'user-b' });
    await ui.flush();
    clipboard.resolve();
    await ui.flush();
    assert.equal(focused, 0);
  } finally {
    ui.dispose();
  }
});

test('only proven NOT_STARTED releases a draft; auth failure and generic conflict retain the request', async () => {
  let response = json(
    { error: '主 Bot 已变化，请检查设置', code: 'MEMORY_IMPORT_NOT_STARTED' },
    409,
  );
  const saved = storageFixture(),
    posts: any[] = [];
  const ui = await panel(
    async (_, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return response;
      }
      return json(ready());
    },
    {},
    { sessionStorage: saved },
  );
  try {
    await ui.flush();
    paste(ui, '失败仍保留的内容');
    await ui.flush();
    ui.button('添加到记忆').props.onClick();
    await ui.flush();
    assert.equal(saved.values.size, 0);
    assert.equal(input(ui).props.disabled, false);
    assert.equal(input(ui).props.value, '失败仍保留的内容');
    response = json({ error: '账号已退出' }, 403);
    ui.button('添加到记忆').props.onClick();
    await ui.flush();
    assert.equal(saved.values.size, 1);
    assert.equal(input(ui).props.disabled, true);
    assert.equal(ui.maybeButton('添加到记忆'), undefined);
    assert.equal(posts.length, 2);
    assert.notEqual(posts[0].requestId, posts[1].requestId);
  } finally {
    ui.dispose();
  }
});

test('late actual POST response and retained event handlers cannot navigate or send after account, URL, or unmount changes', async () => {
  for (const change of ['account', 'workspace', 'unmount']) {
    const gate = deferred<Response>(),
      window = windowFixture(),
      posts: any[] = [];
    let opened = 0;
    const ui = await panel(
      async (_, init) => {
        if (init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)));
          return gate.promise;
        }
        return json(ready());
      },
      {
        onImported() {
          opened++;
        },
      },
      { window },
    );
    await ui.flush();
    paste(ui);
    await ui.flush();
    const click = ui.button('添加到记忆').props.onClick;
    click();
    if (change === 'account') {
      ui.setProps({ userId: 'user-b' });
      await ui.flush();
    }
    if (change === 'workspace')
      window.location.pathname = '/w/44444444-4444-4444-8444-444444444444';
    if (change === 'unmount') ui.dispose();
    gate.resolve(json(receipt(posts[0])));
    await ui.flush();
    click();
    await ui.flush();
    assert.equal(posts.length, 1, change);
    assert.equal(opened, 0, change);
    if (change !== 'unmount') ui.dispose();
  }
});

test('client strict-mode suspension invalidates old reads and malformed or inaccessible pending storage never sends', async () => {
  const window = windowFixture(),
    saved = storageFixture(metadata);
  const module = await compile('web/src/memoryImport.ts', '', { window, sessionStorage: saved });
  const first = deferred<Response>();
  let reads = 0;
  const client = module.createMemoryImportClient({
    userId,
    workspaceId,
    identity: () => ({ userId, workspaceId }),
    storage: saved,
    onState() {},
    fetch: async () => (++reads === 1 ? first.promise : json(receipt(metadata))),
  });
  const old = client.check();
  client.suspend();
  client.resume();
  await client.check();
  first.resolve(json(receipt(metadata, { status: 'missing' })));
  await old;
  assert.equal(client.state().receipt.status, 'queued');
  assert.equal(client.state().busy, false);
  client.suspend();
  for (const store of [
    storageFixture({ ...metadata, content: 'must not restore' }),
    {
      getItem() {
        throw Error('blocked');
      },
      setItem() {},
      removeItem() {},
    },
  ]) {
    let writes = 0;
    const blocked = module.createMemoryImportClient({
      userId,
      workspaceId,
      identity: () => ({ userId, workspaceId }),
      storage: store,
      onState() {},
      fetch: async () => {
        writes++;
        return json(receipt());
      },
    });
    await blocked.start('private text', revision);
    assert.equal(writes, 0);
    assert.equal(blocked.state().blocked, true);
    blocked.suspend();
  }
  assert.ok(module.memoryImportProblem(''));
  assert.equal(module.memoryImportProblem('甲'.repeat(16000)), '');
  assert.ok(module.memoryImportProblem('甲'.repeat(16001)));
});

test('mismatched receipt stays pending and storage-removal errors cannot escape the submission handler', async () => {
  const window = windowFixture();
  const module = await compile('web/src/memoryImport.ts', '', { window });
  for (const mode of ['mismatch', 'remove-failed', 'conflict']) {
    const saved = storageFixture();
    if (mode === 'remove-failed')
      saved.removeItem = () => {
        throw Error('storage blocked');
      };
    const client = module.createMemoryImportClient({
      userId,
      workspaceId,
      identity: () => ({ userId, workspaceId }),
      storage: saved,
      onState() {},
      fetch: async (_: unknown, init: any) =>
        mode === 'mismatch'
          ? json(receipt(JSON.parse(init.body), { userId: 'other-user' }))
          : json(
              {
                error: '拒绝保存',
                ...(mode === 'remove-failed' ? { code: 'MEMORY_IMPORT_NOT_STARTED' } : {}),
              },
              409,
            ),
    });
    assert.equal(await client.start('保留原文', revision), undefined);
    assert.ok(client.state().request, mode);
    assert.equal(client.state().receipt, undefined);
    assert.equal(client.state().busy, false);
    assert.equal(saved.values.size, 1);
    client.suspend();
  }
});
