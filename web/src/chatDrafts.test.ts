import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSubmittedDraft, emptyComposer, makeSendAttempt, submissionKey } from './chatDrafts';

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
