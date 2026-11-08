import { createInterface } from 'node:readline';
import { createAppOAuthProvider, AppOAuthProviderError } from './oauth-provider.js';
import { isSlackHost, slack } from './slack-oauth.js';
import { openAppClient, AppTransportError } from './transport.js';

// The Rust parent owns identity, persistence, secrets, approvals and cancellation.
// This process accepts one bounded protocol operation and no ambient configuration.
const MAX = 2 * 1024 * 1024;
const lifetime = new AbortController();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let started = false;
let sequence = 0;
const gates = new Map<number, { resolve(): void; reject(error: Error): void }>();
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const authorize = () =>
  new Promise<void>((resolve, reject) => {
    lifetime.signal.throwIfAborted();
    const id = ++sequence;
    gates.set(id, { resolve, reject });
    send({ type: 'authorize', id });
  });
const stop = () => {
  lifetime.abort();
  for (const gate of gates.values()) gate.reject(new Error('cancelled'));
  gates.clear();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
input.on('close', stop);
input.on('line', (line) => {
  if (Buffer.byteLength(line) > MAX) {
    stop();
    return;
  }
  let value: any;
  try {
    value = JSON.parse(line);
  } catch {
    stop();
    return;
  }
  if (value.type === 'authorization') {
    const gate = gates.get(value.id);
    gates.delete(value.id);
    if (value.allowed === true) gate?.resolve();
    else gate?.reject(new Error('authorization revoked'));
    return;
  }
  if (started || value.type !== 'operation') {
    stop();
    return;
  }
  started = true;
  void execute(value)
    .then(
      (result) => send({ type: 'result', ok: true, result }),
      (error) =>
        send({
          type: 'result',
          ok: false,
          kind:
            error instanceof AppTransportError || error instanceof AppOAuthProviderError
              ? error.kind
              : 'protocol',
        }),
    )
    .finally(() => {
      input.close();
      process.stdin.destroy();
    });
});

async function execute(request: any) {
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(45000)]);
  const provider = createAppOAuthProvider({
    testOrigins: request.testOrigins,
    authorize,
    publicOrigin: request.publicOrigin,
  });
  if (request.op === 'prepare') return provider.prepare(request.input, signal);
  if (request.op === 'exchange') return provider.exchange(request.prepared, request.code, signal);
  if (request.op === 'refresh') return provider.refresh(request.grant, signal);
  if (request.op === 'revoke') return provider.revoke(request.grant, signal);
  if (!['tools', 'call'].includes(request.op)) throw new Error('unknown operation');
  const client = await openAppClient(request.endpoint, signal, {
    authorize,
    publicOrigin: request.publicOrigin,
    testOrigin: request.testOrigins?.find(
      (origin: string) => origin === new URL(request.endpoint.url).origin,
    ),
  });
  try {
    const discovered = await client.tools();
    const tools = isSlackHost(request.endpoint.url)
      ? discovered.filter((tool) => slack.tools.includes(tool.name))
      : discovered;
    if (!tools.length && isSlackHost(request.endpoint.url))
      throw new AppTransportError('protocol', 'Slack read-only tools are unavailable');
    if (request.op === 'tools') return tools;
    const fresh = tools.find((tool) => tool.name === request.tool.name);
    // Compare the complete approved catalog entry before sending any tool call.
    const deepEqual = (a: any, b: any): boolean => {
      if (a === b) return true;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      const keys = Object.keys(a);
      return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
      );
    };
    if (!deepEqual(fresh, request.tool)) throw new Error('catalog changed');
    if (request.expectedCatalog && !deepEqual(tools, request.expectedCatalog))
      throw new Error('catalog changed');
    await authorize();
    return await client.call(request.tool.name, request.arguments);
  } finally {
    await client.close();
  }
}
