import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createAppOAuthProvider } from '../oauth-provider.js';

import { callback, isKind, providerFixture, signal, state } from './oauth-provider.fixture.js';

test('real OAuth discovery, DCR, S256 code exchange, refresh rotation and revoke keep private state separate', async (t) => {
  const f = await providerFixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.issuer, f.fixture.metadata.issuer);
  assert.equal(prepared.resource, f.fixture.resourceMetadata.resource);
  assert.deepEqual(prepared.scopes, ['notes.read', 'notes.write']);
  const url = new URL(prepared.authorizationUrl);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(prepared.verifier).digest('base64url'),
  );
  const code = await f.authorize(prepared);
  const grant = await f.provider.exchange(prepared, code, signal());
  assert.equal(grant.tokens.issuer, prepared.issuer);
  assert.equal(grant.tokens.token_type, 'Bearer');
  assert.equal(grant.expiresAt! - grant.obtainedAt, 60000);
  for (const privateFlowField of ['verifier', 'state', 'authorizationUrl', 'redirectUri'])
    assert(!(privateFlowField in grant));
  assert(
    f.fixture.calls.filter((call) => call.path !== '/token').every((call) => !call.authorization),
  );
  const refreshed = await f.provider.refresh(grant, signal());
  assert.notEqual(refreshed.tokens.refresh_token, grant.tokens.refresh_token);
  assert.deepEqual(refreshed.scopes, grant.scopes);
  assert.equal(refreshed.expiresAt! - refreshed.obtainedAt, 120000);
  assert.deepEqual(await f.provider.revoke(refreshed, signal()), { revoked: true });
  assert.deepEqual(f.fixture.revoked, [refreshed.tokens.refresh_token]);
  await assert.rejects(f.provider.refresh(refreshed, signal()), isKind('auth'));
  assert.equal(
    f.fixture.calls.filter((call) => call.path === '/token').length,
    3,
    'no token request retries',
  );
});

test('a declared revocation endpoint rejecting the request is a failure, not unsupported revocation', async (t) => {
  const f = await providerFixture(t);
  const prepared = await f.prepare();
  const grant = await f.provider.exchange(prepared, await f.authorize(prepared), signal());
  f.fixture.revocationStatus = 401;
  await assert.rejects(f.provider.revoke(grant, signal()), isKind('auth'));
  assert.equal(f.fixture.calls.filter((call) => call.path === '/revoke').length, 1);
  assert.equal(f.fixture.refreshes.has(grant.tokens.refresh_token!), true);
});

test('OAuth supports standard secret_basic and secret_post without leaking client credentials to discovery', async (t) => {
  const f = await providerFixture(t);
  for (const method of ['client_secret_basic', 'client_secret_post']) {
    const clientId = `synthetic:${method}+id`;
    const clientSecret = 'synthetic:secret+/*';
    f.fixture.metadata.token_endpoint_auth_methods_supported = [method];
    f.fixture.registered.set(clientId, { redirect_uris: [callback], client_secret: clientSecret });
    const prepared = await f.provider.prepare(
      { url: `${f.origin}/mcp`, redirectUri: callback, state: state(), clientId, clientSecret },
      signal(),
    );
    const grant = await f.provider.exchange(prepared, await f.authorize(prepared), signal());
    assert.equal(grant.tokens.token_type, 'Bearer');
    const tokenRequest = f.fixture.calls.filter((call) => call.path === '/token').at(-1)!;
    if (method === 'client_secret_basic') {
      assert(tokenRequest.authorization?.startsWith('Basic '));
      assert(!tokenRequest.body.includes('client_secret'));
    } else {
      assert.equal(tokenRequest.authorization, undefined);
      assert.equal(new URLSearchParams(tokenRequest.body).get('client_secret'), clientSecret);
    }
  }
  assert(
    f.fixture.calls
      .filter((call) => call.path !== '/token')
      .every((call) => !call.authorization && !call.body.includes('synthetic:secret')),
  );
});

test('OAuth dynamic registration negotiates a confidential client when the server requires it', async (t) => {
  const f = await providerFixture(t);
  f.fixture.metadata.token_endpoint_auth_methods_supported = ['client_secret_basic'];
  f.fixture.metadata.grant_types_supported = ['authorization_code'];
  const prepared = await f.prepare();
  assert.equal(prepared.client.client_secret, 'synthetic-dcr:secret+');
  const registration = JSON.parse(f.fixture.calls.find((call) => call.path === '/register')!.body);
  assert.equal(registration.token_endpoint_auth_method, 'client_secret_basic');
  assert.deepEqual(registration.grant_types, ['authorization_code']);
  await f.provider.exchange(prepared, await f.authorize(prepared), signal());
  assert.equal(f.fixture.calls.filter((call) => call.path === '/token').length, 1);
});

