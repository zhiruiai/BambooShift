import assert from 'node:assert/strict';

export function packageOrigins(ready) {
  const localOrigin = (address) => {
    assert.equal(typeof address, 'string', 'The packaged listener address must be reported.');
    const url = new URL(`http://${address}`);
    assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname));
    assert.ok(url.port && Number(url.port) > 0);
    assert.equal(url.pathname, '/');
    assert.equal(url.search + url.hash + url.username + url.password, '');
    return url.origin;
  };
  const product = localOrigin(ready.address),
    operations = localOrigin(ready.operationsAddress);
  assert.notEqual(product, operations, 'Product and operations must use separate listeners.');
  return { product, operations };
}

async function request(origin, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(origin + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    value: await response.json(),
  };
}

export async function checkOperationsBoundary({ product, operations }, account) {
  const health = await request(operations, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.value.backend, 'rust');
  const page = await fetch(operations + '/', {
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(
    await page.text(),
    /<meta\s+name=["']openbot-application["']\s+content=["']operations["']\s*\/?\s*>/,
  );

  for (const path of ['/api/platform/session', '/api/platform/overview']) {
    const response = await request(product, path, { cookie: account.cookie });
    assert.equal(response.status, 404, `The product listener exposed ${path}.`);
  }
  const rejectedLogin = await request(product, '/api/platform/login', {
    method: 'POST',
    body: { email: account.email, password: account.password },
  });
  assert.equal(rejectedLogin.status, 404);
  for (const [path, method, body] of [
    ['/api/account/session', 'GET'],
    ['/api/account/register', 'POST', { email: 'must-not-register@example.test' }],
    ['/api/account/login', 'POST', { email: account.email, password: account.password }],
    [`/api/workspaces/${account.workspace}/bootstrap`, 'GET'],
  ]) {
    const response = await request(operations, path, { method, body, cookie: account.cookie });
    assert.equal(response.status, 404, `The operations listener exposed ${path}.`);
  }

  // Cookies are host scoped, not port scoped. Purpose checks must reject even renamed tokens.
  assert.match(account.cookie, /(?:^|;\s*)(?:__Host-)?openbot_account=/);
  const renamed = account.cookie.replace(/openbot_account=/g, 'openbot_operator=');
  for (const cookie of [undefined, account.cookie, renamed]) {
    const session = await request(operations, '/api/platform/session', { cookie });
    assert.equal(session.status, 200);
    assert.equal(session.value.authenticated, false);
    assert.equal(session.value.setupRequired, true);
    assert.equal(session.value.user, undefined);
    for (const path of [
      '/api/platform/overview',
      '/api/platform/users',
      '/api/platform/workspaces',
    ])
      assert.equal((await request(operations, path, { cookie })).status, 401);
  }
  const ordinaryLogin = await request(operations, '/api/platform/login', {
    method: 'POST',
    cookie: account.cookie,
    body: { email: account.email, password: account.password },
  });
  assert.equal(ordinaryLogin.status, 401);
  assert.equal(ordinaryLogin.headers.getSetCookie().length, 0);
  const unchanged = await request(operations, '/api/platform/session');
  assert.equal(unchanged.value.setupRequired, true);
  assert.equal(unchanged.value.authenticated, false);
  return {
    separateOperationsListener: true,
    operationsPublicUi: true,
    productPlatformRoutesAbsent: true,
    operationsProductRoutesAbsent: true,
    operationsSetupRequired: true,
    ordinaryAccountRejectedByOperations: true,
    renamedAccountCookieRejectedByOperations: true,
    operatorSetupNotConsumed: true,
  };
}
