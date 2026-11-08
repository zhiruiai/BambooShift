import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';

const wid = '11111111-1111-4111-8111-111111111111';
const uid = 'member-a';
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const compiled = (async () => {
  const source = await workspaceSource();
  const ast = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let handler: ts.FunctionDeclaration | undefined, visible: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'stopCurrentTask') handler = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'canStop')
      visible = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(handler);
  assert.ok(visible);
  const output = await build({
    stdin: {
      contents: [
        "import { ApiError } from './api';",
        "import { createChatSendScope } from './chatSendScope';",
        "import { canStopConversation } from './approvalUi';",
        'export { createChatSendScope };',
        `export ${handler.getText(ast)}`,
        `export function show(working, data, selected, currentUserId, canManage) { const workspaceState = { data, selected }; return ${visible.getText(ast)}; }`,
      ].join('\n'),
      resolveDir: resolve('web/src'),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  });
  return output.outputFiles[0].text;
})();
async function fixture() {
  let identity = { workspaceId: wid, userId: uid };
  const calls: Array<{ url: string; init: RequestInit }> = [],
    writes: string[] = [];
  const window = Object.assign(new EventTarget(), { location: { pathname: `/w/${wid}/` } });
  const sandbox: Record<string, any> = {
    module: { exports: {} },
    exports: {},
    window,
    Error,
    TypeError,
    Event,
    Response,
    AbortController,
    AbortSignal,
    DOMException,
    selected: 'chat-a',
    stopping: { current: false },
    stopState: {
      current: {
        selected: 'chat-a',
        working: true,
        busy: false,
        userId: uid,
        owner: false,
        requests: [{ conversationId: 'chat-a', requester: { userId: uid, name: '林' } }],
      },
    },
    setBusy: () => writes.push('busy'),
    setToast: () => writes.push('toast'),
    sync: { written: () => writes.push('written') },
    refresh: async () => {
      writes.push('refresh');
    },
  };
  runInNewContext(await compiled, sandbox);
  const api = sandbox.module.exports;
  sandbox.sendScope = api.createChatSendScope({
    ...identity,
    identity: () => identity,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json({ ok: true });
    },
  });
  return {
    api,
    sandbox,
    calls,
    writes,
    window,
    account: () => {
      identity = { ...identity, userId: 'owner-b' };
    },
  };
}

test('actual App stop visibility follows current requester; neither ownership nor other queued work permits stopping someone else', async () => {
  const { api } = await fixture();
  for (const [requests, userId, owner, allowed] of [
    [[{ conversationId: 'chat-a', requester: { userId: uid } }], uid, false, true],
    [[{ conversationId: 'chat-a', requester: { userId: uid } }], 'owner-b', true, false],
    [[{ conversationId: 'chat-b', requester: { userId: uid } }], uid, true, false],
    [[{ conversationId: 'chat-a' }], uid, false, false],
    [[{ conversationId: 'chat-a' }], 'owner-b', true, true],
    [undefined, uid, false, false],
    [undefined, undefined, true, true],
    [[], uid, true, false],
  ] as const)
    assert.equal(api.show(true, { runningRequests: requests }, 'chat-a', userId, owner), allowed);
  assert.equal(api.show(false, {}, 'chat-a', uid, true), false);
});

test('actual App stop handler captures actor/workspace, refuses stale clicks and never drops another member queue through UI state', async () => {
  for (const change of [
    'same',
    'requester',
    'account',
    'route',
    'conversation',
    'unmount',
  ] as const) {
    const f = await fixture();
    if (change === 'requester')
      f.sandbox.stopState.current.requests = [
        { conversationId: 'chat-a', requester: { userId: 'other' } },
      ];
    if (change === 'account') f.account();
    if (change === 'route') f.window.location.pathname = '/w/33333333-3333-4333-8333-333333333333/';
    if (change === 'conversation') f.sandbox.stopState.current.selected = 'chat-b';
    if (change === 'unmount') f.sandbox.sendScope.suspend();
    await f.api.stopCurrentTask();
    assert.equal(f.calls.length, change === 'same' ? 1 : 0, change);
    if (change === 'same') {
      assert.equal(f.calls[0].url, `/api/workspaces/${wid}/conversations/chat-a/stop`);
      assert.equal(new Headers(f.calls[0].init.headers).get('X-OpenBot-Expected-User'), uid);
      assert.deepEqual(f.writes, ['busy', 'written', 'refresh', 'busy']);
      assert.equal(
        f.sandbox.stopState.current.requests.length,
        1,
        'stopping does not locally clear task or queued-message records',
      );
    } else assert.deepEqual(f.writes, []);
  }
});

