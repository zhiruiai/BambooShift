import { Context, type ForkScope, type Plugin } from '@cordisjs/core';
import type { ToolSpec } from '../agent-runtime/protocol.js';
import { WorkerPluginContext } from './context.js';
import {
  PluginCleanup,
  RustToolBridge,
  WorkerToolRegistry,
  type RustToolRequest,
} from './services.js';
import { trustedBundledPlugins, type TrustedBundledPlugin } from './bundled.js';
import { WorkerEngineRegistry, type EngineOptions, type EngineSession } from './engines.js';

export type PluginHostOptions = {
  tools: readonly ToolSpec[];
  requestTool: RustToolRequest;
  signal: AbortSignal;
};
type Services = {
  bridge: RustToolBridge;
  tools: WorkerToolRegistry;
  cleanup: PluginCleanup;
  engines: WorkerEngineRegistry;
};
const servicesPlugin: Plugin.Object<WorkerPluginContext, Services> = {
  name: 'bambooshift-worker-services',
  apply(ctx, services) {
    ctx.set('rustBridge', services.bridge);
    ctx.set('workerTools', services.tools);
    ctx.set('pluginCleanup', services.cleanup);
    ctx.set('workerEngines', services.engines);
  },
};

/** Runs only trusted, statically imported code in the existing disposable worker process. */
export class WorkerPluginHost {
  private readonly ctx = new WorkerPluginContext();
  private readonly cancellation = new AbortController();
  private readonly cleanup = new PluginCleanup();
  private readonly engines = new WorkerEngineRegistry();
  private readonly bridge: RustToolBridge;
  private readonly tools: WorkerToolRegistry;
  private readonly allowed = new Map<string, TrustedBundledPlugin>();
  private readonly loaded = new Map<string, ForkScope<WorkerPluginContext>>();
  private stopping?: Promise<void>;
  private closed = false;
  private started = false;
  private failures = 0;
  private readonly onAbort = () => {
    void this.dispose().catch(() => {});
  };

  constructor(
    private readonly options: PluginHostOptions,
    bundled: readonly TrustedBundledPlugin[],
  ) {
    const signal = AbortSignal.any([options.signal, this.cancellation.signal]);
    this.bridge = new RustToolBridge(options.tools, options.requestTool, signal);
    this.tools = new WorkerToolRegistry(this.bridge, signal);
    for (const entry of bundled) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) || this.allowed.has(entry.id))
        throw Error('Invalid bundled plugin registry.');
      this.allowed.set(entry.id, entry);
    }
    // Cordis' default diagnostics use stdout, which belongs exclusively to our framed protocol.
    // Keep silent handlers through root disposal (the same static hook mechanism as Cordis core).
    for (const level of ['info', 'warning', 'error'] as const) {
      const release = this.ctx.on(`internal/${level}`, () => {
        if (level === 'error') this.failures++;
      });
      Object.defineProperty(release, Context.static, { value: this.ctx.scope });
    }
    this.ctx.plugin(servicesPlugin, {
      bridge: this.bridge,
      tools: this.tools,
      cleanup: this.cleanup,
      engines: this.engines,
    });
  }

  async start(): Promise<void> {
    if (this.started) throw Error('Plugin host has already started.');
    this.started = true;
    if (this.closed || this.options.signal.aborted) {
      await this.dispose();
      throw Error('Plugin host is closed.');
    }
    this.options.signal.addEventListener('abort', this.onAbort, { once: true });
    try {
      for (const entry of this.allowed.values())
        this.loaded.set(entry.id, this.ctx.plugin(entry.plugin));
      await this.ctx.start();
      if (
        this.closed ||
        this.failures ||
        [...this.loaded.values()].some(
          (fork) => !fork.ready || !fork.isActive || fork.runtime.error,
        )
      ) {
        throw Error('Bundled plugin failed to start.');
      }
    } catch {
      await this.dispose().catch(() => {});
      throw Error('Bundled plugin failed to start.');
    }
  }
  definitions(): ToolSpec[] {
    const names = new Set(this.tools.names());
    return this.bridge.definitions().filter((tool) => names.has(tool.name));
  }
  invoke(name: string, toolCallId: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.tools.invoke(name, toolCallId, args, signal);
  }
  createEngine(id: string, options: EngineOptions): EngineSession {
    if (!this.started || this.closed) throw Error('Plugin host is unavailable.');
    return this.engines.create(id, options);
  }
  async unload(id: string): Promise<void> {
    if (!this.allowed.has(id)) throw Error('Unknown bundled plugin.');
    const fork = this.loaded.get(id);
    if (!fork) return;
    this.loaded.delete(id);
    fork.dispose();
    await this.cleanup.drain();
    if (this.failures) throw Error('Plugin cleanup failed.');
  }
  dispose(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.cancellation.abort();
    this.tools.close();
    this.engines.close();
    this.options.signal.removeEventListener('abort', this.onAbort);
    this.stopping = (async () => {
      try {
        await this.ctx.stop();
      } catch {
        this.failures++;
      } finally {
        this.loaded.clear();
        await this.cleanup.drain();
      }
      if (this.failures) throw Error('Plugin cleanup failed.');
    })();
    return this.stopping;
  }
}

export async function createPluginHost(
  options: PluginHostOptions,
  bundled = trustedBundledPlugins,
): Promise<WorkerPluginHost> {
  const host = new WorkerPluginHost(options, bundled);
  await host.start();
  return host;
}
