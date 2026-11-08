import { componentSource } from './testSupport/componentSource';
import { expandPureViews } from './testSupport/expandPureViews';
import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
import type { BotBlueprint } from '../../shared/bot-blueprint';
import type { BotTemplate } from '../../shared/bot-templates';
import {
  createBotInstaller,
  createBotTemplateScope,
  fetchBotTemplateAvatar,
  safeTemplateAvatarPath,
  parseBotTemplateCard,
} from './botTemplates';
import {
  workspaceId,
  userId,
  templateId,
  token,
  blueprint,
  template,
  receipt,
  installed,
  json,
  storage,
  deferred,
  copy,
  harness,
  scope,
  copyInput,
  dialogFile,
  common,
} from './testSupport/botTemplatesFixture';

test('template paths and cards reject remote sources; avatars bind actor and anonymous public reads omit cookies', async () => {
  const privatePath = `/api/workspaces/${workspaceId}/bot-templates/${templateId}/avatar?revision=d1`;
  assert.equal(safeTemplateAvatarPath(privatePath), privatePath);
  for (const path of [
    'https://example.com/a.png',
    '//example.com/a.png',
    privatePath + '&other=x',
    privatePath + '#x',
    '/api/workspaces/../account/session',
  ])
    assert.equal(safeTemplateAvatarPath(path), undefined);
  const calls: RequestInit[] = [];
  const transport: typeof fetch = async (_url, init) => {
    calls.push(init!);
    return new Response(new Blob(['webp'], { type: 'image/webp' }), {
      headers: { 'Content-Type': 'image/webp' },
    });
  };
  await fetchBotTemplateAvatar(
    privatePath,
    { workspaceId, userId },
    new AbortController().signal,
    transport,
  );
  assert.equal(new Headers(calls[0].headers).get('X-OpenBot-Expected-User'), userId);
  await fetchBotTemplateAvatar(
    `/api/bot-template-links/${token}/avatar`,
    {},
    new AbortController().signal,
    transport,
  );
  assert.equal(calls[1].credentials, 'omit');
  await assert.rejects(
    fetchBotTemplateAvatar(
      privatePath,
      { workspaceId: 'other', userId },
      new AbortController().signal,
      transport,
    ),
  );
  assert.equal(calls.length, 2);
  assert.ok(
    parseBotTemplateCard({
      templateId,
      sequence: 1,
      name: '研究',
      status: 'published',
      audience: 'team',
      path: `/templates/${token}`,
    }),
  );
  assert.equal(
    parseBotTemplateCard({
      templateId,
      sequence: 1,
      name: '研究',
      status: 'published',
      path: 'https://example.com',
    }),
    undefined,
  );
});

test('unknown copy persists exact request across reopening, checks before retry and confirms real Bot/DM', async () => {
  const store = storage(),
    calls: Array<{ url: string; init: RequestInit }> = [];
  let phase = 0,
    requestId = receipt.requestId;
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    if (String(url).endsWith('/bootstrap')) return json(installed);
    if (init?.body) requestId = JSON.parse(String(init.body)).requestId;
    if (init?.method === 'GET')
      return phase === 0 ? json({ error: '没有回执' }, 404) : json({ ...receipt, requestId });
    if (phase++ === 0) throw new TypeError('offline');
    return json({ ...receipt, requestId });
  };
  const first = createBotInstaller({
    scope: scope(transport),
    kind: 'copy',
    storageKey: 'owner-space-source',
    storage: store,
  });
  await first.start(copyInput);
  assert.ok(first.state.attempt);
  const original = JSON.parse(String(calls[0].init.body));
  await first.start({ ...copyInput, name: '不应重建' });
  assert.equal(calls.length, 1);
  first.suspend();
  const second = createBotInstaller({
    scope: scope(transport),
    kind: 'copy',
    storageKey: 'owner-space-source',
    storage: store,
  });
  assert.equal(second.state.attempt?.requestId, original.requestId);
  await second.retry();
  assert.equal(calls.length, 1);
  phase = 0;
  await second.check();
  assert.equal(second.state.checked, true);
  phase = 2;
  await second.retry();
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), original);
  assert.equal(second.state.confirmed?.agent.id, receipt.agentId);
  assert.equal(store.getItem('owner-space-source'), null);
  await second.start(copyInput);
  assert.equal(calls.length, 4);
});

