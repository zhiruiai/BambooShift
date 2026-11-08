import assert from 'node:assert/strict';

import { test } from 'node:test';

import { AppTransportError, parseAppEndpoint } from '../transport.js';

import { exampleTool, mcpFixture, until } from './transport.fixture.js';

test('transport checks the live grant at actual fetch dispatch and still closes a revoked MCP session', async (t) => {
  const fixture = await mcpFixture(t);
  let valid = true;
  const client = await fixture.factory(
    { url: 'https://fixture.example/mcp', token: fixture.state.token },
    new AbortController().signal,
    {
      authorize: async () => {
        if (!valid) throw new Error('Synthetic revoked before actual dispatch');
      },
    },
  );
  try {
    await client.tools();
    valid = false;
    await assert.rejects(client.call('create_note', { title: 'must never dispatch' }));
    assert.equal(fixture.state.calls, 0);
  } finally {
    await client.close();
  }
  assert.equal(fixture.state.deletes, 1);
});

test('live grant is rechecked after the actual MCP catalog response before tool dispatch', async (t) => {
  const fixture = await mcpFixture(t);
  let valid = true;
  const client = await fixture.factory(
    { url: 'https://fixture.example/mcp', token: fixture.state.token },
    new AbortController().signal,
    {
      authorize: async () => {
        if (!valid) throw Error('Synthetic grant revoked');
      },
    },
  );
  t.after(() => client.close());
  await client.tools();
  const selected = await client.tools();
  assert.deepEqual(selected, [exampleTool()]);
  valid = false;
  await assert.rejects(client.call('create_note', { title: 'must never dispatch' }));
  assert.equal(fixture.state.calls, 0);
  assert.equal(
    fixture.state.messages.filter((message) => message.method === 'tools/list').length,
    2,
  );
  await client.close();
  assert.equal(fixture.state.deletes, 1, 'cleanup is permitted after grant revocation');
});

test('app endpoints allow only credential-free public HTTPS on the default port', () => {
  assert.equal(parseAppEndpoint(' https://apps.example/mcp ').href, 'https://apps.example/mcp');
  for (const value of [
    undefined,
    {},
    '',
    'stdio:npx',
    'file:///etc/passwd',
    'http://apps.example/mcp',
    'https://apps.example:8443/mcp',
    'https://user:secret@apps.example/mcp',
    'https://apps.example/mcp?token=secret',
    'https://apps.example/mcp#secret',
    'https://localhost/mcp',
    'https://a.localhost/mcp',
    'https://127.0.0.1/mcp',
    'https://10.0.0.7/mcp',
    'https://169.254.169.254/mcp',
    'https://[::1]/mcp',
  ])
    assert.throws(() => parseAppEndpoint(value));
});

test('real MCP HTTP supports initialize, tools, JSON and SSE calls without duplicate calls', async (t) => {
  const fixture = await mcpFixture(t);
  const client = await fixture.factory(
    { url: 'https://fixture.example/mcp', token: fixture.state.token },
    new AbortController().signal,
  );
  t.after(() => client.close());
  assert.deepEqual(await client.tools(), [exampleTool()]);
  assert.deepEqual(await client.call('create_note', { title: '中文笔记' }), {
    isError: false,
    text: 'Created synthetic note.',
  });
  fixture.state.sse = true;
  fixture.state.result = { content: [{ type: 'text', text: '第二条笔记 🐷' }], isError: true };
  assert.deepEqual(await client.call('create_note', { title: '第二条' }), {
    isError: true,
    text: '第二条笔记 🐷',
  });
  assert.equal(fixture.state.calls, 2);
  assert(fixture.state.messages.some((message) => message.method === 'initialize'));
  assert(
    fixture.state.headers.every(
      (headers) => headers.authorization === `Bearer ${fixture.state.token}`,
    ),
  );
  await client.close();
  assert.equal(
    fixture.state.deletes,
    1,
    'normal close releases only the SDK-created remote session',
  );
  await assert.rejects(client.call('create_note', { title: 'after close' }));
  assert.equal(fixture.state.calls, 2);
});

