import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSession } from './session.js';
import { MAX_RUN_TIMEOUT_MS, parseCommand, type StartRun } from './protocol.js';
import { stream } from './worker.fixture.js';

async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check() && Date.now() < end) await new Promise<void>((done) => setImmediate(done));
  assert.ok(check(), 'Expected real Pi event before the test deadline');
}

async function fixture() {
  await import('@earendil-works/pi-coding-agent');
  const directory = await mkdtemp(join(tmpdir(), 'bambooshift-pi-deadline-'));
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    if (requests.length === 1)
      stream(response, undefined, { name: 'delegate', arguments: { task: 'Synthetic task' } });
    else stream(response, 'Reviewed the actual delegated result.');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const run: StartRun = {
    type: 'start',
    version: 1,
    runId: 'synthetic-deadline',
    cwd: directory,
    timeoutMs: 600000,
    systemPrompt: 'Use supplied tools.',
    prompt: 'Delegate the synthetic task.',
    profile: {
      provider: 'synthetic-deadline',
      model: 'fixture',
      apiKey: 'SYNTHETIC_KEY',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    },
    tools: [
      {
        name: 'delegate',
        description: 'Wait for the actual child result.',
        parameters: {
          type: 'object',
          properties: { task: { type: 'string' } },
          required: ['task'],
        },
      },
    ],
  };
  const events: any[] = [];
  const worker = new WorkerSession(run, (event) => events.push(event));
  return {
    run,
    events,
    worker,
    requests,
    async close(execution: Promise<void>) {
      await worker.command({ type: 'abort', runId: run.runId }).catch(() => {});
      await execution;
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test(
  'a delegated tool can outlive five minutes within the root budget and delivers its real result',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const execution = f.worker.execute();
    try {
      await until(() => f.events.some((event) => event.type === 'tool_call'));
      const call = f.events.find((event) => event.type === 'tool_call');
      t.mock.timers.tick(300001);
      for (let i = 0; i < 10; i++) await new Promise<void>((done) => setImmediate(done));
      assert.equal(f.requests.length, 1, 'The parent must continue waiting for its child');
      assert.equal(
        f.events.some((event) => event.type === 'settled'),
        false,
      );
      await f.worker.command({
        type: 'tool_result',
        runId: f.run.runId,
        callId: call.callId,
        result: {
          content: [{ type: 'text', text: 'Actual synthetic child output.' }],
          details: { status: 'completed' },
          isError: false,
        },
      });
      await execution;
      assert.equal(f.requests.length, 2);
      assert.match(JSON.stringify(f.requests[1]), /Actual synthetic child output/);
      assert.equal(f.events.find((event) => event.type === 'settled').status, 'completed');
    } finally {
      await f.close(execution);
    }
  },
);

for (const mode of ['deadline', 'abort'] as const) {
  test(
    `${mode} ends a waiting tool without a new model call or late-result replay`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const execution = f.worker.execute();
      try {
        await until(() => f.events.some((event) => event.type === 'tool_call'));
        const call = f.events.find((event) => event.type === 'tool_call');
        if (mode === 'deadline') t.mock.timers.tick(f.run.timeoutMs!);
        else await f.worker.command({ type: 'abort', runId: f.run.runId });
        await execution;
        assert.equal(f.requests.length, 1);
        assert.deepEqual(
          f.events.filter((event) => event.type === 'settled').map((event) => event.status),
          [mode === 'deadline' ? 'error' : 'cancelled'],
        );
        assert.equal(
          f.events.find((event) => event.type === 'error').code,
          mode === 'deadline' ? 'RUN_DEADLINE_EXCEEDED' : 'RUN_CANCELLED',
        );
        await assert.rejects(
          f.worker.command({
            type: 'tool_result',
            runId: f.run.runId,
            callId: call.callId,
            result: { content: [{ type: 'text', text: 'Late result' }] },
          }),
          /Stale run/,
        );
        assert.equal(f.requests.length, 1);
      } finally {
        await f.close(execution);
      }
    },
  );
}

test('the host-provided budget is a bounded positive integer', async () => {
  const f = await fixture();
  try {
    for (const timeoutMs of [0, -1, 1.5, '60000', null, MAX_RUN_TIMEOUT_MS + 1])
      assert.throws(() => parseCommand(JSON.stringify({ ...f.run, timeoutMs })), /configuration/);
    for (const timeoutMs of [1, MAX_RUN_TIMEOUT_MS])
      assert.equal(
        (parseCommand(JSON.stringify({ ...f.run, timeoutMs })) as StartRun).timeoutMs,
        timeoutMs,
      );
  } finally {
    await f.close(Promise.resolve());
  }
});
