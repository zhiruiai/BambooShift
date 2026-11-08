import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWebsiteShare,
  parseWebsiteSharePath,
  websiteSharePath,
} from '../../shared/website-shares';
import { safeAccountNext } from './platform/platformApi';

test('website access data accepts only a scoped capability path and a pinned version', () => {
  const token = 'a'.repeat(43);
  const link = websiteSharePath(token);
  const state = {
    visibility: 'public',
    viewerIds: [],
    versionId: 'a'.repeat(64),
    revision: 'r1',
    path: link,
  };
  assert.deepEqual(parseWebsiteShare(state), state);
  assert.equal(parseWebsiteSharePath(link), token);
  assert.equal(safeAccountNext(link), link);
  for (const path of [
    `https://outside.example.test${link}`,
    `//outside.example.test${link}`,
    `${link}?next=/%2f`,
    '/pages/short',
  ]) {
    assert.equal(parseWebsiteShare({ ...state, path }), undefined);
    assert.equal(safeAccountNext(path), '');
  }
  assert.equal(parseWebsiteShare({ ...state, versionId: null }), undefined);
  assert.equal(parseWebsiteShare({ ...state, visibility: 'private' }), undefined);
  const initial = {
    visibility: 'private',
    viewerIds: [],
    versionId: null,
    revision: null,
    path: null,
  };
  assert.deepEqual(parseWebsiteShare(initial), initial);
});
