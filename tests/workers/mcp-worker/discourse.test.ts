import assert from 'node:assert/strict';
import test from 'node:test';
import { discoursePostUrl } from '../../../server/workers/mcp-worker/discourse.js';

test('Discourse links use the connected forum path and the confirmed topic or reply IDs', () => {
  const endpoint = new URL('https://community.example/forums/mcp/');
  const receipt = { id: 304, topic_id: 91, post_number: 7, url: 'https://other.example/fake' };
  assert.equal(
    discoursePostUrl(endpoint, 'discourse_create_topic', receipt),
    'https://community.example/forums/t/91',
  );
  assert.equal(
    discoursePostUrl(endpoint, 'discourse_create_post', receipt),
    'https://community.example/forums/t/91/7',
  );
  assert.equal(discoursePostUrl(endpoint, 'discourse_read_post', receipt), undefined);
  assert.equal(
    discoursePostUrl(new URL('https://community.example/proxy'), 'discourse_create_topic', receipt),
    undefined,
  );
  for (const malformed of [null, undefined, [], {}, false, 12, 'text']) {
    assert.equal(discoursePostUrl(endpoint, 'discourse_create_topic', malformed), undefined);
  }
  for (const invalid of [0, -1, Infinity, 2.5, '7', null, undefined]) {
    for (const key of ['id', 'topic_id', 'post_number']) {
      assert.equal(
        discoursePostUrl(endpoint, 'discourse_create_post', { ...receipt, [key]: invalid }),
        undefined,
      );
    }
  }
});
