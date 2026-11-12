import type { Plugin } from '@cordisjs/core';
import type { WorkerPluginContext } from './context.js';
import { piEnginePlugin } from '../engines/pi/plugin.js';

export type TrustedBundledPlugin = {
  id: string;
  plugin: Plugin.Object<WorkerPluginContext>;
};

export const rustToolBridgePlugin: Plugin.Object<WorkerPluginContext> = {
  name: 'bambooshift-rust-tool-bridge',
  inject: ['rustBridge', 'workerTools'],
  apply(ctx) {
    for (const tool of ctx.rustBridge.definitions()) {
      ctx.effect(() =>
        ctx.workerTools.register(tool.name, (callId, args, signal) =>
          ctx.rustBridge.invoke(callId, tool.name, args, signal),
        ),
      );
    }
  },
};

// Add reviewed source imports here. No workspace, model or configuration string is an import path.
export const trustedBundledPlugins: readonly TrustedBundledPlugin[] = Object.freeze([
  { id: 'rust-tool-bridge', plugin: rustToolBridgePlugin },
  { id: 'pi-engine', plugin: piEnginePlugin },
]);
