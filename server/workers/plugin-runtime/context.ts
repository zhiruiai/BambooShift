import type { PluginCleanup, RustToolBridge, WorkerToolRegistry } from './services.js';
import type { WorkerEngineRegistry } from './engines.js';

declare module '@cordisjs/core' {
  interface Context {
    rustBridge: RustToolBridge;
    workerTools: WorkerToolRegistry;
    pluginCleanup: PluginCleanup;
    workerEngines: WorkerEngineRegistry;
  }
}
export { Context as WorkerPluginContext } from '@cordisjs/core';
