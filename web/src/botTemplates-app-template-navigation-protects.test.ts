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
  json,
  storage,
  deferred,
  copy,
  all,
  harness,
  scope,
  copyInput,
  dialogFile,
  common,
} from './testSupport/botTemplatesFixture';

test('actual App template navigation protects drafts and pending sends, and both link entry points use it', async () => {
  const source = await workspaceSource(),
    ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler: ts.FunctionDeclaration | undefined;
  const bindings: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'navigateTemplatePage')
      handler = node;
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(ast) === 'onOpenPublic' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer)
    )
      bindings.push(node.initializer.expression?.getText(ast) || '');
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(handler);
  assert.deepEqual(bindings, ['navigateTemplatePage', 'navigateTemplatePage']);
  const output = await build({
    stdin: {
      contents: `import {parseBotTemplatePath} from '../../shared/bot-templates';\nexport ${handler.getText(ast)}`,
      resolveDir: resolve('web/src'),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
  });
  const navigations: string[] = [],
    confirmations: any[] = [];
  let pending = 0,
    active = true;
  const drafts: any = {};
  const module = { exports: {} as Record<string, any> },
    sendingRef = { current: new Set<string>() },
    uploading = new Set<string>();
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    sendScope: { ticket: () => 0, current: () => active },
    receipts: { pending: () => pending },
    sendingRef,
    uploading,
    composers: drafts,
    setTemplateNavigation: (value: unknown) => confirmations.push(value),
    window: { location: { assign: (path: string) => navigations.push(path) } },
  });
  const go = module.exports.navigateTemplatePage,
    path = `/templates/${token}`;
  drafts['dm-a'] = { text: '未发送', attachments: [] };
  go(path);
  assert.equal(navigations.length, 0);
  assert.equal(confirmations.at(-1), path);
  go(path, true);
  assert.deepEqual(navigations, [path]);
  assert.equal(drafts['dm-a'].text, '未发送');
  pending = 1;
  go(path, true);
  assert.equal(navigations.length, 1);
  pending = 0;
  sendingRef.current.add('dm');
  go(path, true);
  assert.equal(navigations.length, 1);
  sendingRef.current.clear();
  delete drafts['dm-a'];
  drafts['dm-b'] = { text: '', attachments: [{ id: 'file' }], replyTo: { id: 'quoted' } };
  go(path);
  assert.equal(navigations.length, 1);
  active = false;
  go(path, true);
  assert.equal(navigations.length, 1);
  active = true;
  go('https://example.com', true);
  assert.equal(navigations.length, 1);
});

test('post-commit authorization errors and generic conflict retain the same installation for receipt recovery', async () => {
  for (const status of [401, 403, 409]) {
    let posts = 0;
    const store = storage();
    const transport: typeof fetch = async (_url, init) => {
      if (init?.method === 'POST') {
        posts++;
        return json({ error: '需要重新确认账号' }, status);
      }
      return json({ error: '暂无回执' }, 404);
    };
    const installer = createBotInstaller({
      scope: scope(transport),
      kind: 'copy',
      storageKey: `auth-${status}`,
      storage: store,
    });
    await installer.start(copyInput);
    const requestId = installer.state.attempt?.requestId;
    assert.ok(requestId);
    await installer.start({ ...copyInput, name: '不能创建第二份' });
    assert.equal(posts, 1);
    assert.equal(installer.state.attempt?.requestId, requestId);
    assert.ok(store.getItem(`auth-${status}`));
    await installer.check();
    assert.equal(installer.state.checked, true);
    await installer.retry();
    assert.equal(posts, 2);
    assert.equal(installer.state.attempt?.requestId, requestId);
  }
});

