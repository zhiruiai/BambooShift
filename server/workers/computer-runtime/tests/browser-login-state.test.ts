import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createBrowserLoginState } from '../browser-login-state.js';
import { cookie, LoginContext } from './browser-login.fixture.js';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-login-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'private', 'login.json'),
    scope = randomUUID();
  const login = createBrowserLoginState(path, scope);
  t.after(() => login.close().catch(() => {}));
  return { login, path, scope };
}
test('independent screens merge login and logout without sharing page or profile objects', async (t) => {
  const { login, path } = await fixture(t),
    a = new LoginContext(),
    b = new LoginContext();
  await login.register(a.asContext());
  await login.register(b.asContext());
  a.state.cookies = [cookie('synthetic')];
  a.state.origins = [
    { origin: 'https://example.test', localStorage: [{ name: 'login', value: 'synthetic-local' }] },
  ];
  await login.synchronize();
  assert.deepEqual(b.state.cookies, a.state.cookies);
  assert.notEqual(b.state.cookies, a.state.cookies);
  assert.deepEqual(b.binding!({ frame: { url: () => 'https://example.test/private' } }), [
    { name: 'login', value: 'synthetic-local' },
  ]);
  assert.deepEqual(b.binding!({ frame: { url: () => 'https://other.test/' } }), []);
  assert.deepEqual(b.binding!({ frame: { url: () => 'file:///etc/passwd' } }), []);
  a.state.cookies = [];
  a.state.origins[0].localStorage = [];
  await login.synchronize();
  assert.deepEqual(b.state.cookies, []);
  assert.deepEqual(b.binding!({ frame: { url: () => 'https://example.test/' } }), []);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700);
});
test('persistent login is workspace-bound and survives restart with no original profile', async (t) => {
  const { login, path, scope } = await fixture(t),
    a = new LoginContext();
  a.state.cookies = [cookie('synthetic')];
  await login.register(a.asContext());
  await login.close();
  const recovered = createBrowserLoginState(path, scope),
    b = new LoginContext();
  await recovered.register(b.asContext());
  assert.equal(b.state.cookies[0].value, 'synthetic');
  await recovered.close();
  const foreign = createBrowserLoginState(path, randomUUID());
  await assert.rejects(foreign.register(new LoginContext().asContext()), /不属于/);
});
test('closed contexts cannot poison remaining screens or resurrect after detach', async (t) => {
  const { login } = await fixture(t),
    a = new LoginContext(),
    b = new LoginContext();
  await login.register(a.asContext());
  await login.register(b.asContext());
  await a.close();
  b.state.cookies = [cookie('still-alive')];
  await login.synchronize();
  assert.equal(b.state.cookies[0].value, 'still-alive');
});
test('partitioned cookies stay local and are excluded from persisted sharing', async (t) => {
  const { login, path } = await fixture(t),
    a = new LoginContext(),
    b = new LoginContext();
  a.state.cookies = [{ ...cookie('partitioned'), partitionKey: 'https://top.test' } as any];
  await login.register(a.asContext());
  await login.register(b.asContext());
  await login.synchronize();
  assert.equal(a.state.cookies.length, 1);
  assert.deepEqual(b.state.cookies, []);
  assert.doesNotMatch(await readFile(path, 'utf8'), /partitioned|top\.test/);
});
test('private storage rejects links, malformed data and actual multibyte overflow', async (t) => {
  const { login, path, scope } = await fixture(t),
    a = new LoginContext();
  await login.register(a.asContext());
  await login.close();
  const old = await readFile(path);
  await rm(path);
  await writeFile(`${path}.target`, old, { mode: 0o600 });
  await symlink(`${path}.target`, path);
  await assert.rejects(createBrowserLoginState(path, scope).register(a.asContext()));
  await rm(path);
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      workspaceScopeId: scope,
      state: {
        cookies: [],
        origins: [
          {
            origin: 'https://example.test',
            localStorage: [{ name: 'too-big', value: '界'.repeat(400000) }],
          },
        ],
      },
    }),
    { mode: 0o600 },
  );
  await assert.rejects(createBrowserLoginState(path, scope).register(a.asContext()), /超过限制/);
});

test('a page edit after observation is preserved and becomes the next shared version', async (t) => {
  const { login } = await fixture(t);
  function pageContext() {
    const context = new LoginContext(),
      values = new Map([['preference', 'old']]);
    let afterRead: (() => void) | undefined;
    context.storageState = async () => {
      const snapshot = {
        cookies: [],
        origins: [
          {
            origin: 'https://example.test',
            localStorage: [...values].map(([name, value]) => ({ name, value })),
          },
        ],
      };
      afterRead?.();
      afterRead = undefined;
      return snapshot;
    };
    context.pages = () =>
      [
        {
          url: () => 'https://example.test/',
          evaluate: async (fn: Function, arg: unknown) =>
            runInNewContext(`(${fn.toString()})(arg)`, {
              arg,
              location: { origin: 'https://example.test' },
              localStorage: {
                getItem: (key: string) => values.get(key) ?? null,
                setItem: (key: string, value: string) => values.set(key, value),
                removeItem: (key: string) => values.delete(key),
              },
            }),
        },
      ] as any;
    return {
      context,
      values,
      later: (fn: () => void) => {
        afterRead = fn;
      },
    };
  }
  const a = pageContext(),
    b = pageContext();
  await login.register(a.context.asContext());
  await login.register(b.context.asContext());
  a.values.set('preference', 'first-edit');
  b.later(() => b.values.set('preference', 'newer-local-edit'));
  await login.synchronize();
  assert.equal(b.values.get('preference'), 'newer-local-edit');
  await login.synchronize();
  assert.equal(a.values.get('preference'), 'newer-local-edit');
});
