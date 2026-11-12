import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { WorkerSession } from './session.js';
import { trustedBundledPlugins, type TrustedBundledPlugin } from '../plugin-runtime/bundled.js';
import type { StartRun } from './protocol.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
for (const cancel of [false, true]) {
  test(
    `Pi initialization ${cancel ? 'cancellation' : 'failure'} releases plugin resources before settling`,
    { timeout: 15000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'bambooshift-engine-start-'));
      const entered = deferred(),
        release = deferred();
      let cleanups = 0;
      t.mock.method(DefaultResourceLoader.prototype, 'reload', async () => {
        entered.resolve();
        await release.promise;
        if (!cancel) throw Error('synthetic-private-startup-error');
      });
      const observer: TrustedBundledPlugin = {
        id: 'startup-resource-fixture',
        plugin: {
          inject: ['pluginCleanup'],
          apply(ctx) {
            ctx.pluginCleanup.onDispose(ctx, () => {
              cleanups++;
            });
          },
        },
      };
      const run: StartRun = {
        type: 'start',
        version: 1,
        runId: 'synthetic-startup',
        cwd: directory,
        prompt: 'Synthetic',
        systemPrompt: 'Synthetic',
        tools: [],
        profile: {
          provider: 'synthetic',
          model: 'fixture',
          apiKey: 'SYNTHETIC_KEY',
          baseUrl: 'http://127.0.0.1:1/v1',
        },
      };
      const events: any[] = [];
      const worker = new WorkerSession(run, (event) => events.push(event), [
        ...trustedBundledPlugins,
        observer,
      ]);
      const execution = worker.execute();
      try {
        await Promise.race([entered.promise, execution]);
        assert.equal(
          events.some((event) => event.type === 'settled'),
          false,
        );
        const abort = cancel
          ? worker.command({ type: 'abort', runId: run.runId })
          : Promise.resolve();
        await new Promise<void>((done) => setImmediate(done));
        assert.equal(
          events.some((event) => event.type === 'settled'),
          false,
          'Owned initialization must finish before cleanup settles',
        );
        release.resolve();
        await abort;
        await execution;
        assert.equal(cleanups, 1);
        assert.equal(
          events.some((event) => event.type === 'started'),
          false,
        );
        assert.deepEqual(
          events.filter((event) => event.type === 'settled').map((event) => event.status),
          [cancel ? 'cancelled' : 'error'],
        );
        assert.doesNotMatch(JSON.stringify(events), /synthetic-private-|SYNTHETIC_KEY/);
      } finally {
        release.resolve();
        await execution;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