const adminCompiled = (async () => {
  const source = await readFile('web/src/admin/workspace/useAdminWorkspace.ts', 'utf8');
  const ast = ts.createSourceFile(
    'AdminApp.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const workspace = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'useAdminWorkspace',
  ) as ts.FunctionDeclaration;
  const handlers = ['canStop', 'stopTask', 'refresh'].map((name) => {
    const found = workspace.body!.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.ok(found);
    return `export ${found.getText(ast)}`;
  });
  const output = await build({
    stdin: {
      contents: [
        "import { createAppConnectionScope } from '../appConnections';",
        "import { canStopConversation } from '../approvalUi';",
        'export { createAppConnectionScope };',
        ...handlers,
      ].join('\n'),
      resolveDir: resolve('web/src/admin'),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
  });
  return output.outputFiles[0].text;
})();
async function adminFixture() {
  let identity = { workspaceId: wid, userId: uid };
  let late: Promise<Response> | undefined;
  const calls: Array<{ url: string; init: RequestInit }> = [],
    writes: string[] = [];
  const window = Object.assign(new EventTarget(), { location: { pathname: `/w/${wid}/manage` } });
  const data = {
    agents: [],
    conversations: [{ id: 'chat-a' }],
    runningRequests: [{ conversationId: 'chat-a', requester: { userId: uid } }],
  };
  const overview = {
    execution: {
      runningConversations: [{ id: 'chat-a', title: '真实任务', agentIds: [], isGroup: false }],
    },
    settings: {},
    computer: {},
  };
  const sandbox: Record<string, any> = {
    module: { exports: {} },
    exports: {},
    window,
    Error,
    TypeError,
    Event,
    Response,
    AbortController,
    AbortSignal,
    DOMException,
    mounted: { current: true },
    actionRunning: { current: false },
    requestSequence: { current: 0 },
    stopState: { current: { data, overview, userId: uid, owner: true } },
    ...Object.fromEntries(
      [
        'Busy',
        'ActionError',
        'Notice',
        'Refreshing',
        'Overview',
        'Data',
        'ConversationId',
        'LoadError',
      ].map((key) => [`set${key}`, () => writes.push(key)]),
    ),
  };
  runInNewContext(await adminCompiled, sandbox);
  const api = sandbox.module.exports;
  sandbox.scope = api.createAppConnectionScope({
    ...identity,
    identity: () => identity,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/stop')) return late || json({ ok: true });
      return json(url.endsWith('/bootstrap') ? data : overview);
    },
  });
  return {
    api,
    sandbox,
    calls,
    writes,
    window,
    data,
    overview,
    account: () => {
      identity = { ...identity, userId: 'owner-b' };
    },
    hold: (value: Promise<Response>) => {
      late = value;
    },
  };
}

test('actual workspace management stop also restricts owner to own task and reads updated state with the original Expected-User', async () => {
  for (const mode of ['own', 'other', 'legacy', 'account', 'route', 'unmount'] as const) {
    const f = await adminFixture();
    if (mode === 'other')
      f.sandbox.stopState.current.data.runningRequests = [
        { conversationId: 'chat-a', requester: { userId: 'other' } },
      ];
    if (mode === 'legacy') f.sandbox.stopState.current.data.runningRequests = undefined;
    if (mode === 'account') f.account();
    if (mode === 'route')
      f.window.location.pathname = '/w/33333333-3333-4333-8333-333333333333/manage';
    if (mode === 'unmount') {
      f.sandbox.mounted.current = false;
      f.sandbox.scope.suspend();
    }
    const allowed = mode === 'own' || mode === 'legacy';
    assert.equal(f.api.canStop('chat-a'), allowed, mode);
    await f.api.stopTask('chat-a');
    assert.equal(f.calls.length, allowed ? 3 : 0, mode);
    if (allowed) {
      assert.deepEqual(
        f.calls.map((call) => call.url),
        [
          `/api/workspaces/${wid}/conversations/chat-a/stop`,
          `/api/workspaces/${wid}/admin/overview`,
          `/api/workspaces/${wid}/bootstrap`,
        ],
      );
      for (const call of f.calls)
        assert.equal(new Headers(call.init.headers).get('X-OpenBot-Expected-User'), uid);
    } else assert.deepEqual(f.writes, []);
  }
});

test('a late workspace management stop reply cannot refresh or publish notice after account change or unmount', async () => {
  for (const mode of ['account', 'unmount'] as const) {
    const f = await adminFixture();
    let resolve!: (value: Response) => void;
    f.hold(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const result = f.api.stopTask('chat-a');
    assert.equal(f.calls.length, 1);
    if (mode === 'account') f.account();
    else {
      f.sandbox.mounted.current = false;
      f.sandbox.scope.suspend();
    }
    resolve(json({ ok: true }));
    await result;
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.writes, ['Busy', 'ActionError']);
  }
});
