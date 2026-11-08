import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { checkOperationsBoundary, packageOrigins } from './backend-package-boundaries.mjs';

const account = {
  cookie: 'openbot_account=synthetic-account-session',
  workspace: 'synthetic-workspace',
  email: 'synthetic-user@example.test',
  password: 'synthetic-password-42',
};

async function fixture(fault = '') {
  const calls = [];
  const servers = ['product', 'operations'].map((kind) =>
    createServer(async (request, response) => {
      let raw = '';
      for await (const part of request) raw += part;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({
        kind,
        method: request.method,
        path: request.url,
        headers: request.headers,
        body,
      });
      const json = (status, value) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.url === '/' && kind === 'operations') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(
          `<html><meta name="openbot-application" content="${fault === 'wrong-ui' ? 'product' : 'operations'}"><div id="root"></div></html>`,
        );
      } else if (kind === 'product') {
        json(fault === 'product-route' ? 200 : 404, { error: 'Synthetic missing route' });
      } else if (request.url === '/api/health') {
        json(200, { ok: true, backend: 'rust' });
      } else if (request.url === '/api/platform/session') {
        const authenticated =
          (fault === 'account-cookie' && request.headers.cookie === account.cookie) ||
          (fault === 'renamed-cookie' &&
            request.headers.cookie === account.cookie.replace('account=', 'operator='));
        json(200, {
          authenticated,
          setupRequired: fault !== 'setup-consumed',
          ...(authenticated ? { user: { id: 'synthetic-user' } } : {}),
        });
      } else if (request.url === '/api/platform/login') {
        json(fault === 'ordinary-login' ? 200 : 401, { authenticated: false });
      } else if (request.url.startsWith('/api/platform/')) {
        json(fault === 'public-directory' ? 200 : 401, { error: 'Synthetic login required' });
      } else {
        json(fault === 'operations-route' ? 200 : 404, { error: 'Synthetic missing route' });
      }
    }),
  );
  for (const server of servers) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  return {
    origins: packageOrigins({
      address: `127.0.0.1:${servers[0].address().port}`,
      operationsAddress: `127.0.0.1:${servers[1].address().port}`,
    }),
    calls,
    close: async () => {
      await Promise.all(
        servers.map(async (server) => {
          server.closeAllConnections();
          await new Promise((done) => server.close(done));
        }),
      );
    },
  };
}

test('package readiness requires two distinct actual loopback listener ports', () => {
  assert.deepEqual(
    packageOrigins({ address: '127.0.0.1:3001', operationsAddress: '127.0.0.1:3002' }),
    { product: 'http://127.0.0.1:3001', operations: 'http://127.0.0.1:3002' },
  );
  for (const operationsAddress of [
    undefined,
    '127.0.0.1:3001',
    '127.0.0.1:0',
    'example.test:3002',
    '127.0.0.1:3002/admin',
    '127.0.0.1:3002?origin=synthetic',
  ])
    assert.throws(() => packageOrigins({ address: '127.0.0.1:3001', operationsAddress }));
});

test('the reusable package boundary check exercises separate HTTP servers without consuming setup', async () => {
  const server = await fixture();
  try {
    const result = await checkOperationsBoundary(server.origins, account);
    assert.ok(Object.values(result).every((value) => value === true));
    assert.equal(
      server.calls.some((call) => call.path === '/api/platform/setup'),
      false,
    );
    const login = server.calls.find(
      (call) => call.kind === 'operations' && call.path === '/api/platform/login',
    );
    assert.deepEqual(login.body, { email: account.email, password: account.password });
    assert.equal(login.headers.origin, server.origins.operations);
    assert.equal(login.headers.cookie, account.cookie);
    assert.ok(
      server.calls.some(
        (call) =>
          call.kind === 'operations' &&
          call.path === '/api/platform/session' &&
          call.headers.cookie === 'openbot_operator=synthetic-account-session',
      ),
    );
  } finally {
    await server.close();
  }
});

test('the package check rejects a mixed listener, ordinary-account privilege, or wrong operations UI', async (t) => {
  for (const fault of [
    'product-route',
    'operations-route',
    'account-cookie',
    'renamed-cookie',
    'ordinary-login',
    'public-directory',
    'setup-consumed',
    'wrong-ui',
  ])
    await t.test(fault, async () => {
      const server = await fixture(fault);
      try {
        await assert.rejects(checkOperationsBoundary(server.origins, account), {
          name: 'AssertionError',
        });
      } finally {
        await server.close();
      }
    });
});
