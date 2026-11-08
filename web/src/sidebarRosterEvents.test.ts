import { componentSource } from './testSupport/componentSource';
import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import type { Bootstrap, BotAgent, Conversation } from '../../shared/types';
import type { SidebarRosterState, SidebarRosterOperation } from '../../shared/sidebar-roster';
import {
  workspaceId,
  userId,
  empty,
  section,
  withSection,
  target,
  json,
  deferred,
  copy,
  harness,
  hookFile,
  componentFile,
  baseController,
  dialogProps,
} from './testSupport/sidebarRosterEventsFixture';

test('roster hook uses fixed workspace, expected actor and CAS; unsupported snapshots stay readonly', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [],
    accepted: any[] = [];
  const h = await harness(
    hookFile,
    'useSidebarRoster',
    {
      workspaceId,
      userId,
      state: withSection,
      onChanged(...value: any[]) {
        accepted.push(value);
      },
    },
    async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return json({ ...withSection, revision: 'r2' });
    },
  );
  await h.flush();
  assert.equal((await h.tree.write({ type: 'create-section', name: '写作', target })).ok, true);
  assert.equal(calls[0].url, `/api/workspaces/${workspaceId}/sidebar-roster`);
  assert.equal(new Headers(calls[0].init.headers).get('X-OpenBot-Expected-User'), userId);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    expectedRevision: 'r1',
    operation: { type: 'create-section', name: '写作', target },
  });
  assert.equal(accepted[0][1], 'r1');
  assert.equal(accepted[0][2], true);
  h.setProps({ state: undefined });
  await h.flush();
  assert.equal((await h.tree.write({ type: 'set-entry', target, pinned: true })).ok, false);
  assert.equal(calls.length, 1);
  h.dispose();
});

test('retained old write callback cannot bypass unknown/conflict lock until an explicit GET', async () => {
  for (const status of [0, 408, 409, 503]) {
    let calls = 0;
    const methods: string[] = [];
    const h = await harness(
      hookFile,
      'useSidebarRoster',
      { workspaceId, userId, state: empty, onChanged() {} },
      async (_url, init) => {
        methods.push(init!.method!);
        calls++;
        if (calls === 1) {
          if (status === 0) throw new TypeError('offline');
          return json({ error: '暂时无法确认' }, status);
        }
        return json(empty);
      },
    );
    await h.flush();
    const retained = h.tree.write;
    assert.equal((await retained({ type: 'create-section', name: '新分区' })).review, true);
    assert.equal((await retained({ type: 'create-section', name: '新分区' })).review, true);
    assert.equal(calls, 1);
    await h.flush();
    assert.equal(h.tree.needsSync, true);
    await h.tree.read();
    await h.flush();
    assert.equal(h.tree.needsSync, false);
    assert.equal((await retained({ type: 'create-section', name: '用户再次确认' })).ok, true);
    assert.deepEqual(methods, ['PUT', 'GET', 'PUT']);
    h.dispose();
  }
});

test('unmount, actor change and URL change discard late writes and retained callbacks cannot dispatch', async () => {
  for (const change of ['unmount', 'actor', 'url']) {
    const pending = deferred<Response>();
    let calls = 0,
      accepted = 0;
    const h = await harness(
      hookFile,
      'useSidebarRoster',
      {
        workspaceId,
        userId,
        state: empty,
        onChanged() {
          accepted++;
        },
      },
      async () => {
        calls++;
        return pending.promise;
      },
    );
    await h.flush();
    const retained = h.tree.write,
      request = retained({ type: 'set-entry', target, hidden: true });
    if (change === 'unmount') h.dispose();
    else if (change === 'actor') {
      h.setProps({ userId: 'another-user' });
      await h.flush();
    } else h.window.location.pathname = '/w/33333333-3333-4333-8333-333333333333';
    pending.resolve(json({ ...empty, revision: 'r2' }));
    assert.equal((await request).ok, false);
    assert.equal((await retained({ type: 'set-entry', target, pinned: true })).ok, false);
    assert.equal(accepted, 0);
    assert.equal(calls, 1);
    h.dispose();
  }
});

test('an older GET cannot replace a bootstrap already accepted in flight or offer its stale revision', async () => {
  const pending = deferred<Response>();
  let accepted = 0;
  const h = await harness(
    hookFile,
    'useSidebarRoster',
    {
      workspaceId,
      userId,
      state: empty,
      onChanged() {
        accepted++;
      },
    },
    async () => pending.promise,
  );
  await h.flush();
  const request = h.tree.read();
  const newer = { ...withSection, revision: 'r3' };
  h.setProps({ state: newer });
  await h.flush();
  pending.resolve(json({ ...empty, revision: 'r2' }));
  assert.equal((await request).revision, 'r3');
  assert.equal(accepted, 0);
  h.dispose();
});

