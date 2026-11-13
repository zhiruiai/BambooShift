import type { TrustedBundledPlugin } from '../plugin-runtime/bundled.js';

const syntheticSecret = 'SYNTHETIC_PLUGIN_SECRET_NOT_REAL';
console.info('synthetic-console-import', syntheticSecret);

/** Test-only static registry; no provider SDK, model or external tool is called. */
export const trustedBundledPlugins: readonly TrustedBundledPlugin[] = [
  {
    id: 'synthetic-console-engine',
    plugin: {
      inject: ['workerEngines', 'pluginCleanup'],
      apply(ctx) {
        console.log('synthetic-console-apply', syntheticSecret);
        ctx.effect(() =>
          ctx.workerEngines.register('synthetic', (options) => {
            let stopping: Promise<void> | undefined;
            const session = {
              async start() {},
              async prompt() {
                if (options.run.prompt === 'Wait for cancellation.') {
                  await new Promise<void>((_resolve, reject) => {
                    if (options.signal.aborted) return reject(Error('Synthetic cancellation'));
                    options.signal.addEventListener(
                      'abort',
                      () => reject(Error('Synthetic cancellation')),
                      { once: true },
                    );
                  });
                  return;
                }
                options.onEvent({
                  type: 'message_end',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: `Synthetic answer ${syntheticSecret}` }],
                  },
                });
              },
              async steer() {},
              async followUp() {},
              async abort() {},
              dispose() {
                return (stopping ??= Promise.resolve().then(() => {
                  console.warn('synthetic-console-cleanup', syntheticSecret);
                }));
              },
            };
            ctx.pluginCleanup.onDispose(ctx, () => session.dispose());
            return session;
          }),
        );
      },
    },
  },
];