test('Bot settings copies and shares only through existing dirty navigation; members receive no management actions', async () => {
  let copies = 0,
    shares = 0;
  const agent = {
    ...blueprint.profile,
    id: 'bot-source',
    status: 'idle',
    configRevision: 'config-r1',
  };
  const props = {
    agent,
    computer: { connected: false },
    workspaceId,
    userId,
    readOnly: false,
    busy: false,
    deleteBlocked: '',
    boundScreen: false,
    skillCount: 1,
    fileCount: 0,
    onComputer() {},
    onSkills() {},
    onFiles() {},
    onClose() {},
    onSaved() {},
    onDeleted() {},
    onCopy() {
      copies++;
    },
    onShare() {
      shares++;
    },
  };
  const h = await harness('web/src/components/AgentDialog.tsx', 'AgentSettingsContent', props);
  await h.flush();
  const fields = all(h.tree, (node) => node.type?.name === 'BotProfileFields')[0];
  fields.props.onChange({ ...fields.props.draft, instructions: '尚未保存的指令' });
  await h.flush();
  h.button('相关内容').props.onClick();
  await h.flush();
  const copyButton = all(
    h.tree,
    (node) => node.type === 'button' && copy(node).startsWith('复制 Bot'),
  )[0];
  assert.ok(copyButton);
  copyButton.props.onClick();
  await h.flush();
  assert.equal(copies, 0);
  assert.match(h.copy, /未保存的修改/);
  h.button('继续编辑').props.onClick();
  await h.flush();
  all(
    h.tree,
    (node) => node.type === 'button' && copy(node).startsWith('发布模板'),
  )[0].props.onClick();
  await h.flush();
  assert.equal(shares, 0);
  h.button('放弃修改并继续').props.onClick();
  assert.equal(shares, 1);
  h.setProps({ readOnly: true });
  await h.flush();
  assert.equal(
    all(h.tree, (node) => node.type === 'button' && /^(复制 Bot|发布模板)/.test(copy(node))).length,
    0,
  );
  h.dispose();
});

test('existing templates remain revocable after source Bot deletion, and refreshing requires reviewing the new exact source', async () => {
  const store = storage(),
    calls: any[] = [];
  let deleted = true;
  const published = {
    ...template,
    publication: {
      revision: 'pub1',
      digest: template.draftDigest,
      audience: 'public',
      path: `/templates/${token}`,
      publishedAt: '2026-11-05T00:00:00Z',
    },
  };
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/bot-sharing-policy'))
      return json({ revision: 'p1', mode: 'public' });
    if (String(url).includes('/bot-copy-source/'))
      return deleted
        ? json({ error: '来源 Bot 已删除' }, 404)
        : json({
            sourceRevision: 'source-new',
            blueprint: {
              ...blueprint,
              profile: { ...blueprint.profile, instructions: '原 Bot 新指令' },
            },
          });
    if (init?.method === 'GET') return json(published);
    calls.push({ path: String(url), body: JSON.parse(String(init?.body)) });
    return json({ ...template, revision: 'r2' });
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
  h.button('从原 Bot 更新草稿').props.onClick();
  await h.flush();
  assert.match(h.copy, /来源 Bot 已删除/);
  assert.equal(calls.length, 0);
  h.button('撤销分享链接').props.onClick();
  await h.flush();
  assert.equal(calls.length, 0);
  h.button('确认撤销').props.onClick();
  await h.flush();
  assert.match(calls[0].path, /\/revoke$/);
  assert.equal(calls[0].body.expectedRevision, 'r1');
  assert.match(h.copy, /尚未分享/);
  h.dispose();
  deleted = false;
  const fresh = await harness(
    dialogFile,
    'TemplateManager',
    { ...common(transport), templateId },
    transport,
    globals,
  );
  await fresh.flush();
  fresh.button('从原 Bot 更新草稿').props.onClick();
  await fresh.flush();
  assert.equal(calls.length, 1);
  const previews = all(fresh.tree, (node) => node.type?.name === 'BotTemplatePreview');
  assert.ok(previews.some((node) => node.props.blueprint.profile.instructions === '原 Bot 新指令'));
  fresh.button('确认替换草稿').props.onClick();
  await fresh.flush();
  assert.match(calls[1].path, /\/refresh$/);
  assert.equal(calls[1].body.expectedSourceRevision, 'source-new');
  fresh.dispose();
});

test('library binds logged-in gallery reads and invalidates delayed results when switching tabs', async () => {
  const slow = deferred<Response>(),
    seen: Array<{ url: string; headers: Headers }> = [];
  const transport: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    return String(url).endsWith('/bot-template-gallery') ? slow.promise : json([template]);
  };
  const h = await harness(dialogFile, 'TemplateLibrary', common(transport), transport);
  await h.flush();
  assert.equal(seen.length, 0);
  h.button('用户发布').props.onClick();
  await h.flush();
  assert.equal(seen[0].url, '/api/bot-template-gallery');
  assert.equal(seen[0].headers.get('X-OpenBot-Expected-User'), userId);
  h.button('我的模板').props.onClick();
  await h.flush();
  assert.match(h.copy, /研究伙伴/);
  slow.resolve(
    json([{ token, name: '迟到的公开结果', role: '不应替换', skillCount: 0, routineCount: 0 }]),
  );
  await h.flush();
  assert.doesNotMatch(h.copy, /迟到的公开结果/);
  h.setProps({ owner: false });
  await h.flush();
  assert.equal(
    all(h.tree, (node) => node.type === 'button' && copy(node) === '我的模板').length,
    0,
  );
  h.dispose();
});
