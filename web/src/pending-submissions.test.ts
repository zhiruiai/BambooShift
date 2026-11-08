import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingSubmissions } from './pendingSubmissions.js';
import {
  clearSubmittedDraft,
  emptyComposer,
  makeSendAttempt,
  type ComposerState,
  type SendAttempt,
} from './chatDrafts.js';
import type { Message } from '../../shared/types.js';

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
function draft(text = 'Synthetic private text', fields: Partial<ComposerState> = {}) {
  return { ...emptyComposer(), text, ...fields };
}
function receipt(attempt: SendAttempt, fields: Partial<Message> = {}): Message {
  return {
    id: 'stored-message',
    role: 'user',
    userId: 'person-a',
    content: attempt.content,
    conversationId: attempt.conversationId,
    createdAt: new Date().toISOString(),
    delivery: { state: 'delivered', mode: attempt.mode, clientId: attempt.clientId },
    ...fields,
  };
}
function registry(
  saved = storage(),
  fields: Partial<Parameters<typeof createPendingSubmissions>[0]> = {},
) {
  return createPendingSubmissions({
    userId: 'person-a',
    workspaceId: 'space-a',
    storage: saved,
    ...fields,
  });
}

test('a pinned app receipt requires the same connection and revision', async () => {
  const saved = storage();
  const initial = registry(saved);
  const app = {
    connectionId: 'synthetic-app',
    revision: 'secret-free-revision',
    name: 'Private name',
  };
  const first = await initial.prepare(
    makeSendAttempt('conversation-a', draft(undefined, { appContext: app })),
  );
  const persisted = [...saved.values.values()].join('');
  assert.doesNotMatch(persisted, /synthetic-app|secret-free-revision|Private name/);
  const reloaded = registry(saved);
  const retry = await reloaded.prepare(makeSendAttempt('conversation-a', first.snapshot));
  assert.equal(retry.clientId, first.clientId);
  assert.equal(reloaded.confirm(receipt(retry)), undefined);
  assert.equal(
    reloaded.confirm(receipt(retry, { appContext: { ...app, revision: 'different' } })),
    undefined,
  );
  assert.equal(reloaded.pending(), 1);
  assert.equal(reloaded.confirm(receipt(retry, { appContext: app })), retry);
  assert.equal(reloaded.pending(), 0);
});

test('reload reuses an unresolved receipt ID without persisting text, attachment data or quote text', async () => {
  const saved = storage();
  const first = registry(saved);
  const original = draft('Private draft sentinel', {
    attachments: [
      {
        id: 'file-id',
        name: 'Private document sentinel.pdf',
        type: 'application/pdf',
        size: 25,
        createdAt: '2026-11-04',
      },
    ],
    replyTo: {
      id: 'quote-id',
      author: 'Private author sentinel',
      content: 'Private quoted sentinel',
    },
  });
  const initial = await first.prepare(makeSendAttempt('conversation-a', original));
  assert.equal(first.pending(), 1);
  assert.equal(first.persistent, true);
  const bytes = [...saved.values.values()].join('');
  for (const value of ['Private', 'file-id', 'quote-id', initial.content])
    assert.ok(!bytes.includes(value));
  const data = JSON.parse(bytes);
  assert.deepEqual(Object.keys(data.records[0]).sort(), [
    'clientId',
    'conversationId',
    'createdAt',
    'fingerprint',
  ]);
  assert.match(data.records[0].fingerprint, /^[0-9a-f]{64}$/);
  const reloaded = registry(saved);
  assert.equal(reloaded.pending('conversation-a'), 1);
  const retry = await reloaded.prepare(makeSendAttempt('conversation-a', { ...original }));
  assert.equal(retry.clientId, initial.clientId);
  assert.equal(reloaded.confirm(receipt(retry)), retry);
  assert.equal(reloaded.pending(), 0);
  assert.equal(registry(saved).pending(), 0);
});

test('same text in another conversation, mode, quote or attachment gets a distinct ID', async () => {
  const pending = registry();
  const original = await pending.prepare(makeSendAttempt('conversation-a', draft()));
  const variants = [
    makeSendAttempt('conversation-b', draft()),
    makeSendAttempt('conversation-a', draft('Another message')),
    makeSendAttempt('conversation-a', draft(undefined, { mode: 'followUp' })),
    makeSendAttempt(
      'conversation-a',
      draft(undefined, { replyTo: { id: 'quote-a', author: 'A', content: 'quoted' } }),
    ),
    makeSendAttempt(
      'conversation-a',
      draft(undefined, {
        attachments: [{ id: 'file', name: 'file.txt', type: 'text/plain', size: 2, createdAt: '' }],
      }),
    ),
  ];
  for (const variant of variants)
    assert.notEqual((await pending.prepare(variant)).clientId, original.clientId);
  assert.equal(pending.pending(), 6);
  assert.equal(pending.pending('conversation-b'), 1);
});

