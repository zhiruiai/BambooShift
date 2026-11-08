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
  json,
  deferred,
  text,
  all,
  userId,
  workspaceId,
  revision,
  requestId,
  metadata,
  storeKey,
  storageFixture,
  ready,
  receipt,
  panel,
  input,
  paste,
} from './testSupport/memoryImportFixture';

test('actual copy handler writes on the click turn and offers selection when clipboard access is unavailable', async () => {
  const writes: string[] = [];
  let reject = false,
    focus = 0,
    select = 0;
  const ui = await panel(
    async () => json(ready()),
    {},
    {
      navigator: {
        clipboard: {
          writeText(value: string) {
            writes.push(value);
            return reject ? Promise.reject(Error('Unavailable')) : Promise.resolve();
          },
        },
      },
    },
  );
  try {
    await ui.flush();
    ui.button('复制提示词').props.onClick();
    assert.equal(writes.length, 1, 'clipboard must be called before yielding the user gesture');
    await ui.flush();
    assert.match(ui.copy, /提示词已复制/);
    assert.equal(writes[0], ui.field('1. 复制').props.value);
    ui.field('1. 复制').props.ref.current = {
      focus() {
        focus++;
      },
      select() {
        select++;
      },
    };
    reject = true;
    ui.button('复制提示词').props.onClick();
    await ui.flush();
    assert.equal(focus, 1);
    assert.equal(select, 1);
    assert.match(ui.copy, /系统复制功能/);
  } finally {
    ui.dispose();
  }
});

test('actual panel preserves text through primary/model settings and reports activity before a parent render', async () => {
  let readiness = ready({ available: false, reason: 'primary_required' }),
    primary = 0,
    model = 0;
  const activity: any[] = [],
    calls: any[] = [];
  const ui = await panel(
    async (url, init) => {
      calls.push({ url, init });
      return json(readiness);
    },
    {
      onConfigurePrimary() {
        primary++;
      },
      onConfigureModel() {
        model++;
      },
      onActivity(value: any) {
        activity.push(value);
      },
    },
  );
  try {
    await ui.flush();
    paste(ui, '保留我在配置前粘贴的内容');
    assert.equal(activity.at(-1).dirty, true);
    ui.button('设置主 Bot').props.onClick();
    assert.equal(primary, 1);
    ui.setProps({ active: false });
    await ui.flush();
    readiness = ready({ available: false, reason: 'model_required', modelConfigured: false });
    ui.setProps({ active: true });
    await ui.flush();
    assert.equal(input(ui).props.value, '保留我在配置前粘贴的内容');
    ui.button('连接模型').props.onClick();
    assert.equal(model, 1);
    ui.setProps({ active: false });
    await ui.flush();
    readiness = ready();
    ui.setProps({ active: true });
    await ui.flush();
    assert.equal(input(ui).props.value, '保留我在配置前粘贴的内容');
    assert.equal(ui.button('添加到记忆').props.disabled, false);
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 0);
  } finally {
    ui.dispose();
  }
});

test('team space shows personal-space guidance without accepting private import text', async () => {
  const ui = await panel(
    async () => json(ready({ available: false, reason: 'personal_required' })),
    {
      personalHref: '/w/personal',
    },
  );
  try {
    await ui.flush();
    assert.equal(all(ui.tree, (node) => node.type === 'textarea').length, 0);
    assert.equal(ui.maybeButton('添加到记忆'), undefined);
    assert.equal(all(ui.tree, (node) => node.type === 'a')[0].props.href, '/w/personal');
    assert.match(ui.copy, /团队共享 Bot 不会接收/);
  } finally {
    ui.dispose();
  }
});

