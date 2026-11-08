import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { routineChatDestination, type RoutineChatRequest } from './routineChat';
import { emptyComposer, type ComposerState } from './chatDrafts';

const request: RoutineChatRequest = { kind: 'create', conversationId: 'chat', agentId: 'bot' };
async function harness() {
  const source = await workspaceSource();
  const ast = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let fn: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'openRoutineChat') fn = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(fn);
  const state: any = {
    valid: true,
    owner: true,
    requests: 0,
    refreshed: 0,
    written: 0,
    opened: [],
    modal: 'routine',
    snapshot: {
      agents: [{ id: 'bot', name: '负责Bot' }],
      conversations: [{ id: 'chat', agentIds: ['bot'] }],
      routines: [],
    },
    pending: undefined,
    beforeReturn: () => {},
  };
  const base = emptyComposer();
  const refs = {
    composersRef: { current: {} as Record<string, ComposerState> },
    emptyDraft: { current: base },
    sendingRef: { current: new Set<string>() },
    uploadingRef: { current: new Set<string>() },
    routineChatInput: { current: { dictationBusy: false } },
    compositionRef: { current: false },
    pendingDictation: { current: null },
    routineChatOpening: { current: false },
    routineChatFocus: { current: undefined },
  };
  const exports: any = {};
  const code = ts.transpileModule(fn.getText(ast) + '\nexports.open=openRoutineChat;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(code, {
    exports,
    ...refs,
    routineChatDestination,
    canManageRef: {
      get current() {
        return state.owner;
      },
    },
    sendScope: {
      ticket: () => 1,
      current: () => state.valid,
      request: async (path: string) => {
        assert.equal(path, '/bootstrap');
        state.requests++;
        await state.beforeReturn();
        return state.snapshot;
      },
    },
    receipts: { pending: () => state.unconfirmed || 0 },
    setRoutineChatBusy: (value: boolean) => (state.busy = value),
    setRoutineChatError: () => {},
    setRoutineChatPending: (value: any) => (state.pending = value),
    setModal: (value: any) => (state.modal = value),
    setToast: (value: string) => (state.toast = value),
    updateComposer: (id: string, update: (draft: ComposerState) => ComposerState) => {
      refs.composersRef.current[id] = update(refs.composersRef.current[id] || base);
    },
    openConversation: (value: any) => state.opened.push(value.id),
    sync: { written: () => state.written++ },
    refresh: async () => state.refreshed++,
  });
  return {
    state,
    ...refs,
    open: exports.open as (request: RoutineChatRequest, confirmed?: ComposerState) => Promise<void>,
  };
}
test('routine chat opens the exact existing Bot with a focused draft and no send or snapshot replacement', async () => {
  const h = await harness();
  await h.open(request);
  assert.equal(h.state.requests, 1);
  assert.equal(h.composersRef.current.chat.agentId, 'bot');
  assert.equal(h.composersRef.current.chat.text, '帮我安排一个例行任务：');
  assert.equal(h.routineChatFocus.current, 'chat');
  assert.equal(h.state.opened[0], 'chat');
  assert.equal(h.state.written, 1);
  assert.equal(h.state.refreshed, 1);
});
test('existing text, files, and reply require confirmation and survive appending the prompt', async () => {
  const h = await harness();
  const original: ComposerState = {
    ...emptyComposer(),
    text: '原草稿',
    attachments: [{ id: 'file' } as any],
    replyTo: { id: 'reply' } as any,
    agentId: 'old',
  };
  h.composersRef.current.chat = original;
  await h.open(request);
  assert.equal(h.composersRef.current.chat, original);
  assert.equal(h.state.opened.length, 0);
  assert.equal(h.state.pending.draft, original);
  await h.open(request, original);
  assert.equal(h.composersRef.current.chat.text, '原草稿\n\n帮我安排一个例行任务：');
  assert.equal(h.composersRef.current.chat.attachments, original.attachments);
  assert.equal(h.composersRef.current.chat.replyTo, original.replyTo);
  assert.equal(h.composersRef.current.chat.agentId, 'bot');
});
test('late verification rejects changed account, owner role, draft, destination, and active input without navigation', async () => {
  for (const change of [
    (h: any) => (h.state.valid = false),
    (h: any) => (h.state.owner = false),
    (h: any) => (h.composersRef.current.chat = { ...emptyComposer(), text: '后来输入' }),
    (h: any) => (h.state.snapshot.agents = []),
    (h: any) => (h.routineChatInput.current.dictationBusy = true),
    (h: any) => h.sendingRef.current.add('chat'),
    (h: any) => (h.state.unconfirmed = 1),
  ]) {
    const h = await harness();
    h.state.beforeReturn = () => change(h);
    await assert.rejects(h.open(request));
    assert.equal(h.state.opened.length, 0);
    assert.equal(h.state.written, 0);
    assert.equal(h.routineChatOpening.current, false);
  }
});
test('a changed confirmation draft is retained and blocks a stale confirm before fetching', async () => {
  const h = await harness(),
    original = { ...emptyComposer(), text: '旧草稿' };
  const newer = { ...emptyComposer(), text: '新草稿' };
  h.composersRef.current.chat = newer;
  await assert.rejects(h.open(request, original));
  assert.equal(h.state.requests, 0);
  assert.equal(h.composersRef.current.chat, newer);
});