test('receipt identity requires the authenticated author and exact conversation and client IDs', async () => {
  const pending = registry();
  const attempt = await pending.prepare(makeSendAttempt('conversation-a', draft()));
  for (const fields of [
    { userId: 'person-b' },
    { userId: undefined },
    { role: 'assistant' as const },
    { role: 'system' as const },
    { conversationId: 'conversation-b' },
    { delivery: undefined },
    { delivery: { state: 'delivered' as const, mode: 'steer' as const, clientId: 'another-id' } },
  ]) {
    assert.equal(pending.confirm(receipt(attempt, fields)), undefined);
    assert.equal(pending.pending(), 1);
    assert.equal(pending.wasConfirmed(attempt), false);
  }
  assert.equal(pending.confirm(receipt(attempt)), attempt);
  assert.equal(pending.wasConfirmed(attempt), true);
  assert.equal(pending.confirm(receipt(attempt)), undefined);
  const local = registry(storage(), { userId: undefined });
  const localAttempt = await local.prepare(makeSendAttempt('conversation-a', draft()));
  assert.equal(local.confirm(receipt(localAttempt)), undefined);
  assert.equal(local.confirm(receipt(localAttempt, { userId: undefined })), localAttempt);
});

test('different accounts and workspaces cannot recover one another’s pending submission IDs', async () => {
  const saved = storage();
  const original = await registry(saved).prepare(makeSendAttempt('conversation-a', draft()));
  for (const fields of [
    { userId: 'person-b' },
    { userId: undefined },
    { workspaceId: 'space-b' },
    { userId: 'person-a:space-a', workspaceId: '' },
  ]) {
    const other = registry(saved, fields);
    assert.equal(other.pending(), 0);
    assert.notEqual(
      (await other.prepare(makeSendAttempt('conversation-a', draft()))).clientId,
      original.clientId,
    );
  }
  assert.equal(registry(saved).pending(), 1);
  assert.equal(saved.values.size, 5);
});

test('a stream receipt preceding a lost POST response resolves the attempt without clearing a newer draft', async () => {
  const pending = registry();
  const oldDraft = draft();
  const attempt = await pending.prepare(makeSendAttempt('conversation-a', oldDraft));
  const newDraft = draft('The next message, still being edited');
  const acknowledged = pending.confirm(receipt(attempt));
  assert.ok(acknowledged);
  assert.equal(clearSubmittedDraft(newDraft, acknowledged.snapshot), newDraft);
  assert.equal(clearSubmittedDraft(oldDraft, acknowledged.snapshot).text, '');
  // The HTTP rejection handler checks this instead of displaying a false error.
  assert.equal(pending.wasConfirmed(attempt), true);
  assert.equal(pending.pending(), 0);
  assert.equal(await pending.prepare(attempt), attempt);
  assert.equal(pending.pending(), 0);
  const explicitNewMessage = await pending.prepare(makeSendAttempt('conversation-a', draft()));
  assert.notEqual(explicitNewMessage.clientId, attempt.clientId);
});

test('a recovered snapshot can retire metadata even when the original draft is no longer in memory', async () => {
  const saved = storage();
  const attempt = await registry(saved).prepare(makeSendAttempt('conversation-a', draft()));
  const reloaded = registry(saved);
  assert.equal(reloaded.confirm(receipt(attempt)), undefined);
  assert.equal(reloaded.wasConfirmed(attempt), true);
  assert.equal(reloaded.pending(), 0);
  assert.equal(registry(saved).pending(), 0);
});

test('a definite rejection retires only that prepared fingerprint without confirming it', async () => {
  const saved = storage();
  const pending = registry(saved);
  const refused = await pending.prepare(makeSendAttempt('conversation-a', draft('Refused')));
  const other = await pending.prepare(makeSendAttempt('conversation-a', draft('Still unknown')));
  const anotherConversation = await pending.prepare(
    makeSendAttempt('conversation-b', draft('Refused')),
  );
  const changed = {
    ...makeSendAttempt('conversation-a', draft('Changed')),
    clientId: refused.clientId,
  };
  await assert.rejects(pending.prepare(changed), /内容已变化/);
  pending.reject(changed);
  assert.equal(pending.pending(), 3);
  // A different object not returned by prepare has no verified fingerprint.
  pending.reject({ ...refused });
  assert.equal(pending.pending(), 3);
  const originalSnapshot = refused.snapshot;
  refused.snapshot = draft('A changed snapshot');
  pending.reject(refused);
  assert.equal(pending.pending(), 3);
  refused.snapshot = originalSnapshot;
  pending.reject(refused);
  assert.equal(pending.wasConfirmed(refused), false);
  assert.equal(pending.pending(), 2);
  assert.equal(registry(saved).pending(), 2);
  assert.equal(pending.confirm(receipt(other)), other);
  pending.reject(other);
  assert.equal(pending.wasConfirmed(other), true);
  assert.equal(pending.pending(), 1);
  assert.equal(pending.confirm(receipt(anotherConversation)), anotherConversation);
});

