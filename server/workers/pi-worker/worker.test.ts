import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, stream } from './worker.fixture.js';
import { parseCommand } from './protocol.js';

test('the real Pi child delegates an explicit tool to its host and completes only after the tool result', async () => {
  const f = await fixture((_body, res, count) =>
    count === 1
      ? stream(res, undefined, { name: 'save_note', arguments: { text: 'Synthetic note' } })
      : stream(res, 'Saved by the host.'),
  );
  try {
    f.input.tools = [
      {
        name: 'save_note',
        description: 'Ask the host to save a note.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ];
    f.send(f.input);
    await f.until(
      () => f.events.some((event) => event.type === 'tool_call'),
      'tool request reached host',
    );
    const call = f.events.find((event) => event.type === 'tool_call');
    assert.equal(call.runId, f.input.runId);
    assert.equal(call.name, 'save_note');
    assert.deepEqual(call.arguments, { text: 'Synthetic note' });
    assert.equal(
      f.events.some((event) => event.type === 'settled'),
      false,
    );
    assert.deepEqual(
      f.requests[0].tools.map((tool: any) => tool.function.name),
      ['save_note'],
    );
    f.send({
      type: 'tool_result',
      runId: 'a-stale-run',
      callId: call.callId,
      result: { content: [{ type: 'text', text: 'Wrong result' }] },
    });
    await f.until(
      () => f.events.some((event) => event.type === 'protocol_error'),
      'stale tool result rejected',
    );
    assert.equal(f.requests.length, 1);
    f.send({
      type: 'tool_result',
      runId: f.input.runId,
      callId: call.callId,
      result: {
        content: [{ type: 'text', text: 'Host saved the note.' }],
        details: { saved: true },
      },
    });
    await f.until(() => f.events.some((event) => event.type === 'settled'), 'real Pi run settled');
    assert.equal(f.events.find((event) => event.type === 'settled').status, 'completed');
    assert.equal(f.requests.length, 2);
    assert.ok(JSON.stringify(f.requests[1]).includes('Host saved the note.'));
    assert.equal(JSON.stringify(f.events).includes(f.input.profile.apiKey!), false);
  } finally {
    await f.close();
  }
});

test('aborting the process-owned run produces cancellation without completing or dispatching another model call', async () => {
  const f = await fixture((_body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  });
  try {
    f.send(f.input);
    await f.until(() => f.requests.length === 1, 'model request started');
    f.send({ type: 'abort', runId: f.input.runId });
    await f.until(
      () => f.events.some((event) => event.type === 'settled'),
      'cancelled run settled',
    );
    assert.equal(f.events.find((event) => event.type === 'settled').status, 'cancelled');
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

test('the protocol bounds frame size and accepts no unknown tool definitions or unbound commands', () => {
  assert.throws(() => parseCommand(JSON.stringify({ type: 'abort', runId: '../escape' })));
  assert.throws(() => parseCommand(' '.repeat(2 * 1024 * 1024 + 1)));
  assert.throws(() =>
    parseCommand(
      JSON.stringify({
        type: 'start',
        version: 1,
        runId: 'run',
        cwd: '/tmp',
        systemPrompt: '',
        prompt: 'task',
        profile: { provider: 'test', model: 'test' },
        tools: [{ name: 'tool', description: 'test', parameters: { type: 'array' } }],
      }),
    ),
  );
});

test('steering and follow-up delivery receipts are emitted only when Pi consumes each bound input', async () => {
  let finishFirst: (() => void) | undefined;
  const f = await fixture((_body, res, count) => {
    if (count === 1) finishFirst = () => stream(res, 'Initial synthetic reply.');
    else stream(res, 'Reply to the queued synthetic input.');
  });
  try {
    f.send(f.input);
    await f.until(() => !!finishFirst, 'initial model request started');
    f.send({
      type: 'steer',
      runId: f.input.runId,
      inputId: 'steer-receipt',
      text: 'Synthetic steering requirement.',
    });
    f.send({
      type: 'follow_up',
      runId: f.input.runId,
      inputId: 'follow-receipt',
      text: 'Synthetic follow-up requirement.',
    });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(
      f.events.some((event) => event.type === 'input_delivered'),
      false,
    );
    finishFirst!();
    await f.until(
      () => f.events.some((event) => event.type === 'settled'),
      'queued inputs completed',
    );
    assert.equal(f.events.find((event) => event.type === 'settled').status, 'completed');
    assert.deepEqual(
      f.events.filter((event) => event.type === 'input_delivered').map((event) => event.inputId),
      ['steer-receipt', 'follow-receipt'],
    );
    assert.equal(f.requests.length, 3);
    assert.ok(JSON.stringify(f.requests[1].messages).includes('Synthetic steering requirement.'));
    assert.ok(JSON.stringify(f.requests[2].messages).includes('Synthetic follow-up requirement.'));
  } finally {
    await f.close();
  }
});
