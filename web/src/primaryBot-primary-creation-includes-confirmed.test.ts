import { expandPureViews } from './testSupport/expandPureViews';
import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import React from 'react';
import type { Bootstrap, BotAgent, Conversation } from '../../shared/types';
import type { PrimaryBotState } from '../../shared/primary-bot';
import type { SidebarRosterState } from '../../shared/sidebar-roster';
import { createWorkspaceSync } from './workspaceSync';
import {
  confirmedPrimary,
  conversationSelectionKey,
  createPrimaryBotScope,
  defaultConversation,
  primaryConversation,
} from './primaryBot';
import {
  workspaceId,
  userId,
  agent,
  other,
  conversation,
  group,
  empty,
  selected,
  bootstrap,
  json,
  deferred,
  all,
  harness,
} from './testSupport/primaryBotFixture';

test('primary creation includes only confirmed avatar assets and retains newer profile edits', async () => {
  const imageId = '55555555-5555-4555-8555-555555555555',
    writes: any[] = [];
  const view = await harness({}, async (url, init) => {
    if (init?.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)));
      return json(selected);
    }
    return json(String(url).endsWith('/bootstrap') ? bootstrap() : empty);
  });
  await view.flush();
  const fields = all(view.tree, (node) => node.type?.name === 'BotProfileFields')[0];
  fields.props.onAvatarActivity({ pending: true, busy: false });
  view.tree.props.onClose();
  await view.flush();
  assert.match(view.text, /放弃尚未保存/);
  view.button('继续编辑').props.onClick();
  await view.flush();
  view.submit();
  await view.flush();
  assert.equal(writes.length, 0);
  assert.match(view.text, /先确认或取消头像裁剪/);
  view.field('Bot 名称').props.onChange({ target: { value: '新的个人主 Bot' } });
  await view.flush();
  view.field('工作角色').props.onChange({ target: { value: '整理工作' } });
  await view.flush();
  fields.props.onAvatarChange({ avatarImageId: imageId });
  fields.props.onAvatarActivity({ pending: false, busy: false });
  await view.flush();
  view.submit();
  await view.flush();
  assert.equal(writes[0].bot.name, '新的个人主 Bot');
  assert.equal(writes[0].bot.avatarImageId, imageId);
  view.dispose();
});

test('dirty close and server conflict preserve draft until explicit discard/load, not status rerender', async () => {
  let current = empty,
    reads = 0,
    closes = 0;
  const view = await harness({ onClose: () => closes++ }, async (_url, init) =>
    init?.method === 'PUT' ? json({ error: '版本已变化' }, 409) : (reads++, json(current)),
  );
  await view.flush();
  view.field('Bot 名称').props.onChange({ target: { value: '尚未保存的名字' } });
  await view.flush();
  view.field('工作角色').props.onChange({ target: { value: '私人助理' } });
  await view.flush();
  view.update({ agents: [{ ...agent, status: 'working' }, other], state: selected });
  await view.flush();
  assert.equal(view.field('Bot 名称').props.value, '尚未保存的名字');
  view.tree.props.onClose();
  await view.flush();
  assert.equal(closes, 0);
  assert.match(view.text, /放弃尚未保存/);
  view.button('继续编辑').props.onClick();
  await view.flush();
  view.submit();
  await view.flush();
  assert.match(view.text, /设置已有变化/);
  assert.equal(view.field('Bot 名称').props.value, '尚未保存的名字');
  current = selected;
  view.button('检查当前设置').props.onClick();
  await view.flush();
  assert.equal(reads, 2);
  assert.equal(view.field('Bot 名称').props.value, '尚未保存的名字');
  view.button('载入当前设置').props.onClick();
  await view.flush();
  assert.match(view.text, /放弃尚未保存/);
  view.button('放弃更改并继续').props.onClick();
  await view.flush();
  assert.equal(view.choice(agent.id).props['aria-pressed'], true);
  assert.doesNotMatch(view.text, /设置已有变化/);
  view.dispose();
});

test('unknown create first reads authority and never repeats creation or invents a private conversation', async () => {
  let writes = 0,
    reads = 0,
    saved = 0;
  const view = await harness({ onSaved: () => saved++ }, async (url, init) => {
    if (init?.method === 'PUT') {
      writes++;
      throw new TypeError('connection lost');
    }
    if (String(url).endsWith('/bootstrap')) return json({ ...bootstrap(), conversations: [group] });
    return json(reads++ ? selected : empty);
  });
  await view.flush();
  view.field('Bot 名称').props.onChange({ target: { value: '小松' } });
  await view.flush();
  view.field('工作角色').props.onChange({ target: { value: '助理' } });
  await view.flush();
  view.submit();
  await view.flush();
  assert.match(view.text, /不要重复创建/);
  view.submit();
  await view.flush();
  assert.equal(writes, 1);
  view.button('检查当前设置').props.onClick();
  await view.flush();
  assert.equal(writes, 1);
  assert.equal(saved, 0);
  view.button('打开当前私聊').props.onClick();
  await view.flush();
  view.button('放弃更改并继续').props.onClick();
  await view.flush();
  assert.equal(saved, 0);
  assert.match(view.text, /无法确认主 Bot 的会话/);
  assert.equal(writes, 1);
  view.dispose();
});

