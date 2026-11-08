import test from 'node:test';
import assert from 'node:assert/strict';
import { safeAccountNext, accountEntryPath } from './platform/platformApi';
import {
  createSharedBotPageReader,
  sharedBotPersonalTargets,
  sharedBotConversationPath,
  type SharedBotPageState,
} from './platform/sharedBotPageState';
import type { AccountSession } from '../../shared/platform';
import type { ConfirmedSharedBot } from './sharedBots';

const shareId = '11111111-1111-4111-8111-111111111111';
const session = (id: string): AccountSession => ({
  authenticated: true,
  user: { id, name: id, email: `${id}@example.test`, status: 'active', createdAt: '2026-11-05' },
  workspaces: [
    {
      id: 'personal',
      name: 'Personal',
      kind: 'personal',
      role: 'owner',
      status: 'active',
      createdAt: '2026-11-05',
    },
  ],
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('shared links keep a strict login/register return without redirects or encoded paths', () => {
  const path = `/shared-bots/${shareId}`;
  assert.equal(safeAccountNext(path), path);
  assert.equal(accountEntryPath('login', path), `/login?next=${encodeURIComponent(path)}`);
  for (const value of [
    path + '/',
    path + '?next=//evil.test',
    path + '#fragment',
    path + '/edit',
    `//evil.test${path}`,
    '/shared-bots/%31' + shareId.slice(1),
    '/shared-bots/../account',
    '/shared-bots/\\account',
  ])
    assert.equal(safeAccountNext(value), '', value);
});

test('late account response cannot restore old identity or a page that has closed; no source is read anonymously', async () => {
  let resolveOld!: (value: Response) => void;
  const old = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  let calls = 0,
    state: SharedBotPageState | undefined;
  const reader = createSharedBotPageReader({
    current: () => true,
    onChange: (value) => {
      state = value;
    },
    fetch: (async (path, init) => {
      assert.equal(path, '/api/account/session');
      assert.equal(init?.credentials, 'same-origin');
      return ++calls === 1 ? old : json(session('new-user'));
    }) as typeof fetch,
  });
  const first = reader.read();
  await reader.read();
  resolveOld(json(session('old-user')));
  await first;
  assert.equal(state?.session?.user?.id, 'new-user');
  reader.suspend();
  await reader.read();
  assert.equal(calls, 2);
});

test('loss of session clears private target choices and a team can never become the personal destination', async () => {
  let allowed = true,
    state: SharedBotPageState | undefined;
  const current = session('owner');
  current.workspaces.push(
    { ...current.workspaces[0], id: 'team', kind: 'team' },
    { ...current.workspaces[0], id: 'suspended', status: 'suspended' },
  );
  const reader = createSharedBotPageReader({
    current: () => true,
    onChange: (value) => {
      state = value;
    },
    fetch: (async () =>
      allowed ? json(current) : json({ error: 'unavailable' }, 503)) as typeof fetch,
  });
  await reader.read();
  assert.deepEqual(
    sharedBotPersonalTargets(state?.session).map((space) => space.id),
    ['personal'],
  );
  allowed = false;
  await reader.read();
  assert.deepEqual(sharedBotPersonalTargets(state?.session), []);
  assert.equal(state?.session, undefined);
});

test('confirmed join navigation rejects receipts from a changed account, target, or Bot', () => {
  const confirmed = {
    receipt: {
      actorId: 'owner',
      workspaceId: 'personal',
      shareId,
      agentId: 'alias',
      conversationId: 'dm',
    },
    agent: { id: 'alias', sharedBot: { shareId } },
    conversation: { id: 'dm', isGroup: false, agentIds: ['alias'] },
  } as ConfirmedSharedBot;
  const expected = { userId: 'owner', workspaceId: 'personal', shareId };
  assert.equal(sharedBotConversationPath(confirmed, expected), '/w/personal?conversation=dm');
  for (const changed of [
    { ...expected, userId: 'other' },
    { ...expected, workspaceId: 'other' },
    { ...expected, shareId: 'other' },
  ])
    assert.equal(sharedBotConversationPath(confirmed, changed), undefined);
  assert.equal(
    sharedBotConversationPath(
      { ...confirmed, conversation: { ...confirmed.conversation, agentIds: ['other'] } },
      expected,
    ),
    undefined,
  );
});
