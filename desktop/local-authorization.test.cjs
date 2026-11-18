'use strict';
const assert = require('node:assert/strict');
const { get } = require('node:http');
const test = require('node:test');
const { createAuthorizationHandler } = require('./authorization.cjs');
const { translate } = require('./ui/i18n.js');

const request = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  flowId: '33333333-3333-4333-8333-333333333333',
  expectedUserId: '44444444-4444-4444-8444-444444444444',
};
const origin = 'http://127.0.0.1:3456';
const path = '/api/app-oauth/callback';
const name = 'openbot_oauth_' + request.flowId.replaceAll('-', '');

function fixture(t) {
  const state = { confirm: true, focused: true, valid: true, began: 0 };
  const provider = 'https://forum.example.com';
  const flow = {
    id: request.flowId,
    connectionId: request.connectionId,
    connectionRevision: 'revision',
    status: 'pending',
    scopes: ['posts:write'],
    launchPath:
      '/app-authorize/' + [request.workspaceId, request.connectionId, request.flowId].join('/'),
    authorizationOrigin: provider,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  state.location = provider + '/authorize?state=fixture';
  const frame = { origin, url: origin + '/w/' + request.workspaceId, isDestroyed: () => false };
  const session = {
    async fetch(url, init) {
      assert.equal(init.headers['X-OpenBot-Expected-User'], request.expectedUserId);
      if (!state.valid) return new Response(null, { status: 403 });
      if (url.endsWith('/begin')) {
        assert.equal(init.method, 'POST');
        state.began++;
        return Response.json({ authorizationUrl: state.location });
      }
      assert.ok(url.endsWith('/oauth/' + request.flowId));
      assert.equal(init.method, 'GET');
      return Response.json(flow);
    },
    cookies: {
      async get(filter) {
        assert.deepEqual(filter, { name, url: origin + path });
        return [
          {
            name,
            value: 'A'.repeat(43),
            domain: '127.0.0.1',
            path,
            hostOnly: true,
            httpOnly: true,
            sameSite: 'lax',
            expirationDate: Date.now() / 1000 + 500,
          },
        ];
      },
    },
  };
  const contents = { session, mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const current = {
    origin,
    attached: true,
    managed: true,
    view: { webContents: contents },
    healthCheck: new AbortController(),
  };
  t.after(() => current.healthCheck.abort());
  const handler = createAuthorizationHandler({
    getConnection: () => current,
    getWindow: () => ({}),
    foregroundFrame: () => state.focused && frame,
    dialog: {
      async showMessageBox(_window, options) {
        assert.match(options.message, /https:\/\/forum\.example\.com/);
        assert.match(options.detail, /posts:write/);
        return { response: state.confirm ? 1 : 0 };
      },
    },
    t: (key, params) => translate('en', key, params),
    now: Date.now,
    shell: {
      async openExternal(local) {
        assert.match(local, /^http:\/\/127\.0\.0\.1:\d+\/app-oauth\/[\da-f-]+\/[\w-]{43}$/);
        state.url = local;
      },
    },
  });
  const open = () => {
    current.oauthInput = { frame, url: frame.url, expiresAt: Date.now() + 5000 };
    return handler({ sender: contents, senderFrame: frame }, request);
  };
  return { state, open, current };
}
function navigate(url, options) {
  return new Promise((resolve, reject) => {
    get(url, { agent: false, ...options }, (response) => {
      response.resume();
      response.once('end', () =>
        resolve({ status: response.statusCode, headers: response.headers }),
      );
    }).once('error', reject);
  });
}

test('managed desktop confirms the provider and scopes before handing off only its callback cookie once', async (t) => {
  const { state, open } = fixture(t);
  state.confirm = false;
  assert.deepEqual(await open(), { opened: false });
  assert.equal(state.url, undefined);
  state.confirm = true;
  assert.deepEqual(await open(), { opened: true });
  assert.equal(state.began, 0);
  state.focused = false; // The system browser takes focus to navigate.
  assert.equal((await navigate(state.url, { headers: { host: 'unrelated.example' } })).status, 404);
  assert.equal((await navigate(state.url, { headers: { 'Sec-Purpose': 'prefetch' } })).status, 404);
  assert.equal((await navigate(state.url + 'x')).status, 404);
  assert.equal(state.began, 0);
  const results = await Promise.allSettled([navigate(state.url), navigate(state.url)]);
  const redirects = results.filter((r) => r.status === 'fulfilled' && r.value.status === 303);
  assert.equal(redirects.length, 1);
  const { headers } = redirects[0].value;
  assert.equal(headers.location, state.location);
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['set-cookie'].length, 1);
  assert.ok(
    headers['set-cookie'][0].startsWith(
      name + '=' + 'A'.repeat(43) + '; Path=' + path + '; HttpOnly; SameSite=Lax; Max-Age=',
    ),
  );
  assert.equal(state.began, 1);
});

test('revocation before redemption and a changed provider cannot transfer a cookie', async (t) => {
  const { state, open, current } = fixture(t);
  await open();
  state.valid = false;
  const revoked = await navigate(state.url);
  assert.equal(revoked.status, 410);
  assert.equal(revoked.headers['set-cookie'], undefined);
  assert.equal(state.began, 0);
  state.valid = true;
  state.location = 'https://different.example/authorize';
  await open();
  const changed = await navigate(state.url);
  assert.equal(changed.status, 410);
  assert.equal(changed.headers.location, undefined);
  assert.equal(changed.headers['set-cookie'], undefined);
  await open();
  current.healthCheck.abort();
  await assert.rejects(navigate(state.url));
});
