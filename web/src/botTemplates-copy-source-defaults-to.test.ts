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
  require,
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
  all,
  harness,
  dialogFile,
  common,
} from './testSupport/botTemplatesFixture';

test('copy source defaults to preserved routines and never installs on initial read or before confirmation', async () => {
  const store = storage(),
    calls: any[] = [];
  const transport: typeof fetch = async (url, init) => {
    if (String(url).includes('/bot-copy-source/'))
      return json({ sourceRevision: 'source-r1', blueprint });
    if (String(url).endsWith('/bootstrap')) return json(installed);
    calls.push(JSON.parse(String(init?.body)));
    return json({ ...receipt, requestId: calls.at(-1).requestId });
  };
  const window = Object.assign(new EventTarget(), {
    location: { pathname: `/w/${workspaceId}`, origin: 'https://openbot.invalid' },
    sessionStorage: store,
  });
  const h = await harness(
    dialogFile,
    'TemplateSource',
    {
      ...common(transport),
      request: { kind: 'copy', agentId: 'bot-source', conversationId: 'source-dm' },
    },
    transport,
    { sessionStorage: store, window },
  );
  await h.flush();
  assert.equal(calls.length, 0);
  h.field('副本名称').props.onChange({ target: { value: '研究副本' } });
  await h.flush();
  h.button('确认复制').props.onClick();
  await h.flush();
  assert.equal(calls[0].routineMode, 'preserve');
  assert.equal(calls[0].name, '研究副本');
  assert.ok(h.button('打开新 Bot'));
  h.dispose();
});

test('template edit preserves unsaved fields on conflict; publication requires a separate exact confirmation', async () => {
  const store = storage(),
    calls: any[] = [];
  let record = template;
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/bot-sharing-policy'))
      return json({ revision: 'policy1', mode: 'public' });
    if (init?.method === 'GET') return json(record);
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    if (init?.method === 'PATCH')
      return json({ error: '草稿已改变', code: 'BOT_TEMPLATE_NOT_APPLIED' }, 409);
    record = {
      ...record,
      revision: 'r2',
      publication: {
        revision: 'p1',
        digest: 'digest1',
        audience: 'public',
        path: `/templates/${token}`,
        publishedAt: '2026-11-05T00:00:00Z',
      },
    };
    return json(record);
  };
  const h = await harness(
    dialogFile,
    'TemplateManager',
    { ...common(transport), templateId },
    transport,
    {
      sessionStorage: store,
      window: { location: { pathname: `/w/${workspaceId}`, origin: 'https://openbot.invalid' } },
    },
  );
  await h.flush();
  h.button('编辑模板草稿').props.onClick();
  await h.flush();
  const editor = all(h.tree, (node) => node.type?.name === 'BotTemplateEditor')[0];
  editor.props.onChange({
    ...blueprint,
    profile: { ...blueprint.profile, instructions: '编辑后保留的指令' },
  });
  await h.flush();
  h.tree.props.onClose();
  await h.flush();
  assert.match(h.copy, /未保存的修改/);
  h.button('继续编辑').props.onClick();
  h.button('保存模板草稿').props.onClick();
  await h.flush();
  const after = all(h.tree, (node) => node.type?.name === 'BotTemplateEditor')[0];
  assert.equal(after.props.value.profile.instructions, '编辑后保留的指令');
  assert.equal(calls[0].body.expectedDraftRevision, 'd1');
  assert.match(h.copy, /草稿已改变/);
  h.dispose();
  const clean = await harness(
    dialogFile,
    'TemplateManager',
    { ...common(transport), templateId },
    transport,
    {
      sessionStorage: store,
      window: { location: { pathname: `/w/${workspaceId}`, origin: 'https://openbot.invalid' } },
    },
  );
  await clean.flush();
  const before = calls.length;
  clean.button('发布分享链接').props.onClick();
  await clean.flush();
  assert.equal(calls.length, before);
  assert.match(clean.copy, /确认公开以上完整内容/);
  clean.button('确认发布').props.onClick();
  await clean.flush();
  assert.equal(calls.at(-1).body.audience, 'public');
  assert.equal(calls.at(-1).body.expectedDraftRevision, 'd1');
  assert.match(clean.copy, /已公开分享/);
  clean.dispose();
});

