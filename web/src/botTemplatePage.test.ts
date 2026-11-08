import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccountSession, WorkspaceSummary } from '../../shared/platform';
import type { PublishedBotTemplate } from '../../shared/bot-templates';
import {
  createTemplatePageReader,
  createSharingPolicyEditor,
  templateImportTargets,
  sharingModes,
} from './platform/botTemplatePageState';
import { accountEntryPath, safeAccountNext } from './platform/platformApi';
import { createBotTemplateScope } from './botTemplates';

const token = 'a'.repeat(43),
  workspaceId = '11111111-1111-4111-8111-111111111111';
const space: WorkspaceSummary = {
  id: workspaceId,
  name: '个人空间',
  kind: 'personal',
  role: 'owner',
  status: 'active',
  createdAt: '2026-11-05T00:00:00Z',
};
const session = (id: string): AccountSession => ({
  authenticated: true,
  user: { id, name: id, email: `${id}@example.test`, status: 'active', createdAt: space.createdAt },
  workspaces: [space],
});
const template: PublishedBotTemplate = {
  token,
  revision: 'publication-1',
  digest: 'digest',
  audience: 'public',
  publishedAt: space.createdAt,
  blueprint: {
    version: 1,
    profile: {
      name: '研究助手',
      role: '研究',
      description: '查证资料',
      instructions: '列出来源',
      color: '#8a61bf',
      avatar: 'leaf',
    },
    skills: [],
    routines: [],
  },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('login/register return permits only complete template tokens and preserves existing safe workspace links', () => {
  const path = `/templates/${token}`;
  assert.equal(safeAccountNext(path), path);
  assert.equal(safeAccountNext(path + '/'), path);
  assert.equal(accountEntryPath('register', path), `/register?next=${encodeURIComponent(path)}`);
  assert.equal(
    safeAccountNext(`/w/${workspaceId}?conversation=dm-1`),
    `/w/${workspaceId}?conversation=dm-1`,
  );
  for (const value of [
    path + '?next=https://evil.test',
    path + '#fragment',
    path + '/edit',
    '/templates/' + 'a'.repeat(42),
    '//evil.test/templates/' + token,
    '/templates/%61' + 'a'.repeat(42),
    '/templates/..%2faccount',
    'https://evil.test',
    '/templates/\\' + token,
  ])
    assert.equal(safeAccountNext(value), '', value);
});

test('public preview reads account first then explicitly omits credentials for anonymous viewer', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const reader = createTemplatePageReader({
    token,
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });
      return json(calls.length === 1 ? { authenticated: false, workspaces: [] } : template);
    }) as typeof fetch,
  });
  await reader.read();
  assert.deepEqual(
    calls.map((call) => call.url),
    ['/api/account/session', `/api/bot-template-links/${token}`],
  );
  assert.equal(calls[0].init?.credentials, 'same-origin');
  assert.equal(calls[1].init?.credentials, 'omit');
  assert.equal(calls[1].init?.headers, undefined);
  assert.equal(reader.state.preview?.revision, template.revision);
});

test('signed-in preview pins expected account and denied team response clears prior body', async () => {
  let allowed = true;
  const reader = createTemplatePageReader({
    token,
    fetch: (async (url, init) => {
      if (String(url).endsWith('/account/session')) return json(session('owner-a'));
      assert.equal(init?.credentials, 'same-origin');
      assert.equal(new Headers(init?.headers).get('X-OpenBot-Expected-User'), 'owner-a');
      return allowed ? json({ ...template, audience: 'team' }) : json({ error: '模板不可用' }, 404);
    }) as typeof fetch,
  });
  await reader.read();
  assert.equal(reader.state.preview?.audience, 'team');
  allowed = false;
  await reader.read();
  assert.equal(reader.state.preview, undefined);
  assert.match(reader.state.error, /不可用/);
});

test('new account wins over a delayed old-account preview even when transport ignores abort', async () => {
  const old = deferred<Response>();
  let account = 'owner-a',
    oldStarted = false;
  const reader = createTemplatePageReader({
    token,
    fetch: (async (url, init) => {
      if (String(url).endsWith('/account/session')) return json(session(account));
      const expected = new Headers(init?.headers).get('X-OpenBot-Expected-User');
      if (expected === 'owner-a') {
        oldStarted = true;
        return old.promise;
      }
      return json({ error: '没有权限' }, 403);
    }) as typeof fetch,
  });
  const first = reader.read();
  while (!oldStarted) await flush();
  account = 'owner-b';
  await reader.read();
  old.resolve(json({ ...template, audience: 'team' }));
  await first;
  assert.equal(reader.state.session?.user?.id, 'owner-b');
  assert.equal(reader.state.preview, undefined);
  assert.match(reader.state.error, /没有权限/);
});

