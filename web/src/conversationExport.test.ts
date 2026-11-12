import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationExport } from './conversationExport';
import { conversationExport } from '../../shared/conversation-export';

const transcript = {
  conversationId: 'chat-a',
  filename: 'conversation-chat-a.md',
  content: '# Complete\n',
  messageCount: 503,
  complete: true as const,
  exportedAt: '2026-11-01T00:00:00Z',
};
function setup(request: (path: string, method?: string) => Promise<unknown>) {
  let current = true;
  const scope = {
    request: request as <T>(path: string, method?: string) => Promise<T>,
    ticket: () => 0,
    current: () => current,
    suspend: () => {
      current = false;
    },
  };
  return {
    job: createConversationExport(scope, 'chat-a', () => current),
    revoke: () => {
      current = false;
    },
  };
}
test('complete transcript comes from server and authorization is checked before handoff', async () => {
  const requests: string[] = [];
  const { job } = setup(async (path, method = 'GET') => {
    requests.push(`${method} ${path}`);
    return method === 'HEAD' ? undefined : transcript;
  });
  const data = await job.load('zh-CN');
  let saved = '';
  await job.deliver(data, (value) => {
    saved = value.content;
  });
  assert.equal(data.messageCount, 503);
  assert.equal(saved, transcript.content);
  assert.deepEqual(requests, [
    'GET /conversations/chat-a/export?language=zh-CN',
    'HEAD /conversations/chat-a/export',
  ]);
});
test('closing or changing workspace during preparation rejects a late complete response', async () => {
  for (const action of ['close', 'revoke']) {
    let resolve!: (value: unknown) => void;
    const { job, revoke } = setup(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = job.load('en');
    action === 'close' ? job.close() : revoke();
    resolve(transcript);
    await assert.rejects(pending, { name: 'AbortError' });
  }
});
test('revoked access or cancellation during final authorization never saves', async () => {
  let release!: () => void;
  const { job } = setup(
    () =>
      new Promise((done) => {
        release = () => done(undefined);
      }),
  );
  let saved = false;
  const pending = job.deliver(transcript, () => {
    saved = true;
  });
  job.close();
  release();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(saved, false);
  const denied = setup(async () => {
    throw new Error('Forbidden');
  });
  await assert.rejects(
    denied.job.deliver(transcript, () => {
      saved = true;
    }),
  );
  assert.equal(saved, false);
});
test('partial, wrong-conversation, unsafe filename and oversized responses are rejected', () => {
  for (const patch of [
    { complete: false },
    { conversationId: 'other' },
    { filename: '../secret.md' },
    { messageCount: -1 },
    { content: '你'.repeat(4 * 1024 * 1024) },
  ]) {
    assert.throws(() => conversationExport({ ...transcript, ...patch }, 'chat-a'));
  }
});
