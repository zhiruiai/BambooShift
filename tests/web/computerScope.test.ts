import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require('react-dom/server');
async function compile(path: string) {
  const compiled = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty' },
  });
  const module = { exports: {} as Record<string, any> };
  runInNewContext(compiled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    AbortController,
    AbortSignal,
    DOMException,
    Response,
    Headers,
    fetch,
  });
  return module.exports;
}
const scopeModule = compile('web/src/computerScope.ts');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const abort = (e: any) => e.name === 'AbortError';

test('every Bot request and shared-file request has a captured workspace target; missing Bot never falls back', async () => {
  const { createComputerScope } = await scopeModule;
  const calls: string[] = [];
  const transport = async (url: string) => {
    calls.push(url);
    return json({});
  };
  const a = createComputerScope({
    workspaceId: 'team-a',
    userId: 'user-a',
    agentId: 'bot-a',
    fetch: transport,
  });
  const b = createComputerScope({
    workspaceId: 'team-b',
    userId: 'user-b',
    agentId: 'bot-b',
    fetch: transport,
  });
  await a.request('/status');
  await a.request('/prepare', 'POST');
  await b.request('/surface', 'POST', { surface: 'desktop' });
  await a.request('/actions', 'GET', undefined, true);
  assert.deepEqual(calls, [
    '/api/workspaces/team-a/computer/bots/bot-a/status',
    '/api/workspaces/team-a/computer/bots/bot-a/prepare',
    '/api/workspaces/team-b/computer/bots/bot-b/surface',
    '/api/workspaces/team-a/computer/actions',
  ]);
  const none = createComputerScope({ fetch: transport });
  await assert.rejects(none.request('/screenshot'), abort);
  assert.equal(calls.length, 4);
});

test('scope changes discard a late JSON body and never apply stale authentication failure to the new account', async () => {
  const { createComputerScope } = await scopeModule;
  const body = deferred<unknown>(),
    headers = deferred<Response>();
  let auth = 0;
  const scope = createComputerScope({
    agentId: 'A',
    fetch: async () => ({ ok: true, status: 200, json: () => body.promise }),
    onAuthFailure: () => auth++,
  });
  const pending = scope.request('/status');
  await Promise.resolve();
  await Promise.resolve();
  scope.invalidate();
  body.resolve({ old: true });
  await assert.rejects(pending, abort);
  const old = createComputerScope({
    agentId: 'B',
    fetch: () => headers.promise,
    onAuthFailure: () => auth++,
  });
  const failed = old.request('/status');
  old.dispose();
  headers.resolve(json({ error: 'expired' }, 401));
  await assert.rejects(failed, abort);
  assert.equal(auth, 0);
  const active = createComputerScope({
    agentId: 'B',
    fetch: async () => json({ error: 'denied' }, 403),
    onAuthFailure: () => auth++,
  });
  await assert.rejects(active.request('/status'), /denied/);
  assert.equal(auth, 1);
});

test('screenshot cancellation reaches the transport and stale screenshot headers cannot be reused', async () => {
  const { createComputerScope } = await scopeModule;
  const headers = deferred<Response>();
  let signal: AbortSignal | undefined;
  const scope = createComputerScope({
    agentId: 'A',
    fetch: (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return headers.promise;
    },
  });
  const capture = scope.response('/screenshot');
  scope.invalidate();
  assert.equal(signal?.aborted, true);
  headers.resolve(new Response('png'));
  await assert.rejects(capture, abort);
  const external = new AbortController();
  const next = scope.response('/screenshot', { signal: external.signal });
  external.abort();
  assert.equal(signal?.aborted, true);
  await next; // Real fetch rejects; caller also checks its cancelled signal.
});

