import type { Plugin } from '@cordisjs/core';
import type { WorkerPluginContext } from '../../plugin-runtime/context.js';
import { PiEngineSession } from './session.js';

/** The only production engine provider, statically bundled and reviewed with the application. */
export const piEnginePlugin: Plugin.Object<WorkerPluginContext> = {
  name: 'bambooshift-pi-engine',
  inject: ['workerEngines', 'rustBridge', 'workerTools', 'pluginCleanup'],
  apply(ctx) {
    ctx.effect(() =>
      ctx.workerEngines.register('pi', (options) => {
        const session = new PiEngineSession(options, ctx.rustBridge, ctx.workerTools);
        // Register before any asynchronous initialization can acquire resources or fail.
        ctx.pluginCleanup.onDispose(ctx, () => session.dispose());
        return session;
      }),
    );
  },
};