test('created receipt with missing real conversation never reports success or POSTs another Bot', async () => {
  let posts = 0,
    reads = 0;
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      posts++;
      return json({ ...receipt, requestId: JSON.parse(String(init.body)).requestId });
    }
    reads++;
    return json(reads === 1 ? { agents: installed.agents, conversations: [] } : installed);
  };
  const installer = createBotInstaller({
    scope: scope(transport),
    kind: 'copy',
    storageKey: 'missing',
    storage: storage(),
  });
  await installer.start(copyInput);
  assert.ok(installer.state.receipt);
  assert.equal(installer.state.confirmed, undefined);
  await installer.check();
  assert.equal(
    (installer.state as { confirmed?: { conversation: { id: string } } }).confirmed?.conversation
      .id,
    receipt.conversationId,
  );
  assert.equal(posts, 1);
});

test('late install response after account/path switch never confirms or starts a bootstrap request', async () => {
  for (const change of ['actor', 'path', 'dispose']) {
    const deferredResponse = deferred<Response>();
    let actor = userId,
      path = `/w/${workspaceId}`,
      calls = 0;
    const requestScope = scope(
      async () => {
        calls++;
        return deferredResponse.promise;
      },
      () => ({ workspaceId, userId: actor }),
      () => path,
    );
    const installer = createBotInstaller({
      scope: requestScope,
      kind: 'copy',
      storageKey: change,
      storage: storage(),
    });
    const job = installer.start(copyInput);
    if (change === 'actor') actor = 'other';
    else if (change === 'path') path = '/login';
    else {
      installer.suspend();
      requestScope.suspend();
    }
    deferredResponse.resolve(json(receipt));
    await job;
    assert.equal(installer.state.confirmed, undefined);
    assert.equal(calls, 1);
    await installer.start(copyInput);
    assert.equal(calls, 1);
  }
});

test('storage unavailable refuses dispatch; definite source conflict allows explicit revised confirmation', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return json({ error: '原 Bot 已变化', code: 'BOT_INSTALL_NOT_STARTED' }, 409);
  };
  const installer = createBotInstaller({
    scope: scope(transport),
    kind: 'copy',
    storageKey: 'full',
    storage: {
      getItem() {
        return null;
      },
      setItem() {
        throw Error('quota');
      },
      removeItem() {},
    },
  });
  await installer.start(copyInput);
  assert.equal(calls, 0);
  assert.match(installer.state.error, /站点存储/);
  const editable = createBotInstaller({
    scope: scope(transport),
    kind: 'copy',
    storageKey: 'valid',
    storage: storage(),
  });
  await editable.start(copyInput);
  assert.equal(editable.state.attempt, undefined);
  assert.match(editable.state.error, /已变化/);
  await editable.start({ ...copyInput, expectedSourceRevision: 'source-r2' });
  assert.equal(calls, 2);
});

test('source sharing retains request after unknown response and stale create handler cannot generate a second ID', async () => {
  const store = storage(),
    calls: any[] = [];
  let created = 0,
    managed = '';
  const transport: typeof fetch = async (url, init) => {
    if (String(url).includes('/bot-copy-source/'))
      return json({ sourceRevision: 'source-r1', blueprint });
    if (init?.method === 'GET') return json(created ? [template] : []);
    calls.push(JSON.parse(String(init?.body)));
    created++;
    throw new TypeError('lost receipt');
  };
  const h = await harness(
    dialogFile,
    'TemplateSource',
    {
      ...common(transport),
      request: { kind: 'share', agentId: 'bot-source', conversationId: 'source-dm' },
      onManage(id: string) {
        managed = id;
      },
    },
    transport,
    { sessionStorage: store },
  );
  await h.flush();
  const retained = h.button('保存为模板草稿').props.onClick;
  retained();
  await h.flush();
  assert.equal(calls.length, 1);
  retained();
  await h.flush();
  assert.equal(calls.length, 1);
  assert.equal(h.button('继续保存同一草稿').props.disabled, true);
  h.button('检查草稿状态').props.onClick();
  await h.flush();
  assert.equal(managed, templateId);
  assert.equal(calls.length, 1);
  h.dispose();
});
