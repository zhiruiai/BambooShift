import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import {
  modules,
  ready,
  saved,
  resettable,
  render,
  view,
  buttons,
  has,
  json,
  deferred,
} from './testSupport/computerLifecycleFixture';

test('confirmation captures the exact Bot assignment and cannot be reused after revision, Bot or allowance changes', async () => {
  const [logic] = await modules;
  const intent = logic.lifecycleIntent(ready, 'release');
  assert.equal(intent.operationKind, 'release');
  const req = logic.lifecycleRequest(intent, ready);
  assert.equal(req.path, '/release');
  assert.deepEqual(JSON.parse(JSON.stringify(req.body)), {
    confirm: true,
    assignmentRevision: 'revision-a',
  });
  for (const screen of [
    { ...ready, agentId: 'bot-b' },
    { ...ready, assignmentRevision: 'revision-b' },
    {
      ...ready,
      lifecycle: { ...ready.lifecycle, releaseAllowed: false, reason: '当前有待批准操作' },
    },
  ])
    assert.throws(() => logic.lifecycleRequest(intent, screen));
  assert.throws(
    () => logic.lifecycleIntent({ ...ready, lifecycle: undefined }, 'release'),
    /尚未提供/,
  );
});

test('active tasks, queue and maintenance block new transactions; unknown cleanup offers only explicitly allowed reset', async () => {
  const [logic] = await modules;
  for (const status of ['running', 'waiting_cleanup', 'maintenance'])
    assert.throws(
      () => logic.lifecycleIntent({ ...ready, task: { status, queued: 0 } }, 'release'),
      /任务和排队/,
    );
  assert.throws(() =>
    logic.lifecycleIntent({ ...ready, task: { status: 'idle', queued: 1 } }, 'release'),
  );
  assert.throws(() => logic.lifecycleIntent(resettable, 'release'), /需要恢复/);
  assert.equal(
    logic.lifecycleRequest(logic.lifecycleIntent(resettable, 'reset'), resettable).path,
    '/reset',
  );
  assert.throws(() =>
    logic.lifecycleIntent(
      { ...resettable, lifecycle: { ...resettable.lifecycle, resetAllowed: false } },
      'reset',
    ),
  );
});

test('an outstanding operation can only resume its persisted id and kind, even during maintenance', async () => {
  const [logic] = await modules;
  const screen = { ...saved, task: { status: 'maintenance', queued: 0 } };
  assert.throws(() => logic.lifecycleIntent(screen, 'release'), /尚未完成/);
  assert.throws(() => logic.lifecycleIntent(screen, 'reset'), /尚未完成/);
  const intent = logic.lifecycleIntent(screen, 'resume'),
    request = logic.lifecycleRequest(intent, screen);
  assert.equal(request.path, '/lifecycle/resume');
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)), {
    confirm: true,
    assignmentRevision: 'revision-a',
    operationId: 'operation-a',
  });
  for (const operation of [
    { id: 'new-id', kind: 'release' },
    { id: 'operation-a', kind: 'reset' },
    undefined,
  ])
    assert.throws(() =>
      logic.lifecycleRequest(intent, { ...screen, lifecycle: { ...screen.lifecycle, operation } }),
    );
});

test('only conclusive server state unlocks an uncertain release or reset, not an unavailable or same-generation state', async () => {
  const [logic] = await modules;
  const release = logic.lifecycleIntent(ready, 'release'),
    reset = logic.lifecycleIntent(resettable, 'reset');
  const unassigned = {
    agentId: 'bot-a',
    status: 'unassigned',
    lifecycle: { state: 'ready', releaseAllowed: false, resetAllowed: false },
  };
  assert.equal(logic.lifecycleCompleted(release, unassigned), true);
  for (const state of [
    ready,
    saved,
    { ...unassigned, status: 'unavailable' },
    { ...unassigned, agentId: 'other' },
  ])
    assert.equal(logic.lifecycleCompleted(release, state), false);
  assert.equal(
    logic.lifecycleCompleted(reset, { ...ready, assignmentRevision: 'new-revision' }),
    true,
  );
  for (const state of [
    ready,
    resettable,
    {
      ...ready,
      assignmentRevision: 'new',
      lifecycle: { ...ready.lifecycle, operation: { id: 'x', kind: 'reset' } },
    },
  ])
    assert.equal(logic.lifecycleCompleted(reset, state), false);
});

test('only an explicit pre-transaction rejection code permits a fresh confirmation; transport and accepted failures stay unknown', async () => {
  const [logic] = await modules;
  assert.equal(logic.lifecycleNotStarted({ status: 409, code: 'LIFECYCLE_NOT_STARTED' }), true);
  for (const error of [
    null,
    new Error('network'),
    { status: 0, code: 'LIFECYCLE_NOT_STARTED' },
    { status: 500, code: 'LIFECYCLE_NOT_STARTED' },
    { status: 409 },
    { status: 409, code: 'CLEANUP_UNKNOWN' },
  ])
    assert.equal(logic.lifecycleNotStarted(error), false);
});

