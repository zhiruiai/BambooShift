import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPiToolRuntime } from './pi-adapter.js';
import { createPluginHost } from './host.js';
import { trustedBundledPlugins, type TrustedBundledPlugin } from './bundled.js';

const tools = [
  {
    name: 'computer_action',
    description: 'Ask Rust to perform a computer operation.',
    parameters: { type: 'object' },
  },
];
const result = { content: [{ type: 'text', text: 'Synthetic result' }], details: {} };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('Pi adapter forwards the admitted contract and exact request through Rust, without executing during load', async () => {
  const calls: unknown[][] = [];
  const runtime = await createPiToolRuntime({
    tools,
    signal: new AbortController().signal,
    requestTool: async (...args) => {
      calls.push(args);
      return result;
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(runtime.customTools.length, 1);
  const tool = runtime.customTools[0];
  assert.deepEqual(tool.parameters, tools[0].parameters);
  const args = { type: 'desktop_click', x: 20, y: 30 };
  assert.deepEqual(await tool.execute('call-1', args, undefined, undefined, {} as never), result);
  assert.deepEqual(calls[0].slice(0, 3), ['call-1', 'computer_action', args]);
  assert.ok(calls[0][3] instanceof AbortSignal);
  await runtime.dispose();
  await assert.rejects(
    tool.execute('late', args, undefined, undefined, {} as never),
    /unavailable/,
  );
  assert.equal(calls.length, 1);
});

test('unloading a plugin unregisters tools, cancels pending calls and ignores late transport success', async () => {
  const response = deferred<unknown>();
  let signal!: AbortSignal;
  const host = await createPluginHost({
    tools,
    signal: new AbortController().signal,
    requestTool: async (_id, _name, _args, current) => {
      signal = current!;
      return response.promise;
    },
  });
  const pending = host.invoke('computer_action', 'call-1', {});
  const rejected = assert.rejects(pending, /cancelled/);
  await host.unload('rust-tool-bridge');
  assert.equal(signal.aborted, true);
  response.resolve(result);
  await rejected;
  assert.deepEqual(host.definitions(), []);
  await assert.rejects(host.invoke('computer_action', 'late', {}), /unavailable/);
  await host.dispose();
});

test('Cordis effects release listeners and registered asynchronous cleanup is awaited once', async () => {
  const events = new EventEmitter();
  const cleanup = deferred<void>();
  let notifications = 0,
    cleanups = 0,
    finished = false;
  const fixture: TrustedBundledPlugin = {
    id: 'lifecycle-fixture',
    plugin: {
      inject: ['pluginCleanup'],
      apply(ctx) {
        ctx.effect(() => {
          const callback = () => {
            notifications++;
          };
          events.on('tick', callback);
          return () => {
            events.off('tick', callback);
          };
        });
        ctx.pluginCleanup.onDispose(ctx, async () => {
          cleanups++;
          await cleanup.promise;
        });
      },
    },
  };
  const host = await createPluginHost(
    { tools, signal: new AbortController().signal, requestTool: async () => result },
    [...trustedBundledPlugins, fixture],
  );
  events.emit('tick');
  assert.equal(notifications, 1);
  const unloading = host.unload(fixture.id).then(() => {
    finished = true;
  });
  events.emit('tick');
  assert.equal(notifications, 1);
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(cleanups, 1);
  cleanup.resolve();
  await unloading;
  await host.dispose();
  await host.dispose();
  assert.equal(cleanups, 1);
});

test('missing injected services and failed startup fail closed without logging plugin details to stdout', async (t) => {
  const output = t.mock.method(console, 'info', () => {});
  let applied = false;
  for (const fixture of [
    {
      id: 'missing-service',
      plugin: {
        inject: ['missingSyntheticService'],
        apply() {
          applied = true;
        },
      },
    },
    {
      id: 'failed-start',
      plugin: {
        apply() {
          throw Error('synthetic-secret-must-not-be-logged');
        },
      },
    },
  ]) {
    await assert.rejects(
      createPluginHost(
        { tools, signal: new AbortController().signal, requestTool: async () => result },
        [fixture],
      ),
      /failed to start/,
    );
  }
  assert.equal(applied, false);
  assert.equal(output.mock.callCount(), 0);
});

test('cleanup failure still removes tools and is reported consistently without raw details', async (t) => {
  const output = t.mock.method(console, 'info', () => {});
  const fixture: TrustedBundledPlugin = {
    id: 'failed-cleanup',
    plugin: {
      inject: ['pluginCleanup'],
      apply(ctx) {
        ctx.pluginCleanup.onDispose(ctx, async () => {
          throw Error('synthetic-private-detail');
        });
      },
    },
  };
  const host = await createPluginHost(
    { tools, signal: new AbortController().signal, requestTool: async () => result },
    [...trustedBundledPlugins, fixture],
  );
  const disposing = host.dispose();
  assert.equal(host.dispose(), disposing);
  await assert.rejects(disposing, { message: 'Plugin cleanup failed.' });
  await assert.rejects(host.invoke('computer_action', 'late', {}), /unavailable/);
  assert.equal(output.mock.callCount(), 0);
});

test('run and call cancellation prevent late results while independent hosts stay active', async () => {
  for (const cancelRun of [false, true]) {
    const run = new AbortController(),
      call = new AbortController();
    const response = deferred<unknown>();
    const first = await createPluginHost({
      tools,
      signal: run.signal,
      requestTool: async () => response.promise,
    });
    const second = await createPluginHost({
      tools,
      signal: new AbortController().signal,
      requestTool: async () => result,
    });
    const pending = first.invoke('computer_action', 'call', {}, call.signal);
    const rejected = assert.rejects(pending, /cancelled/);
    (cancelRun ? run : call).abort();
    response.resolve(result);
    await rejected;
    assert.deepEqual(await second.invoke('computer_action', 'other', {}), result);
    await first.dispose();
    await second.dispose();
  }
});

test('duplicate or unadmitted tools and unknown plugin identifiers are rejected', async () => {
  const options = { tools, signal: new AbortController().signal, requestTool: async () => result };
  await assert.rejects(
    createPluginHost({ ...options, tools: [...tools, ...tools] }),
    /Invalid worker tool contract/,
  );
  const fixture: TrustedBundledPlugin = {
    id: 'unadmitted-tool',
    plugin: {
      inject: ['workerTools'],
      apply(ctx) {
        ctx.workerTools.register('not_admitted', async () => result);
      },
    },
  };
  await assert.rejects(createPluginHost(options, [fixture]), /failed to start/);
  const host = await createPluginHost(options);
  await assert.rejects(host.unload('../untrusted/plugin.js'), /Unknown bundled plugin/);
  await assert.rejects(host.invoke('not_admitted', 'call', {}), /unavailable/);
  await host.dispose();
});
