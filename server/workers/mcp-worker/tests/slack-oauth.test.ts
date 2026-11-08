import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSlackHost,
  slack,
  slackTokenResponse,
  validateSlackIdentity,
  validateSlackScopes,
  validateSlackSetup,
} from '../slack-oauth.js';

const callback = 'https://openbot.example.test/api/app-oauth/callback';
const credentials = ['synthetic-client-id', 'synthetic-client-secret'] as const;
const discovery = {
  issuer: slack.resource,
  authorization_endpoint: slack.authorizationEndpoint,
  token_endpoint: slack.tokenEndpoint,
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_post'],
};

test('Slack uses the exact hosted resource, confidential registration, and HTTPS callback', () => {
  assert.doesNotThrow(() => validateSlackSetup(new URL(slack.endpoint), callback, ...credentials));
  assert.throws(() => validateSlackSetup(new URL(slack.endpoint), callback, credentials[0]));
  assert.throws(() =>
    validateSlackSetup(
      new URL(slack.endpoint),
      'http://localhost/api/app-oauth/callback',
      ...credentials,
    ),
  );
  assert.throws(() =>
    validateSlackSetup(
      new URL(slack.endpoint),
      'https://openbot.example.test/other',
      ...credentials,
    ),
  );
  assert.equal(isSlackHost('https://mcp.slack.com./mcp'), true);
  assert.throws(() => validateSlackSetup(new URL(slack.endpoint + '/'), callback, ...credentials));
  assert.equal(isSlackHost('https://mcp.slack.com.example.test/mcp'), false);
  assert.doesNotThrow(() => validateSlackIdentity(slack.resource, discovery));
  assert.throws(() => validateSlackIdentity('https://other.example.test', discovery));
  assert.throws(() =>
    validateSlackIdentity(slack.resource, {
      ...discovery,
      token_endpoint: 'https://other.example.test/token',
    }),
  );
  assert.throws(() =>
    validateSlackIdentity(slack.resource, {
      ...discovery,
      code_challenge_methods_supported: ['plain'],
    }),
  );
});

test('native Slack token responses are normalized only with explicit read scopes', () => {
  const native = {
    ok: true,
    token_type: 'user',
    access_token: 'synthetic-access-token',
    authed_user: { scope: 'search:read.public,channels:read' },
    refresh_token: 'synthetic-refresh-token',
    expires_in: 3600,
  };
  assert.deepEqual(slackTokenResponse(native), {
    token_type: 'Bearer',
    access_token: 'synthetic-access-token',
    scope: 'search:read.public channels:read',
    refresh_token: 'synthetic-refresh-token',
    expires_in: 3600,
  });
  assert.throws(() => slackTokenResponse({ ...native, authed_user: undefined }));
  assert.throws(() => slackTokenResponse({ ...native, ok: false }));
  assert.throws(() => slackTokenResponse({ ...native, token_type: 'bot' }));
  assert.throws(() => slackTokenResponse({ ...native, scope: 'channels:read' }));
  for (const scope of ['search:read.private', 'search:read.im', 'chat:write']) {
    assert.throws(() =>
      slackTokenResponse({
        ...native,
        authed_user: { scope: `search:read.public,${scope}` },
      }),
    );
  }
  assert.deepEqual(validateSlackScopes([...slack.scopes, slack.scopes[0]]), slack.scopes);
});

test('Slack refresh may retain or reduce established scopes and rejects scope growth', () => {
  const response = { access_token: 'synthetic-access-token', token_type: 'Bearer' };
  const previous = ['search:read.public', 'channels:read'];
  assert.equal(slackTokenResponse(response, previous).scope, previous.join(' '));
  assert.equal(
    slackTokenResponse({ ...response, scope: 'channels:read' }, previous).scope,
    'channels:read',
  );
  assert.throws(() => slackTokenResponse({ ...response, scope: 'channels:history' }, previous));
  assert.throws(() => slackTokenResponse({ ...response, scope: 'chat:write' }, previous));
});