test('real OAuth uses supplied client registration or CIMD without posting dynamic registration', async (t) => {
  const f = await providerFixture(t);
  f.fixture.registered.set('pre-registered-client', { redirect_uris: [callback] });
  const registered = await f.provider.prepare(
    {
      url: `${f.origin}/mcp`,
      redirectUri: callback,
      state: state(),
      clientId: 'pre-registered-client',
    },
    signal(),
  );
  await f.provider.exchange(registered, await f.authorize(registered), signal());
  f.fixture.metadata.client_id_metadata_document_supported = true;
  const document = await f.provider.prepare(
    {
      url: `${f.origin}/mcp`,
      redirectUri: callback,
      state: state(),
      clientMetadataUrl: `${f.origin}/client.json`,
    },
    signal(),
  );
  assert.equal(document.client.client_id, `${f.origin}/client.json`);
  await f.provider.exchange(document, await f.authorize(document), signal());
  assert.equal(f.fixture.calls.filter((call) => call.path === '/register').length, 0);
  assert.equal(
    f.fixture.calls.filter((call) => call.path === '/client.json').length,
    1,
    'AS actually read the local client metadata document',
  );
});

test('OAuth permits a distinct discovered authorization origin without forwarding credentials to the resource server', async (t) => {
  const resource = await providerFixture(t);
  const authority = await providerFixture(t);
  resource.fixture.resourceMetadata.authorization_servers = [authority.fixture.metadata.issuer];
  authority.fixture.resourceMetadata.resource = `${resource.origin}/mcp`;
  const provider = createAppOAuthProvider({ testOrigins: [resource.origin, authority.origin] });
  const prepared = await provider.prepare(
    { url: `${resource.origin}/mcp`, redirectUri: callback, state: state() },
    signal(),
  );
  assert.equal(prepared.issuer, authority.fixture.metadata.issuer);
  assert.equal(prepared.resource, `${resource.origin}/mcp`);
  const grant = await provider.exchange(prepared, await authority.authorize(prepared), signal());
  assert.equal(grant.tokens.issuer, authority.fixture.metadata.issuer);
  assert(resource.fixture.calls.every((call) => !call.authorization && !call.body));
  assert.equal(
    resource.fixture.calls.filter((call) => call.path === '/token' || call.path === '/register')
      .length,
    0,
  );
  assert.equal(authority.fixture.calls.filter((call) => call.path === '/token').length, 1);
});

test('OAuth refresh preserves omitted refresh token and scope while rejecting DPoP results', async (t) => {
  const f = await providerFixture(t);
  const prepared = await f.prepare();
  const grant = await f.provider.exchange(prepared, await f.authorize(prepared), signal());
  f.fixture.omitRefreshAndScope = true;
  const refreshed = await f.provider.refresh(grant, signal());
  assert.equal(refreshed.tokens.refresh_token, grant.tokens.refresh_token);
  assert.deepEqual(refreshed.scopes, grant.scopes);
  assert.equal(refreshed.tokens.scope, grant.tokens.scope);
  f.fixture.tokenType = 'DPoP';
  await assert.rejects(f.provider.refresh(refreshed, signal()), isKind('protocol'));
  assert.equal(f.fixture.calls.filter((call) => call.path === '/token').length, 3);
});

test('OAuth rejects an incorrect verifier and replayed code without automatic authentication recovery', async (t) => {
  const f = await providerFixture(t);
  const prepared = await f.prepare();
  const code = await f.authorize(prepared);
  await assert.rejects(
    f.provider.exchange({ ...prepared, verifier: 'a'.repeat(64) }, code, signal()),
    isKind('auth'),
  );
  assert.equal(f.fixture.calls.filter((call) => call.path === '/token').length, 1);
  await f.provider.exchange(prepared, code, signal());
  await assert.rejects(f.provider.exchange(prepared, code, signal()), isKind('auth'));
  assert.equal(f.fixture.calls.filter((call) => call.path === '/token').length, 3);
  assert.equal(f.fixture.calls.filter((call) => call.path === '/register').length, 1);
});

test('OAuth does not infer revocation endpoints and rejects changed saved issuer before credentials leave', async (t) => {
  const f = await providerFixture(t);
  const prepared = await f.prepare();
  const grant = await f.provider.exchange(prepared, await f.authorize(prepared), signal());
  const metadata = { ...grant.metadata };
  delete (metadata as any).revocation_endpoint;
  const before = f.fixture.calls.length;
  assert.deepEqual(await f.provider.revoke({ ...grant, metadata }, signal()), { revoked: false });
  await assert.rejects(
    f.provider.refresh({ ...grant, issuer: `${f.origin}/different` }, signal()),
    isKind('protocol'),
  );
  assert.equal(f.fixture.calls.length, before);
});