test('rejecting after reload requires preparing the recovered ID and leaves other metadata intact', async () => {
  const saved = storage();
  const original = await registry(saved).prepare(makeSendAttempt('conversation-a', draft()));
  const reloaded = registry(saved);
  reloaded.reject(original);
  assert.equal(reloaded.pending(), 1);
  const retry = await reloaded.prepare(makeSendAttempt('conversation-a', draft()));
  assert.equal(retry.clientId, original.clientId);
  reloaded.reject(retry);
  assert.equal(reloaded.pending(), 0);
  assert.equal(reloaded.wasConfirmed(retry), false);
  assert.equal(registry(saved).pending(), 0);
});

test('concurrent equivalent preparation keeps one ID in either fingerprint completion order', async (t) => {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const release: Array<() => void> = [];
  t.mock.method(
    crypto.subtle,
    'digest',
    (algorithm: AlgorithmIdentifier, data: BufferSource) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        release.push(() => {
          void digest(algorithm, data).then(resolve, reject);
        });
      }),
  );
  for (const order of [
    [0, 1],
    [1, 0],
  ] as const) {
    const pending = registry();
    const originals = [
      makeSendAttempt('conversation-a', draft()),
      makeSendAttempt('conversation-a', draft()),
    ];
    const preparing = originals.map((attempt) => pending.prepare(attempt));
    const finish = release.splice(0);
    finish[order[0]]();
    await preparing[order[0]];
    finish[order[1]]();
    const prepared = await Promise.all(preparing);
    assert.equal(prepared[0].clientId, prepared[1].clientId);
    assert.equal(prepared[0].snapshot, originals[0].snapshot);
    assert.equal(prepared[1].snapshot, originals[1].snapshot);
    assert.equal(pending.pending(), 1);
    assert.equal(pending.confirm(receipt(prepared[0])), prepared[order[1]]);
  }
});

test('a receipt arriving during async fingerprinting preserves the confirmed ID instead of sending twice', async () => {
  const saved = storage();
  const original = await registry(saved).prepare(makeSendAttempt('conversation-a', draft()));
  const reloaded = registry(saved);
  const retryDraft = draft();
  const preparing = reloaded.prepare(makeSendAttempt('conversation-a', retryDraft));
  reloaded.confirm(receipt(original));
  const prepared = await preparing;
  assert.equal(prepared.clientId, original.clientId);
  assert.equal(reloaded.wasConfirmed(prepared), true);
  assert.equal(reloaded.pending(), 0);
  assert.equal(clearSubmittedDraft(retryDraft, prepared.snapshot).text, '');
  assert.equal(registry(saved).pending(), 0);
});

test('the unresolved capacity refuses new messages while permitting retries and confirmation', async () => {
  const pending = registry();
  const attempts: SendAttempt[] = [];
  for (let i = 0; i < 100; i++)
    attempts.push(await pending.prepare(makeSendAttempt('conversation-a', draft(`Message ${i}`))));
  assert.equal(pending.pending(), 100);
  await assert.rejects(
    pending.prepare(makeSendAttempt('conversation-a', draft('Overflow'))),
    /尚未确认/,
  );
  assert.equal(pending.pending(), 100);
  assert.equal(
    (await pending.prepare(makeSendAttempt('conversation-a', draft('Message 0')))).clientId,
    attempts[0].clientId,
  );
  pending.confirm(receipt(attempts[1]));
  await pending.prepare(makeSendAttempt('conversation-a', draft('After confirmation')));
  assert.equal(pending.pending(), 100);
});

test('expired metadata is retired and unavailable or malformed storage does not claim persistent recovery', async () => {
  const saved = storage();
  let clock = 1_800_000_000_000;
  const first = registry(saved, { now: () => clock });
  const attempt = await first.prepare(makeSendAttempt('conversation-a', draft()));
  clock += 7 * 24 * 60 * 60 * 1000;
  assert.equal(first.pending(), 0);
  assert.equal(registry(saved, { now: () => clock }).pending(), 0);
  assert.notEqual(
    (await first.prepare(makeSendAttempt('conversation-a', draft()))).clientId,
    attempt.clientId,
  );
  const key = [...saved.values.keys()][0];
  saved.values.set(key, '{invalid JSON');
  const malformed = registry(saved);
  assert.equal(malformed.persistent, false);
  assert.equal(malformed.pending(), 0);
  const volatile = await malformed.prepare(makeSendAttempt('conversation-a', draft()));
  assert.equal(malformed.pending(), 1);
  assert.equal(saved.getItem(key), '{invalid JSON');
  assert.equal(malformed.confirm(receipt(volatile)), volatile);
  for (const failure of ['get', 'set']) {
    const unavailable = createPendingSubmissions({
      userId: 'person-a',
      workspaceId: 'space-a',
      storage: {
        getItem: () => {
          if (failure === 'get') throw new Error('Storage denied');
          return null;
        },
        setItem: () => {
          throw new Error('Storage quota exceeded');
        },
      },
    });
    const active = await unavailable.prepare(makeSendAttempt('conversation-a', draft()));
    assert.equal(unavailable.persistent, false);
    assert.equal(unavailable.pending(), 1);
    assert.equal(unavailable.confirm(receipt(active)), active);
  }
});

