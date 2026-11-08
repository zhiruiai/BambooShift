import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, deferred, json } from './testSupport/appsFixture';
import {
  choices,
  clientFixture,
  environment,
  exactRead,
  memory,
  receipt,
  settle,
} from './testSupport/appPolicyFixture';

test('exact authorization requires explicit confirmation and persists only an identifier before dispatch', async () => {
  const storage = memory(),
    posts: any[] = [];
  const { client } = await clientFixture(async (url, init) => {
    assert.equal(new Headers(init?.headers).get('X-OpenBot-Expected-User'), 'owner-a');
    assert.match(String(url), /^\/api\/workspaces\/workspace-a\/apps\/connection-a\/policies/);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      assert.deepEqual([...storage.values.values()], [body.requestId]);
      assert.doesNotMatch(JSON.stringify([...storage.values]), /newer_than|arguments/);
      return json(receipt(body.requestId));
    }
    return choices(url);
  }, storage);
  await client.create({ ...exactRead, confirmed: false });
  await client.create({ ...exactRead, toolName: 'write_note' });
  assert.equal(posts.length, 0);
  await client.create(exactRead);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].expectedRoutineRevision, 'routine-r1');
  assert.equal(posts[0].catalogRevision, 'catalog-r1');
  assert.deepEqual(posts[0].arguments, exactRead.arguments);
  assert.equal(client.getState().policies[0].status, 'active');
  assert.equal(storage.values.size, 0);
  client.suspend();
});

test('lost response survives reopening; read never replays and explicit cancellation fences the same identifier', async () => {
  const storage = memory(),
    posts: any[] = [];
  const first = await clientFixture(async (url, init) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      throw new TypeError('lost response');
    }
    return choices(url);
  }, storage);
  await first.client.create(exactRead);
  const pending = first.client.getState().pendingId;
  assert.ok(pending);
  first.client.suspend();
  const second = await clientFixture(async (url, init) => {
    if (init?.method === 'POST') {
      assert.equal(
        String(url),
        `/api/workspaces/workspace-a/apps/connection-a/policies/${pending}/revoke`,
      );
      posts.push(JSON.parse(String(init.body)));
      return json({ id: pending, status: 'not_created' });
    }
    return choices(url);
  }, storage);
  await second.client.create(exactRead);
  await second.client.read();
  assert.equal(posts.length, 1);
  assert.equal(second.client.getState().pendingId, pending);
  await second.client.revoke(pending);
  assert.equal(posts.length, 2);
  assert.equal(second.client.getState().pendingId, undefined);
  assert.equal(storage.values.size, 0);
  second.client.suspend();
});

test('readonly recovery returns the accepted receipt without creating another grant', async () => {
  const storage = memory();
  let saved: any;
  const first = await clientFixture(async (url, init) => {
    if (init?.method === 'POST') {
      saved = receipt(JSON.parse(String(init.body)).requestId);
      throw new TypeError('lost response');
    }
    return choices(url);
  }, storage);
  await first.client.create(exactRead);
  first.client.suspend();
  const recovered = await clientFixture(async (url, init) => {
    assert.equal(init?.method, 'GET');
    return String(url).endsWith('/options') ? choices(url) : json([saved]);
  }, storage);
  assert.equal(recovered.client.getState().policies[0].id, saved.id);
  assert.equal(recovered.client.getState().pendingId, undefined);
  recovered.client.suspend();
});

test('account, workspace, role and path changes reject retained handlers and late responses', async () => {
  for (const change of ['account', 'workspace', 'role', 'path']) {
    const pending = deferred<Response>();
    let posts = 0;
    const fixture = await clientFixture(async (url, init) => {
      if (init?.method === 'POST') {
        posts++;
        return pending.promise;
      }
      return choices(url);
    });
    const oldCreate = fixture.client.create;
    const running = oldCreate(exactRead);
    await settle();
    if (change === 'account') fixture.identity({ userId: 'owner-b' });
    if (change === 'workspace') fixture.identity({ workspaceId: 'workspace-b' });
    if (change === 'role') fixture.identity({ canManage: false });
    if (change === 'path') fixture.globals.window.location.pathname = '/workspace-b';
    pending.resolve(json(receipt(fixture.client.getState().pendingId)));
    await running;
    await oldCreate(exactRead);
    await fixture.client.read();
    assert.equal(posts, 1, change);
    assert.equal(fixture.client.getState().policies.length, 0);
    assert.equal(fixture.storage.values.size, 1);
    fixture.client.suspend();
  }
});

test('unavailable storage blocks new grants and exact argument parsing rejects nonobjects and oversized values', async () => {
  const storage = memory();
  storage.setItem = () => {
    throw new Error('blocked');
  };
  let posts = 0;
  const { client } = await clientFixture(async (url, init) => {
    if (init?.method === 'POST') posts++;
    return choices(url);
  }, storage);
  await client.create(exactRead);
  assert.equal(posts, 0);
  assert.equal(client.getState().blocked, true);
  const module = await compile('web/src/appPolicies.ts', '', environment());
  for (const text of ['null', '[]', '"text"', '{', JSON.stringify({ q: 'x'.repeat(16384) })])
    assert.throws(() => module.policyArguments(text));
  assert.equal(module.policyArguments('{"q":"newer_than:1d"}').q, 'newer_than:1d');
  client.suspend();
});

test('explicit scope conflicts are localized without discarding the uncertain request identifier', async () => {
  const { client } = await clientFixture(async (url, init) => {
    if (init?.method === 'POST')
      return json({ code: 'APP_POLICY_CHANGED', error: 'opaque server detail' }, 409);
    return choices(url);
  });
  await client.create(exactRead);
  assert.match(client.getState().error, /routine or application tool has changed/);
  assert.ok(client.getState().pendingId);
  client.suspend();
});
