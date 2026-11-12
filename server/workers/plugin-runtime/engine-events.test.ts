import test from 'node:test';
import assert from 'node:assert/strict';
import { toWorkerEvent } from '../engines/pi/events.js';

test('the Pi adapter emits only the v1 text and usage contract consumed by Rust', () => {
  const usage = { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, totalTokens: 26 };
  for (const type of ['message_start', 'message_update', 'message_end']) {
    const adapted = toWorkerEvent({
      type,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Visible reply.' },
          { type: 'thinking', thinking: 'Private reasoning' },
        ],
        usage: { ...usage, cost: { total: 999 } },
        provider: 'internal',
        errorMessage: 'private error',
      },
      assistantMessageEvent: { type: 'internal', delta: 'private delta' },
    } as never);
    assert.deepEqual(adapted, {
      type,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Visible reply.' }], usage },
    });
  }
  assert.deepEqual(
    toWorkerEvent({
      type: 'message_start',
      message: { role: 'user', content: 'Queued input' },
    } as never),
    {
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: 'Queued input' }] },
    },
  );
  assert.equal(toWorkerEvent({ type: 'agent_start' } as never), undefined);
  assert.equal(
    toWorkerEvent({ type: 'message_end', message: { role: 'toolResult', content: [] } } as never),
    undefined,
  );
});

test('real tool completion fields preserve failure observations and their exact Rust result', () => {
  for (const isError of [false, true]) {
    const result = {
      content: [{ type: 'text', text: 'Child output' }],
      details: {
        conversationId: 'child-chat',
        resultMessageId: 'saved-message',
        content: 'Actual result',
      },
      isError,
    };
    const event = {
      type: 'tool_execution_end' as const,
      toolCallId: 'call',
      toolName: 'delegate',
      result,
      isError,
      durationMs: 42,
    };
    assert.deepEqual(toWorkerEvent({ ...event, extraSdkField: 'not part of v1' } as never), event);
  }
});
