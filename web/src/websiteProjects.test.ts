import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseWebsiteProject, websiteProjectClient } from './websiteProjects';

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