test('unknown template mutation locks old action callbacks, persists reopening and retries identical request after GET', async () => {
  const store = storage(),
    bodies: any[] = [];
  let first = true;
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/bot-sharing-policy'))
      return json({ revision: 'p1', mode: 'public' });
    if (init?.method === 'GET') return json(template);
    bodies.push(JSON.parse(String(init?.body)));
    if (first) {
      first = false;
      throw new TypeError('offline');
    }
    return json({
      ...template,
      revision: 'r2',
      publication: {
        revision: 'p1',
        digest: 'digest1',
        audience: 'public',
        path: `/templates/${token}`,
        publishedAt: '2026-11-05T00:00:00Z',
      },
    });
  };
  const globals = {
    sessionStorage: store,
    window: { location: { pathname: `/w/${workspaceId}`, origin: 'https://openbot.invalid' } },
  };
  const h = await harness(
    dialogFile,
    'TemplateManager',
    { ...common(transport), templateId },
    transport,
    globals,
  );
  await h.flush();
  h.button('发布分享链接').props.onClick();
  await h.flush();
  const retained = h.button('确认发布').props.onClick;
  retained();
  await h.flush();
  retained();
  await h.flush();
  assert.equal(bodies.length, 1);
  h.dispose();
  const resumed = await harness(
    dialogFile,
    'TemplateManager',
    { ...common(transport), templateId },
    transport,
    globals,
  );
  await resumed.flush();
  assert.equal(bodies.length, 1);
  resumed.button('继续处理同一次请求').props.onClick();
  await resumed.flush();
  assert.deepEqual(bodies[1], bodies[0]);
  assert.match(resumed.copy, /已公开分享/);
  resumed.dispose();
});

test('complete preview and safe chat card render actual instructions, methods and routine activation effects', async () => {
  const output = await build({
    entryPoints: [resolve('web/src/components/BotTemplatePreview.tsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty' },
  });
  const module = { exports: {} as Record<string, any> };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, require });
  const { renderToStaticMarkup } = require('react-dom/server');
  const preserve = renderToStaticMarkup(
    React.createElement(module.exports.BotTemplatePreview, { blueprint, routineMode: 'preserve' }),
  );
  assert.match(preserve, /核对来源后再输出/);
  assert.match(preserve, /使用原始资料并列出来源/);
  assert.match(preserve, /汇总本周进展/);
  assert.match(preserve, /创建后启用/);
  assert.match(preserve, /北京时间/);
  assert.match(preserve, /不继承记忆/);
  const paused = renderToStaticMarkup(
    React.createElement(module.exports.BotTemplatePreview, { blueprint, routineMode: 'pause' }),
  );
  assert.match(paused, /创建后暂停/);
  assert.doesNotMatch(paused, /创建后启用/);
  const h = await harness('web/src/components/BotTemplateCard.tsx', 'BotTemplateCard', {
    card: { templateId, sequence: 1, name: '模板', status: 'draft' },
    owner: false,
    onManage() {
      throw Error('must not manage');
    },
  });
  await h.flush();
  assert.equal(all(h.tree, (node) => node.type === 'button' || node.type === 'a').length, 0);
  assert.match(h.copy, /拥有者/);
  h.setProps({
    card: {
      templateId,
      sequence: 2,
      name: '模板',
      status: 'published',
      audience: 'team',
      path: `/templates/${token}`,
    },
  });
  await h.flush();
  assert.equal(all(h.tree, (node) => node.type === 'a')[0].props.href, `/templates/${token}`);
  h.dispose();
});

test('template avatar cancels stale actor reads and releases only its own object URL', async () => {
  const old = deferred<Response>(),
    next = deferred<Response>(),
    created: string[] = [],
    revoked: string[] = [],
    headers: string[] = [];
  class TestURL extends URL {
    static createObjectURL(_blob: Blob) {
      const url = `blob:preview-${created.length}`;
      created.push(url);
      return url;
    }
    static revokeObjectURL(url: string) {
      revoked.push(url);
    }
  }
  const transport: typeof fetch = async (_url, init) => {
    headers.push(new Headers(init?.headers).get('X-OpenBot-Expected-User') || '');
    return headers.length === 1 ? old.promise : next.promise;
  };
  const avatar = {
    ...blueprint,
    avatar: {
      mimeType: 'image/webp' as const,
      sha256: 'a'.repeat(64),
      width: 512 as const,
      height: 512 as const,
    },
  };
  const h = await harness(
    'web/src/components/BotTemplatePreview.tsx',
    'BotTemplateAvatar',
    {
      blueprint: avatar,
      avatarPath: `/api/workspaces/${workspaceId}/bot-templates/${templateId}/avatar?revision=d1`,
      workspaceId,
      userId,
    },
    transport,
    { URL: TestURL },
  );
  await h.flush();
  h.setProps({ userId: 'new-user' });
  await h.flush();
  old.resolve(new Response(new Blob(['old']), { headers: { 'Content-Type': 'image/webp' } }));
  await h.flush();
  assert.equal(created.length, 0);
  next.resolve(new Response(new Blob(['new']), { headers: { 'Content-Type': 'image/webp' } }));
  for (let pass = 0; pass < 8 && !created.length; pass++) await h.flush();
  assert.equal(created.length, 1);
  assert.equal(all(h.tree, (node) => node.type === 'img')[0].props.src, 'blob:preview-0');
  h.dispose();
  assert.deepEqual(revoked, created);
  assert.deepEqual(headers, [userId, 'new-user']);
});
