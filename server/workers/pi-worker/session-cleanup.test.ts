import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { WorkerPluginHost } from '../plugin-runtime/host.js';
import { trustedBundledPlugins, type TrustedBundledPlugin } from '../plugin-runtime/bundled.js';
import { WorkerSession } from './session.js';
import type { StartRun } from './protocol.js';
import { stream } from './worker.fixture.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const [sessionFailure, pluginFailure] of [
  [true, false],
  [false, true],
  [true, true],
]) {
  test(
    `real Pi session and Cordis dispose independently: session=${sessionFailure}, plugin=${pluginFailure}`,
    { timeout: 15000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'bambooshift-session-cleanup-'));
      let requests = 0;
      const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
          /* Consume the synthetic request body. */
        }
        requests++;
        stream(response, 'Synthetic completed reply.');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const cleanupStarted = deferred(),
        releaseCleanup = deferred();
      let sessionDisposals = 0,
        pluginDisposals = 0,
        host: WorkerPluginHost | undefined;
      const disposeSession = AgentSession.prototype.dispose;
      const disposePlugin = WorkerPluginHost.prototype.dispose;
      t.mock.method(AgentSession.prototype, 'dispose', function (this: AgentSession) {
        sessionDisposals++;
        disposeSession.call(this);
        if (sessionFailure) throw Error('synthetic-private-session-detail');
      });
      t.mock.method(WorkerPluginHost.prototype, 'dispose', function (this: WorkerPluginHost) {
        host = this;
        return disposePlugin.call(this);
      });
      const independentPlugin: TrustedBundledPlugin = {
        id: 'independent-cleanup-fixture',
        plugin: {
          inject: ['pluginCleanup'],
          apply(ctx) {
            ctx.pluginCleanup.onDispose(ctx, async () => {
              pluginDisposals++;
              cleanupStarted.resolve();
              await releaseCleanup.promise;
              if (pluginFailure) throw Error('synthetic-private-plugin-detail');
            });
          },
        },
      };
      const events: Record<string, unknown>[] = [];
      const run: StartRun = {
        type: 'start',
        version: 1,
        runId: 'synthetic-cleanup-run',
        cwd: directory,
        prompt: 'Reply with the synthetic result.',
        systemPrompt: 'Use only supplied tools.',
        profile: {
          provider: 'synthetic-cleanup',
          model: 'fixture',
          apiKey: 'SYNTHETIC_KEY',
          baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        },
        tools: [
          {
            name: 'save_note',
            description: 'Ask Rust to save a note.',
            parameters: { type: 'object' },
          },
        ],
      };
      const worker = new WorkerSession(run, (event) => events.push(event), [
        ...trustedBundledPlugins,
        independentPlugin,
      ]);
      const execution = worker.execute();
      try {
        // Completion winning this race exposes the original skipped-plugin regression immediately.
        await Promise.race([cleanupStarted.promise, execution]);
        assert.equal(pluginDisposals, 1);
        for (let i = 0; i < 20 && !sessionDisposals; i++)
          await new Promise<void>((done) => setImmediate(done));
        assert.equal(sessionDisposals, 1);
        assert.equal(
          events.some((event) => event.type === 'settled'),
          false,
        );
        await assert.rejects(
          worker.command({ type: 'steer', runId: run.runId, text: 'Too late.' }),
          /Stale run/,
        );
        assert.deepEqual(host!.definitions(), []);
        await assert.rejects(host!.invoke('save_note', 'late-call', {}), /unavailable/);
        releaseCleanup.resolve();
        await execution;
        assert.equal(requests, 1);
        assert.equal(sessionDisposals, 1);
        assert.equal(pluginDisposals, 1);
        assert.deepEqual(
          events.filter((event) => event.type === 'error').map((event) => event.code),
          ['PLUGIN_CLEANUP_FAILED'],
        );
        assert.deepEqual(
          events.filter((event) => event.type === 'settled').map((event) => event.status),
          ['error'],
        );
        assert.doesNotMatch(JSON.stringify(events), /synthetic-private-|SYNTHETIC_KEY/);
        await assert.rejects(worker.command({ type: 'abort', runId: run.runId }), /Stale run/);
      } finally {
        releaseCleanup.resolve();
        await execution;
        await host?.dispose().catch(() => {});
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
