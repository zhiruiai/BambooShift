import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesChatMentionReceipt } from '../../shared/chat-mentions';
import { emptyComposer, makeSendAttempt } from './chatDrafts';
import { removeMention, selectBotMention } from './composerMentions';
import { createPendingSubmissions } from './pendingSubmissions';
import type { Message } from '../../shared/types';

test('selecting and removing multiple recipients retains inline task labels and ordered intent', () => {
  const draft = { ...emptyComposer(), text: '@Research (AI) verify; @Reviewer finish.' };
  const first = selectBotMention(draft, 'research', true);
  assert.equal(first.agentId, 'research');
  const group = selectBotMention(first, 'review', true);
  assert.deepEqual(group.mentions, { agentIds: ['research', 'review'] });
  assert.equal(group.agentId, undefined);
  assert.equal(selectBotMention(group, 'research', true), group);
  const reduced = removeMention(group, 'research', 'Research (AI)');
  assert.equal(reduced.text, 'Research (AI) verify; @Reviewer finish.');
  assert.equal(reduced.agentId, 'review');
  assert.equal(reduced.mentions, undefined);
  const app = { ...first, appContext: { connectionId: 'app', revision: 'r1', name: 'Issues' } };
  const redirected = selectBotMention(app, 'review', true);
  assert.equal(redirected.agentId, 'review');
  assert.equal(redirected.appContext, app.appContext);
  assert.equal(redirected.mentions, undefined);
});

test('pending receipts bind the exact audience without trusting the current group roster', async () => {
  const draft = { ...emptyComposer(), text: 'Review' };
  const group = selectBotMention(selectBotMention(draft, 'a', true), 'b', true);
  const attempt = makeSendAttempt('group', group, undefined, 'root');
  assert.deepEqual(attempt.mentions, { agentIds: ['a', 'b'] });
  assert.equal(makeSendAttempt('group', group, attempt, 'root').clientId, attempt.clientId);
  assert.notEqual(
    makeSendAttempt('group', { ...group, mentions: { everyone: true } }, attempt, 'root').clientId,
    attempt.clientId,
  );
  const pending = createPendingSubmissions({ workspaceId: 'space', userId: 'me' });
  const prepared = await pending.prepare(attempt);
  const receipt: Message = {
    id: 'received',
    conversationId: 'group',
    role: 'user',
    userId: 'me',
    threadRootId: 'root',
    content: 'Review',
    createdAt: '',
    delivery: { clientId: prepared.clientId, state: 'queued', mode: 'steer' },
    mentions: { agentIds: ['b', 'a'] },
  };
  assert.equal(pending.confirm(receipt), undefined);
  assert.equal(pending.pending('group', 'root'), 1);
  assert.equal(pending.confirm({ ...receipt, mentions: { agentIds: ['a', 'b'] } }), prepared);
  assert.equal(pending.pending(), 0);
  assert.equal(
    matchesChatMentionReceipt(
      { everyone: true },
      { agentIds: ['first', 'second'], everyone: true },
    ),
    true,
  );
  assert.equal(
    matchesChatMentionReceipt({ everyone: true }, { agentIds: ['first', 'first'], everyone: true }),
    false,
  );
});
