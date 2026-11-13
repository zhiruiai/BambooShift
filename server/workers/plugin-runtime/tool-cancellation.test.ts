import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { RustToolBridge, WorkerToolRegistry } from './services.js';

const contract = {
  name: 'synthetic_tool',
  description: 'Synthetic cancellation test; no external operations.',
  parameters: { type: 'object' },
};

for (const mode of ['registry', 'bridge']) {
  test(`${mode}: cancellation followed by a synchronous throw does not crash a default Node process`, () => {
    const code = `
      import { RustToolBridge, WorkerToolRegistry } from ${JSON.stringify(new URL('./services.ts', import.meta.url).href)};
      const run = new AbortController();
      let calls = 0;
      const failing = () => {
        calls++;
        run.abort();
        throw Error('Synthetic synchronous failure');
      };
      const bridge = new RustToolBridge([${JSON.stringify(contract)}], failing, run.signal);
      const registry = new WorkerToolRegistry(bridge, run.signal);
      registry.register('synthetic_tool', failing);
      let caught = false;
      try {
        await (${JSON.stringify(mode)} === 'registry'
          ? registry.invoke('synthetic_tool', 'call', {})
          : bridge.invoke('call', 'synthetic_tool', {}, new AbortController().signal));
      } catch { caught = true; }
      // No unhandledRejection handler: retain Node's default fatal-error behavior.
      await new Promise(resolve => setImmediate(resolve));
      registry.close();
      console.log(JSON.stringify({ caught, calls, survived: true }));
    `;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', code],
      {
        cwd: new URL('../../../', import.meta.url),
        env: { ...process.env, NODE_OPTIONS: '', TSX_DISABLE_CACHE: '1' },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { caught: true, calls: 1, survived: true });
  });
}

test('synchronous handler failures remain catchable and dispatch is still immediate', async () => {
  const run = new AbortController();
  const failure = Error('Synthetic handler failure');
  let calls = 0;
  const bridge = new RustToolBridge(
    [contract],
    () => {
      calls++;
      throw failure;
    },
    run.signal,
  );
  const registry = new WorkerToolRegistry(bridge, run.signal);
  registry.register(contract.name, () => {
    calls++;
    throw failure;
  });
  try {
    const handler = registry.invoke(contract.name, 'handler', {});
    assert.equal(calls, 1, 'registered handlers keep synchronous dispatch timing');
    await assert.rejects(handler, (error) => error === failure);
    const transport = bridge.invoke('transport', contract.name, {}, new AbortController().signal);
    assert.equal(calls, 2, 'Rust bridge transport keeps synchronous dispatch timing');
    await assert.rejects(transport, (error) => error === failure);
  } finally {
    registry.close();
  }
});

test('an already cancelled call never dispatches either a plugin handler or Rust transport', async () => {
  const run = new AbortController();
  const call = new AbortController();
  let calls = 0;
  const bridge = new RustToolBridge(
    [contract],
    async () => {
      calls++;
    },
    run.signal,
  );
  const registry = new WorkerToolRegistry(bridge, run.signal);
  registry.register(contract.name, async () => {
    calls++;
  });
  call.abort();
  try {
    await assert.rejects(registry.invoke(contract.name, 'handler', {}, call.signal), /cancelled/);
    await assert.rejects(bridge.invoke('transport', contract.name, {}, call.signal), /cancelled/);
    assert.equal(calls, 0);
  } finally {
    registry.close();
  }
});
