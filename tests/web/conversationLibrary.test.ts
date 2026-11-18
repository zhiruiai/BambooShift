import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message, WorkspaceFile } from '../../shared/types';
import { conversationLibraryItems, libraryItemKey } from '../../web/src/conversationLibrary';

const createdAt = '2026-11-03T10:00:00Z';
function version(id: string, timestamp: string, conversationId: string): Message {
  return {
    id,
    conversationId,
    role: 'assistant',
    content: 'Latest site',
    kind: 'website_project',
    createdAt: timestamp,
    metadata: {
      websiteProject: {
        id: id.repeat(64),
        projectKey: 'e'.repeat(64),
        title: 'Site',
        entry: 'index.html',
        fileCount: 1,
        totalBytes: 10,
      },
    },
  };
}
const file = (id: string, name: string, type: string, conversationId?: string): WorkspaceFile => ({
  id,
  name,
  type,
  size: 16,
  createdAt,
  conversationId,
});

test('library preserves stable website and link identities and the conversation file boundary', () => {
  const latest = { ...version('b', '2026-11-07T10:00:00Z', 'chat'), threadRootId: 'thread' };
  const message: Message = {
    id: 'references',
    conversationId: 'chat',
    role: 'assistant',
    createdAt,
    content: '[Documentation](https://docs.example.com) and `https://ignored.example.com`',
  };
  const repeated = {
    ...message,
    id: 'recent',
    content: '[Latest source](https://docs.example.com/)',
  };
  const items = conversationLibraryItems(
    'chat',
    [
      version('a', createdAt, 'chat'),
      message,
      repeated,
      latest,
      version('c', latest.createdAt, 'other'),
    ],
    [
      file('image', 'map.webp', 'application/octet-stream', 'chat'),
      file('document', 'brief.md', 'text/markdown'),
      file('private', 'elsewhere.md', 'text/markdown', 'other'),
    ],
  );
  const [website, ...rest] = items;
  assert.ok(website.kind === 'website');
  assert.equal(website.message, latest);
  assert.equal(libraryItemKey(website), `website:${'e'.repeat(64)}`);
  assert.equal(rest.find((entry) => entry.target === 'image')?.media, true);
  assert.equal(rest.find((entry) => entry.target === 'document')?.media, false);
  assert.ok(!items.some((entry) => entry.target === 'private'));
  const link = rest.filter((entry) => entry.kind === 'link');
  assert.equal(link.length, 1);
  assert.equal(link[0].messageId, repeated.id);
  assert.equal(libraryItemKey(link[0]), 'link:https://docs.example.com/');
});
