# Trusted worker plugins

This extension point uses the MIT-licensed **`@cordisjs/core` 3.18.1**. It provides Cordis contexts, dependency injection, plugin effects and disposal inside the existing Node worker. It adds no daemon, database, language or independent authorization system.

The worker host loads the statically imported entries in `bundled.ts`. The `rust-tool-bridge` plugin registers only tool contracts supplied in Rust's run configuration. The `pi-engine` plugin provides the single production engine through Cordis's injected `workerEngines` registry. Calling a tool still sends the existing `tool_call` request to Rust. Rust remains responsible for permissions, approvals, credentials, persistence and execution decisions. Plugins neither approve actions nor open workspace databases.

```ts
const plugins = await createPluginHost({ tools, requestTool, signal });
try {
  const engine = plugins.createEngine('pi', { run, signal, onEvent });
  await engine.start();
  await engine.prompt(run.prompt);
} finally {
  // The engine plugin owns its SDK session and registers its cleanup with the host.
  await plugins.dispose();
}
```

The owning worker must settle its run even if disposal rejects: catch the fixed cleanup error, finish its protocol cleanup, and emit the final settlement event in `finally`. Disposal immediately removes tools and aborts pending calls before awaiting registered resource cleanup. A late transport result cannot become a successful tool result after cancellation. Disposal cannot undo an action already executed by Rust or another service.

Each plugin's cleanup starts independently; a failing engine disposer must not skip another plugin's cleanup. `WorkerSession` waits for the host's cleanup drain, reports `PLUGIN_CLEANUP_FAILED` if any cleanup fails, and settles once. New input is rejected once teardown starts. Engine cleanup is idempotent and is registered before asynchronous initialization starts, including initialization that fails or finishes after cancellation. The deadline stops new work and cancels pending operations; it does not promise instantaneous shutdown of an already dispatched external action or an unresponsive SDK cleanup.

## Agent engine boundary

`agent-runtime/protocol.ts` owns the existing version 1 host/worker contract. The old `pi-worker/protocol.ts` path re-exports it for compatibility. The deployed `pi-worker` package name also remains compatible. `WorkerSession` owns run identity, input delivery receipts, pending tool calls, the Rust-supplied deadline, cancellation and the final settlement event; it does not import the Pi SDK.

`engines/pi/` owns Pi's model runtime, resource loader, custom tool adaptation, SDK session, prompt/steer/follow-up operations and disposal. It disables Pi's workspace extension, skill, context and prompt-template discovery; Rust supplies the approved context and tool contracts. The plugin receives the tool and engine services through Cordis dependency injection. An engine identifier selects an already registered factory and is never resolved as a package or path. An omitted identifier selects `pi`; an unknown identifier fails instead of falling back.

The engine contract in `engines.ts` intentionally exposes a small version 1 compatibility event shape: user and assistant `message_start`, `message_update`, and `message_end`, text content, and the five usage counters already consumed by Rust. `engines/pi/events.ts` maps SDK events to that shape. It also preserves `tool_execution_end` with the real call ID, tool name, result, `isError`, duration and optional parent call ID so tool failures remain observable. Raw SDK diagnostics, reasoning and unrelated extra metadata are not forwarded as a supposed engine-neutral contract. Tool requests use the separate Rust-authorized bridge.

The production distribution still requires Pi. This change isolates that dependency behind a tested provider interface; it does not ship or claim compatibility with a second production engine. A synthetic test provider verifies replacement without importing any Pi SDK package. Adding another engine requires an explicit reviewed source import, registration, event/tool adaptation, cancellation and lifecycle tests; it is not enabled by merely adding a model provider or an npm dependency.

An engine plugin must register its factory through `ctx.workerEngines.register()` inside a Cordis effect, and register each session's idempotent `dispose()` through `ctx.pluginCleanup.onDispose()` before returning the session. `start()` may then acquire resources asynchronously. Cleanup must wait for in-flight initialization, cancel the engine's own work, and release everything it acquired even when abort fails. It must not dispose the root host or await host disposal from inside engine disposal, which would create a lifecycle cycle. The Pi plugin is the concrete implementation to follow.

## Add a reviewed bundled plugin

Choose the existing extension point that fits the contribution:

- **Workflow instructions:** use the reviewed skill editor or add a bilingual recipe to `mobile/assets/skills/{en,zh}.json`. Skills do not grant new tools, run package scripts or load a worker plugin.
- **MCP connectors:** add a documented provider to `shared/app-providers.json`, update both UI languages, and run `npm run sync:app-catalog`. The existing [MCP executor](../mcp-worker/README.md) and [connection service](../../../docs/app-connections.md) retain discovery, authorization and approvals.
- **Worker or engine behavior:** use the trusted source registry below. An engine example is not another production provider, and a plugin cannot grant itself Rust tool contracts.