test('a late takeover start is cleaned up on its original Bot, and does not settle before cleanup acknowledgement', async () => {
  const { createComputerScope } = await scopeModule;
  const start = deferred<Response>(),
    end = deferred<Response>();
  const calls: string[] = [];
  const scope = createComputerScope({
    workspaceId: 'old-space',
    agentId: 'old-bot',
    fetch: (url: string) => {
      calls.push(url);
      return url.endsWith('/start') ? start.promise : end.promise;
    },
  });
  const pending = scope.startLease();
  let settled = false;
  pending.catch(() => {
    settled = true;
  });
  scope.dispose();
  start.resolve(json({ leaseId: 'old-lease' }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [
    '/api/workspaces/old-space/computer/bots/old-bot/takeover/start',
    '/api/workspaces/old-space/computer/bots/old-bot/takeover/end',
  ]);
  assert.equal(settled, false);
  end.resolve(json({ active: false }));
  await assert.rejects(pending, abort);
});

test('failed cleanup including HTTP 409 prevents a screen-switch acknowledgement', async () => {
  const { createComputerScope } = await scopeModule;
  for (const status of [409, 503]) {
    const scope = createComputerScope({
      agentId: 'old',
      fetch: async () => json({ error: 'cleanup unknown' }, status),
    });
    let switched = false;
    await assert.rejects(
      scope.endLease('lease').then(() => {
        switched = true;
      }),
      /未能确认/,
    );
    assert.equal(switched, false);
  }
});

test('unmount or changed account prevents a connection queued behind cleanup from sending under new cookies', async () => {
  const { createComputerScope } = await scopeModule;
  for (const transition of ['unmount', 'account', 'effect-replay'] as const) {
    const cleanup = deferred<Response>();
    const calls: string[] = [];
    let mounted = true;
    const scope = createComputerScope({
      workspaceId: 'original',
      agentId: 'A',
      fetch: (url: string) => {
        calls.push(url);
        return url.endsWith('/takeover/end')
          ? cleanup.promise
          : Promise.resolve(json({ connected: true }));
      },
    });
    const dispatch = scope.guard(
      () => scope.request('/connect', 'POST', { mode: 'remote' }, true),
      () => mounted,
    );
    const pending = scope.endLease('lease').then(dispatch);
    if (transition === 'unmount') mounted = false;
    else if (transition === 'account') scope.invalidate();
    else {
      scope.suspend();
      scope.resume();
    }
    cleanup.resolve(json({ active: false }));
    await assert.rejects(pending, abort);
    assert.deepEqual(calls, ['/api/workspaces/original/computer/bots/A/takeover/end']);
  }
});

test('delayed action callback remains revoked after effect resume, while new reads and actions work', async () => {
  const { createComputerScope } = await scopeModule;
  const calls: string[] = [];
  const scope = createComputerScope({
    agentId: 'A',
    fetch: async (url: string) => {
      calls.push(url);
      return json({});
    },
  });
  const callback = scope.guard(() => scope.request('/disconnect', 'POST', undefined, true));
  scope.suspend();
  await assert.rejects(scope.request('/connect', 'POST', {}, true), abort);
  scope.resume();
  await assert.rejects(callback(), abort);
  assert.deepEqual(calls, []);
  await scope.request('/status');
  await scope.guard(() => scope.request('/connect', 'POST', {}, true))();
  assert.deepEqual(calls, ['/api/computer/bots/A/status', '/api/computer/connect']);
  scope.dispose();
  assert.throws(() => scope.resume(), abort);
});

test('identity changes revoke an old frame but queue updates do not; unprepared state exposes no default desktop', async () => {
  const { screenIdentity, unpreparedScreen } = await scopeModule;
  const base = {
    connected: true,
    surface: 'desktop',
    capabilities: ['virtual-desktop-v1'],
    desktop: { session: { id: 's', generation: 'g' } },
    botScreen: { agentId: 'A', screenId: 'one', assignmentRevision: 'r1', status: 'ready' },
  };
  const identity = screenIdentity(base);
  assert.equal(
    identity,
    screenIdentity({
      ...base,
      botScreen: { ...base.botScreen, task: { status: 'running', queued: 2 } },
    }),
  );
  for (const patch of [
    { ...base, botScreen: { ...base.botScreen, assignmentRevision: 'r2' } },
    { ...base, desktop: { session: { id: 's', generation: 'g2' } } },
    { ...base, botScreen: { ...base.botScreen, agentId: 'B' } },
    {
      ...base,
      botScreen: {
        ...base.botScreen,
        lifecycle: { state: 'changing', operation: { id: 'maintenance-a' } },
      },
    },
  ])
    assert.notEqual(identity, screenIdentity(patch));
  const empty = unpreparedScreen(base, 'B');
  assert.equal(empty.connected, false);
  assert.equal(empty.desktop, undefined);
  assert.equal(empty.capabilities.length, 0);
  assert.equal(empty.botScreen.agentId, 'B');
});

test('shared local frames are scoped to the selected worker connection', async () => {
  const { screenIdentity } = await scopeModule;
  const local = {
    connected: true,
    surface: 'browser',
    executionLocation: 'server',
    targetRevision: 'connection-a',
    botScreen: { agentId: 'A', shared: true, status: 'ready' },
  };
  assert.notEqual(
    screenIdentity(local),
    screenIdentity({ ...local, targetRevision: 'connection-b' }),
  );
  assert.notEqual(screenIdentity(local), screenIdentity({ ...local, executionLocation: 'cloud' }));
});

const machine = {
  connected: true,
  name: '共享工作电脑',
  mode: 'remote',
  platform: 'linux',
  surface: 'desktop',
  capabilities: ['virtual-desktop-v1'],
  status: 'ready',
  desktop: {
    kind: 'virtual',
    authorized: true,
    available: true,
    permissions: { screenRecording: 'granted', accessibility: 'granted' },
  },
};
const agent = {
  id: 'A',
  name: '小松',
  role: '助理',
  description: '',
  color: '#8877aa',
  avatar: 'orb',
  instructions: '',
  status: 'idle',
};
const noop = () => {
  throw new Error('Rendering must not perform an operation');
};
const render = (Component: any, props: any) =>
  renderToStaticMarkup(React.createElement(Component, props)) as string;
test('actual dialog and preview require Bot selection/preparation and never show the shared machine as a Bot screen', async () => {
  const [{ ComputerDialog }, { ComputerPreview }] = await Promise.all([
    compile('web/src/components/ComputerDialog.tsx'),
    compile('web/src/components/ComputerPreview.tsx'),
  ]);
  const props = {
    data: { computer: machine, agents: [agent] },
    conversationId: 'chat',
    conversationTitle: '聊天',
    busy: false,
    onClose: noop,
    onSelectBot: noop,
    onAction: noop,
    refresh: noop,
  };
  const unselected = render(ComputerDialog, props);
  assert.match(unselected, /请先选择一位 Bot/);
  assert.doesNotMatch(unselected, /<img|准备此 Bot 画面/);
  const selected = render(ComputerDialog, { ...props, agentId: 'A' });
  for (const label of [
    '小松 的电脑',
    '小松 的画面',
    '准备此 Bot 画面',
    '文件和浏览器登录状态在此空间内共享',
  ])
    assert.ok(selected.includes(label), label);
  const html = render(ComputerPreview, {
    computer: { ...machine, connected: false, botScreen: { agentId: 'A', status: 'unassigned' } },
    agentName: '小松',
    onOpen: noop,
  });
  assert.match(html, /小松 的画面/);
  assert.doesNotMatch(html, /<img|工作环境示意|mini-chart/);
});

test('screen picker renders real task and capacity state, keeps selection explicit and dispatches only the chosen Bot', async () => {
  const { BotScreenPicker, botTaskLabel } = await compile('web/src/components/BotScreenPicker.tsx');
  const picked: string[] = [];
  const inventory = {
    capacity: { max: 2, configured: 2, ready: 2, assigned: 2 },
    bots: [{ agentId: 'A', status: 'ready', task: { status: 'running', queued: 2 } }],
  };
  const props = { agents: [agent], inventory, onSelect: (id: string) => picked.push(id) };
  const html = render(BotScreenPicker, props);
  for (const label of ['选择一位 Bot', '正在操作', '2 项等待', '已分配 2 / 2'])
    assert.ok(html.includes(label), label);
  const tree = BotScreenPicker(props);
  tree.props.children[0].props.children[1].props.onChange({ target: { value: 'A' } });
  assert.deepEqual(picked, ['A']);
  assert.equal(
    botTaskLabel({ status: 'ready', task: { status: 'waiting_cleanup', queued: 1 } }),
    '正在结束操作 · 1 项等待',
  );
  assert.equal(
    botTaskLabel({ status: 'ready', task: { status: 'blocked', queued: 0 } }),
    '需要维护',
  );
  assert.equal(
    botTaskLabel({ status: 'unassigned', task: { status: 'idle', queued: 0 } }),
    '尚未分配画面',
  );
  assert.equal(
    botTaskLabel({ status: 'unavailable', task: { status: 'idle', queued: 0 } }),
    '暂不可用',
  );
  assert.equal(
    botTaskLabel({ status: 'ready', task: { status: 'maintenance', queued: 0 } }),
    '正在维护画面',
  );
  assert.equal(
    botTaskLabel({
      status: 'unavailable',
      lifecycle: { state: 'blocked', operation: { id: 'saved' } },
    }),
    '需要继续处理',
  );
  const noCapacity = render(BotScreenPicker, {
    ...props,
    inventory: {
      ...inventory,
      capacity: { max: 0, configured: 0, ready: 0, assigned: 0 },
      reason: '尚未配置独立画面',
    },
  });
  assert.match(noCapacity, /尚未配置独立画面/);
});
