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
  require,
  compile,
  ready,
  saved,
  resettable,
  render,
  noop,
  view,
  has,
  json,
  deferred,
  dialogHarness,
  approvalTransport,
  humanAccount,
  computerRequest,
} from './testSupport/computerLifecycleFixture';

test('actual Bot details carry the loaded-computer deletion guard into the settings tabs, while member details remain read-only', async () => {
  const { AgentDialog } = await compile('web/src/components/AgentDialog.tsx');
  const agent = {
    id: 'bot-a',
    name: '小松',
    role: '助理',
    description: '',
    color: '#8877aa',
    avatar: 'orb',
    instructions: '',
    status: 'idle',
  };
  const props = {
    agent,
    computer: {
      connected: true,
      name: '工作电脑',
      mode: 'remote',
      surface: 'browser',
      capabilities: [],
      status: 'ready',
    },
    onComputer: noop,
    readOnly: false,
    busy: false,
    onClose: noop,
    onSave: noop,
    onDelete: noop,
    deleteBlocked: '',
  };
  const html = render(AgentDialog, props);
  assert.match(html, /Bot 设置分类/);
  assert.doesNotMatch(html, /确认删除/);
  const hooks = {
    ...React,
    useState: (value: any) => [typeof value === 'function' ? value() : value, noop],
    useEffect: () => {},
  };
  const wrapper = await compile('web/src/components/AgentDialog.tsx', '', {
    require: (name: string) => (name === 'react' ? hooks : require(name)),
  });
  assert.match(wrapper.AgentDialog(props).props.deleteBlocked, /正在检查这位 Bot 的电脑画面/);
  const member = render(AgentDialog, { ...props, readOnly: true });
  assert.doesNotMatch(member, /删除 Bot|释放画面|确认删除/);
  assert.match(member, /查看 小松 的独立画面/);
});

test('actual ComputerDialog recovers from network loss and HTTP 200 blocked through continue → confirm resume without a second release', async () => {
  for (const failure of ['network', 'blocked'] as const) {
    const completed = {
      agentId: 'bot-a',
      status: 'unassigned',
      lifecycle: { state: 'ready', releaseAllowed: false, resetAllowed: false },
    };
    let screen: any = ready;
    const mutations: Array<{ url: string; body: any }> = [];
    const resume = deferred<Response>();
    const transport = (async (url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') {
        mutations.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith('/release')) {
          screen = saved;
          if (failure === 'network') throw new TypeError('connection lost after acceptance');
          return json({ connected: false, surface: 'browser', botScreen: screen });
        }
        if (url.endsWith('/lifecycle/resume')) return resume.promise;
        throw Error(`Unexpected mutation ${url}`);
      }
      if (url.endsWith('/bots'))
        return json({
          capacity: { max: 2, configured: 2, ready: 2, assigned: screen.screenId ? 1 : 0 },
          bots: [screen],
        });
      if (url.endsWith('/takeover/status'))
        return json({ active: false, width: 1440, height: 900 });
      if (url.endsWith('/status'))
        return json({
          connected: screen.status === 'ready',
          name: '电脑',
          mode: 'remote',
          surface: 'browser',
          capabilities: [],
          status: 'ready',
          botScreen: screen,
        });
      if (url.endsWith('/actions')) return json([]);
      throw Error(`Unexpected read ${url}`);
    }) as typeof fetch;
    const ui = await dialogHarness(transport);
    try {
      await ui.flush();
      ui.click('释放画面');
      await ui.flush();
      ui.click('确认释放画面');
      await ui.flush();
      assert.equal(ui.lifecycle().props.uncertain, true, failure);
      assert.equal(mutations.length, 1);
      // Even an outdated saved callback cannot create another release while unknown.
      ui.lifecycle().props.onConfirm();
      await ui.flush();
      assert.equal(mutations.length, 1);
      ui.click('继续处理');
      await ui.flush();
      assert.equal(ui.lifecycle().props.confirmation.kind, 'resume');
      assert.equal(
        ui.lifecycle().props.uncertain,
        false,
        'choosing persisted resume clears the old UI uncertainty marker',
      );
      ui.click('确认继续处理');
      await ui.flush();
      assert.equal(ui.lifecycle().props.pending, true);
      ui.lifecycle().props.onConfirm();
      ui.close();
      ui.selectOther();
      await ui.flush();
      assert.equal(mutations.length, 2, 'pending ref prevents duplicate dispatch');
      assert.deepEqual(ui.counts(), { closes: 0, switches: 0 });
      assert.deepEqual(
        mutations.map((call) => ({ url: call.url, body: call.body })),
        [
          {
            url: '/api/workspaces/workspace-a/computer/bots/bot-a/release',
            body: { confirm: true, assignmentRevision: 'revision-a' },
          },
          {
            url: '/api/workspaces/workspace-a/computer/bots/bot-a/lifecycle/resume',
            body: { confirm: true, assignmentRevision: 'revision-a', operationId: 'operation-a' },
          },
        ],
      );
      screen = completed;
      resume.resolve(json({ connected: false, surface: 'browser', botScreen: completed }));
      await ui.flush();
      assert.equal(ui.lifecycle().props.pending, false);
      assert.equal(ui.lifecycle().props.uncertain, false);
      assert.equal(ui.lifecycle().props.confirmation, null);
      assert.match(ui.lifecycle().props.notice, /画面已释放/);
    } finally {
      ui.dispose();
    }
  }
});