test('leaving the template page prevents delayed account/body publication and no request on invalid token', async () => {
  const response = deferred<Response>();
  let calls = 0,
    updates = 0;
  const reader = createTemplatePageReader({
    token,
    fetch: (async () => {
      calls++;
      return response.promise;
    }) as typeof fetch,
    onChange: () => updates++,
  });
  const pending = reader.read();
  reader.suspend();
  const before = updates;
  response.resolve(json(session('owner-a')));
  await pending;
  assert.equal(updates, before);
  assert.equal(calls, 1);
  const invalid = createTemplatePageReader({
    token: 'short',
    fetch: (async () => {
      throw new Error('must not dispatch');
    }) as typeof fetch,
  });
  await invalid.read();
  assert.match(invalid.state.error, /格式/);
});

test('import targets contain active owned spaces only and personal policy never offers team-only', () => {
  const account = session('owner-a');
  account.workspaces = [
    space,
    { ...space, id: 'member', role: 'member' },
    { ...space, id: 'suspended', status: 'suspended' },
    { ...space, id: 'team', kind: 'team' },
  ];
  assert.deepEqual(
    templateImportTargets(account).map((item) => item.id),
    [workspaceId, 'team'],
  );
  assert.deepEqual(templateImportTargets({ ...account, authenticated: false }), []);
  assert.deepEqual(
    templateImportTargets({ ...account, user: { ...account.user!, status: 'suspended' } }),
    [],
  );
  assert.deepEqual(sharingModes('personal'), ['public', 'disabled']);
  assert.deepEqual(sharingModes('team'), ['public', 'team-only', 'disabled']);
});

test('sharing policy CAS conflict retains intended choice, requires read and only explicit save uses new revision', async () => {
  let revision = 'r1',
    mode = 'team-only',
    conflict = true;
  const writes: unknown[] = [];
  const scope = createBotTemplateScope({
    workspaceId,
    userId: 'owner-a',
    identity: () => ({ workspaceId, userId: 'owner-a' }),
    locationPath: () => `/w/${workspaceId}/members`,
    fetch: (async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('X-OpenBot-Expected-User'), 'owner-a');
      if (init?.method !== 'PUT') return json({ revision, mode });
      writes.push(JSON.parse(String(init.body)));
      if (conflict) {
        revision = 'r2';
        mode = 'public';
        return json({ error: '策略已改变' }, 409);
      }
      revision = 'r3';
      mode = 'disabled';
      return json({ revision, mode });
    }) as typeof fetch,
  });
  const editor = createSharingPolicyEditor({ scope, kind: 'team' });
  await editor.read();
  editor.choose('disabled');
  await editor.save();
  assert.equal(editor.state.selection, 'disabled');
  assert.equal(editor.state.needsRefresh, true);
  await editor.save();
  assert.equal(writes.length, 1);
  await editor.read();
  assert.equal(editor.state.selection, 'disabled');
  assert.equal(editor.state.policy?.revision, 'r2');
  assert.equal(writes.length, 1);
  conflict = false;
  await editor.save();
  assert.deepEqual(writes, [
    { expectedRevision: 'r1', mode: 'disabled' },
    { expectedRevision: 'r2', mode: 'disabled' },
  ]);
  assert.equal(editor.state.policy?.mode, 'disabled');
});

test('policy response loss never retries and late response after account switch cannot update new screen', async () => {
  let currentUser = 'owner-a',
    puts = 0,
    late = false;
  const pending = deferred<Response>();
  const scope = createBotTemplateScope({
    workspaceId,
    userId: 'owner-a',
    identity: () => ({ workspaceId, userId: currentUser }),
    locationPath: () => '/members',
    fetch: (async (_url, init) => {
      if (init?.method !== 'PUT') return json({ revision: 'r1', mode: 'public' });
      puts++;
      if (late) return pending.promise;
      throw new TypeError('lost response');
    }) as typeof fetch,
  });
  let changed = 0;
  const editor = createSharingPolicyEditor({ scope, kind: 'personal', onChange: () => changed++ });
  await editor.read();
  editor.choose('team-only');
  assert.equal(editor.state.selection, 'public');
  editor.choose('disabled');
  await editor.save();
  await editor.save();
  assert.equal(puts, 1);
  assert.equal(editor.state.needsRefresh, true);
  await editor.read();
  late = true;
  const saving = editor.save();
  await flush();
  currentUser = 'owner-b';
  const previous = changed;
  pending.resolve(json({ revision: 'r2', mode: 'disabled' }));
  await saving;
  assert.equal(changed, previous);
  assert.equal(editor.state.policy?.revision, 'r1');
});
