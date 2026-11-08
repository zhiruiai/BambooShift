import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { historicalAuthor } from './messageAuthors';
import { MAX_AVATAR_UPLOAD_BYTES } from '../../shared/avatar-assets';
import {
  avatarActivity,
  avatarImageUrl,
  constrainCrop,
  createAvatarEditor,
  cropPixels,
  initialCropView,
  validAvatarImageId,
} from './avatarImages';
const require = createRequire(import.meta.url),
  { renderToStaticMarkup } = require('react-dom/server');
const workspaceId = '11111111-1111-4111-8111-111111111111',
  userId = '22222222-2222-4222-8222-222222222222';
const sourceId = '33333333-3333-4333-8333-333333333333',
  secondId = '44444444-4444-4444-8444-444444444444',
  assetId = '55555555-5555-4555-8555-555555555555';
const source = {
  id: sourceId,
  width: 1600,
  height: 900,
  previewWidth: 1024,
  previewHeight: 576,
  expiresAt: '2030-01-01T00:00:00Z',
};
const asset = {
  id: assetId,
  width: 512,
  height: 512,
  mimeType: 'image/webp',
  createdAt: '2026-11-05T00:00:00Z',
};
const file = () => new Blob(['image fixture'], { type: 'image/png' });
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const preview = () => new Response(new Blob(['bounded webp fixture'], { type: 'image/webp' }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(transport?: (url: string, init: RequestInit) => Promise<Response>) {
  let identity = { workspaceId, userId },
    location = workspaceId,
    enabled = true;
  const states: any[] = [],
    assets: any[] = [],
    calls: Array<{ url: string; init: RequestInit }> = [],
    urls: Blob[] = [],
    revoked: string[] = [];
  const editor = createAvatarEditor({
    workspaceId,
    userId,
    identity: () => identity,
    locationWorkspace: () => location,
    enabled: () => enabled,
    onState: (value) => states.push(value),
    onAsset: (value) => assets.push(value),
    createObjectURL: (blob) => {
      urls.push(blob);
      return `blob:preview-${urls.length}`;
    },
    revokeObjectURL: (url) => revoked.push(url),
    fetch: async (url, init) => {
      const value = { url: String(url), init: init! };
      calls.push(value);
      if (transport) return transport(value.url, value.init);
      return init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : String(url).endsWith('/sources')
          ? json(source)
          : init?.method === 'POST'
            ? json(asset)
            : preview();
    },
  });
  return {
    editor,
    states,
    assets,
    calls,
    urls,
    revoked,
    changeAccount() {
      identity = { workspaceId, userId: 'other' };
    },
    changeWorkspace() {
      location = 'other';
    },
    disable() {
      enabled = false;
    },
  };
}

test('crop mathematics use oriented original pixels, remain square and stay bounded across drag/zoom', () => {
  assert.deepEqual(cropPixels(1600, 900, initialCropView()), { left: 350, top: 0, size: 900 });
  assert.deepEqual(cropPixels(900, 1600, initialCropView()), { left: 0, top: 350, size: 900 });
  for (const [width, height] of [
    [1, 1],
    [31, 600],
    [1600, 900],
    [900, 1600],
    [7999, 4000],
  ])
    for (const zoom of [0, 1, 1.37, 4, 10])
      for (const x of [-100, -0.3, 0, 0.4, 100]) {
        const crop = cropPixels(width, height, { zoom, x, y: -x });
        assert.ok(Object.values(crop).every(Number.isSafeInteger));
        assert.ok(crop.size > 0 && crop.left >= 0 && crop.top >= 0);
        assert.ok(crop.left + crop.size <= width && crop.top + crop.size <= height);
      }
  assert.deepEqual(constrainCrop(400, 400, { zoom: NaN, x: Infinity, y: NaN }), initialCropView());
  assert.throws(() => cropPixels(0, 40, initialCropView()));
  assert.equal(cropPixels(20000, 1000, { zoom: 3, x: 29.5, y: 0 }).left, 0);
  assert.equal(cropPixels(1000, 20000, { zoom: 3, x: 0, y: 29.5 }).top, 0);
});

test('raw stage and authenticated preview remain private; only confirmed crop returns a draft asset', async () => {
  const f = fixture(),
    blob = file();
  await f.editor.select(blob);
  assert.equal(f.assets.length, 0);
  assert.equal(f.editor.state.phase, 'editing');
  assert.deepEqual(avatarActivity(f.editor.state), { pending: true, busy: false });
  assert.equal(f.calls[0].url, `/api/workspaces/${workspaceId}/bot-avatars/sources`);
  assert.equal(f.calls[0].init.body, blob);
  assert.equal(new Headers(f.calls[0].init.headers).get('Content-Type'), 'image/png');
  assert.equal(f.calls[1].init.method, 'GET');
  assert.equal(new Headers(f.calls[1].init.headers).get('X-OpenBot-Expected-User'), userId);
  await f.editor.confirm(cropPixels(source.width, source.height, initialCropView()));
  assert.deepEqual(JSON.parse(String(f.calls[2].init.body)), {
    sourceId,
    crop: { left: 350, top: 0, size: 900 },
  });
  assert.equal(f.assets[0].id, assetId);
  assert.equal(f.editor.state.phase, 'idle');
  assert.deepEqual(f.revoked, ['blob:preview-1']);
  const deleted = f.calls.filter((call) => call.init.method === 'DELETE');
  assert.equal(deleted.length, 1);
  assert.ok(deleted[0].url.endsWith(`/sources/${sourceId}`));
  assert.equal(deleted[0].init.body, undefined);
  assert.ok(f.calls.every((call) => !/\/agents|\/primary-bot|bot-team-plans/.test(call.url)));
});

test('invalid or oversized source never uploads, and IDs never become arbitrary image URLs', async () => {
  const f = fixture();
  await f.editor.select(new Blob(['svg'], { type: 'image/svg+xml' }));
  assert.equal(f.calls.length, 0);
  assert.equal(f.editor.state.phase, 'error');
  await f.editor.select(new Blob([new Uint8Array(MAX_AVATAR_UPLOAD_BYTES)], { type: 'image/png' }));
  assert.equal(f.calls.length, 0);
  for (const value of [
    'https://example.com/a.png',
    'data:image/png;base64,abc',
    '../asset',
    '',
    null,
  ]) {
    assert.equal(validAvatarImageId(value), false);
    assert.equal(avatarImageUrl(value, workspaceId), undefined);
  }
  assert.equal(
    avatarImageUrl(assetId, workspaceId),
    `/api/workspaces/${workspaceId}/bot-avatars/${assetId}`,
  );
  assert.equal(avatarImageUrl(assetId), `/api/bot-avatars/${assetId}`);
});

test('cancel before source receipt and replacement by another photo invalidate every older response', async () => {
  const pending = deferred<Response>(),
    f = fixture(async (url, init) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : url.endsWith('/sources')
          ? pending.promise
          : preview(),
    );
  const selecting = f.editor.select(file());
  f.editor.cancel();
  pending.resolve(json(source));
  await selecting;
  assert.equal(f.editor.state.phase, 'idle');
  assert.equal(f.urls.length, 0);
  assert.equal(f.assets.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.signal!.aborted, true);
  const first = deferred<Response>();
  let count = 0;
  const g = fixture(async (url, init) =>
    init.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : url.endsWith('/sources')
        ? ++count === 1
          ? first.promise
          : json({ ...source, id: secondId })
        : preview(),
  );
  const old = g.editor.select(file());
  await g.editor.select(file());
  first.resolve(json(source));
  await old;
  assert.equal(g.editor.state.source?.id, secondId);
  assert.equal(g.urls.length, 1);
  g.editor.cancel();
  assert.deepEqual(g.revoked, ['blob:preview-1']);
});

test('known source is released when preview loading is cancelled; final assets are never deleted', async () => {
  const waiting = deferred<Response>();
  const f = fixture(async (url, init) =>
    init.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : url.endsWith('/sources')
        ? json(source)
        : waiting.promise,
  );
  const selecting = f.editor.select(file());
  await new Promise((done) => setImmediate(done));
  f.editor.cancel();
  waiting.resolve(preview());
  await selecting;
  assert.equal(f.urls.length, 0);
  assert.equal(f.calls.filter((call) => call.init.method === 'DELETE').length, 1);
  assert.equal(f.editor.state.phase, 'idle');
});

test('late crop results after cancel, unmount, account or workspace switch never change the parent draft', async () => {
  for (const change of ['cancel', 'unmount', 'account', 'workspace']) {
    const pending = deferred<Response>();
    const f = fixture(async (url, init) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : url.endsWith('/sources')
          ? json(source)
          : init.method === 'POST'
            ? pending.promise
            : preview(),
    );
    await f.editor.select(file());
    const finishing = f.editor.confirm({ left: 0, top: 0, size: 900 });
    if (change === 'cancel') f.editor.cancel();
    if (change === 'unmount') f.editor.suspend();
    if (change === 'account') f.changeAccount();
    if (change === 'workspace') f.changeWorkspace();
    pending.resolve(json(asset));
    await finishing;
    assert.equal(f.assets.length, 0, change);
    assert.equal(
      f.calls.filter((call) => call.init.method === 'DELETE').length,
      change === 'cancel' || change === 'unmount' ? 1 : 0,
      change,
    );
    f.editor.suspend();
    assert.deepEqual(f.revoked, ['blob:preview-1']);
  }
});

test('preview completion after identity change does not create a local URL or cross-scope cleanup', async () => {
  const pending = deferred<Response>();
  const f = fixture(async (url) => (url.endsWith('/sources') ? json(source) : pending.promise));
  const selecting = f.editor.select(file());
  await new Promise((done) => setImmediate(done));
  f.changeAccount();
  pending.resolve(preview());
  await selecting;
  assert.equal(f.urls.length, 0);
  f.editor.cancel();
  assert.equal(f.calls.length, 2);
  f.editor.suspend();
});

test('expired or failed crop retains preview and original file for explicit reupload without publishing', async () => {
  let sources = 0;
  const f = fixture(async (url, init) =>
    init.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : url.endsWith('/sources')
        ? (sources++, json(source))
        : init.method === 'POST'
          ? json({ error: '图片暂存已过期，请重新上传。' }, 404)
          : preview(),
  );
  const original = file();
  await f.editor.select(original);
  await f.editor.confirm({ left: 0, top: 0, size: 900 });
  assert.equal(f.editor.state.phase, 'editing');
  assert.match(f.editor.state.error!, /已过期/);
  assert.equal(f.assets.length, 0);
  assert.equal(f.revoked.length, 0);
  await f.editor.reupload();
  assert.equal(sources, 2);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/sources')).at(-1)?.init.body, original);
  assert.deepEqual(f.revoked, ['blob:preview-1']);
  f.editor.suspend();
});

test('best effort source deletion failure never replays crop or changes a confirmed asset', async () => {
  const f = fixture(async (url, init) => {
    if (init.method === 'DELETE') throw new TypeError('lost cleanup');
    return url.endsWith('/sources')
      ? json(source)
      : init.method === 'POST'
        ? json(asset)
        : preview();
  });
  await f.editor.select(file());
  await f.editor.confirm({ left: 0, top: 0, size: 900 });
  await new Promise((done) => setImmediate(done));
  assert.equal(f.assets.length, 1);
  assert.equal(f.editor.state.phase, 'idle');
  assert.equal(f.calls.filter((call) => call.url.endsWith('/bot-avatars')).length, 1);
});

test('actual Avatar and group rendering share safe UUID images and removed author projection preserves only valid assets', async () => {
  const compiled = await build({
    entryPoints: ['web/src/components/Avatar.tsx'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty' },
  });
  const module = { exports: {} as any };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require });
  const render = (component: any, props: any) =>
    renderToStaticMarkup(React.createElement(component, props)) as string;
  const bot = { id: 'a', name: '小松', avatar: 'leaf', color: '#9363ed', avatarImageId: assetId };
  const html = render(module.exports.Avatar, { agent: bot, size: 43 });
  assert.match(html, /\/api\/bot-avatars\//);
  assert.match(html, /width="43"/);
  assert.match(html, /loading="lazy"/);
  assert.doesNotMatch(html, /<svg/);
  const invalid = render(module.exports.Avatar, {
    agent: { ...bot, avatarImageId: 'https://untrusted.test/pic' },
  });
  assert.match(invalid, /<svg/);
  assert.doesNotMatch(invalid, /untrusted|<img/);
  const groupHtml = render(module.exports.GroupAvatar, {
    agents: [bot, { ...bot, id: 'b', avatarImageId: null }],
  });
  assert.match(groupHtml, /avatar-image/);
  assert.match(groupHtml, /<svg/);
  let failed: string | undefined;
  const controlled = { exports: {} as any };
  runInNewContext(compiled.outputFiles[0].text, {
    module: controlled,
    exports: controlled.exports,
    require: (name: string) =>
      name === 'react'
        ? {
            ...React,
            useContext: () => null,
            useRef: (value: unknown) => ({ current: value }),
            useEffect: () => {},
            useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
            useState: () => [
              failed,
              (value: string) => {
                failed = value;
              },
            ],
          }
        : require(name),
  });
  const firstImage = controlled.exports.Avatar({ agent: bot }).props.children;
  assert.equal(firstImage.type, 'img');
  firstImage.props.onError();
  assert.match(renderToStaticMarkup(controlled.exports.Avatar({ agent: bot })), /<svg/);
  assert.equal(
    controlled.exports.Avatar({ agent: { ...bot, avatarImageId: secondId } }).props.children.type,
    'img',
  );
  firstImage.props.onError();
  assert.equal(
    controlled.exports.Avatar({ agent: { ...bot, avatarImageId: secondId } }).props.children.type,
    'img',
  );
  assert.equal(
    historicalAuthor({ agentId: 'removed', metadata: { author: bot } } as any)?.avatarImageId,
    assetId,
  );
  assert.equal(
    historicalAuthor({
      agentId: 'removed',
      metadata: { author: { ...bot, avatarImageId: '../image' } },
    } as any)?.avatarImageId,
    null,
  );
});
