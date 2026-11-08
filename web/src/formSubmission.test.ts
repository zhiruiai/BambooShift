import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormSubmission, type FormSaveResult } from './formSubmission.js';

function deferred() {
  let resolve!: (result: FormSaveResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<FormSaveResult>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('an explicit failed save keeps the memory editor and text until a successful retry', async () => {
  const submission = createFormSubmission();
  const editor = { text: 'Keep this edited preference', open: true };
  let resets = 0;
  const saved = () => {
    resets++;
    editor.text = '';
    editor.open = false;
  };
  const response = deferred();
  const pending = submission.submit(() => response.promise, saved);
  assert.equal(submission.pending, true);
  assert.deepEqual(editor, { text: 'Keep this edited preference', open: true });
  response.resolve({ ok: false, error: 'Unable to reach workspace' });
  assert.deepEqual(await pending, { ok: false, error: 'Unable to reach workspace' });
  assert.equal(resets, 0);
  assert.equal(submission.pending, false);
  assert.deepEqual(editor, { text: 'Keep this edited preference', open: true });
  assert.deepEqual(await submission.submit(async () => ({ ok: true }), saved), { ok: true });
  assert.equal(resets, 1);
  assert.deepEqual(editor, { text: '', open: false });
});

test('thrown failures become inline errors without closing the skill draft or trapping the submit lock', async () => {
  const submission = createFormSubmission();
  const draft = {
    name: 'Review workflow',
    description: 'Check work',
    content: 'Verify sources',
    open: true,
  };
  const original = structuredClone(draft);
  const saved = () => {
    draft.open = false;
    draft.content = '';
  };
  const response = deferred();
  const pending = submission.submit(() => response.promise, saved);
  response.reject(new Error('Permission changed'));
  assert.deepEqual(await pending, { ok: false, error: 'Permission changed' });
  assert.deepEqual(draft, original);
  assert.equal(submission.pending, false);
  const unknown = await submission.submit(async () => {
    throw null;
  }, saved);
  assert.deepEqual(unknown, { ok: false, error: '未能保存，请稍后重试。' });
  assert.deepEqual(draft, original);
  assert.equal(submission.pending, false);
});

test('repeated submit gestures while waiting dispatch one write and one draft reset', async () => {
  const submission = createFormSubmission();
  const response = deferred();
  let requests = 0,
    resets = 0;
  const work = () => {
    requests++;
    return response.promise;
  };
  const saved = () => {
    resets++;
  };
  const first = submission.submit(work, saved);
  assert.equal(await submission.submit(work, saved), null);
  assert.equal(await submission.submit(work, saved), null);
  assert.equal(requests, 1);
  assert.equal(resets, 0);
  response.resolve({ ok: true });
  await first;
  assert.equal(requests, 1);
  assert.equal(resets, 1);
  assert.equal(submission.pending, false);
});

test('independent dialogs do not block or clear one another’s draft', async () => {
  const memories = createFormSubmission(),
    skills = createFormSubmission();
  const waiting = deferred();
  let memorySaved = false,
    skillSaved = false;
  const memoryWork = memories.submit(
    () => waiting.promise,
    () => {
      memorySaved = true;
    },
  );
  await skills.submit(
    async () => ({ ok: true }),
    () => {
      skillSaved = true;
    },
  );
  assert.equal(memories.pending, true);
  assert.equal(memorySaved, false);
  assert.equal(skillSaved, true);
  waiting.resolve({ ok: false, error: 'offline' });
  await memoryWork;
  assert.equal(memorySaved, false);
});
