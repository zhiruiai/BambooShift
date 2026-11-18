import { webcrypto } from 'node:crypto';
import { compile, json } from './appsFixture';

export const policyOptions = {
  connectionId: 'connection-a',
  connectionRevision: 'connection-r1',
  catalogRevision: 'catalog-r1',
  routines: [
    {
      id: 'routine-a',
      title: 'Read notes',
      revision: 'routine-r1',
      schedule: 'daily:09:00',
      timeZone: 'Asia/Shanghai',
    },
  ],
  tools: [
    {
      tool: {
        name: 'read_notes',
        description: 'Read notes only',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        annotations: { readOnlyHint: true },
      },
      revision: 'tool-r1',
      eligible: true,
    },
    {
      tool: { name: 'write_note', description: 'Write notes', inputSchema: { type: 'object' } },
      revision: 'write-r1',
      eligible: false,
    },
  ],
};
export const exactRead = {
  routineId: 'routine-a',
  toolName: 'read_notes',
  arguments: { query: 'newer_than:1d' },
  confirmed: true,
};
export function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
export function environment(storage = memory(), language = 'en') {
  return {
    crypto: webcrypto,
    TextEncoder,
    Event,
    window: Object.assign(new EventTarget(), {
      sessionStorage: storage,
      localStorage: { getItem: () => JSON.stringify({ version: 1, locale: language }) },
      location: { pathname: '/workspace-a' },
    }),
  };
}
export function receipt(id: string) {
  return {
    id,
    issuerUserId: 'owner-a',
    routineId: 'routine-a',
    routineTitle: 'Read notes',
    routineRevision: 'routine-r1',
    connectionId: 'connection-a',
    connectionRevision: 'connection-r1',
    toolName: 'read_notes',
    toolRevision: 'tool-r1',
    arguments: exactRead.arguments,
    status: 'active',
    createdAt: '2026-11-07T00:00:00Z',
  };
}
export async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((done) => setImmediate(done));
}
export async function clientFixture(transport: typeof fetch, storage = memory()) {
  let identity = { userId: 'owner-a', workspaceId: 'workspace-a', canManage: true };
  const globals = environment(storage);
  const module = await compile('web/src/appPolicies.ts', '', globals);
  const client = module.createAppPolicies({
    ...identity,
    connectionId: 'connection-a',
    identity: () => identity,
    onState() {},
    fetch: transport,
    storage,
  });
  client.resume();
  await settle();
  return {
    client,
    storage,
    globals,
    identity: (next: Partial<typeof identity>) => {
      identity = { ...identity, ...next };
    },
  };
}
export const choices = (url: unknown) =>
  json(String(url).endsWith('/options') ? policyOptions : []);