test('rename conflict retains the real edited input and requires explicit adoption before save', async () => {
  const writes: any[] = [],
    latest = { ...withSection, revision: 'r2', sections: [{ ...section, name: '服务端名称' }] };
  let closed = 0;
  const controller = {
    ...baseController(withSection),
    async write(operation: SidebarRosterOperation, revision?: string) {
      writes.push({ operation, revision });
      return writes.length === 1
        ? { ok: false as const, review: true, message: '名单已有变化' }
        : { ok: true as const, state: { ...latest, revision: 'r3' } };
    },
    async read() {
      return latest;
    },
  };
  const h = await harness(componentFile, 'RosterDialogContent', {
    ...dialogProps({ kind: 'rename', id: section.id }, withSection),
    roster: controller,
    onClose() {
      closed++;
    },
  });
  await h.flush();
  h.field('分区名称').props.onChange({ target: { value: '我的重命名' } });
  await h.flush();
  h.tree.props.onClose();
  await h.flush();
  assert.match(h.copy, /编辑还没有保存/);
  assert.equal(closed, 0);
  h.button('继续编辑').props.onClick();
  h.form().props.onSubmit({ preventDefault() {} });
  await h.flush();
  assert.equal(h.field('分区名称').props.value, '我的重命名');
  assert.equal(h.button('保存').props.disabled, true);
  h.button('同步名单').props.onClick();
  await h.flush();
  assert.equal(writes.length, 1);
  assert.equal(h.field('分区名称').props.value, '我的重命名');
  h.button('使用最新名单继续').props.onClick();
  await h.flush();
  assert.equal(h.button('保存').props.disabled, false);
  h.form().props.onSubmit({ preventDefault() {} });
  await h.flush();
  assert.equal(writes[1].revision, 'r2');
  assert.equal(writes[1].operation.name, '我的重命名');
  assert.equal(closed, 1);
  h.dispose();
});

test('unknown section creation reads actual state without replay; existing name prevents duplicate creation', async () => {
  let writes = 0;
  const latest = { ...withSection, revision: 'r2' };
  const controller = {
    ...baseController(),
    async write() {
      writes++;
      return { ok: false as const, review: true, message: '结果未知' };
    },
    async read() {
      return latest;
    },
  };
  const h = await harness(componentFile, 'RosterDialogContent', {
    ...dialogProps({ kind: 'create', target }),
    roster: controller,
  });
  await h.flush();
  h.field('分区名称').props.onChange({ target: { value: '研究' } });
  await h.flush();
  h.form().props.onSubmit({ preventDefault() {} });
  await h.flush();
  h.button('同步名单').props.onClick();
  await h.flush();
  assert.equal(writes, 1);
  h.button('使用最新名单继续').props.onClick();
  await h.flush();
  assert.equal(h.field('分区名称').props.value, '研究');
  assert.equal(h.button('创建分区').props.disabled, true);
  assert.match(h.copy, /已有同名分区/);
  assert.equal(writes, 1);
  h.dispose();
});

test('create-and-move is one action; deletion only removes section; pending close and late actor response are guarded', async () => {
  const cases = [
    {
      request: { kind: 'create', target },
      expected: { type: 'create-section', name: '新研究', target },
    },
    {
      request: { kind: 'delete', id: section.id },
      expected: { type: 'delete-section', id: section.id },
    },
    { request: { kind: 'move', target }, expected: { type: 'set-entry', target, sectionId: null } },
  ];
  for (const item of cases) {
    const writes: any[] = [];
    const pending = deferred<any>();
    let closed = 0;
    const controller = {
      ...baseController(withSection),
      async write(operation: SidebarRosterOperation, revision?: string) {
        writes.push({ operation, revision });
        return pending.promise;
      },
    };
    const h = await harness(componentFile, 'RosterDialogContent', {
      ...dialogProps(item.request, withSection),
      roster: controller,
      onClose() {
        closed++;
      },
    });
    await h.flush();
    if (item.request.kind === 'create') {
      h.field('分区名称').props.onChange({ target: { value: '新研究' } });
      await h.flush();
    }
    h.form().props.onSubmit({ preventDefault() {} });
    await h.flush();
    h.tree.props.onClose();
    assert.equal(closed, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(writes[0].operation)), item.expected);
    h.setProps({ userId: 'another-user' });
    await h.flush();
    pending.resolve({ ok: true, state: { ...withSection, revision: 'r2' } });
    await h.flush();
    assert.equal(closed, 0);
    h.dispose();
  }
});
