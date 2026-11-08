import test from 'node:test';
import assert from 'node:assert/strict';
import {
  all,
  base,
  component,
  deferred,
  env,
  harness,
  json,
} from './testSupport/memoryImportSettingsFixture';

const totals = (count = 1) => ({
  modelTurns: count,
  reportedTurns: count,
  unreportedTurns: 0,
  inputTokens: 10 * count,
  outputTokens: 5 * count,
  cacheReadTokens: 2 * count,
  cacheWriteTokens: 1 * count,
  totalTokens: 18 * count,
});
const response = (days = 30, count = 1) => ({
  scope: { workspaceId: base.workspaceId, userId: base.userId, visibility: 'self' },
  period: { days, since: '2026-10-01T00:00:00Z', until: '2026-10-30T12:00:00Z', timeZone: 'UTC' },
  totals: totals(count),
  byDay: [{ day: '2026-10-30', totals: totals(count) }],
  byBot: [{ agentId: 'bot-a', name: 'Synthetic Bot', totals: totals(count) }],
  byModel: [{ provider: 'synthetic', model: 'fixture', totals: totals(count) }],
  cost: null,
});
const properties = { workspaceId: base.workspaceId, userId: base.userId, active: true };

test('system assistance is shown as recorded usage, without inventing a Bot or price', async () => {
  const value = { ...response(), byBot: [{ agentId: null, name: null, totals: totals() }] };
  const h = await harness('web/src/components/UsagePanel.tsx', 'UsageContent', properties, {
    ...env(),
    fetch: async () => json(value),
  });
  try {
    await h.flush();
    assert.match(h.copy, /系统辅助任务/);
    assert.match(h.copy, /费用未知/);
    assert.doesNotMatch(h.copy, /已删除的 Bot/);
  } finally {
    h.dispose();
  }
});

test('usage is read only, loads only while selected and binds the account, period and scope', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const h = await harness(
    'web/src/components/UsagePanel.tsx',
    'UsageContent',
    { ...properties, active: false },
    {
      ...env(),
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return json(response(Number(new URL(url, 'http://example.test').searchParams.get('days'))));
      },
    },
  );
  try {
    await h.flush();
    assert.equal(calls.length, 0);
    h.setProps({ active: true });
    await h.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `/api/workspaces/${base.workspaceId}/usage?days=30`);
    assert.equal(new Headers(calls[0].init.headers).get('X-OpenBot-Expected-User'), base.userId);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.body, undefined);
    assert.match(h.copy, /仅我的任务.*UTC/);
    assert.match(h.copy, /费用未知/);
    assert.match(h.copy, /Synthetic Bot/);
    const select = all(h.tree, (node) => node.type === 'select')[0];
    select.props.onChange({ target: { value: '7' } });
    await h.flush();
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /days=7$/);
    select.props.onChange({ target: { value: '45' } });
    await h.flush();
    assert.equal(calls.length, 2);
    h.setProps({ active: false });
    await h.flush();
    h.button('刷新').props.onClick();
    await h.flush();
    assert.equal(calls.length, 2);
  } finally {
    h.dispose();
  }
});

test('late prior-window responses cannot replace the current statistics and hidden requests are aborted', async () => {
  const first = deferred<Response>(),
    second = deferred<Response>();
  let reads = 0;
  const signals: AbortSignal[] = [];
  const h = await harness('web/src/components/UsagePanel.tsx', 'UsageContent', properties, {
    ...env(),
    fetch: async (_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return ++reads === 1 ? first.promise : second.promise;
    },
  });
  try {
    await h.flush();
    all(h.tree, (node) => node.type === 'select')[0].props.onChange({ target: { value: '7' } });
    await h.flush();
    assert.equal(reads, 2);
    assert.equal(signals[0].aborted, true);
    second.resolve(json(response(7, 2)));
    await h.flush();
    assert.match(h.copy, /2 个模型轮次/);
    first.resolve(json(response(30, 9)));
    await h.flush();
    assert.doesNotMatch(h.copy, /9 个模型轮次/);
    const refresh = h.button('刷新');
    h.setProps({ active: false });
    await h.flush();
    refresh.props.onClick();
    await h.flush();
    assert.equal(reads, 2);
  } finally {
    h.dispose();
  }
});

test('an account change or unmount discards an already-started usage response without retrying it', async () => {
  for (const unmount of [false, true]) {
    const pending = deferred<Response>();
    let reads = 0;
    let signal: AbortSignal | undefined;
    const h = await harness('web/src/components/UsagePanel.tsx', 'UsageContent', properties, {
      ...env(),
      fetch: async (_url: string, init: RequestInit) => {
        reads++;
        signal = init.signal as AbortSignal;
        return pending.promise;
      },
    });
    try {
      await h.flush();
      if (unmount) h.dispose();
      else {
        h.setProps({ userId: 'other-account' });
        await h.flush();
      }
      pending.resolve(json(response()));
      await h.flush();
      assert.doesNotMatch(h.copy, /Synthetic Bot/);
      assert.equal(reads, 1);
      if (unmount) assert.equal(signal?.aborted, true);
    } finally {
      if (!unmount) h.dispose();
    }
  }
});

test('invalid scope, cost and a failed read display a retryable read error rather than fabricated totals', async () => {
  for (const value of [
    { ...response(), scope: { ...response().scope, userId: 'other' } },
    { ...response(), cost: 0 },
    null,
  ]) {
    let calls = 0;
    const h = await harness('web/src/components/UsagePanel.tsx', 'UsageContent', properties, {
      ...env(),
      fetch: async () => {
        calls++;
        return value ? json(value) : json({ error: 'Synthetic unavailable' }, 503);
      },
    });
    try {
      await h.flush();
      assert.equal(all(h.tree, (node) => node.props?.role === 'alert').length, 1);
      assert.doesNotMatch(h.copy, /Synthetic Bot/);
      h.button('刷新').props.onClick();
      await h.flush();
      assert.equal(calls, 2);
    } finally {
      h.dispose();
    }
  }
});

test('usage navigation is available to members and preserves an unrelated draft while remaining read only', async () => {
  const h = await harness(
    'web/src/components/WorkspaceSettingsDialog.tsx',
    'WorkspaceSettingsContent',
    {
      ...base,
      canManage: false,
      onClose() {},
      onImported: async () => {},
      onTimeZoneChanged() {},
      onSettingsChanged() {},
      onPrimaryChanged() {},
    },
    env(),
  );
  try {
    await h.flush();
    const memory = component(h.tree, 'MemoryImportPanel');
    memory.props.onActivity({ dirty: true, busy: false, pending: false });
    component(h.tree, 'SettingsNavigation').props.onChange('usage');
    await h.flush();
    assert.equal(component(h.tree, 'UsagePanel').props.active, true);
    assert.equal(component(h.tree, 'UsagePanel').props.userId, base.userId);
    component(h.tree, 'Dialog').props.onClose();
    await h.flush();
    assert.match(h.copy, /尚未提交的导入内容/);
    assert.equal(all(h.tree, (node) => node.type?.name === 'SettingsDialog').length, 0);
  } finally {
    h.dispose();
  }
});