test('deletion is blocked until authoritative unbound state is loaded; maintenance and network failures never look unbound', async () => {
  const [logic] = await modules;
  const unassigned = { agentId: 'bot-a', status: 'unassigned' };
  assert.match(logic.botDeletionScreenReason(unassigned, false), /正在检查/);
  assert.match(logic.botDeletionScreenReason(unassigned, true, 'offline'), /无法确认/);
  for (const screen of [ready, resettable, saved])
    assert.ok(logic.botDeletionScreenReason(screen, true));
  assert.match(logic.botDeletionScreenReason(saved, true), /继续处理/);
  assert.equal(logic.botDeletionScreenReason(unassigned, true), '');
});

test('release/reset confirmation states data loss and only preserves shared files/login, with no automatic mutation', async () => {
  const [logic, { ComputerLifecycle }] = await modules;
  let selected = '';
  const initial = ComputerLifecycle({
    ...view,
    onChoose: (kind: string) => {
      selected = kind;
    },
  });
  assert.equal(selected, '');
  has(initial, '释放画面').props.onClick();
  assert.equal(selected, 'release');
  for (const [screen, kind] of [
    [ready, 'release'],
    [resettable, 'reset'],
  ] as const) {
    const html = render(ComputerLifecycle, {
      ...view,
      screen,
      confirmation: logic.lifecycleIntent(screen, kind),
    });
    for (const text of [
      '小松',
      '未保存的内容会丢失',
      '共享工作区文件和浏览器登录状态会保留',
      '取消',
      kind === 'release' ? '确认释放画面' : '确认恢复画面',
    ])
      assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /自动回收|删除 Bot 并|个人文件会保留/);
    if (kind === 'reset') assert.match(html, /不保证自动恢复/);
  }
});

test('member, takeover, pending approval, changed identity and in-flight requests cannot confirm lifecycle actions', async () => {
  const [logic, { ComputerLifecycle }] = await modules;
  const confirmation = logic.lifecycleIntent(ready, 'release');
  assert.equal(buttons(ComputerLifecycle({ ...view, owner: false })).length, 0);
  for (const patch of [
    { owner: false },
    { busy: true },
    { pending: true },
    { localBlock: '请先结束人工接管' },
    { localBlock: '有待批准操作' },
    { screen: { ...ready, assignmentRevision: 'changed' } },
  ]) {
    const tree = ComputerLifecycle({ ...view, confirmation, ...patch });
    assert.equal(has(tree, '确认释放画面').props.disabled, true);
  }
  const waiting = ComputerLifecycle({ ...view, confirmation, pending: true });
  assert.equal(has(waiting, '取消').props.disabled, true);
  assert.match(render(ComputerLifecycle, { ...view, confirmation, pending: true }), /90 秒/);
});

test('lost responses preserve the confirmation and offer only status refresh or the saved-operation resume', async () => {
  const [logic, { ComputerLifecycle }] = await modules;
  const confirmation = logic.lifecycleIntent(ready, 'release');
  const unknown = ComputerLifecycle({ ...view, confirmation, uncertain: true, error: '连接中断' });
  assert.equal(has(unknown, '确认释放画面').props.disabled, true);
  assert.ok(has(unknown, '刷新状态'));
  const collapsed = ComputerLifecycle({ ...view, uncertain: true });
  assert.equal(has(collapsed, '释放画面'), undefined);
  assert.ok(has(collapsed, '刷新处理结果'));
  let chosen = '';
  const recovered = ComputerLifecycle({
    ...view,
    screen: saved,
    confirmation,
    uncertain: true,
    onChoose: (kind: string) => {
      chosen = kind;
    },
  });
  const raced = ComputerLifecycle({ ...view, screen: saved, confirmation });
  assert.ok(has(raced, '继续处理'));
  assert.equal(has(raced, '确认释放画面'), undefined);
  assert.equal(has(recovered, '确认释放画面'), undefined);
  has(recovered, '继续处理').props.onClick();
  assert.equal(chosen, 'resume');
  const resume = render(ComputerLifecycle, {
    ...view,
    screen: saved,
    confirmation: logic.lifecycleIntent(saved, 'resume'),
  });
  assert.match(resume, /只继续服务器已保存的这一次释放操作/);
  assert.match(resume, /确认继续处理/);
});

test('real lifecycle request uses its captured workspace/revision and a late response is discarded after account scope changes', async () => {
  const [logic, , { createComputerScope }] = await modules;
  const response = deferred<Response>();
  const calls: Array<{ url: string; body: any }> = [];
  const scope = createComputerScope({
    workspaceId: 'original',
    agentId: 'bot-a',
    fetch: (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return response.promise;
    },
  });
  const req = logic.lifecycleRequest(logic.lifecycleIntent(ready, 'release'), ready);
  const pending = scope.request(req.path, 'POST', req.body);
  scope.suspend();
  response.resolve(json({ botScreen: { agentId: 'bot-a', status: 'unassigned' } }));
  await assert.rejects(pending, (e: any) => e.name === 'AbortError');
  assert.deepEqual(calls, [
    {
      url: '/api/workspaces/original/computer/bots/bot-a/release',
      body: { confirm: true, assignmentRevision: 'revision-a' },
    },
  ]);
  scope.resume();
  const resumeReq = logic.lifecycleRequest(logic.lifecycleIntent(saved, 'resume'), saved);
  const resumed = scope.request(resumeReq.path, 'POST', resumeReq.body);
  await resumed;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/workspaces/original/computer/bots/bot-a/lifecycle/resume');
  assert.deepEqual(calls[1].body, {
    confirm: true,
    assignmentRevision: 'revision-a',
    operationId: 'operation-a',
  });
});