test('loading saved metadata filters invalid records and strips unknown fields', async () => {
  const saved = storage();
  const clock = 1_800_000_000_000;
  const attempt = await registry(saved, { now: () => clock }).prepare(
    makeSendAttempt('conversation-a', draft()),
  );
  const key = [...saved.values.keys()][0];
  const valid = JSON.parse(saved.getItem(key)!).records[0];
  saved.values.set(
    key,
    JSON.stringify({
      version: 1,
      records: [
        { ...valid, content: 'unexpected private body', token: 'unexpected token' },
        { ...valid, clientId: 'future', createdAt: clock + 600_000 },
        { ...valid, clientId: 'bad-hash', fingerprint: 'bad' },
        { ...valid, clientId: 'control\ncharacter' },
        { ...valid, clientId: 'expired', createdAt: clock - 8 * 24 * 60 * 60 * 1000 },
        null,
        'string',
      ],
    }),
  );
  const loaded = registry(saved, { now: () => clock });
  assert.equal(loaded.pending(), 1);
  assert.ok(!saved.getItem(key)!.includes('unexpected'));
  assert.equal(
    (await loaded.prepare(makeSendAttempt('conversation-a', draft()))).clientId,
    attempt.clientId,
  );
});

test('explicit recipient retries recover the same ID after reload while another recipient or no recipient remains distinct', async () => {
  const saved = storage();
  const original = await registry(saved).prepare(
    makeSendAttempt('conversation-a', draft('相同正文', { agentId: 'bot-a' })),
  );
  const next = registry(saved);
  const retry = await next.prepare(
    makeSendAttempt('conversation-a', draft('相同正文', { agentId: 'bot-a' })),
  );
  assert.equal(retry.clientId, original.clientId);
  assert.equal(retry.agentId, 'bot-a');
  const other = await next.prepare(
    makeSendAttempt('conversation-a', draft('相同正文', { agentId: 'bot-b' })),
  );
  const automatic = await next.prepare(makeSendAttempt('conversation-a', draft('相同正文')));
  assert.notEqual(other.clientId, original.clientId);
  assert.notEqual(automatic.clientId, original.clientId);
  assert.equal(next.pending(), 3);
  const wrong = receipt(retry, {
    delivery: { state: 'delivered', mode: retry.mode, clientId: retry.clientId, agentId: 'bot-b' },
  });
  assert.equal(next.confirm(wrong), undefined);
  assert.equal(next.pending(), 3);
  assert.equal(
    next.confirm({ ...wrong, delivery: { ...wrong.delivery!, agentId: 'bot-a' } }),
    retry,
  );
  assert.equal(next.pending(), 2);
  assert.doesNotMatch([...saved.values.values()].join(''), /相同正文|bot-a|bot-b/);
});

test('legacy three-part fingerprints still recover untargeted sends and cannot claim a newly targeted send', async () => {
  const saved = storage(),
    original = draft('升级前的草稿');
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([original.text, '', original.mode])),
  );
  const fingerprint = [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  const clientId = crypto.randomUUID();
  saved.values.set(
    'openbot-pending-v1:["person-a","space-a"]',
    JSON.stringify({
      version: 1,
      records: [{ conversationId: 'conversation-a', clientId, fingerprint, createdAt: Date.now() }],
    }),
  );
  const pending = registry(saved);
  assert.equal(
    (await pending.prepare(makeSendAttempt('conversation-a', original))).clientId,
    clientId,
  );
  assert.notEqual(
    (await pending.prepare(makeSendAttempt('conversation-a', { ...original, agentId: 'bot-a' })))
      .clientId,
    clientId,
  );
  const targeted = makeSendAttempt('conversation-a', { ...original, agentId: 'bot-a' });
  await assert.rejects(pending.prepare({ ...targeted, agentId: 'bot-b' }), /收件人已变化/);
  await assert.rejects(pending.prepare({ ...targeted, agentId: undefined }), /收件人已变化/);
});