test('actual ComputerDialog clears unknown after a committed reset whose replacement screen is still unavailable, while screen controls remain disabled', async () => {
  const newRevision = {
    ...ready,
    assignmentRevision: 'revision-after-reset',
    status: 'unavailable',
    lifecycle: { state: 'ready', releaseAllowed: true, resetAllowed: true },
  };
  const recorded = {
    ...resettable,
    lifecycle: { ...saved.lifecycle, operation: { id: 'reset-operation', kind: 'reset' } },
  };
  let screen: any = resettable;
  const calls: Array<{ url: string; method: string }> = [];
  const transport = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (init.method === 'POST') {
      assert.ok(url.endsWith('/reset'), 'only the explicitly confirmed reset may be posted');
      screen = recorded;
      throw new TypeError('reset accepted but response lost');
    }
    if (url.endsWith('/bots'))
      return json({ capacity: { max: 2, configured: 2, ready: 1, assigned: 1 }, bots: [screen] });
    if (url.endsWith('/takeover/status')) return json({ active: false, width: 1440, height: 900 });
    if (url.endsWith('/status'))
      return json({
        connected: screen.status === 'ready',
        name: '电脑',
        mode: 'remote',
        surface: 'browser',
        capabilities: ['private-takeover-frames-v1'],
        status: '当前连接暂不可用',
        botScreen: screen,
      });
    if (url.endsWith('/actions')) return json([]);
    throw Error(`Unexpected read ${url}`);
  }) as typeof fetch;
  const ui = await dialogHarness(transport);
  try {
    await ui.flush();
    ui.click('恢复画面');
    await ui.flush();
    ui.click('确认恢复画面');
    await ui.flush();
    assert.equal(ui.lifecycle().props.uncertain, true);
    // Closing the confirmation must not discard the remembered transaction identity.
    ui.click('收起确认');
    await ui.flush();
    assert.equal(ui.lifecycle().props.confirmation, null);
    screen = newRevision;
    ui.lifecycle().props.onRefresh();
    await ui.flush();
    assert.equal(ui.lifecycle().props.uncertain, false);
    assert.equal(ui.lifecycle().props.pending, false);
    assert.equal(ui.lifecycle().props.confirmation, null);
    assert.equal(ui.lifecycle().props.notice, '重置已完成，画面暂不可用，请检查连接。');
    assert.doesNotMatch(ui.lifecycle().props.notice, /可以重新查看和操作/);
    for (const label of ['刷新画面', '接管电脑', '打开网站'])
      assert.equal(ui.rootButton(label).props.disabled, true, label);
    // Stale/direct callbacks also cannot turn an unavailable screen into an input or screenshot.
    ui.rootButton('刷新画面').props.onClick();
    ui.rootButton('接管电脑').props.onClick();
    await ui.flush();
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
    assert.equal(
      calls.some((c) => c.url.includes('/screenshot')),
      false,
    );
    screen = { ...newRevision, status: 'ready' };
    ui.lifecycle().props.onRefresh();
    await ui.flush();
    assert.equal(ui.rootButton('刷新画面').props.disabled, false);
    assert.equal(ui.rootButton('接管电脑').props.disabled, false);
  } finally {
    ui.dispose();
  }
});

test('actual computer approval is available to the requesting member, never another member or owner; old actions retain owner fallback', async () => {
  for (const [account, requester, allowed] of [
    [humanAccount('member-a'), computerRequest.requester, true],
    [humanAccount('member-b'), computerRequest.requester, false],
    [humanAccount('owner-a', 'owner'), computerRequest.requester, false],
    [humanAccount('owner-a', 'owner'), undefined, true],
    [humanAccount('member-a'), undefined, false],
    [null, undefined, true],
    [humanAccount('owner-a', 'owner'), null, false],
  ] as const) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ui = await dialogHarness(approvalTransport({ ...computerRequest, requester }, calls), {
      account,
    });
    try {
      await ui.flush();
      const row = ui.action();
      assert.equal(!!has(row.view, '允许本次操作'), allowed);
      assert.equal(!!has(row.view, '拒绝'), allowed);
      // Even directly invoking a retained child callback is checked in the parent handler.
      row.props.onApprove();
      await ui.flush();
      assert.equal(calls.length, allowed ? 1 : 0);
      if (allowed) {
        assert.equal(
          calls[0].url,
          `${account ? '/api/workspaces/workspace-a' : '/api'}/computer/bots/bot-a/actions/approval-a/approve`,
        );
        assert.equal(
          new Headers(calls[0].init.headers).get('X-OpenBot-Expected-User'),
          account?.session.user.id || null,
        );
      }
    } finally {
      ui.dispose();
    }
  }
});
