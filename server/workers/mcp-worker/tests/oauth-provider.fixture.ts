import { validateAuthorizationResponseIssuer } from '@modelcontextprotocol/client';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { type TestContext } from 'node:test';
import {
  AppOAuthProviderError,
  createAppOAuthProvider,
  type OAuthPrepared,
} from '../oauth-provider.js';

const signal = () => new AbortController().signal;

const state = () => randomBytes(32).toString('base64url');

const callback = 'http://127.0.0.1:3001/api/app-oauth/callback';

/** Actual local OAuth AS/RS: validates PKCE, code replay, refresh rotation and revocation. */
async function providerFixture(t: TestContext) {
  let origin = '';
  const fixture = {
    calls: [] as Array<{ path: string; method: string; authorization?: string; body: string }>,
    metadata: {} as Record<string, any>,
    resourceMetadata: {} as Record<string, any>,
    challenge: true,
    noResourceMetadata: false,
    malformedResource: false,
    redirectPath: '',
    redirectTo: '',
    hugePath: '',
    holdPath: '',
    holding: [] as ServerResponse[],
    aborts: 0,
    tokenType: 'Bearer',
    invalidGrant: false,
    omitRefreshAndScope: false,
    registered: new Map<string, Record<string, any>>(),
    codes: new Map<
      string,
      { clientId: string; challenge: string; redirect: string; scope: string; used: boolean }
    >(),
    refreshes: new Set<string>(),
    revoked: [] as string[],
    revocationStatus: 200,
    issued: 0,
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', origin);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      fixture.calls.push({
        path: url.pathname,
        method: req.method || 'GET',
        authorization: req.headers.authorization,
        body,
      });
      const json = (status: number, data: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (url.pathname === fixture.redirectPath) {
        res.writeHead(307, { location: fixture.redirectTo }).end();
        return;
      }
      if (url.pathname === fixture.hugePath) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"message":"');
        res.end('x'.repeat(1024 * 1024 + 1));
        return;
      }
      if (url.pathname === fixture.holdPath) {
        fixture.holding.push(res);
        res.once('close', () => fixture.aborts++);
        return;
      }
      if (url.pathname === '/mcp') {
        res
          .writeHead(
            401,
            fixture.challenge
              ? {
                  'www-authenticate': `Bearer resource_metadata="${origin}/resource", scope="notes.read notes.write"`,
                }
              : {},
          )
          .end();
        return;
      }
      if (
        url.pathname === '/resource' ||
        url.pathname.startsWith('/.well-known/oauth-protected-resource')
      ) {
        if (fixture.noResourceMetadata) {
          json(404, {});
          return;
        }
        if (fixture.malformedResource) {
          json(200, { resource: 42 });
          return;
        }
        json(200, fixture.resourceMetadata);
        return;
      }
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        json(200, fixture.metadata);
        return;
      }
      if (url.pathname === '/register') {
        const metadata = JSON.parse(body);
        if (metadata.token_endpoint_auth_method !== 'none')
          metadata.client_secret = 'synthetic-dcr:secret+';
        const clientId = `fixture-client-${fixture.registered.size}`;
        fixture.registered.set(clientId, metadata);
        json(201, { ...metadata, client_id: clientId });
        return;
      }
      if (url.pathname === '/client.json') {
        json(200, {
          client_id: `${origin}/client.json`,
          client_name: 'Synthetic CIMD Client',
          redirect_uris: [callback],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        });
        return;
      }
      if (url.pathname === '/authorize') {
        const clientId = url.searchParams.get('client_id') || '';
        let registered = fixture.registered.get(clientId);
        if (clientId === `${origin}/client.json`) {
          const response = await fetch(clientId);
          registered = (await response.json()) as Record<string, any>;
        }
        if (
          !registered ||
          !registered.redirect_uris.includes(url.searchParams.get('redirect_uri')) ||
          url.searchParams.get('code_challenge_method') !== 'S256' ||
          url.searchParams.get('resource') !== fixture.resourceMetadata.resource
        ) {
          json(400, { error: 'invalid_request' });
          return;
        }
        const code = `fixture-code-${fixture.codes.size}`;
        fixture.codes.set(code, {
          clientId,
          challenge: url.searchParams.get('code_challenge') || '',
          redirect: url.searchParams.get('redirect_uri') || '',
          scope: url.searchParams.get('scope') || '',
          used: false,
        });
        const destination = new URL(url.searchParams.get('redirect_uri')!);
        destination.searchParams.set('code', code);
        destination.searchParams.set('state', url.searchParams.get('state')!);
        destination.searchParams.set('iss', fixture.metadata.issuer);
        res.writeHead(302, { location: destination.href }).end();
        return;
      }
      if (url.pathname === '/token') {
        const params = new URLSearchParams(body);
        let clientId = params.get('client_id');
        if (req.headers.authorization?.startsWith('Basic ')) {
          const decoded = Buffer.from(req.headers.authorization.slice(6), 'base64').toString(
            'utf8',
          );
          const parts = decoded.split(':');
          if (parts.length !== 2) {
            json(401, { error: 'invalid_client' });
            return;
          }
          const decode = (value: string) => new URLSearchParams(`v=${value}`).get('v');
          clientId = decode(parts[0]);
          if (fixture.registered.get(clientId || '')?.client_secret !== decode(parts[1])) {
            json(401, { error: 'invalid_client' });
            return;
          }
        } else if (
          fixture.metadata.token_endpoint_auth_methods_supported.includes('client_secret_post')
        ) {
          if (
            fixture.registered.get(clientId || '')?.client_secret !== params.get('client_secret')
          ) {
            json(401, { error: 'invalid_client' });
            return;
          }
        }
        if (fixture.invalidGrant) {
          json(400, {
            error: 'invalid_grant',
            error_description: 'synthetic-secret-upstream-error',
          });
          return;
        }
        if (params.get('grant_type') === 'authorization_code') {
          const code = fixture.codes.get(params.get('code') || '');
          const hash = createHash('sha256')
            .update(params.get('code_verifier') || '')
            .digest('base64url');
          if (
            !code ||
            code.used ||
            code.challenge !== hash ||
            code.clientId !== clientId ||
            code.redirect !== params.get('redirect_uri') ||
            params.get('resource') !== fixture.resourceMetadata.resource
          ) {
            json(400, { error: 'invalid_grant' });
            return;
          }
          code.used = true;
          const refresh = `synthetic-refresh-${fixture.issued}`;
          fixture.refreshes.add(refresh);
          json(200, {
            access_token: `synthetic-access-${fixture.issued++}`,
            token_type: fixture.tokenType,
            refresh_token: refresh,
            scope: code.scope,
            expires_in: 60,
          });
          return;
        }
        if (params.get('grant_type') === 'refresh_token') {
          const token = params.get('refresh_token') || '';
          if (!fixture.refreshes.has(token)) {
            json(400, { error: 'invalid_grant' });
            return;
          }
          if (fixture.omitRefreshAndScope) {
            json(200, {
              access_token: `synthetic-access-${fixture.issued++}`,
              token_type: fixture.tokenType,
              expires_in: 120,
            });
            return;
          }
          fixture.refreshes.delete(token);
          const refresh = `synthetic-refresh-${fixture.issued}`;
          fixture.refreshes.add(refresh);
          json(200, {
            access_token: `synthetic-access-${fixture.issued++}`,
            token_type: fixture.tokenType,
            refresh_token: refresh,
            expires_in: 120,
          });
          return;
        }
        json(400, { error: 'unsupported_grant_type' });
        return;
      }
      if (url.pathname === '/revoke') {
        const params = new URLSearchParams(body);
        fixture.revoked.push(params.get('token') || '');
        if (fixture.revocationStatus !== 200) {
          json(fixture.revocationStatus, { error: 'synthetic-private-provider-detail' });
          return;
        }
        fixture.refreshes.delete(params.get('token') || '');
        res.writeHead(200).end();
        return;
      }
      json(404, {});
    } catch {
      if (!res.destroyed) res.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  fixture.resourceMetadata = {
    resource: `${origin}/mcp`,
    authorization_servers: [`${origin}/issuer`],
    scopes_supported: ['notes.read', 'notes.write'],
  };
  fixture.metadata = {
    issuer: `${origin}/issuer`,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
  };
  t.after(async () => {
    fixture.holding.forEach((response) => response.destroy());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const provider = createAppOAuthProvider({ testOrigins: [origin] });
  const prepare = () =>
    provider.prepare({ url: `${origin}/mcp`, redirectUri: callback, state: state() }, signal());
  const authorize = async (prepared: OAuthPrepared) => {
    // Emulates an owner's browser visiting only this test-owned authorization endpoint.
    const response = await fetch(prepared.authorizationUrl, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const returned = new URL(response.headers.get('location')!);
    assert.equal(returned.searchParams.get('state'), prepared.state);
    validateAuthorizationResponseIssuer({
      iss: returned.searchParams.get('iss')!,
      expectedIssuer: prepared.issuer,
      issParameterSupported: true,
    });
    return returned.searchParams.get('code')!;
  };
  return { fixture, origin, provider, prepare, authorize };
}

const isKind = (kind: AppOAuthProviderError['kind']) => (error: unknown) =>
  error instanceof AppOAuthProviderError &&
  error.kind === kind &&
  !error.message.includes('synthetic-secret');

export { callback, isKind, providerFixture, signal, state };
