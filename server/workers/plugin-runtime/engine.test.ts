import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { TrustedBundledPlugin } from './bundled.js';
import type { StartRun } from '../agent-runtime/protocol.js';
import { WorkerEngineRegistry } from './engines.js';

const run: StartRun = {
  type: 'start',
  version: 1,
  runId: 'synthetic-provider',
  cwd: '/synthetic',
  systemPrompt: 'Synthetic engine test.',
  prompt: 'Use the Rust-authorized tool.',
  engine: 'fixture',
  profile: { provider: 'synthetic', model: 'fixture' },
  tools: [{ name: 'save_note', description: 'Ask Rust to save.', parameters: { type: 'object' } }],
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a Cordis engine replaces Pi without loading its SDK and still uses the Rust tool bridge', async () => {
  const blockedImports: string[] = [];
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('@earendil-works/pi-')) {
        blockedImports.push(specifier);
        throw Error('Pi must not load for the fixture engine.');
      }
      return next(specifier, context);
    },
  });
  const { WorkerSession } = await import('../pi-worker/session.js');
  const { rustToolBridgePlugin } = await import('./bundled.js');
  const cleanupStarted = deferred(),
    releaseCleanup = deferred();
  let disposals = 0;
  const events: any[] = [];
  const engine: TrustedBundledPlugin = {
    id: 'fixture-engine',
    plugin: {
      inject: ['workerEngines', 'workerTools', 'pluginCleanup'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.workerEngines.register('fixture', (options) => {
            let stopping: Promise<void> | undefined;
            const session = {
              async start() {},
              async prompt() {
                const result = await ctx.workerTools.invoke('save_note', 'engine-call', {
                  text: 'Synthetic',
                });
                assert.deepEqual(result, { content: [{ type: 'text', text: 'Rust saved it.' }] });
                options.onEvent({
                  type: 'message_end',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Actual tool result received.' }],
                  },
                });
              },
              async steer() {},
              async followUp() {},
              async abort() {},
              dispose() {
                return (stopping ??= (async () => {
                  disposals++;
                  cleanupStarted.resolve();
                  await releaseCleanup.promise;
                })());
              },
            };
            ctx.pluginCleanup.onDispose(ctx, () => session.dispose());
            return session;
          }),
        );
      },
    },
  };
  const worker = new WorkerSession(
    run,
    (event) => {
      events.push(event);
      if (event.type === 'tool_call')
        queueMicrotask(() => {
          void worker.command({
            type: 'tool_result',
            runId: run.runId,
            callId: String(event.callId),
            result: { content: [{ type: 'text', text: 'Rust saved it.' }] },
          });
        });
    },
    [{ id: 'rust-tool-bridge', plugin: rustToolBridgePlugin }, engine],
  );
  const execution = worker.execute();
  try {
    await Promise.race([cleanupStarted.promise, execution]);
    assert.equal(disposals, 1);
    assert.equal(
      events.some((event) => event.type === 'settled'),
      false,
    );
    assert.deepEqual(events.find((event) => event.type === 'tool_call').arguments, {
      text: 'Synthetic',
    });
    await assert.rejects(
      worker.command({ type: 'steer', runId: run.runId, text: 'Too late' }),
      /Stale/,
    );
    releaseCleanup.resolve();
    await execution;
    assert.deepEqual(
      events.filter((event) => event.type === 'settled').map((event) => event.status),
      ['completed'],
    );
    assert.equal(disposals, 1);
    assert.deepEqual(blockedImports, []);
  } finally {
    releaseCleanup.resolve();
    await execution;
    hooks.deregister();
  }
});

test('the static registry rejects duplicate, unknown and removed engines', () => {
  const registry = new WorkerEngineRegistry();
  const options = { run, signal: new AbortController().signal, onEvent() {} };
  const factory = () => {
    throw Error('Factory must not execute.');
  };
  const remove = registry.register('fixture', factory);
  assert.throws(() => registry.register('fixture', factory), /duplicate/);
  assert.throws(() => registry.register('../untrusted.js', factory), /Invalid/);
  assert.throws(() => registry.create('unavailable', options), /Unknown/);
  remove();
  assert.throws(() => registry.create('fixture', options), /Unknown/);
  registry.close();
  assert.throws(() => registry.register('later', factory), /closed/);
});

test('an unavailable engine settles as a failure without falling back to Pi', async () => {
  const { WorkerSession } = await import('../pi-worker/session.js');
  const events: any[] = [];
  await new WorkerSession(
    { ...run, engine: 'unavailable' },
    (event) => events.push(event),
    [],
  ).execute();
  assert.equal(
    events.some((event) => event.type === 'started'),
    false,
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'error').map((event) => event.code),
    ['RUN_FAILED'],
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'settled').map((event) => event.status),
    ['error'],
  );
});
