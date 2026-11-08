import { expandPureViews } from './testSupport/expandPureViews';
import { componentSource } from './testSupport/componentSource';
import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import React from 'react';
import ts from 'typescript';
import {
  ids,
  json,
  deferred,
  storage,
  environment,
  compile,
  text,
  all,
  harness,
  alias,
  sharing,
  fileGrant,
  sourceFiles,
} from './testSupport/sharedBotsFixture';

test('actual file picker refuses late account selections and leaves missing grants visible until explicitly removed', async () => {
  const module = await compile('web/src/sharedBots.ts', '', environment());
  let actor = ids.user;
  const late = deferred<Response>();
  let changes = 0;
  const client = module.createSharedBotClient({
    userId: ids.user,
    identity: () => actor,
    fetch: async (url: any) =>
      String(url).endsWith('/files')
        ? json({
            files: [{ ...fileGrant, fileId: 'file_2' }],
            selected: [{ ...fileGrant, status: 'missing' }],
            truncated: true,
          })
        : late.promise,
  });
  const ui = await harness(
    'web/src/components/SharedBotFiles.tsx',
    'SharedBotFilePicker',
    {
      client,
      userId: ids.user,
      endpoint: sourceFiles,
      files: [fileGrant],
      disabled: false,
      onChange() {
        changes++;
      },
      onBusy() {},
    },
    async () => {
      throw Error('unused');
    },
  );
  try {
    await ui.flush();
    assert.match(ui.copy, /来源文件已移除/);
    assert.match(ui.copy, /200/);
    const checkboxes = all(
      ui.tree,
      (node) => node.type === 'input' && node.props.type === 'checkbox',
    );
    assert.equal(checkboxes[0].props.checked, true);
    checkboxes[1].props.onChange({ target: { checked: true } });
    await ui.flush();
    actor = 'changed-account';
    late.resolve(json({ ...fileGrant, fileId: 'file_2' }));
    await ui.flush();
    assert.equal(changes, 0);
  } finally {
    ui.dispose();
    client.suspend();
  }
});

test('actual manager includes only selected file references in one CAS request, blocks save/close during lookup and restores unknown exact versions', async () => {
  const store = storage(),
    calls: any[] = [];
  let closed = 0,
    mode = 'unknown';
  const props = {
    userId: ids.user,
    workspaceId: ids.team,
    workspaceKind: 'team',
    agentId: ids.agent,
    agentName: '小松',
    onClose() {
      closed++;
    },
    async onChanged() {},
  };
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === 'GET') return json(sharing);
    if (mode === 'unknown') throw new TypeError('lost');
    const body = JSON.parse(String(init?.body));
    return json({
      ...sharing,
      share: {
        id: ids.share,
        ...body,
        revision: ids.revision,
        status: 'active',
        files: [fileGrant],
      },
    });
  };
  const ui = await harness(
    'web/src/components/SharedBotsDialog.tsx',
    'ManageSharedBotContent',
    props,
    transport,
    { sessionStorage: store },
  );
  try {
    await ui.flush();
    const picker = all(ui.tree, (node) => node.type?.name === 'SharedBotFilePicker')[0];
    picker.props.onBusy(true);
    all(ui.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    ui.tree.props.onClose();
    assert.equal(closed, 0);
    assert.equal(calls.length, 1);
    ui.field('谁可以使用').props.onChange({ target: { value: 'selected' } });
    await ui.flush();
    ui.field('林').props.onChange({ target: { checked: true } });
    picker.props.onChange([fileGrant]);
    picker.props.onBusy(false);
    await ui.flush();
    all(ui.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    await ui.flush();
    const body = JSON.parse(calls.find((call) => call.init.method === 'PUT').init.body);
    assert.equal(body.audience, 'selected');
    assert.deepEqual(body.memberIds, [ids.user]);
    assert.deepEqual(body.files, [{ fileId: 'file_1', revision: 'a'.repeat(64) }]);
    assert.equal(body.files[0].name, undefined);
    assert.match(ui.copy, /原请求包含 1 份/);
  } finally {
    ui.dispose();
  }
  mode = 'saved';
  const recovered = await harness(
    'web/src/components/SharedBotsDialog.tsx',
    'ManageSharedBotContent',
    props,
    transport,
    { sessionStorage: store },
  );
  try {
    await recovered.flush();
    recovered.button('重试原请求').props.onClick();
    await recovered.flush();
    const writes = calls.filter((call) => call.init.method === 'PUT');
    assert.equal(writes[0].init.body, writes[1].init.body);
    assert.match(recovered.copy, /共享设置已保存/);
  } finally {
    recovered.dispose();
  }
});

