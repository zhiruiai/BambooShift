import assert from 'node:assert/strict';
import test from 'node:test';
import { planRelease } from './plan-release.mjs';

const source = 'a'.repeat(40);
const olderSource = 'b'.repeat(40);
const startedAt = '2026-11-09T01:17:00Z';
const plan = (overrides = {}) =>
  planRelease({ startedAt, source, releases: [], tagLines: '', ...overrides });
const release = (tag_name, published_at) => ({ tag_name, published_at, draft: false });

test('starts at v0.0.1 and advances the highest stable patch', () => {
  assert.deepEqual(plan(), {
    publish: true,
    version: '0.0.1',
    tag: 'v0.0.1',
    source,
    day: '2026-11-09',
  });
  const releases = [
    release('v0.0.9', '2026-11-06T00:00:00Z'),
    release('v0.0.10', '2026-11-07T00:00:00Z'),
    release('v1.0.0', '2026-11-09T00:00:00Z'),
  ];
  assert.equal(plan({ releases }).tag, 'v0.0.11');
});

test('a retry or manual run does not publish twice on the same Shanghai day', () => {
  const releases = [release('v0.0.1', '2026-11-08T16:04:00Z')];
  assert.deepEqual(plan({ releases }), { publish: false });
  assert.equal(plan({ releases, startedAt: '2026-11-10T01:17:00Z' }).tag, 'v0.0.2');
});

test('resumes the version and source of an interrupted release', () => {
  const tagLines = `v0.0.1\ttag\tPandaMate release from ${olderSource}\n`;
  const releases = [
    { tag_name: 'v0.0.1', draft: true, body: `<!-- pandamate-source: ${olderSource} -->` },
  ];
  assert.equal(plan({ tagLines }).source, olderSource);
  assert.equal(plan({ tagLines, releases }).tag, 'v0.0.1');
  assert.equal(plan({ tagLines, releases }).source, olderSource);
  const untagged = [{ ...releases[0], tag_name: 'untagged-123', name: 'PandaMate v0.0.1' }];
  assert.equal(plan({ tagLines, releases: untagged }).source, olderSource);
  assert.throws(() => plan({ releases }), /draft does not match/);
});

test('stops if the next tag belongs to another release or maintainer', () => {
  assert.throws(() => plan({ tagLines: 'v0.0.1\tcommit\tOther build' }), /next tag/);
  const releases = [{ tag_name: 'v0.0.1', draft: false, prerelease: true }];
  assert.throws(() => plan({ releases }), /reserved/);
});
