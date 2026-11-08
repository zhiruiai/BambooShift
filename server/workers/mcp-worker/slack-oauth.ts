import type { AuthorizationServerMetadata, OAuthTokens } from '@modelcontextprotocol/client';
import slack from '../../../shared/slack-mcp.json';
import { AppOAuthProviderError } from './oauth-network.js';

export { slack };

export function isSlackHost(value: string | URL): boolean {
  return new URL(value).hostname.replace(/\.+$/, '') === 'mcp.slack.com';
}

const fixedResource = new URL(slack.resource).href;
const isResource = (value: unknown) =>
  typeof value === 'string' && (value === slack.resource || value === fixedResource);
const protocol = () => new AppOAuthProviderError('protocol');

export function validateSlackIdentity(resource: string, metadata: AuthorizationServerMetadata) {
  if (
    !isResource(resource) ||
    !isResource(metadata.issuer) ||
    metadata.authorization_endpoint !== slack.authorizationEndpoint ||
    metadata.token_endpoint !== slack.tokenEndpoint ||
    !metadata.token_endpoint_auth_methods_supported?.includes('client_secret_post') ||
    !metadata.code_challenge_methods_supported?.includes('S256')
  ) {
    throw protocol();
  }
}

export function validateSlackSetup(
  endpoint: URL,
  callback: string,
  clientId?: string,
  secret?: string,
) {
  const redirect = new URL(callback);
  if (
    endpoint.href !== slack.endpoint ||
    redirect.protocol !== 'https:' ||
    redirect.pathname !== '/api/app-oauth/callback' ||
    !clientId ||
    !secret
  ) {
    throw protocol();
  }
}

export function validateSlackScopes(value: string[]): string[] {
  const clean = [...new Set(value)];
  if (!clean.length || clean.some((scope) => !slack.scopes.includes(scope))) {
    throw new AppOAuthProviderError('auth');
  }
  return clean;
}

function splitScopes(value: unknown) {
  if (typeof value !== 'string' || value.length > 4096) throw protocol();
  return validateSlackScopes(value.split(/[, ]+/).filter(Boolean));
}

export function slackTokenResponse(value: unknown, existingScopes?: string[]): OAuthTokens {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocol();
  const payload = value as Record<string, unknown>;
  const native = payload.ok === true && payload.token_type === 'user';
  const bearer =
    typeof payload.token_type === 'string' &&
    payload.token_type.toLowerCase() === 'bearer' &&
    payload.ok !== false;
  const user =
    native && payload.authed_user && typeof payload.authed_user === 'object'
      ? (payload.authed_user as Record<string, unknown>)
      : undefined;
  if ((!native && !bearer) || typeof payload.access_token !== 'string') throw protocol();

  const direct = payload.scope === undefined ? undefined : splitScopes(payload.scope);
  const nested = user?.scope === undefined ? undefined : splitScopes(user.scope);
  if (
    direct &&
    nested &&
    (direct.length !== nested.length || direct.some((scope) => !nested.includes(scope)))
  ) {
    throw protocol();
  }
  const granted = direct ?? nested ?? (existingScopes && validateSlackScopes(existingScopes));
  if (!granted || (existingScopes && granted.some((scope) => !existingScopes.includes(scope)))) {
    throw new AppOAuthProviderError('auth');
  }
  const refresh = payload.refresh_token;
  const expires = payload.expires_in;
  if (
    (refresh !== undefined && typeof refresh !== 'string') ||
    (expires !== undefined && typeof expires !== 'number')
  )
    throw protocol();
  return {
    access_token: payload.access_token,
    token_type: 'Bearer',
    scope: granted.join(' '),
    ...(refresh !== undefined ? { refresh_token: refresh } : {}),
    ...(expires !== undefined ? { expires_in: expires } : {}),
  };
}