test('completed mutation with lost bootstrap stays locked and can recover via authoritative reads', async () => {
  let writes = 0,
    snapshots = 0,
    saved = 0;
  const view = await harness(
    { state: selected, initialMode: 'select', onSaved: () => saved++ },
    async (url, init) => {
      if (init?.method === 'PUT') {
        writes++;
        return json(selected);
      }
      if (String(url).endsWith('/bootstrap')) {
        if (!snapshots++) throw new TypeError('lost');
        return json(bootstrap());
      }
      return json(selected);
    },
  );
  await view.flush();
  view.submit();
  await view.flush();
  assert.match(view.text, /设置已保存/);
  view.submit();
  await view.flush();
  assert.equal(writes, 1);
  view.button('检查当前设置').props.onClick();
  await view.flush();
  view.button('打开当前私聊').props.onClick();
  await view.flush();
  assert.equal(saved, 1);
  assert.equal(writes, 1);
  view.dispose();
});

test('team state only offers personal-space navigation and cannot submit a primary write', async () => {
  const unavailable = { ...empty, available: false, reason: 'team_workspace' as const };
  let writes = 0;
  const view = await harness(
    { team: true, state: unavailable, personalHref: '/w/personal-id' },
    async (_url, init) => {
      if (init?.method !== 'GET') writes++;
      return json(unavailable);
    },
  );
  await view.flush();
  assert.match(view.text, /成员共同使用/);
  assert.match(view.text, /前往个人空间/);
  assert.equal(all(view.tree, (node) => node.type === 'form').length, 0);
  assert.equal(all(view.tree, (node) => node.type === 'a')[0].props.href, '/w/personal-id');
  assert.equal(writes, 0);
  view.dispose();
});

test('clear requires explicit confirmation and returns no navigation target or deletion command', async () => {
  const writes: any[] = [],
    saved: any[] = [];
  const view = await harness(
    { state: selected, onSaved: (...args: any[]) => saved.push(args) },
    async (_url, init) => {
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        return json({ ...empty, revision: 'cleared', checkIn: { enabled: false, time: '09:00' } });
      }
      return json(selected);
    },
  );
  await view.flush();
  view.button('不再设为主 Bot').props.onClick();
  await view.flush();
  assert.equal(writes.length, 0);
  assert.match(view.text, /Bot 和聊天记录仍保留/);
  view.button('确认取消主 Bot').props.onClick();
  await view.flush();
  assert.deepEqual(writes, [{ mode: 'clear', expectedRevision: 'rev-a' }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0][1], undefined);
  view.dispose();
});

test('late initial reads, writes and bootstrap replies cannot navigate after unmount/account/workspace changes', async () => {
  for (const phase of ['initial', 'write', 'bootstrap'])
    for (const change of ['unmount', 'account', 'workspace']) {
      const pending = deferred<Response>();
      let saved = 0,
        snapshots = 0;
      const view = await harness({ state: selected, onSaved: () => saved++ }, async (url, init) => {
        if (init?.method === 'PUT') return phase === 'write' ? pending.promise : json(selected);
        if (String(url).endsWith('/bootstrap')) {
          snapshots++;
          return pending.promise;
        }
        return phase === 'initial' ? pending.promise : json(selected);
      });
      await view.flush();
      if (phase !== 'initial') {
        view.submit();
        await view.flush();
      }
      if (change === 'unmount') view.dispose();
      if (change === 'account') {
        view.update({ userId: 'new-user' });
        await view.flush();
      }
      if (change === 'workspace')
        view.window.location.pathname = '/w/33333333-3333-4333-8333-333333333333';
      pending.resolve(json(phase === 'bootstrap' ? bootstrap() : selected));
      await view.flush();
      assert.equal(saved, 0, `${phase}/${change}`);
      if (phase === 'write') assert.equal(snapshots, 0);
      view.dispose();
    }
});

test('scope checks before dispatch and keeps abandoned epochs invalid after StrictMode resume', async () => {
  let identity = { workspaceId, userId },
    location = workspaceId,
    calls = 0;
  const scope = createPrimaryBotScope({
    workspaceId,
    userId,
    identity: () => identity,
    locationWorkspace: () => location,
    fetch: async () => {
      calls++;
      return json(empty);
    },
  });
  const old = scope.ticket();
  scope.suspend();
  scope.resume();
  assert.equal(scope.current(old), false);
  await scope.request('/primary-bot');
  assert.equal(calls, 1);
  identity = { workspaceId, userId: 'other' };
  await assert.rejects(scope.request('/primary-bot', 'PUT', {}), /工作空间已切换/);
  assert.equal(calls, 1);
  identity = { workspaceId, userId };
  location = 'other';
  await assert.rejects(scope.request('/primary-bot', 'PUT', {}), /工作空间已切换/);
  assert.equal(calls, 1);
});
