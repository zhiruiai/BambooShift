import assert from 'node:assert/strict';

import { once } from 'node:events';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { type TestContext } from 'node:test';

import type { ConnectedAppTool } from '../../../../shared/app-connections.js';

import { openAppClient, type AppClientFactory } from '../../../../server/workers/mcp-worker/transport.js';

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

const modernVersion = '2026-07-28';

function modernTool(): ConnectedAppTool {
  return {
    ...exampleTool(),
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', 'x-mcp-header': 'Title' } },
      required: ['title'],
      additionalProperties: false,
    },
  };
}

function modernRequestMatches(headers: IncomingMessage['headers'], message: RpcMessage) {
  const meta = message.params?._meta;
  const title = message.params?.arguments?.title;
  const expectedTitle =
    typeof title === 'string' ? `=?base64?${Buffer.from(title).toString('base64')}?=` : undefined;
  return Boolean(
    message.jsonrpc === '2.0' &&
    message.id !== undefined &&
    headers.accept?.includes('application/json') &&
    headers.accept.includes('text/event-stream') &&
    headers['mcp-protocol-version'] === modernVersion &&
    headers['mcp-method'] === message.method &&
    headers['mcp-session-id'] === undefined &&
    meta?.['io.modelcontextprotocol/protocolVersion'] === modernVersion &&
    meta['io.modelcontextprotocol/clientInfo']?.name === 'openbot' &&
    (message.method !== 'tools/call' ||
      (headers['mcp-name'] === message.params?.name &&
        headers['mcp-param-title'] === expectedTitle)),
  );
}

/** An actual local MCP endpoint. No product server, real credentials, or remote service. */
async function mcpFixture(t: TestContext, modern = false) {
  const state = {
    token: 'synthetic-fixture-credential',
    authStatus: 0,
    redirect: '',
    tools: [modern ? modernTool() : exampleTool()],
    nextCursor: undefined as string | undefined,
    result: { content: [{ type: 'text', text: 'Created synthetic note.' }], isError: false } as any,
    sse: false,
    oversized: false,
    holdCall: false,
    messages: [] as RpcMessage[],
    headers: [] as IncomingMessage['headers'][],
    methods: [] as (string | undefined)[],
    callResponses: [] as ServerResponse[],
    reverseRequest: false,
    reverseResponses: [] as Record<string, unknown>[],
    calls: 0,
    deletes: 0,
    abortedCalls: 0,
    toolError: undefined as { code: number; message: string } | undefined,
  };
  const server = createServer(async (req, res) => {
    try {
      state.headers.push(req.headers);
      state.methods.push(req.method);
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
        res.writeHead(modern ? 405 : 200).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcMessage;
      if (modern && !modernRequestMatches(req.headers, message)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id ?? null,
            error: { code: -32020, message: 'Modern request metadata or headers did not match' },
          }),
        );
        return;
      }
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
      const send = (result: unknown, error?: unknown, status = 200) => {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          ...(error
            ? { error }
            : {
                result: modern
                  ? {
                      resultType: 'complete',
                      _meta: {
                        'io.modelcontextprotocol/serverInfo': {
                          name: 'modern-fixture',
                          version: '1.0.0',
                        },
                      },
                      ...(result as Record<string, unknown>),
                    }
                  : result,
              }),
        });
        if (!modern) res.setHeader('Mcp-Session-Id', 'synthetic-session');
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
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body);
        }
      };
      switch (message.method) {
        case 'server/discover':
          if (modern) {
            send({
              supportedVersions: [modernVersion],
              capabilities: { tools: {} },
              ttlMs: 0,
              cacheScope: 'private',
            });
            return;
          }
          break;
        case 'initialize':
          if (modern) break;
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
            ...(modern ? { ttlMs: 0, cacheScope: 'private' } : {}),
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
          send(state.result, state.toolError, state.toolError ? 400 : 200);
          return;
      }
      send(undefined, { code: -32601, message: 'Method not found' });
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
export { mcpFixture, exampleTool, modernTool, until };