test('OAuth rejects mismatched metadata issuer, resource audience and unsupported PKCE before registration', async (t) => {
  const f = await providerFixture(t);
  const original = f.fixture.metadata.issuer;
  f.fixture.metadata.issuer = `${f.origin}/wrong-issuer`;
  await assert.rejects(f.prepare(), isKind('protocol'));
  f.fixture.metadata.issuer = original;
  f.fixture.resourceMetadata.resource = `${f.origin}/different-resource`;
  await assert.rejects(f.prepare(), isKind('protocol'));
  f.fixture.resourceMetadata.resource = `${f.origin}/mcp`;
  f.fixture.metadata.code_challenge_methods_supported = ['plain'];
  await assert.rejects(f.prepare(), isKind('protocol'));
  assert.equal(f.fixture.calls.filter((call) => call.path === '/register').length, 0);
});

test('OAuth discovery never follows redirects or falls back after a blocked private endpoint', async (t) => {
  const f = await providerFixture(t);
  f.fixture.redirectPath = '/resource';
  f.fixture.redirectTo = `${f.origin}/unexpected`;
  await assert.rejects(f.prepare(), isKind('blocked'));
  assert(
    !f.fixture.calls.some(
      (call) => call.path === '/unexpected' || call.path.startsWith('/.well-known/'),
    ),
  );
  f.fixture.redirectPath = '';
  f.fixture.metadata.token_endpoint = 'http://169.254.169.254/private';
  await assert.rejects(f.prepare(), isKind('blocked'));
  assert.equal(f.fixture.calls.filter((call) => call.path === '/register').length, 0);
  const before = f.fixture.calls.length;
  await assert.rejects(
    createAppOAuthProvider().prepare(
      { url: `${f.origin}/mcp`, redirectUri: callback, state: state() },
      signal(),
    ),
    isKind('blocked'),
  );
  assert.equal(f.fixture.calls.length, before, 'test seam never changes the default provider');
});

test('OAuth token redirects never forward the code, verifier or client secret to another path', async (t) => {
  const f = await providerFixture(t);
  const prepared = await f.prepare();
  const code = await f.authorize(prepared);
  f.fixture.redirectPath = '/token';
  f.fixture.redirectTo = `${f.origin}/unexpected-token-destination`;
  await assert.rejects(f.provider.exchange(prepared, code, signal()), isKind('blocked'));
  assert.equal(f.fixture.calls.filter((call) => call.path === '/token').length, 1);
  assert(!f.fixture.calls.some((call) => call.path === '/unexpected-token-destination'));
});

test('OAuth response byte limits reject chunked metadata and malformed metadata cannot become legacy discovery', async (t) => {
  const f = await providerFixture(t);
  f.fixture.hugePath = '/resource';
  await assert.rejects(f.prepare(), isKind('protocol'));
  f.fixture.hugePath = '';
  f.fixture.malformedResource = true;
  await assert.rejects(f.prepare(), isKind('protocol'));
  assert.equal(
    f.fixture.calls.filter((call) =>
      call.path.startsWith('/.well-known/oauth-authorization-server'),
    ).length,
    0,
  );
});

test('OAuth legacy well-known discovery works only for actually absent resource metadata', async (t) => {
  const f = await providerFixture(t);
  f.fixture.challenge = false;
  f.fixture.noResourceMetadata = true;
  f.fixture.metadata.issuer = `${f.origin}/`;
  const prepared = await f.prepare();
  assert.equal(prepared.issuer, `${f.origin}/`);
  assert.equal(prepared.resourceMetadata, undefined);
  assert.equal(prepared.resource, `${f.origin}/mcp`);
  assert.equal(f.fixture.calls.filter((call) => call.path === '/register').length, 1);
});

test('OAuth cancellation closes an actually dispatched token request and never retries it', async (t) => {
  const f = await providerFixture(t);
  const prepared = await f.prepare();
  const code = await f.authorize(prepared);
  f.fixture.holdPath = '/token';
  const abort = new AbortController();
  const operation = f.provider.exchange(prepared, code, abort.signal);
  const rejected = assert.rejects(operation, isKind('network'));
  const deadline = Date.now() + 3000;
  while (!f.fixture.holding.length) {
    assert(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  abort.abort();
  await rejected;
  while (!f.fixture.aborts) {
    assert(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(f.fixture.calls.filter((call) => call.path === '/token').length, 1);
});
