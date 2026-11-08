import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatQuestionSelection, parseChatQuestion } from './chat-questions.js';

const pending = {
  version: 1,
  question: '需要准备哪些材料？',
  mode: 'multiple',
  options: [
    { id: 'timeline', label: '时间表', description: '包含关键日期' },
    { id: 'notes', label: '会议笔记' },
    { id: 'risks', label: '风险清单' },
  ],
  requester: { userId: 'original-actor', messageId: 'input-message' },
  runId: 'root-run',
  status: 'pending',
};

test('question parsing enforces bounded data and accepts a pending question without an answer', () => {
  const card = parseChatQuestion(pending);
  assert.equal(card?.question, pending.question);
  assert.equal(card?.status, 'pending');
  assert.equal(card?.options[0].description, '包含关键日期');
  for (const value of [
    { ...pending, question: '😀'.repeat(251) },
    { ...pending, options: [{ id: 'a', label: 'A' }] },
    { ...pending, options: [pending.options[0], { id: 'timeline', label: 'Duplicate' }] },
    { ...pending, options: [pending.options[0], { id: 'bad/id', label: 'Invalid' }] },
    {
      ...pending,
      options: [pending.options[0], { id: 'b', label: 'B', url: 'https://example.test' }],
    },
    { ...pending, requester: { userId: '', messageId: 'root' } },
    { ...pending, answer: {} },
  ]) {
    assert.equal(parseChatQuestion(value), undefined);
  }
});

test('selection uses option order and rejects unknown, duplicate or excessive options', () => {
  const card = parseChatQuestion(pending);
  assert.ok(card);
  assert.deepEqual(normalizeChatQuestionSelection(card, ['risks', 'timeline']), [
    'timeline',
    'risks',
  ]);
  for (const selection of [null, [], ['timeline', 'timeline'], ['unknown'], ['notes', {}]]) {
    assert.equal(normalizeChatQuestionSelection(card, selection), undefined);
  }
  assert.equal(
    normalizeChatQuestionSelection({ ...card, mode: 'single' }, ['notes', 'risks']),
    undefined,
  );
});

test('an answered card requires selected options and a valid answer message binding', () => {
  const answer = {
    optionIds: ['notes'],
    messageId: 'answer-message',
    submittedAt: '2026-11-08T05:20:00.000Z',
  };
  assert.deepEqual(parseChatQuestion({ ...pending, status: 'answered', answer })?.answer, answer);
  assert.equal(
    parseChatQuestion({
      ...pending,
      status: 'answered',
      answer: { ...answer, messageId: '../stale' },
    }),
    undefined,
  );
  assert.equal(
    parseChatQuestion({
      ...pending,
      status: 'answered',
      answer: { ...answer, optionIds: ['other'] },
    }),
    undefined,
  );
});
