import {
  checkResourceAllowed,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  OAuthError,
  refreshAuthorization,
  registerClient,
  resolveClientMetadata,
  selectClientAuthMethod,
  startAuthorization,
  type OAuthTokens,
  type OAuthClientMetadata,
  type AuthorizationServerMetadata,
  type OAuthProtectedResourceMetadata,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { AppOAuthProviderError, OAuthNetwork, oauthUrl } from './oauth-network.js';
import {
  isSlackHost,
  slack,
  slackTokenResponse,
  validateSlackIdentity,
  validateSlackScopes,
  validateSlackSetup,
} from './slack-oauth.js';
export { AppOAuthProviderError } from './oauth-network.js';

/** Private OAuth state. Never expose these objects through API/bootstrap/model views. */
export interface OAuthPrepared {
  authorizationUrl: string;
  issuer: string;
  resource: string;
  scopes: string[];
  client: StoredOAuthClientInformation;
  metadata: AuthorizationServerMetadata;
  verifier: string;
  redirectUri: string;
  state: string;
  resourceMetadata?: OAuthProtectedResourceMetadata;
}
export interface OAuthGrant {
  issuer: string;
  resource: string;
  scopes: string[];
  client: StoredOAuthClientInformation;
  metadata: AuthorizationServerMetadata;
  tokens: StoredOAuthTokens;
  obtainedAt: number;
  expiresAt?: number;
}
export interface AppOAuthProvider {
  prepare(
    input: {
      url: string;
      redirectUri: string;
      state: string;
      clientMetadataUrl?: string;
      clientId?: string;
      clientSecret?: string;
    },
    signal: AbortSignal,
  ): Promise<OAuthPrepared>;
  exchange(prepared: OAuthPrepared, code: string, signal: AbortSignal): Promise<OAuthGrant>;
  refresh(grant: OAuthGrant, signal: AbortSignal): Promise<OAuthGrant>;
  revoke(grant: OAuthGrant, signal: AbortSignal): Promise<{ revoked: boolean }>;
}
export interface AppOAuthProviderOptions {
  /** Constructor-only exact local fixture origins. Never supplied by API or environment. */
  testOrigins?: string[];
  authorize?: () => Promise<void>;
  publicOrigin?: string;
}

function requireValue(value: unknown): asserts value {
  if (!value) throw new AppOAuthProviderError('protocol');
}
function boundedSecret(value: unknown, max = 16384): asserts value is string {
  requireValue(typeof value === 'string' && /^[\x21-\x7e]+$/.test(value) && value.length <= max);
}
function scopes(value: unknown): string[] {
  requireValue(typeof value === 'string' && value.length <= 4096);
  const result = [...new Set(value.split(' ').filter(Boolean))];
  requireValue(
    result.length <= 64 &&
      result.every((scope) => scope.length <= 256 && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)),
  );
  return result;
}
function redirectUri(value: string): string {
  const url = new URL(value);
  requireValue(!url.username && !url.password && !url.search && !url.hash && value.length <= 2048);
  requireValue(
    url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)),
  );
  return url.href;
}
function clientAuth(
  client: StoredOAuthClientInformation,
  supported?: string[],
): 'none' | 'client_secret_basic' | 'client_secret_post' {
  boundedSecret(client.client_id, 2048);
  if (client.client_secret !== undefined) boundedSecret(client.client_secret, 4096);
  const method = selectClientAuthMethod(client, supported || []);
  requireValue(!supported?.length || supported.includes(method));
  if (method !== 'none') requireValue(!!client.client_secret);
  return method;
}
function authenticate(client: StoredOAuthClientInformation, supported?: string[]) {
  const method = clientAuth(client, supported);
  return (headers: Headers, params: URLSearchParams) => {
    if (method === 'client_secret_basic') {
      const form = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
      headers.set(
        'Authorization',
        `Basic ${Buffer.from(`${form(client.client_id)}:${form(client.client_secret!)}`).toString('base64')}`,
      );
    } else {
      params.set('client_id', client.client_id);
      if (method === 'client_secret_post') params.set('client_secret', client.client_secret!);
    }
  };
}
function makeGrant(
  base: Pick<OAuthGrant, 'issuer' | 'resource' | 'client' | 'metadata' | 'scopes'>,
  value: OAuthTokens,
): OAuthGrant {
  boundedSecret(value.access_token);
  requireValue(typeof value.token_type === 'string' && value.token_type.toLowerCase() === 'bearer');
  if (value.refresh_token !== undefined) boundedSecret(value.refresh_token);
  if (value.expires_in !== undefined)
    requireValue(
      Number.isFinite(value.expires_in) &&
        value.expires_in >= 0 &&
        value.expires_in <= 10 * 365 * 86400,
    );
  const granted = value.scope === undefined ? [...base.scopes] : scopes(value.scope);
  const obtainedAt = Date.now();
  return {
    issuer: base.issuer,
    resource: base.resource,
    client: base.client,
    metadata: base.metadata,
    scopes: granted,
    tokens: {
      access_token: value.access_token,
      token_type: 'Bearer',
      ...(value.refresh_token ? { refresh_token: value.refresh_token } : {}),
      ...(value.expires_in !== undefined ? { expires_in: value.expires_in } : {}),
      scope: granted.join(' '),
      issuer: base.issuer,
    },
    obtainedAt,
    ...(value.expires_in !== undefined ? { expiresAt: obtainedAt + value.expires_in * 1000 } : {}),
  };
}

