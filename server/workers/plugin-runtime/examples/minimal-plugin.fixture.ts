import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '@cordisjs/core';
import type { WorkerPluginContext } from '../context.js';
import { createPluginHost } from '../host.js';

/** A standalone synthetic example, excluded from released worker bundles. */
export async function runMinimalPluginExample() {
  let activeTimers = 0,
    cleanupCalls = 0,
    toolCalls = 0;
  const reviewedPlugin: Plugin.Object<WorkerPluginContext> = {
    name: 'example-lifecycle',
    inject: ['pluginCleanup'],
    apply(ctx) {
      ctx.effect(() => {
        const timer = setInterval(() => {}, 1000);
        timer.unref();
        activeTimers++;
        return () => {
          clearInterval(timer);
          activeTimers--;
        };
      });
      ctx.pluginCleanup.onDispose(ctx, async () => {
        // A real plugin awaits its own SDK client's close() here.
        await Promise.resolve();
        cleanupCalls++;
      });
    },
  };
  const host = await createPluginHost(
    {
      tools: [],
      signal: new AbortController().signal,
      requestTool: async () => {
        toolCalls++;
        throw Error('This example grants no tools.');
      },
    },
    [{ id: 'example-lifecycle', plugin: reviewedPlugin }],
  );
  try {
    assert.equal(activeTimers, 1);
    await assert.rejects(host.invoke('unadmitted', 'example-call', {}), /unavailable/);
  } finally {
    await host.dispose();
  }
  await host.dispose();
  assert.equal(activeTimers, 0);
  assert.equal(cleanupCalls, 1);
  assert.equal(toolCalls, 0);
  return { plugin: 'example-lifecycle', activeTimers, cleanupCalls, toolCalls };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Standalone example output only; a production plugin must not write protocol frames.
  console.info(JSON.stringify(await runMinimalPluginExample()));
}