test('real MCP HTTP rejects redirects and authentication errors without replay or secrets', async (t) => {
  const fixture = await mcpFixture(t);
  fixture.state.redirect = `${fixture.origin}/redirect-destination`;
  await assert.rejects(
    fixture.factory(
      { url: 'https://fixture.example/mcp', token: fixture.state.token },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof AppTransportError &&
      error.kind === 'blocked' &&
      !error.message.includes(fixture.state.token),
  );
  assert.equal(fixture.state.headers.length, 1, 'redirect must not be followed');
  fixture.state.redirect = '';
  fixture.state.authStatus = 401;
  await assert.rejects(
    fixture.factory(
      { url: 'https://fixture.example/mcp', token: fixture.state.token },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof AppTransportError &&
      error.kind === 'auth' &&
      !error.message.includes(fixture.state.token),
  );
  assert.equal(fixture.state.headers.length, 2, 'auth errors must not automatically retry');
  assert.equal(fixture.state.calls, 0);
});

test('real MCP HTTP aborts an in-flight call and does not retry it', async (t) => {
  const fixture = await mcpFixture(t);
  const abort = new AbortController();
  const client = await fixture.factory(
    { url: 'https://fixture.example/mcp', token: fixture.state.token },
    abort.signal,
  );
  t.after(() => client.close());
  fixture.state.holdCall = true;
  const result = client.call('create_note', { title: 'cancelled synthetic call' });
  const rejected = assert.rejects(result);
  await until(() => fixture.state.calls === 1, 'fixture must actually receive the call');
  abort.abort();
  await rejected;
  await client.close();
  await until(() => fixture.state.abortedCalls === 1, 'local request stream must be closed');
  assert.equal(fixture.state.calls, 1);
});

test('real MCP HTTP bounds chunked response bytes and catalog size', async (t) => {
  const fixture = await mcpFixture(t);
  const client = await fixture.factory(
    { url: 'https://fixture.example/mcp', token: fixture.state.token },
    new AbortController().signal,
  );
  t.after(() => client.close());
  fixture.state.oversized = true;
  await assert.rejects(client.call('create_note', { title: 'oversized' }));
  assert.equal(fixture.state.calls, 1);
  await client.close();
  fixture.state.tools = Array.from({ length: 65 }, (_, index) => ({
    ...exampleTool(),
    name: `tool_${index}`,
  }));
  const catalogClient = await fixture.factory(
    { url: 'https://fixture.example/mcp', token: fixture.state.token },
    new AbortController().signal,
  );
  t.after(() => catalogClient.close());
  await assert.rejects(
    catalogClient.tools(),
    (error: unknown) => error instanceof AppTransportError && error.kind === 'protocol',
  );
});

test('MCP tools cannot invoke sampling or cause linked and binary content to be fetched', async (t) => {
  const fixture = await mcpFixture(t);
  const client = await fixture.factory(
    { url: 'https://fixture.example/mcp', token: fixture.state.token },
    new AbortController().signal,
  );
  t.after(() => client.close());
  fixture.state.sse = true;
  fixture.state.reverseRequest = true;
  fixture.state.result = {
    content: [
      { type: 'resource_link', name: 'untrusted local link', uri: 'http://127.0.0.1/private' },
      { type: 'image', mimeType: 'image/png', data: 'c3ludGhldGljLWJpbmFyeQ==' },
      { type: 'text', text: 'ordinary tool text' },
    ],
  };
  const result = await client.call('create_note', {});
  assert.match(result.text, /ordinary tool text/);
  assert(!result.text.includes('127.0.0.1/private'));
  assert(!result.text.includes('c3ludGhldGlj'));
  await until(
    () => fixture.state.reverseResponses.length === 1,
    'unsupported sampling must receive a protocol rejection',
  );
  const rejection = fixture.state.reverseResponses[0] as { id: string; error?: { code: number } };
  assert.equal(rejection.id, 'untrusted-sampling-request');
  assert.equal(rejection.error?.code, -32601);
  assert.equal(fixture.state.calls, 1);
  const initialize = fixture.state.messages.find((message) => message.method === 'initialize');
  assert.deepEqual(initialize?.params?.capabilities, {});
});
