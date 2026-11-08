import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../shared/types';
import { parseWebResearchMessage } from '../../shared/web-research';
import { chatTimeline } from './chatTimeline';

const research = {
  version: 1,
  provider: 'Exa',
  searches: 3,
  cachedSearches: 2,
  emptySearches: 1,
  pagesRead: 1,
  issues: ['upstream_rate_limit', 'search_retry_limit'],
  sources: [{ title: 'Library guide', url: 'https://example.com/guide', kind: 'page' }],
};

const message: Message = {
  id: 'research',
  conversationId: 'group',
  role: 'assistant',
  agentId: 'researcher',
  kind: 'web_research',
  status: 'done',
  content: '',
  createdAt: '2026-11-08T09:00:00.000Z',
  metadata: { webResearch: research },
};

test('completed research survives an empty body and separates adjacent Bot text', () => {
  const bot = { ...message, kind: 'text', content: 'Normal response' } as const;
  const { rows } = chatTimeline(
    [{ ...bot, id: 'before' }, message, { ...bot, id: 'after' }],
    false,
  );
  assert.deepEqual(
    rows.map((row) => [row.message.id, row.groupedWithPrevious, row.groupedWithNext]),
    [
      ['before', false, false],
      ['research', false, false],
      ['after', false, false],
    ],
  );
  assert.deepEqual(rows[1].webResearch, {
    ...research,
    issues: ['search_retry_limit', 'upstream_rate_limit'],
  });
  assert.equal(rows[0].webResearch, undefined);
});

test('invalid audit headers cannot produce a visible or live research message', () => {
  const malformed = [
    { ...message, role: 'user' } as const,
    { ...message, status: 'running' } as const,
    { ...message, metadata: {} },
    ...[
      { version: 2 },
      { provider: 'Unverified' },
      { searches: Infinity },
      { searches: 0 },
      { emptySearches: -1 },
      { cachedSearches: 10_000 },
      { pagesRead: 0.5 },
      { sources: {} },
      { issues: 'timeout' },
    ].map((fields) => ({ ...message, metadata: { webResearch: { ...research, ...fields } } })),
  ];
  for (const item of malformed) assert.equal(parseWebResearchMessage(item), undefined);
  assert.deepEqual(chatTimeline(malformed, false).rows, []);
});

test('sources omit unsafe navigation and deduplicate normalized URLs in favor of pages read', () => {
  const unsafe = [
    'javascript:alert(1)',
    'https://name:secret@example.com/',
    'https://example.test/',
    'http://127.1/',
    'http://[::ffff:7f00:1]/',
    'https://local.device.local/',
    'https://openbot/',
    'https://example.com/a\\b',
    'https://example.com/a\tb',
  ].map((url) => ({ title: 'Unsafe', url, kind: 'search' }));
  const result = parseWebResearchMessage({
    ...message,
    metadata: {
      webResearch: {
        ...research,
        issues: ['timeout', 'unknown', 'timeout'],
        sources: [
          { title: 'Found', url: 'https://EXAMPLE.com/guide#heading', kind: 'search' },
          ...unsafe,
          research.sources[0],
          { title: 'HTTP article', url: 'http://example.org/doc', kind: 'search' },
        ],
      },
    },
  });
  assert.deepEqual(result?.issues, ['timeout']);
  assert.deepEqual(result?.sources, [
    research.sources[0],
    { title: 'HTTP article', url: 'http://example.org/doc', kind: 'search' },
  ]);
});
