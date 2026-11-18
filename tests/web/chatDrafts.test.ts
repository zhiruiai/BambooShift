import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingSubmissions } from '../../web/src/pendingSubmissions';
import { clearSubmittedDraft, emptyComposer, makeSendAttempt, submissionKey } from '../../web/src/chatDrafts';

test('explicit recipients are captured in send attempts and changes create a distinct request identity', () => {
  const ordinary = { ...emptyComposer(), text: ' 相同的要求 ' };
  assert.equal(submissionKey(ordinary), JSON.stringify(['相同的要求', '', 'steer']));
  const first = makeSendAttempt('group-a', { ...ordinary, agentId: 'bot-a' });
  assert.equal(first.agentId, 'bot-a');
  const retry = makeSendAttempt('group-a', { ...first.snapshot }, first);
  assert.equal(retry.clientId, first.clientId);
  assert.equal(retry.agentId, 'bot-a');
  const changed = makeSendAttempt('group-a', { ...first.snapshot, agentId: 'bot-b' }, first);
  assert.notEqual(changed.clientId, first.clientId);
  assert.equal(changed.agentId, 'bot-b');
  assert.notEqual(submissionKey(first.snapshot), submissionKey(changed.snapshot));
  const removed = makeSendAttempt('group-a', ordinary, first);
  assert.notEqual(removed.clientId, first.clientId);
  assert.equal(removed.agentId, undefined);
});

test('successful send clears only its exact draft and its recipient while a newer draft keeps all contents', () => {
  const snapshot = {
    ...emptyComposer(),
    text: '明确发送给小松',
    agentId: 'bot-a',
    replyTo: { id: 'message-a', author: '小鱼', content: '引用' },
    attachments: [{ id: 'file-a', name: 'input.txt', size: 3, type: 'text/plain', createdAt: '' }],
  };
  const cleared = clearSubmittedDraft(snapshot, snapshot);
  assert.equal(cleared.agentId, undefined);
  assert.equal(cleared.text, '');
  assert.equal(cleared.replyTo, undefined);
  assert.deepEqual(cleared.attachments, []);
  const newer = { ...snapshot, text: '我的新草稿', agentId: 'bot-b' };
  assert.equal(clearSubmittedDraft(newer, snapshot), newer);
  assert.equal(newer.replyTo, snapshot.replyTo);
  assert.equal(newer.attachments, snapshot.attachments);
});

test('the selected application revision participates in retries without sending its display name', () => {
  const draft = {
    ...emptyComposer(),
    text: 'Review a ticket',
    appContext: { connectionId: 'app-a', revision: 'rev-a', name: 'Issues' },
  };
  const attempt = makeSendAttempt('chat-a', draft);
  assert.deepEqual(attempt.appContext, { connectionId: 'app-a', revision: 'rev-a' });
  assert.equal(makeSendAttempt('chat-a', { ...draft }, attempt).clientId, attempt.clientId);
  const changed = { ...draft, appContext: { ...draft.appContext, revision: 'rev-b' } };
  assert.notEqual(makeSendAttempt('chat-a', changed, attempt).clientId, attempt.clientId);
  assert.equal(clearSubmittedDraft(draft, draft).appContext, undefined);
  assert.deepEqual(clearSubmittedDraft(changed, draft).appContext, changed.appContext);
});

test('a viewed website version pins the send and leaves the actual draft available for clearing', () => {
  const draft = { ...emptyComposer(), text: 'Change the heading.' };
  const first = makeSendAttempt('chat-a', draft, undefined, 'thread-a', 'delivery-a');
  const retry = makeSendAttempt('chat-a', draft, first, 'thread-a', 'delivery-a');
  const next = makeSendAttempt('chat-a', draft, first, 'thread-a', 'delivery-b');
  assert.equal(retry, first);
  assert.equal(first.replyToMessageId, 'delivery-a');
  assert.equal(next.replyToMessageId, 'delivery-b');
  assert.notEqual(next.clientId, first.clientId);
  assert.equal(first.snapshot, draft);
  assert.equal(clearSubmittedDraft(draft, first.snapshot).text, '');

  const quoted = { ...draft, replyTo: { id: 'chosen', author: 'Bot', content: 'Reference' } };
  assert.equal(
    makeSendAttempt('chat-a', quoted, next, 'thread-a', 'delivery-b').replyToMessageId,
    'chosen',
  );
});

test('website preview retries recover per quoted version and confirm only an exact quote', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const registry = () =>
    createPendingSubmissions({ userId: 'person-a', workspaceId: 'space-a', storage });
  const compose = { ...emptyComposer(), text: 'Change the heading.' };
  const first = await registry().prepare(
    makeSendAttempt('conversation-a', compose, undefined, 'thread-a', 'website-delivery-a'),
  );
  const reloaded = registry();
  const recovery = await reloaded.prepare(
    makeSendAttempt('conversation-a', compose, undefined, 'thread-a', 'website-delivery-a'),
  );
  const different = await reloaded.prepare(
    makeSendAttempt('conversation-a', compose, undefined, 'thread-a', 'website-delivery-b'),
  );
  assert.equal(first.clientId, recovery.clientId);
  assert.notEqual(first.clientId, different.clientId);
  assert.doesNotMatch([...values.values()].join(''), /website-delivery-a|website-delivery-b/);
  const receipt = {
    id: 'persisted',
    role: 'user' as const,
    userId: 'person-a',
    content: compose.text,
    conversationId: 'conversation-a',
    threadRootId: 'thread-a',
    createdAt: '',
    delivery: { state: 'delivered' as const, mode: 'steer' as const, clientId: recovery.clientId },
  };
  const quote = { id: 'website-delivery-b', author: 'Bot', content: 'Website' };
  assert.equal(reloaded.confirm({ ...receipt, replyTo: quote }), undefined);
  assert.equal(
    reloaded.confirm({ ...receipt, replyTo: { ...quote, id: 'website-delivery-a' } }),
    recovery,
  );
});
