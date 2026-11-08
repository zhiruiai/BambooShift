import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordProblem, submitPasswordChange } from './platform/accountActions.js';
import { PlatformApiError, safeAccountNext, type platformApi } from './platform/platformApi.js';

const input = {
  expectedUserId: 'fixture-user',
  currentPassword: 'current-fixture-123',
  newPassword: 'new-fixture-456',
};
test('account password form validates confirmation without trimming intentional password characters', () => {
  assert.match(passwordProblem('', input.newPassword, input.newPassword), /当前密码/);
  assert.match(passwordProblem(input.currentPassword, 'short', 'short'), /10 到 128/);
  assert.match(
    passwordProblem(input.currentPassword, input.currentPassword, input.currentPassword),
    /不能.*相同/,
  );
  assert.match(
    passwordProblem(input.currentPassword, input.newPassword, 'different-fixture'),
    /不一致/,
  );
  assert.equal(
    passwordProblem(input.currentPassword, ` ${input.newPassword} `, ` ${input.newPassword} `),
    '',
  );
});

test('password mutation makes exactly one identity-bound request; a lost response remains unknown', async () => {
  for (const error of [
    new PlatformApiError('offline', 0),
    new PlatformApiError('timeout', 408),
    new PlatformApiError('upstream', 502),
    new SyntaxError('truncated response'),
  ]) {
    const calls: unknown[][] = [];
    const request = (async (...args: unknown[]) => {
      calls.push(args);
      throw error;
    }) as typeof platformApi;
    assert.equal(await submitPasswordChange(input, request), 'unknown');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/account/password');
    assert.equal(calls[0][1], 'POST');
    assert.deepEqual(calls[0][2], input);
    assert.ok((calls[0][3] as { signal: AbortSignal }).signal instanceof AbortSignal);
  }
});

test('explicit password rejection is shown to the user; only a success receipt reports changed', async () => {
  for (const status of [400, 401, 403, 409, 429]) {
    const error = new PlatformApiError('fixture rejection', status);
    await assert.rejects(
      submitPasswordChange(input, (async () => {
        throw error;
      }) as typeof platformApi),
      (value) => value === error,
    );
  }
  assert.equal(
    await submitPasswordChange(input, (async () => undefined) as typeof platformApi),
    'changed',
  );
});

test('account settings can be resumed after product login without opening operator or external redirects', () => {
  assert.equal(safeAccountNext('/account'), '/account');
  assert.equal(safeAccountNext('/account?from=profile#password'), '/account?from=profile#password');
  for (const path of [
    '/admin',
    '/admin/login',
    '//external.test/account',
    '/account/../../admin',
    '/account%2f..%2fadmin',
    '/\\external.test/account',
  ])
    assert.equal(safeAccountNext(path), '');
});

test('a timed-out password request is aborted and reported as unknown without retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0,
    signal: AbortSignal | undefined;
  const request = ((_path, _method, _body, options) => {
    count++;
    signal = options?.signal;
    return new Promise((_resolve, reject) =>
      signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      }),
    );
  }) as typeof platformApi;
  const result = submitPasswordChange(input, request);
  t.mock.timers.tick(30000);
  assert.equal(await result, 'unknown');
  assert.equal(signal?.aborted, true);
  assert.equal(count, 1);
});