export function createAppOAuthProvider(options: AppOAuthProviderOptions = {}): AppOAuthProvider {
  const testOrigins = new Set(options.testOrigins || []);
  for (const origin of testOrigins) {
    const url = new URL(origin);
    requireValue(url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1');
  }
  const operation = async <T>(
    signal: AbortSignal,
    run: (network: OAuthNetwork) => Promise<T>,
  ): Promise<T> => {
    const network = new OAuthNetwork(testOrigins, signal, options.authorize, options.publicOrigin);
    try {
      const result = await run(network);
      network.assertSafe();
      return result;
    } catch (cause) {
      if (cause instanceof AppOAuthProviderError) throw cause;
      if (
        cause instanceof OAuthError &&
        ['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied'].includes(
          cause.code,
        )
      )
        throw new AppOAuthProviderError('auth');
      throw new AppOAuthProviderError('protocol');
    } finally {
      await network.close();
    }
  };
  const slackBound = (saved: Pick<OAuthGrant, 'issuer' | 'resource'>) =>
    isSlackHost(saved.issuer) || isSlackHost(saved.resource);
  const tokenFetch = (
    saved: Pick<OAuthGrant, 'issuer' | 'resource'>,
    network: OAuthNetwork,
    previousScopes?: string[],
  ): OAuthNetwork['fetch'] => {
    if (!slackBound(saved)) return network.fetch;
    return async (url, init) => {
      requireValue(String(url) === slack.tokenEndpoint && init?.method === 'POST');
      const response = await network.fetch(url, init);
      if (!response.ok) return response;
      return Response.json(slackTokenResponse(await response.json(), previousScopes));
    };
  };
  const bound = async (
    saved: Pick<OAuthGrant, 'issuer' | 'resource' | 'client' | 'metadata' | 'scopes'>,
    network: OAuthNetwork,
  ) => {
    requireValue(saved.issuer === saved.metadata.issuer && saved.client.issuer === saved.issuer);
    const issuer = await network.validate(saved.issuer);
    requireValue(!issuer.search);
    if (slackBound(saved)) {
      validateSlackIdentity(saved.resource, saved.metadata);
      requireValue(saved.client.client_secret);
      validateSlackScopes(saved.scopes);
    }
    await network.validate(saved.resource);
    await network.validate(saved.metadata.token_endpoint);
    clientAuth(saved.client, saved.metadata.token_endpoint_auth_methods_supported);
  };
  return {
    prepare: (input, signal) =>
      operation(signal, async (network) => {
        const resourceUrl = await network.validate(input.url);
        requireValue(!resourceUrl.search);
        requireValue(!input.clientSecret || input.clientId);
        const callback = redirectUri(input.redirectUri);
        const slackEndpoint = isSlackHost(resourceUrl);
        if (slackEndpoint) {
          validateSlackSetup(resourceUrl, callback, input.clientId, input.clientSecret);
        }
        requireValue(
          typeof input.state === 'string' && /^[a-zA-Z0-9_-]{32,256}$/.test(input.state),
        );
        // A harmless unauthenticated GET retrieves a challenge, never an MCP tool call.
        const challengeResponse = await network.fetch(resourceUrl.href, {
          headers: { Accept: 'application/json' },
        });
        const challenge = extractWWWAuthenticateParams(challengeResponse);
        await challengeResponse.body?.cancel();
        const resourceMetadataUrl = slackEndpoint
          ? new URL(slack.resourceMetadata)
          : challenge.resourceMetadataUrl;
        if (resourceMetadataUrl) await network.validate(resourceMetadataUrl.href);
        let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
        let discoveryStatus: number | undefined;
        try {
          resourceMetadata = await discoverOAuthProtectedResourceMetadata(
            resourceUrl,
            { resourceMetadataUrl },
            async (url, init) => {
              const response = await network.fetch(url, init);
              discoveryStatus = response.status;
              return response;
            },
          );
        } catch (cause) {
          network.assertSafe();
          // Only actual absent legacy metadata may fall back to the resource origin.
          if (discoveryStatus !== 404 || resourceMetadataUrl) throw cause;
        }
        network.assertSafe();
        if (resourceMetadata) {
          requireValue(
            checkResourceAllowed({
              requestedResource: resourceUrl,
              configuredResource: resourceMetadata.resource,
            }),
          );
          requireValue(resourceMetadata.dpop_bound_access_tokens_required !== true);
          requireValue(
            !resourceMetadata.authorization_servers ||
              resourceMetadata.authorization_servers.length <= 8,
          );
        }
        const resource = resourceMetadata?.resource || resourceUrl.href;
        await network.validate(resource);
        const authorizationServer =
          resourceMetadata?.authorization_servers?.[0] || `${resourceUrl.origin}/`;
        if (slackEndpoint) {
          requireValue(
            resourceMetadata && new URL(authorizationServer).href === new URL(slack.resource).href,
          );
        }
        await network.validate(authorizationServer);
        const metadata = await discoverAuthorizationServerMetadata(authorizationServer, {
          fetchFn: network.fetch,
        });
        requireValue(metadata);
        const issuer = metadata.issuer;
        if (slackEndpoint) validateSlackIdentity(resource, metadata);
        requireValue(!new URL(issuer).search);
        await network.validate(issuer);
        await network.validate(metadata.authorization_endpoint);
        await network.validate(metadata.token_endpoint);
        requireValue(metadata.response_types_supported.includes('code'));
        requireValue(
          !metadata.code_challenge_methods_supported ||
            metadata.code_challenge_methods_supported.includes('S256'),
        );
        requireValue(
          !metadata.grant_types_supported ||
            metadata.grant_types_supported.includes('authorization_code'),
        );
        const selectedScopes = slackEndpoint
          ? [...slack.scopes]
          : scopes(challenge.scope || resourceMetadata?.scopes_supported?.join(' ') || '');
        const refreshSupported =
          !metadata.grant_types_supported ||
          metadata.grant_types_supported.includes('refresh_token');
        if (
          !slackEndpoint &&
          refreshSupported &&
          metadata.scopes_supported?.includes('offline_access') &&
          !selectedScopes.includes('offline_access')
        )
          selectedScopes.push('offline_access');
        requireValue(selectedScopes.length <= 64);
        let client: StoredOAuthClientInformation;
        const clientMetadata: OAuthClientMetadata = resolveClientMetadata({
          redirectUrl: callback,
          clientMetadata: {
            client_name: 'OpenBot',
            redirect_uris: [callback],
            response_types: ['code'],
            grant_types: refreshSupported
              ? ['authorization_code', 'refresh_token']
              : ['authorization_code'],
            token_endpoint_auth_method: 'none',
          },
        });
        if (input.clientId) {
          boundedSecret(input.clientId, 2048);
          if (input.clientSecret !== undefined) boundedSecret(input.clientSecret, 4096);
          client = {
            client_id: input.clientId,
            ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
            issuer,
          };
        } else if (
          metadata.client_id_metadata_document_supported === true &&
          input.clientMetadataUrl
        ) {
          const clientDocument = oauthUrl(input.clientMetadataUrl, testOrigins);
          requireValue(
            (clientDocument.protocol === 'https:' || testOrigins.has(clientDocument.origin)) &&
              clientDocument.pathname !== '/' &&
              !clientDocument.search,
          );
          // The public metadata document may belong to this platform; only validate it here.
          // OAuthNetwork.fetch still forbids requests back into the platform itself.
          await network.validate(clientDocument.href, true);
          client = { client_id: clientDocument.href, issuer };
        } else {
          requireValue(!input.clientSecret && metadata.registration_endpoint);
          const supported = metadata.token_endpoint_auth_methods_supported ?? [
            'client_secret_basic',
          ];
          const registrationMethod = ['none', 'client_secret_basic', 'client_secret_post'].find(
            (method) => supported.includes(method),
          );
          requireValue(registrationMethod);
          clientMetadata.token_endpoint_auth_method = registrationMethod;
          await network.validate(metadata.registration_endpoint);
          const registered = await registerClient(authorizationServer, {
            metadata,
            clientMetadata,
            scope: selectedScopes.join(' ') || undefined,
            fetchFn: network.fetch,
          });
          requireValue(
            registered.redirect_uris.length === 1 && registered.redirect_uris[0] === callback,
          );
          client = { ...registered, issuer };
        }
        clientAuth(client, metadata.token_endpoint_auth_methods_supported);
        const authorization = await startAuthorization(issuer, {
          metadata,
          clientInformation: client,
          redirectUrl: callback,
          state: input.state,
          scope: selectedScopes.join(' ') || undefined,
          resource,
        });
        await network.validate(authorization.authorizationUrl.href);
        return {
          authorizationUrl: authorization.authorizationUrl.href,
          issuer,
          resource,
          scopes: selectedScopes,
          client,
          metadata,
          verifier: authorization.codeVerifier,
          redirectUri: callback,
          state: input.state,
          ...(resourceMetadata ? { resourceMetadata } : {}),
        };
      }),
    exchange: (prepared, code, signal) =>
      operation(signal, async (network) => {
        await bound(prepared, network);
        boundedSecret(code, 8192);
        requireValue(/^[a-zA-Z0-9._~-]{43,128}$/.test(prepared.verifier));
        const tokens = await exchangeAuthorization(prepared.issuer, {
          metadata: prepared.metadata,
          clientInformation: prepared.client,
          authorizationCode: code,
          // The flow validates callback iss before calling this private method.
          iss: prepared.issuer,
          codeVerifier: prepared.verifier,
          redirectUri: redirectUri(prepared.redirectUri),
          resource: prepared.resource,
          fetchFn: tokenFetch(prepared, network),
          addClientAuthentication: authenticate(
            prepared.client,
            prepared.metadata.token_endpoint_auth_methods_supported,
          ),
        });
        return makeGrant(prepared, tokens);
      }),
    refresh: (grant, signal) =>
      operation(signal, async (network) => {
        await bound(grant, network);
        requireValue(grant.tokens.issuer === grant.issuer);
        boundedSecret(grant.tokens.refresh_token);
        const tokens = await refreshAuthorization(grant.issuer, {
          metadata: grant.metadata,
          clientInformation: grant.client,
          refreshToken: grant.tokens.refresh_token,
          resource: grant.resource,
          fetchFn: tokenFetch(grant, network, grant.scopes),
          addClientAuthentication: authenticate(
            grant.client,
            grant.metadata.token_endpoint_auth_methods_supported,
          ),
        });
        return makeGrant(grant, tokens);
      }),
    revoke: (grant, signal) =>
      operation(signal, async (network) => {
        if (slackBound(grant)) return { revoked: false };
        requireValue(
          grant.issuer === grant.metadata.issuer &&
            grant.client.issuer === grant.issuer &&
            grant.tokens.issuer === grant.issuer,
        );
        const revocation = grant.metadata as AuthorizationServerMetadata & {
          revocation_endpoint?: unknown;
          revocation_endpoint_auth_methods_supported?: unknown;
        };
        const endpoint = revocation.revocation_endpoint;
        if (typeof endpoint !== 'string') return { revoked: false };
        await network.validate(endpoint);
        const token = grant.tokens.refresh_token || grant.tokens.access_token;
        boundedSecret(token);
        const supported = revocation.revocation_endpoint_auth_methods_supported as
          string[] | undefined;
        requireValue(
          supported === undefined ||
            (Array.isArray(supported) && supported.every((method) => typeof method === 'string')),
        );
        const params = new URLSearchParams({
          token,
          token_type_hint: grant.tokens.refresh_token ? 'refresh_token' : 'access_token',
        });
        const headers = new Headers({
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        });
        authenticate(
          grant.client,
          supported || grant.metadata.token_endpoint_auth_methods_supported,
        )(headers, params);
        const response = await network.fetch(endpoint, { method: 'POST', headers, body: params });
        await response.body?.cancel();
        if (!response.ok)
          throw new AppOAuthProviderError(
            response.status === 401 || response.status === 403 ? 'auth' : 'protocol',
          );
        return { revoked: true };
      }),
  };
}
