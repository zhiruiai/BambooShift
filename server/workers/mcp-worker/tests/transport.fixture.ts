import assert from 'node:assert/strict';

import { once } from 'node:events';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { type TestContext } from 'node:test';

import type { ConnectedAppTool } from '../../../../shared/app-connections.js';

import { openAppClient, type AppClientFactory } from '../transport.js';

const exampleTool = (): ConnectedAppTool => ({
  name: 'create_note',
  description: 'Create a synthetic note for the connection test.',
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  },
});

type RpcMessage = {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, any>;
};

/** An actual local MCP endpoint. No product server, real credentials, or remote service. */
async function mcpFixture(t: TestContext) {
  const state = {
    token: 'synthetic-fixture-credential',
    authStatus: 0,
    redirect: '',
    tools: [exampleTool()],
    nextCursor: undefined as string | undefined,
    result: { content: [{ type: 'text', text: 'Created synthetic note.' }], isError: false } as any,
    sse: false,
    oversized: false,
    holdCall: false,
    messages: [] as RpcMessage[],
    headers: [] as IncomingMessage['headers'][],
    callResponses: [] as ServerResponse[],
    reverseRequest: false,
    reverseResponses: [] as Record<string, unknown>[],
    calls: 0,
    deletes: 0,
    abortedCalls: 0,
  };
  const server = createServer(async (req, res) => {
    try {
      state.headers.push(req.headers);
      if (req.url !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      if (state.redirect) {
        res.writeHead(307, { location: state.redirect }).end();
        return;
      }
      if (state.authStatus || req.headers.authorization !== `Bearer ${state.token}`) {
        res.writeHead(state.authStatus || 401, { 'content-type': 'text/plain' });
        res.end(`Private upstream error must not escape: ${state.token}`);
        return;
      }
      if (req.method === 'DELETE') {
        state.deletes++;
        res.writeHead(200).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcMessage;
      if (!message.method) {
        state.reverseResponses.push(message as unknown as Record<string, unknown>);
        res.writeHead(202).end();
        return;
      }
      state.messages.push(message);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const send = (result: unknown, error?: unknown) => {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          ...(error ? { error } : { result }),
        });
        res.setHeader('Mcp-Session-Id', 'synthetic-session');
        if (state.sse && message.method === 'tools/call') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          if (state.reverseRequest)
            res.write(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: '2.0',
                id: 'untrusted-sampling-request',
                method: 'sampling/createMessage',
                params: {
                  messages: [
                    { role: 'user', content: { type: 'text', text: 'must never invoke a model' } },
                  ],
                  maxTokens: 8,
                },
              })}\n\n`,
            );
          res.end(`event: message\ndata: ${body}\n\n`);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(body);
        }
      };
      switch (message.method) {
        case 'initialize':
          send({
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'openbot-owned-http-fixture', version: '1.0.0' },
          });
          return;
        case 'tools/list':
          send({
            tools: state.tools,
            ...(state.nextCursor ? { nextCursor: state.nextCursor } : {}),
          });
          return;
        case 'tools/call':
          state.calls++;
          if (state.holdCall) {
            state.callResponses.push(res);
            res.once('close', () => state.abortedCalls++);
            return;
          }
          if (state.oversized) {
            res.writeHead(200, { 'content-type': 'application/json' });
            // Chunked rather than Content-Length: the body bound itself must work.
            res.write('{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"');
            res.end('x'.repeat(1024 * 1024 + 128));
            return;
          }
          send(state.result);
          return;
        default:
          send(undefined, { code: -32601, message: 'Method not found' });
      }
    } catch {
      if (!res.destroyed) res.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    for (const response of state.callResponses) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const factory: AppClientFactory = (endpoint, signal, options) =>
    openAppClient({ ...endpoint, url: `${origin}/mcp` }, signal, {
      ...options,
      testOrigin: origin,
    });
  return { state, origin, factory };
}

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export { mcpFixture, exampleTool, until };