test('shared downloads are actor-bound blobs, never source URLs; stale or revoked responses cannot save and all object URLs are released', async () => {
  const env = environment(),
    created: string[] = [],
    revoked: string[] = [],
    saved: any[] = [],
    calls: any[] = [];
  const FakeURL = class extends URL {
    static createObjectURL() {
      const value = `blob:file-${created.length}`;
      created.push(value);
      return value;
    }
    static revokeObjectURL(value: string) {
      revoked.push(value);
    }
  };
  const module = await compile('web/src/sharedBotFiles.ts', '', {
      ...env,
      URL: FakeURL,
      setTimeout: () => 1,
      clearTimeout() {},
    }),
    scopeModule = await compile('web/src/sharedBots.ts', '', env);
  let actor = ids.user,
    allowed = true;
  const client = scopeModule.createSharedBotClient({ userId: ids.user, identity: () => actor });
  const late = deferred<Response>();
  let mode = 'normal';
  const download = module.createSharedFileDownload({
    client,
    userId: ids.user,
    basePath: `/shared-bots/${ids.share}/files`,
    allowed: () => allowed,
    fetch: async (url: any, init: any) => {
      calls.push({ url, init });
      return mode === 'normal' ? new Response('data') : late.promise;
    },
    save: (url: string, name: string) => saved.push({ url, name }),
  });
  await download.download(fileGrant);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].url, 'blob:file-0');
  assert.equal(calls[0].init.headers['X-OpenBot-Expected-User'], ids.user);
  assert.equal(
    calls[0].url,
    `/api/shared-bots/${ids.share}/files/file_1/download?revision=${fileGrant.revision}`,
  );
  mode = 'late';
  const work = download.download(fileGrant);
  actor = 'different';
  late.resolve(new Response('data'));
  await work;
  assert.equal(saved.length, 1);
  actor = ids.user;
  allowed = false;
  await download.download(fileGrant);
  assert.equal(calls.length, 2);
  download.suspend();
  assert.deepEqual(revoked, created);
  assert.equal(calls[1].init.signal.aborted, true);
  assert.throws(() =>
    module.createSharedFileDownload({
      client,
      userId: ids.user,
      basePath: 'https://other.example/files',
    }),
  );
});

test('actual recipient files show only readonly source versions, hide unavailable downloads, and discard a late user-switch download', async () => {
  const created: string[] = [],
    saved: string[] = [],
    calls: any[] = [],
    late = deferred<Response>();
  const FakeURL = class extends URL {
    static createObjectURL() {
      created.push('blob:download');
      return 'blob:download';
    }
    static revokeObjectURL() {}
  };
  const fakeDocument = {
    body: { appendChild() {} },
    createElement() {
      return {
        href: '',
        download: '',
        click() {
          saved.push(this.href);
        },
        remove() {},
      };
    },
  };
  const ui = await harness(
    'web/src/components/SharedBotFiles.tsx',
    'SharedBotFilesContent',
    { agent: { ...alias, sharedBot: { ...alias.sharedBot, fileCount: 3 } }, userId: ids.user },
    async (url, init) => {
      calls.push({ url, init });
      return String(url).includes('/download?')
        ? late.promise
        : json([
            { ...fileGrant, status: 'available' },
            { ...fileGrant, fileId: 'file_2', name: '已更新.txt', status: 'changed' },
            { ...fileGrant, fileId: 'file_3', name: '已删除.txt', status: 'missing' },
          ]);
    },
    { URL: FakeURL, document: fakeDocument, setTimeout: () => 1, clearTimeout() {} },
  );
  try {
    await ui.flush();
    assert.match(ui.copy, /发布者提供.*小松/);
    assert.match(ui.copy, /来源已更新/);
    assert.match(ui.copy, /来源文件已移除/);
    assert.equal(all(ui.tree, (node) => node.type === 'a').length, 0);
    assert.equal(all(ui.tree, (node) => node.type === 'input').length, 0);
    assert.doesNotMatch(ui.copy, /发送到电脑|添加附件/);
    const buttons = all(
      ui.tree,
      (node) => node.type === 'button' && text(node) === '下载已确认版本',
    );
    assert.equal(buttons.length, 1);
    buttons[0].props.onClick();
    await ui.flush();
    ui.props({ userId: 'different-account' });
    await ui.flush();
    late.resolve(new Response('data'));
    await ui.flush();
    assert.equal(created.length, 0);
    assert.equal(saved.length, 0);
    assert.equal(calls[1].init.headers['X-OpenBot-Expected-User'], ids.user);
  } finally {
    ui.dispose();
  }
});
