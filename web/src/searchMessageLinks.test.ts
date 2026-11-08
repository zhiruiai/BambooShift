import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../shared/types';
import { messageLinks } from './messageLinks';

const message: Message = {
  id: 'source',
  conversationId: 'chat',
  role: 'assistant',
  content: [
    '[**Design** notes](https://example.com/notes_(v2))',
    '[specification][spec]',
    '[spec]: https://example.org/spec',
    '<https://example.org/spec>',
    'www.example.net/docs',
    '![Image](https://ignore.test/image.png)',
    '`https://ignore.test/inline`',
    '```text\nhttps://ignore.test/fenced\n```',
    '<div><a href="https://ignore.test/raw">raw</a></div>',
    '',
    '[Credentials](https://demo:sample@example.com/secret)',
    '[Relative](/api/files/test)',
    '[Other scheme](ftp://ignore.test)',
  ].join('\n\n'),
  createdAt: '2026-11-08T00:00:00Z',
};

test('prior-work links follow visible Markdown anchors and ignore commands, media, raw HTML and credentials', () => {
  assert.deepEqual(messageLinks(message), [
    { label: 'Design notes', href: 'https://example.com/notes_(v2)' },
    { label: 'specification', href: 'https://example.org/spec' },
    { label: 'www.example.net/docs', href: 'http://www.example.net/docs' },
  ]);
  for (const unavailable of [
    { ...message, status: 'running' as const },
    { ...message, role: 'system' as const },
    { ...message, kind: 'computer' as const },
  ]) {
    assert.deepEqual(messageLinks(unavailable), []);
  }
});