test('actual Add event fixes actor/path/revision, rejects double clicks, and retries failed navigation without resending', async () => {
  const saved = storageFixture(),
    gate = deferred<Response>(),
    calls: any[] = [],
    activity: any[] = [];
  let opens = 0;
  const ui = await panel(
    async (url, init) => {
      calls.push({ url, init });
      return init?.method === 'POST' ? gate.promise : json(ready());
    },
    {
      onActivity(value: any) {
        activity.push(value);
      },
      async onImported(value: any) {
        assert.equal(value.conversationId, 'private-a');
        opens++;
        if (opens === 1) throw Error('暂时无法核对会话');
      },
    },
    { sessionStorage: saved },
  );
  try {
    await ui.flush();
    paste(ui, '这是仅留在内存的私人摘要');
    await ui.flush();
    const click = ui.button('添加到记忆').props.onClick;
    click();
    click();
    assert.equal(activity.at(-1).busy, true);
    assert.equal(activity.at(-1).pending, true);
    const post = calls.filter((call) => call.init.method === 'POST');
    assert.equal(post.length, 1);
    assert.equal(post[0].url, `/api/workspaces/${workspaceId}/memory-imports`);
    assert.equal(post[0].init.headers['X-OpenBot-Expected-User'], userId);
    const body = JSON.parse(post[0].init.body);
    assert.equal(body.content, '这是仅留在内存的私人摘要');
    assert.equal(body.expectedPrimaryRevision, revision);
    assert.deepEqual(Object.keys(body).sort(), ['content', 'expectedPrimaryRevision', 'requestId']);
    const stored = JSON.parse(saved.values.get(storeKey)!);
    assert.deepEqual(stored, { requestId: body.requestId, expectedPrimaryRevision: revision });
    assert.ok(![...saved.values.values()].join('').includes('私人摘要'));
    gate.resolve(json(receipt(body)));
    await ui.flush();
    assert.equal(opens, 1);
    assert.equal(input(ui).props.value, body.content);
    assert.match(ui.copy, /暂时无法核对会话/);
    assert.match(ui.copy, /等待主 Bot 处理/);
    ui.button('打开主 Bot 会话').props.onClick();
    await ui.flush();
    assert.equal(opens, 2);
    assert.equal(saved.values.size, 0);
    assert.equal(input(ui).props.value, '');
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1);
  } finally {
    ui.dispose();
  }
});

test('unknown POST checks first and only retries its original body and primary revision under the same request ID', async () => {
  const posts: any[] = [];
  let checks = 0,
    opened = 0;
  const ui = await panel(
    async (url, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        if (posts.length === 1) throw new TypeError('Connection lost');
        return json(receipt(body));
      }
      if (String(url).endsWith('/memory-imports')) return json(ready());
      checks++;
      return json({ error: '尚无回执' }, 404);
    },
    {
      onImported() {
        opened++;
      },
    },
  );
  try {
    await ui.flush();
    paste(ui, '原确认内容');
    await ui.flush();
    const oldClick = ui.button('添加到记忆').props.onClick;
    oldClick();
    await ui.flush();
    assert.equal(ui.maybeButton('重试原请求'), undefined);
    oldClick();
    await ui.flush();
    assert.equal(posts.length, 1);
    ui.button('检查这次导入').props.onClick();
    await ui.flush();
    assert.equal(checks, 1);
    assert.equal(input(ui).props.disabled, true);
    ui.button('重试原请求').props.onClick();
    await ui.flush();
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1], posts[0]);
    assert.equal(opened, 1);
  } finally {
    ui.dispose();
  }
});

test('remount restores only pending metadata; GET 404 never invents lost text or a new mutation', async () => {
  const calls: any[] = [],
    saved = storageFixture(metadata);
  const ui = await panel(
    async (url, init) => {
      calls.push({ url, init });
      return String(url).endsWith('/memory-imports')
        ? json(ready())
        : json({ error: '未找到' }, 404);
    },
    {},
    { sessionStorage: saved },
  );
  try {
    await ui.flush();
    assert.equal(input(ui).props.value, '');
    assert.equal(input(ui).props.disabled, true);
    assert.match(ui.copy, /原文未保存在此页面/);
    assert.equal(ui.maybeButton('重试原请求'), undefined);
    assert.equal(ui.maybeButton('添加到记忆'), undefined);
    ui.button('检查这次导入').props.onClick();
    await ui.flush();
    assert.equal(calls.filter((call) => call.init.method !== 'GET').length, 0);
    assert.equal(saved.values.size, 1);
  } finally {
    ui.dispose();
  }
});

test('receipt recovery is read-only, completed is not a memory-save claim, and missing records cannot reopen or replay', async () => {
  let status = 'completed',
    opened = 0;
  const ui = await panel(
    async (url) =>
      String(url).endsWith('/memory-imports') ? json(ready()) : json(receipt(metadata, { status })),
    {
      onImported() {
        opened++;
      },
    },
    {
      sessionStorage: storageFixture(metadata),
    },
  );
  try {
    await ui.flush();
    assert.equal(opened, 0);
    assert.match(ui.copy, /整理任务已结束/);
    assert.doesNotMatch(ui.copy, /记忆已保存|全部记忆/);
    status = 'missing';
    ui.button('刷新处理状态').props.onClick();
    await ui.flush();
    assert.match(ui.copy, /不会重新发送/);
    assert.equal(ui.maybeButton('打开主 Bot 会话'), undefined);
    assert.equal(ui.maybeButton('添加到记忆'), undefined);
    assert.equal(opened, 0);
  } finally {
    ui.dispose();
  }
});
