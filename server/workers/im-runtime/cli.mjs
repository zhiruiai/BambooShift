import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrivateConfig } from './config.mjs';
import { openLedger } from './ledger.mjs';
import { createBridge } from './bridge.mjs';
import { createBambooShiftClient } from './bambooshift.mjs';
import { createSdkAdapter } from './sdk-adapters.mjs';
import { shieldSdkConsole } from './diagnostics.mjs';

export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  const check = args[0] === '--check';
  if (check) args = args.slice(1);
  if (args.length !== 2 || args[0] !== '--config')
    throw Error('Usage: node cli.mjs --config /private/im.json');
  const file = resolve(args[1]),
    config = await readPrivateConfig(file);
  if (check) {
    process.stdout.write(
      JSON.stringify({
        valid: true,
        accounts: config.accounts.length,
        bindings: config.accounts.reduce((n, a) => n + a.bindings.length, 0),
        externalConnectionsStarted: false,
      }) + '\n',
    );
    return;
  }
  const controller = new AbortController(),
    adapters = new Map();
  const ledger = openLedger(join(dirname(file), 'im-state'));
  const report = (result) => process.stdout.write(JSON.stringify(result) + '\n');
  const restoreConsole = shieldSdkConsole(report);
  const client = createBambooShiftClient(config.origin);
  const bridge = createBridge({
    config,
    ledger,
    ...client,
    signal: controller.signal,
    report,
    reply: (event, text, signal) => adapters.get(event.accountId).reply(event, text, signal),
  });
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    // Validate every explicit aihubot identity before opening an external transport.
    for (const account of config.accounts)
      for (const binding of account.bindings) await client.authorize(binding, controller.signal);
    for (const account of config.accounts) {
      controller.signal.throwIfAborted();
      const adapter = await createSdkAdapter(account, bridge.accept, { report });
      adapters.set(account.id, adapter);
      await adapter.start();
      report({ accountId: account.id, status: 'started' });
    }
    if (!controller.signal.aborted)
      await new Promise((done) =>
        controller.signal.addEventListener('abort', done, { once: true }),
      );
  } finally {
    controller.abort();
    await Promise.allSettled([...adapters.values()].map((adapter) => adapter.close()));
    await bridge.drain();
    ledger.close();
    restoreConsole();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write(
      'IM connector stopped. Check private configuration, session access, and SDK installation.\n',
    );
    process.exitCode = 1;
  });
