import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { routineOperationDestination } from './routineOperationNavigation';
import type { Bootstrap } from '../../shared/types';
import type { RoutineOperationReceipt } from '../../shared/routine-operations';

const receipt: Extract<RoutineOperationReceipt, { kind: 'run' }> = {
  kind: 'run',
  requestId: 'request',
  routineId: 'routine',
  agentId: 'bot',
  conversationId: 'chat',
  userId: 'user',
  workspaceId: 'space',
  createdAt: '2026-11-05T00:00:00Z',
  nextRunAt: '2026-11-06T00:00:00Z',
  messageId: 'input',
  status: 'completed',
  resultMessageId: 'result',
};
const fixture = () =>
  ({
    conversations: [{ id: 'chat', title: '原会话', agentIds: ['bot'], isGroup: false }],
    routines: [{ id: 'routine', agentId: 'bot', conversationId: 'chat' }],
    messages: [
      {
        id: 'input',
        role: 'user',
        userId: 'user',
        conversationId: 'chat',
        delivery: { agentId: 'bot', clientId: 'request' },
        metadata: { routineOperation: { requestId: 'request', routineId: 'routine' } },
      },
    ],
  }) as unknown as Bootstrap;

test('receipt navigation verifies the original input, still permits history after routine removal, and never recreates missing destinations', () => {
  const data = fixture();
  const original = JSON.stringify(data);
  assert.equal(routineOperationDestination(data, receipt).id, 'chat');
  assert.equal(JSON.stringify(data), original);
  data.routines = [];
  assert.equal(routineOperationDestination(data, receipt).id, 'chat');
  assert.throws(() =>
    routineOperationDestination(data, { ...receipt, kind: 'create', status: 'created' }),
  );
  for (const modify of [
    (s: Bootstrap) => {
      s.messages[0].userId = 'another';
    },
    (s: Bootstrap) => {
      s.messages[0].delivery!.clientId = 'another';
    },
    (s: Bootstrap) => {
      s.messages[0].metadata!.routineOperation = { requestId: 'request', routineId: 'another' };
    },
    (s: Bootstrap) => {
      s.messages = [];
    },
    (s: Bootstrap) => {
      s.conversations = [];
    },
  ]) {
    const s = fixture();
    modify(s);
    assert.throws(() => routineOperationDestination(s, receipt));
  }
  assert.throws(() => routineOperationDestination(fixture(), { ...receipt, status: 'missing' }));
});
async function mainHandler(context: Record<string, unknown>) {
  const source = await workspaceSource();
  const ast = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let handler: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'openRoutineOperation')
      handler = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(handler);
  const code = ts.transpileModule(handler.getText(ast) + '\nexports.open=openRoutineOperation;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, ...context });
  return exports.open as (receipt: RoutineOperationReceipt) => Promise<void>;
}
test('actual chat callback verifies destination before navigation without overwriting newer synchronized data', async () => {
  let requests = 0,
    written = 0,
    refreshed = 0,
    opened = 0,
    closed = 0;
  const handler = await mainHandler({
    sendScope: {
      ticket: () => 1,
      current: () => true,
      request: async () => {
        requests++;
        return fixture();
      },
    },
    currentUserId: 'user',
    sendIdentity: { current: { workspaceId: 'space' } },
    routineOperationDestination,
    sync: {
      written() {
        written++;
      },
    },
    refresh: async () => {
      refreshed++;
    },
    openConversation: (c: { id: string }) => {
      assert.equal(c.id, 'chat');
      opened++;
    },
    setModal: (value: null) => {
      assert.equal(value, null);
      closed++;
    },
    setData: () => {
      throw Error('unordered bootstrap overwrite');
    },
  });
  await assert.rejects(() => handler({ ...receipt, userId: 'other' }));
  assert.equal(requests, 0);
  await handler(receipt);
  assert.deepEqual(
    { requests, written, refreshed, opened, closed },
    { requests: 1, written: 1, refreshed: 1, opened: 1, closed: 1 },
  );
});
test('actual chat callback rejects a late verification after account or space changes', async () => {
  let active = true,
    complete!: (value: Bootstrap) => void,
    requests = 0;
  const waiting = new Promise<Bootstrap>((resolve) => (complete = resolve));
  const fail = () => {
    throw Error('stale navigation published');
  };
  const handler = await mainHandler({
    sendScope: {
      ticket: () => 1,
      current: () => active,
      request: () => {
        requests++;
        return waiting;
      },
    },
    currentUserId: 'user',
    sendIdentity: { current: { workspaceId: 'space' } },
    routineOperationDestination,
    sync: { written: fail },
    refresh: fail,
    openConversation: fail,
    setModal: fail,
  });
  const pending = handler(receipt);
  assert.equal(requests, 1);
  active = false;
  complete(fixture());
  await assert.rejects(() => pending, /账户或空间已变化/);
});
