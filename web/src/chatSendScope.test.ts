import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import ts from 'typescript';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/** Compile the actual App handlers and lifecycle, without copying their implementation or running a product browser. */
async function handlerSource() {
  const source = await workspaceSource();
  const ast = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = ['submitAttempt', 'settleAttempt', 'reconcileReceipts'];
  const declarations = new Map<string, ts.FunctionDeclaration>();
  function findHandlers(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text))
      declarations.set(node.name.text, node);
    ts.forEachChild(node, findHandlers);
  }
  findHandlers(ast);
  const handlers = names.map((name) => {
    const node = declarations.get(name);
    assert.ok(node);
    return `export ${node.getText(ast)}`;
  });
  let teamCallback: ts.Expression | undefined, lifecycle: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(ast) === 'onTeamCreated' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer)
    )
      teamCallback = node.initializer.expression;
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'useEffect' &&
      node.arguments[0]?.getText(ast).includes('sendScope.resume()')
    )
      lifecycle = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(teamCallback);
  assert.ok(lifecycle);
  return [
    "import { ApiError } from './api';",
    "import { matchesChatMentionReceipt } from '../../shared/chat-mentions';",
    "import { uiText } from './i18n';",
    "import { createChatSendScope } from './chatSendScope';",
    "import { createPendingSubmissions } from './pendingSubmissions';",
    "import { emptyComposer, makeSendAttempt, clearSubmittedDraft, composerScopeKey } from './chatDrafts';",
    'export { createChatSendScope, createPendingSubmissions, makeSendAttempt };',
    ...handlers,
    `export const onTeamCreated = ${teamCallback.getText(ast)};`,
    `export const sendLifecycle = ${lifecycle.getText(ast)};`,
  ].join('\n');
}
const code = handlerSource()
  .then((contents) =>
    build({
      stdin: {
        contents,
        resolveDir: resolve('web/src'),
        sourcefile: 'actual-App-send-handlers.ts',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
    }),
  )
  .then((result) => result.outputFiles[0].text);

async function fixture(
  options: {
    hash?: Promise<ArrayBuffer>;
    transport?: (url: string, init: RequestInit) => Promise<Response>;
    abortSignals?: typeof AbortSignal;
  } = {},
) {
  let identity = { workspaceId, userId };
  const window = Object.assign(new EventTarget(), { location: { pathname: `/w/${workspaceId}` } });
  const savedDraft = {
    text: '尚未发送的报告草稿',
    attachments: [
      {
        id: 'file-a',
        name: '资料.pdf',
        size: 80,
        type: 'application/pdf',
        createdAt: '2026-11-05T00:00:00Z',
      },
    ],
    replyTo: { id: 'reply-a', author: '同事', content: '需要先确认范围' },
    mode: 'followUp',
  };
  let composers: Record<string, any> = { 'group-a': savedDraft },
    errors: Record<string, any> = {};
  const stateWrites: string[] = [],
    sent: Array<{ url: string; init: RequestInit }> = [],
    published: any[] = [];
  const dispatchObservers = new Set<() => void>(),
    settledObservers = new Set<() => void>();
  function waitFor(condition: () => boolean, observers: Set<() => void>, label: string) {
    if (condition()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const notify = () => {
        if (condition()) {
          clearTimeout(deadline);
          observers.delete(notify);
          resolve();
        }
      };
      const deadline = setTimeout(() => {
        observers.delete(notify);
        reject(new Error(`Timed out waiting for ${label}`));
      }, 5000);
      observers.add(notify);
      notify();
    });
  }
  const ref = <T>(current: T) => ({ current });
  const storage = new Map<string, string>();
  const state = (name: string) => {
    stateWrites.push(name);
  };
  const sandbox: Record<string, any> = {
    module: { exports: {} },
    exports: {},
    URL,
    Error,
    TypeError,
    DOMException,
    AbortController,
    AbortSignal: options.abortSignals || AbortSignal,
    Response,
    Event,
    TextEncoder,
    crypto: options.hash
      ? { randomUUID: () => webcrypto.randomUUID(), subtle: { digest: () => options.hash } }
      : webcrypto,
    window,
    selected: 'group-a',
    dictation: { busy: false },
    sendingRef: ref(new Set<string>()),
    attempts: ref(new Map()),
    selectedRef: ref('group-a'),
    modalRef: ref(null),
    nearBottom: ref(false),
    jumpRef: ref(null),
    composerRef: ref({
      focus() {
        state('focus');
      },
    }),
    setSending() {
      state('sending');
      for (const notify of settledObservers) notify();
    },
    setReceiptCount() {
      state('receipt');
    },
    setSendErrors(update: any) {
      state('errors');
      errors = typeof update === 'function' ? update(errors) : update;
    },
    setComposers(update: any) {
      state('composers');
      composers = typeof update === 'function' ? update(composers) : update;
    },
    setPendingJump() {
      state('jump');
    },
    setHighlightedMessage() {
      state('highlight');
    },
    sync: {
      written() {
        state('sync');
      },
    },
    upsertMessage(value: any) {
      state('message');
      published.push(value);
    },
    refresh: async () => {
      state('refresh');
    },
    acceptConfirmedTeam() {
      state('group');
    },
    setSelected() {
      state('selected');
    },
    showChat() {
      state('chat');
    },
    setModal() {
      state('modal');
    },
    updateComposer(target: string, update: any) {
      state('unexpected-draft-replacement');
      composers[target] = update(composers[target]);
    },
  };
  sandbox.exports = sandbox.module.exports;
  runInNewContext(await code, sandbox);
  const handlers = sandbox.module.exports;
  sandbox.receipts = handlers.createPendingSubmissions({
    workspaceId,
    userId,
    storage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  sandbox.sendScope = handlers.createChatSendScope({
    workspaceId,
    userId,
    identity: () => identity,
    fetch: async (input: any, init: RequestInit) => {
      const url = String(input);
      sent.push({ url, init });
      for (const notify of dispatchObservers) notify();
      if (options.transport) return options.transport(url, init);
      const body = JSON.parse(String(init.body));
      return json({
        message: {
          id: 'message-a',
          conversationId: 'group-a',
          userId,
          role: 'user',
          content: body.content,
          createdAt: '2026-11-05T00:00:00Z',
          delivery: { clientId: body.clientId, state: 'delivered', mode: body.mode },
        },
      });
    },
  });
  const cleanup = handlers.sendLifecycle();
  const attempt = handlers.makeSendAttempt('group-a', {
    text: '准备新品发布',
    attachments: [],
    mode: 'steer',
  });
  return {
    ...handlers,
    sandbox,
    sent,
    stateWrites,
    published,
    savedDraft,
    attempt,
    cleanup,
    waitForDispatch(count = 1) {
      return waitFor(() => sent.length >= count, dispatchObservers, `dispatch ${count}`);
    },
    waitForSettled() {
      return waitFor(
        () => sandbox.sendingRef.current.size === 0,
        settledObservers,
        'send settlement',
      );
    },
    get composers() {
      return composers;
    },
    get errors() {
      return errors;
    },
    changeAccount() {
      identity = { ...identity, userId: '33333333-3333-4333-8333-333333333333' };
    },
    changeWorkspaceURL() {
      window.location.pathname = '/w/44444444-4444-4444-8444-444444444444';
    },
  };
}

test('actual App send waits for receipt hashing but never dispatches after unmount, account change, or URL workspace change', async () => {
  for (const event of ['unmount', 'account', 'workspace'] as const) {
    const hash = deferred<ArrayBuffer>(),
      ui = await fixture({ hash: hash.promise });
    const pending = ui.submitAttempt(ui.attempt);
    assert.equal(ui.sent.length, 0);
    if (event === 'unmount') ui.cleanup();
    else if (event === 'account') ui.changeAccount();
    else ui.changeWorkspaceURL();
    const before = ui.stateWrites.length;
    hash.resolve(new Uint8Array(32).buffer);
    await pending;
    assert.equal(ui.sent.length, 0);
    assert.equal(ui.stateWrites.length, before);
    assert.equal(ui.published.length, 0);
    await ui.submitAttempt(ui.attempt);
    assert.equal(ui.sent.length, 0);
    ui.cleanup();
  }
});

test('actual App send binds path and Expected-User, ignores late HTTP success/error after scope loss, and preserves the draft', async () => {
  for (const outcome of ['success', 'forbidden', 'account', 'workspace'] as const) {
    const response = deferred<Response>(),
      ui = await fixture({ transport: async () => response.promise });
    const pending = ui.submitAttempt(ui.attempt);
    await ui.waitForDispatch();
    assert.equal(ui.sent.length, 1);
    assert.equal(ui.sent[0].url, `/api/workspaces/${workspaceId}/conversations/group-a/messages`);
    assert.equal((ui.sent[0].init.headers as any)['X-OpenBot-Expected-User'], userId);
    if (outcome === 'account') ui.changeAccount();
    else if (outcome === 'workspace') ui.changeWorkspaceURL();
    else ui.cleanup();
    const before = ui.stateWrites.length;
    response.resolve(
      outcome === 'forbidden'
        ? json({ error: '原账号已离开' }, 403)
        : json({ message: { id: 'late', conversationId: 'group-a', role: 'user', userId } }),
    );
    await pending;
    assert.equal(ui.stateWrites.length, before);
    assert.equal(ui.published.length, 0);
    assert.equal(ui.composers['group-a'], ui.savedDraft);
    ui.cleanup();
  }
});

test('actual team-start callback sends an independent stable goal attempt and preserves text, files, and reply through HTTP and stream settlement', async () => {
  const ui = await fixture();
  const plan = {
    id: 'plan-stable',
    goal: '准备新品发布',
    draft: { title: '计划' },
    result: { conversationId: 'group-a' },
  };
  ui.onTeamCreated(plan, true, { conversation: { id: 'group-a' }, agents: [] });
  await ui.waitForDispatch();
  await ui.waitForSettled();
  assert.equal(ui.sent.length, 1);
  assert.equal(JSON.parse(String(ui.sent[0].init.body)).clientId, plan.id);
  assert.equal(ui.composers['group-a'], ui.savedDraft);
  assert.equal(ui.composers['group-a'].attachments.length, 1);
  assert.equal(ui.composers['group-a'].replyTo.id, 'reply-a');
  assert.equal(ui.stateWrites.includes('unexpected-draft-replacement'), false);
  ui.reconcileReceipts(ui.published);
  assert.equal(ui.composers['group-a'], ui.savedDraft);
  ui.onTeamCreated(plan, true, { conversation: { id: 'group-a' }, agents: [] });
  await ui.waitForSettled();
  assert.equal(ui.sent.length, 1);
  assert.equal(ui.composers['group-a'], ui.savedDraft);
  ui.cleanup();
});

test('actual ordinary send still clears only its own unchanged draft, while a new draft entered during hashing survives', async () => {
  for (const changed of [false, true]) {
    const hash = deferred<ArrayBuffer>(),
      ui = await fixture({ hash: hash.promise });
    const original = ui.makeSendAttempt('group-a', ui.savedDraft);
    const pending = ui.submitAttempt(original);
    if (changed)
      ui.sandbox.updateComposer('group-a', () => ({
        ...ui.savedDraft,
        text: '发送过程中继续写的新内容',
      }));
    const current = ui.composers['group-a'];
    hash.resolve(new Uint8Array(32).buffer);
    await pending;
    if (changed) assert.equal(ui.composers['group-a'], current);
    else {
      assert.equal(ui.composers['group-a'].text, '');
      assert.deepEqual(Array.from(ui.composers['group-a'].attachments), []);
    }
    ui.cleanup();
  }
});

test('actual send handles a definite actor rejection without retry and keeps the original payload and draft', async () => {
  const ui = await fixture({
    transport: async () => json({ error: '账号已切换，请刷新页面。' }, 403),
  });
  await ui.submitAttempt(ui.attempt);
  assert.equal(ui.sent.length, 1);
  assert.equal(ui.errors['group-a'].uncertain, false);
  assert.equal(ui.composers['group-a'], ui.savedDraft);
  assert.equal(ui.published.length, 0);
  ui.cleanup();
});

test('actual send pins the selected skill and keeps the draft until that selection is confirmed', async () => {
  let returnedSkill = 'other-skill';
  const ui = await fixture({
    transport: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      return json({
        message: {
          id: 'skill-message',
          conversationId: 'group-a',
          userId,
          role: 'user',
          content: body.content,
          skillId: returnedSkill,
          delivery: {
            clientId: body.clientId,
            state: 'delivered',
            mode: body.mode,
            agentId: body.agentId,
          },
        },
      });
    },
  });
  try {
    ui.sandbox.updateComposer('group-a', () => ({
      ...ui.savedDraft,
      agentId: 'bot-a',
      skillId: 'reviewed-skill',
      mode: 'steer',
    }));
    const draft = ui.composers['group-a'];
    const attempt = ui.makeSendAttempt('group-a', draft);
    await ui.submitAttempt(attempt);
    const submitted = JSON.parse(String(ui.sent[0].init.body));
    assert.equal(submitted.skillId, 'reviewed-skill');
    assert.equal(submitted.mode, 'followUp');
    assert.equal(draft.mode, 'steer');
    assert.equal(ui.errors['group-a'].uncertain, true);
    assert.equal(ui.composers['group-a'], draft);
    returnedSkill = 'reviewed-skill';
    await ui.submitAttempt(attempt);
    assert.equal(ui.composers['group-a'].skillId, undefined);
    assert.equal(ui.composers['group-a'].text, '');
  } finally {
    ui.cleanup();
  }
});

test('send scope keeps the 30 second deadline, aborts on cleanup, and cannot revive an old epoch during StrictMode replay', async () => {
  const timeouts: Array<{ ms: number; controller: AbortController }> = [];
  const signals = {
    any: AbortSignal.any.bind(AbortSignal),
    timeout(ms: number) {
      const controller = new AbortController();
      timeouts.push({ ms, controller });
      return controller.signal;
    },
  } as typeof AbortSignal;
  const ui = await fixture({
    abortSignals: signals,
    transport: async (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
      ),
  });
  const pending = ui.submitAttempt(ui.attempt);
  await ui.waitForDispatch();
  assert.ok(timeouts.some((value) => value.ms === 30_000));
  const old = ui.sandbox.sendScope.ticket();
  ui.cleanup();
  const restore = ui.sendLifecycle();
  assert.equal(ui.sandbox.sendScope.current(old), false);
  await pending;
  assert.equal(ui.sent[0].init.signal?.aborted, true);
  assert.equal(ui.published.length, 0);
  const again = ui.submitAttempt(ui.attempt);
  await ui.waitForDispatch(2);
  timeouts
    .filter((value) => value.ms === 30_000)
    .at(-1)!
    .controller.abort(new DOMException('Deadline', 'TimeoutError'));
  await again;
  assert.equal(ui.errors['group-a'].uncertain, true);
  assert.match(ui.errors['group-a'].message, /发送回执超时/);
  restore();
});