Add a source module under the worker tree, import it explicitly in `bundled.ts`, and add its stable ID to `trustedBundledPlugins`. The host does not resolve plugin names to filesystem paths, scan user directories, load npm packages on demand, or execute workspace/model-supplied code. The optional registry argument used by host tests accepts trusted in-process plugin objects; it is not a wire or settings format.

Declare required services with Cordis `inject`. Register synchronous resources through `ctx.effect()` so Cordis removes them when the plugin unloads. For asynchronous resource teardown, use the injected cleanup service:

```ts
import type { Plugin } from '@cordisjs/core';
import type { WorkerPluginContext } from './context.js';

export const reviewedPlugin: Plugin.Object<WorkerPluginContext> = {
  name: 'reviewed-plugin',
  inject: ['pluginCleanup'],
  apply(ctx) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        /* local, non-sensitive housekeeping */
      }, 1000);
      timer.unref();
      return () => clearInterval(timer);
    });
    ctx.pluginCleanup.onDispose(ctx, async () => {
      // Await a plugin-owned SDK client's close() here, if needed.
    });
  },
};
```

Run the [complete standalone example](examples/minimal-plugin.fixture.ts) from the repository root after `npm ci`:

```sh
node --import tsx server/workers/plugin-runtime/examples/minimal-plugin.fixture.ts
```

It creates the real Cordis host with this example alone, rejects an ungranted tool, and disposes its timer and asynchronous cleanup. It prints `activeTimers: 0`, `cleanupCalls: 1` and `toolCalls: 0`. It needs no model, account, server, credentials or network service. The `.fixture.ts` file is test-only and is rejected by the release bundler if accidentally imported into a production worker. Put a reviewed implementation in a normal source module before registering it in `bundled.ts`.

Cordis 3.18.1 starts asynchronous native disposal callbacks without waiting for their results. `pluginCleanup.onDispose()` is the small adapter that lets the worker await those tasks and report a fixed error without writing plugin exception details to its stdout protocol. Use it for asynchronous teardown; use ordinary effects for synchronous listeners and timers. Missing required services or startup failures reject host creation. Tool registration rejects duplicates and names absent from the Rust run contract.

### Worker output boundary

Worker stdout belongs exclusively to the existing version 1 JSON frame writer. Do not call `process.stdout.write()` or create another stdout logger from a plugin, and never emit your own protocol frames. Before importing plugins or SDKs, the actual worker entry point routes the standard `console` methods to stderr, then dynamically imports the worker implementation. The release builder preserves this module boundary: `index.mjs` is the bootstrap, and its separate implementation chunk contains external dependencies. Both files are inventoried with hashes and byte sizes in `workers.json`. This includes external dependency initialization, plugin startup and cleanup diagnostics, so a normal `console.info()` cannot turn a valid task into a malformed-frame error.

The Rust supervisor discards stderr; arbitrary SDK diagnostics are not stored or shown in chat. A developer running the worker directly may see stderr, so never log credentials or private content. This routing is not secret redaction and is not isolation against trusted code deliberately writing to stdout or capturing another logger. The standalone example's final JSON summary is outside the worker protocol. Full-entry process tests cover external/import/startup/cleanup diagnostics, successful settlement, cancellation and the existing frame redaction in source and split-bundle modes. A separate release test runs the actual `buildWorkers()` output with an external dependency initializer that logs.

**This is not a security boundary for untrusted JavaScript.** A bundled plugin runs with the worker process's OS access and could import Node filesystem/network/process APIs. Review, distribution, OS process permissions and Rust authorization still matter. Cordis dependency injection does not provide filesystem, shell, network or per-plugin memory isolation. This host intentionally does not implement a third-party plugin marketplace or installer.

## Version and license evidence

Verified against the official published package, rather than the moving Cordis 4 prerelease documentation:

- [Published 3.18.1 package metadata](https://registry.npmjs.org/@cordisjs/core/3.18.1): MIT, the core package depends only on `cosmokit`.
- [Published 3.18.1 source archive](https://registry.npmjs.org/@cordisjs/core/-/core-3.18.1.tgz): inspected `src/scope.ts`, `src/events.ts`, `src/reflect.ts` and `lib/index.d.ts` for the actual lifecycle and injection contracts.
- [Official upstream MIT license](https://github.com/cordiverse/cordis/blob/main/LICENSE).

The `cordis` aggregate package includes CLI/loader/schema/logger/timer modules; they are unnecessary here. Published npm `latest` currently refers to a Cordis 4 release candidate. Keep the reviewed core version exact in the package lock. The npm core tarball declares MIT in its package metadata but does not contain a separate LICENSE file; include the upstream MIT notice when generating distributable dependency notices.

Run the dedicated lifecycle tests with the repository's supported Node runtime:

```sh
node --import tsx --test server/workers/plugin-runtime/*.test.ts server/workers/pi-worker/*.test.ts
```
