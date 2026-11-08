import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bootstrap } from '../../shared/types';
import type { RoutineRun } from '../../shared/routine-runs';
import { routineRunDestination } from './routineRunNavigation';

const run: RoutineRun = {
  runId: 'run',
  routineId: 'routine',
  agentId: 'bot',
  conversationId: 'chat',
  inputMessageId: 'input',
  resultMessageId: 'result',
  trigger: 'scheduled',
  status: 'completed',
  startedAt: '2026-11-05T00:00:00Z',
};
const fixture = () =>
  ({
    conversations: [{ id: 'chat', agentIds: ['bot'], isGroup: false }],
    routines: [],
    messages: [
      {
        id: 'input',
        role: 'system',
        agentId: 'bot',
        conversationId: 'chat',
        metadata: { routineRun: { runId: 'run', routineId: 'routine', inputMessageId: 'input' } },
      },
      {
        id: 'result',
        role: 'assistant',
        agentId: 'bot',
        conversationId: 'chat',
        metadata: { routineRun: { runId: 'run', routineId: 'routine', inputMessageId: 'input' } },
      },
    ],
  }) as unknown as Bootstrap;

test('run navigation uses the original exact result after plan, Bot or source input removal without mutating state', () => {
  const snapshot = fixture(),
    original = JSON.stringify(snapshot);
  assert.equal(routineRunDestination(snapshot, run).messageId, 'result');
  assert.equal(JSON.stringify(snapshot), original);
  snapshot.messages = snapshot.messages.filter((message) => message.id !== 'input');
  assert.equal(
    routineRunDestination(snapshot, { ...run, inputMessageId: undefined }).messageId,
    'result',
  );
});
test('missing or unrelated results never redirect to a replacement chat or its input', () => {
  for (const change of [
    (s: Bootstrap) => {
      s.conversations = [];
    },
    (s: Bootstrap) => {
      s.messages.pop();
    },
    (s: Bootstrap) => {
      s.messages[1].conversationId = 'other';
    },
    (s: Bootstrap) => {
      s.messages[1].agentId = 'other';
    },
    (s: Bootstrap) => {
      s.messages[1].role = 'user';
    },
    (s: Bootstrap) => {
      s.messages[1].metadata!.routineRun = {
        runId: 'other',
        routineId: 'routine',
        inputMessageId: 'input',
      };
    },
    (s: Bootstrap) => {
      s.messages[1].metadata!.routineRun = {
        runId: 'run',
        routineId: 'other',
        inputMessageId: 'input',
      };
    },
    (s: Bootstrap) => {
      s.messages[1].metadata!.routineRun = {
        runId: 'run',
        routineId: 'routine',
        inputMessageId: 'other',
      };
    },
  ]) {
    const s = fixture();
    change(s);
    assert.throws(() => routineRunDestination(s, run));
  }
});
test('in-progress navigation accepts only the bound background or human input and preserves manual target', () => {
  const pending = { ...run, status: 'running' as const, resultMessageId: undefined };
  assert.equal(routineRunDestination(fixture(), pending).messageId, 'input');
  const s = fixture();
  s.messages[0].role = 'user';
  s.messages[0].delivery = { state: 'delivered', mode: 'followUp', agentId: 'bot' };
  assert.equal(routineRunDestination(s, { ...pending, trigger: 'manual' }).messageId, 'input');
  s.messages[0].delivery.agentId = 'other';
  assert.throws(() => routineRunDestination(s, pending));
  assert.throws(() => routineRunDestination(fixture(), { ...pending, inputMessageId: undefined }));
});
