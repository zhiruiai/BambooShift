import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Message } from '../../shared/types';
import { latestWebsiteUpdates, WebsiteProjectCard } from './components/WebsiteProjectCard';
import { websiteVersionNumber } from './components/WebsiteVersionHistory';
import { all } from './testSupport/appsFixture';
import {
  parseWebsiteProject,
  websiteProjectClient,
  websiteProjectHistory,
} from './websiteProjects';

const workspace = '11111111-1111-4111-8111-111111111111';
const body = '<h1>Synthetic site</h1>';
const project = {
  id: 'a'.repeat(64),
  projectKey: 'b'.repeat(64),
  title: 'Synthetic site',
  entry: 'pages/index.html',
  fileCount: 1,
  totalBytes: body.length,
};
const entry = {
  path: project.entry,
  mime: 'text/html',
  size: body.length,
  sha256: createHash('sha256').update(body).digest('hex'),
};

test('loads verified bytes through the exact version and actor scope, rejects mismatched data or stale scope', async (t) => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { pathname: `/w/${workspace}` } },
  });
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  let current = true;
  let mime = 'application/octet-stream';
  let manifest = { ...project, files: [entry] };
  let file = body;
  let staleOnFile = false;
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const root = `/api/workspaces/${workspace}/website-projects/${project.id}`;
    assert.equal(new Headers(options.headers).get('X-OpenBot-Expected-User'), 'synthetic-owner');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    seen.push(url);
    if (url === root) return Response.json(manifest);
    assert.equal(url, `${root}/files/${project.entry}`);
    if (staleOnFile) current = false;
    return new Response(file, {
      headers: { 'Content-Type': mime, 'Content-Disposition': 'attachment' },
    });
  });
  const load = () =>
    websiteProjectClient(project, {
      workspaceId: workspace,
      userId: 'synthetic-owner',
      current: () => current,
    }).load(new AbortController().signal);
  const loaded = await load();
  assert.equal(new TextDecoder().decode(loaded[0].bytes), body);
  file = body.replace('Synthetic', 'Corrupted');
  await assert.rejects(load, /checksum/);
  file = body;
  mime = 'text/html';
  await assert.rejects(load, /response unavailable/);
  mime = 'application/octet-stream';
  manifest = { ...manifest, files: [{ ...entry, path: '../other.html' }] };
  const requests = seen.length;
  await assert.rejects(load, /Invalid website project file/);
  assert.equal(seen.length, requests + 1);
  manifest = { ...project, files: [entry] };
  staleOnFile = true;
  await assert.rejects(load, { name: 'AbortError' });
  assert.equal(parseWebsiteProject({ ...project, id: 'bad' }), undefined);
});

test('older delivery cards preserve the original and link only to a distinct latest snapshot in their chat', () => {
  function delivery(id: string, version: string, conversationId = 'chat'): Message {
    return {
      id,
      conversationId,
      role: 'assistant',
      kind: 'website_project',
      content: project.title,
      createdAt: '2026-11-15T12:00:00.000Z',
      metadata: { websiteProject: { ...project, id: version.repeat(64) } },
    };
  }
  const original = delivery('original', 'a');
  const repeatBeforeUpdate = delivery('original-repeat', 'a');
  const newer = { ...delivery('newer', 'c'), threadRootId: 'reply-thread' };
  const latest = { ...delivery('newer-repeat', 'c'), threadRootId: 'reply-thread' };
  const otherChat = delivery('other-chat', 'd', 'another-chat');
  assert.equal(latestWebsiteUpdates([original, repeatBeforeUpdate], 'chat').size, 0);
  const updates = latestWebsiteUpdates(
    [original, repeatBeforeUpdate, newer, latest, otherChat],
    'chat',
  );
  assert.deepEqual([...updates.keys()].sort(), [original.id, repeatBeforeUpdate.id].sort());
  assert.equal(updates.get(original.id), latest);
  const opened: Message[] = [];
  const card = WebsiteProjectCard({
    message: original,
    latest: updates.get(original.id),
    onOpen: (message) => opened.push(message),
  });
  const buttons = all(card, (node) => node.type === 'button');
  assert.equal(buttons.length, 2);
  buttons.forEach((button) => button.props.onClick());
  assert.deepEqual(opened, [original, latest]);
});

test('re-delivering old contents preserves version numbers and uses the latest delivery thread', () => {
  const delivery = (id: string, digit: string, threadRootId?: string): Message => ({
    id,
    conversationId: 'chat',
    threadRootId,
    role: 'assistant',
    kind: 'website_project',
    content: project.title,
    createdAt: '2026-11-16T12:00:00.000Z',
    metadata: { websiteProject: { ...project, id: digit.repeat(64) } },
  });
  const original = delivery('first', 'a');
  const revision = delivery('second', 'c');
  const duplicate = delivery('second-again', 'c', 'revision-thread');
  const restored = delivery('first-again', 'a', 'restore-thread');
  const history = (messages: Message[]) =>
    websiteProjectHistory(messages, 'chat', project.projectKey);
  const before = history([original, revision, duplicate]);
  assert.deepEqual(
    before.map(({ number }) => number),
    [2, 1],
  );
  const after = history([
    original,
    revision,
    duplicate,
    { ...delivery('unrelated', 'd'), conversationId: 'another-chat' },
    restored,
  ]);
  assert.deepEqual(
    after.map(({ number }) => number),
    [1, 2],
  );
  assert.equal(after[0].message, restored);
  assert.equal(after[1].message, duplicate);
  for (const version of before)
    assert.equal(websiteVersionNumber(after, version.project.id), version.number);
  assert.deepEqual(
    history([original, revision, restored, delivery('third', 'e')]).map(({ number }) => number),
    [3, 1, 2],
  );
});
