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
  all,
  harness,
  alias,
  sharing,
  fileGrant,
  sourceFiles,
} from './testSupport/sharedBotsFixture';

test('actual shared avatar binds expected actor, ignores late account images, and revokes its own preview on unmount', async () => {
  const late = deferred<Response>(),
    calls: any[] = [],
    created: string[] = [],
    revoked: string[] = [];
  const fakeURL = class extends URL {
    static createObjectURL() {
      const value = `blob:shared-${created.length}`;
      created.push(value);
      return value;
    }
    static revokeObjectURL(value: string) {
      revoked.push(value);
    }
  };
  const path = `/api/shared-bots/${ids.share}/avatar?revision=${'a'.repeat(64)}`;
  const ui = await harness(
    'web/src/components/Avatar.tsx',
    'Avatar',
    {
      agent: {
        ...alias,
        avatarImageId: ids.agent,
        sharedBot: { ...alias.sharedBot, avatarPath: path },
      },
      userId: ids.user,
    },
    async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? late.promise
        : new Response('webp', { headers: { 'Content-Type': 'image/webp' } });
    },
    { URL: fakeURL },
  );
  try {
    await ui.flush();
    assert.equal(calls[0].url, path);
    assert.equal(calls[0].init.headers['X-OpenBot-Expected-User'], ids.user);
    assert.equal(all(ui.tree, (node) => node.type === 'img').length, 0);
    ui.props({ userId: 'other-user' });
    await ui.flush();
    assert.equal(calls[0].init.signal.aborted, true);
    assert.equal(created.length, 1);
    late.resolve(new Response('old-webp', { headers: { 'Content-Type': 'image/webp' } }));
    await ui.flush();
    assert.equal(created.length, 1);
    assert.equal(all(ui.tree, (node) => node.type === 'img')[0].props.src, 'blob:shared-0');
  } finally {
    ui.dispose();
  }
  assert.deepEqual(revoked, ['blob:shared-0']);
});

test('actual sharing keeps unmarked authorization failure frozen, unlocks only proven non-applied refusal, and drops late-account mutations', async () => {
  for (const safe of [false, true]) {
    const calls: any[] = [],
      store = storage();
    const ui = await harness(
      'web/src/components/SharedBotsDialog.tsx',
      'ManageSharedBotContent',
      {
        userId: ids.user,
        workspaceId: ids.team,
        workspaceKind: 'team',
        agentId: ids.agent,
        agentName: '小松',
        onClose() {},
        async onChanged() {},
      },
      async (_url, init) => {
        calls.push(init);
        return init?.method === 'GET'
          ? json(sharing)
          : json(
              { error: '版本已变化', ...(safe ? { code: 'SHARED_BOT_NOT_APPLIED' } : {}) },
              safe ? 409 : 403,
            );
      },
      { sessionStorage: store },
    );
    try {
      await ui.flush();
      const original = all(ui.tree, (node) => node.type === 'form')[0].props.onSubmit;
      original({ preventDefault() {} });
      await ui.flush();
      assert.equal(ui.button('保存并共享').props.disabled, !safe);
      const before = calls.length;
      if (!safe) {
        original({ preventDefault() {} });
        await ui.flush();
        assert.equal(calls.length, before);
      }
      ui.props({ userId: 'new-account' });
      await ui.flush();
      if (safe)
        all(ui.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
      else ui.button('重试原请求').props.onClick();
      await ui.flush();
      assert.equal(calls.length, before);
      assert.match(ui.copy, /原团队会话和资料仍然团队可见/);
    } finally {
      ui.dispose();
    }
  }
});

test('shared file references defend persisted payloads and enforce exact versions, count, bytes and safe names', async () => {
  const helper = await compile('web/src/sharedBotFiles.ts'),
    shared = await compile('web/src/sharedBots.ts');
  assert.equal(helper.validSharedFileGrant(fileGrant), true);
  for (const change of [
    { name: '../private.txt' },
    { size: 10 * 1024 * 1024 + 1 },
    { revision: 'A'.repeat(64) },
    { fileId: '../../file' },
  ])
    assert.equal(helper.validSharedFileGrant({ ...fileGrant, ...change }), false);
  const base = {
    method: 'PUT',
    body: {
      requestId: ids.revision,
      expectedRevision: 'unset',
      targetTeamId: ids.team,
      audience: 'team',
      memberIds: [],
      files: [{ fileId: fileGrant.fileId, revision: fileGrant.revision }],
    },
  };
  assert.equal(shared.validSharingAttempt(base), true);
  assert.equal(
    shared.validSharingAttempt({
      ...base,
      body: { ...base.body, files: [{ ...base.body.files[0], path: '/private' }] },
    }),
    false,
  );
  assert.equal(
    shared.validSharingAttempt({
      ...base,
      body: { ...base.body, files: [...base.body.files, ...base.body.files] },
    }),
    false,
  );
  assert.equal(
    shared.validSharingAttempt({ ...base, body: { ...base.body, files: undefined } }),
    true,
  );
  assert.match(
    helper.sharedFileProblem(
      Array.from({ length: 33 }, (_, i) => ({ ...fileGrant, fileId: `file_${i}` })),
    ),
    /32/,
  );
  assert.match(
    helper.sharedFileProblem(
      Array.from({ length: 6 }, (_, i) => ({
        ...fileGrant,
        fileId: `file_${i}`,
        size: 10 * 1024 * 1024,
      })),
    ),
    /50 MB/,
  );
});

test('actual file picker cancels a late selection, preserves concurrent choices and upgrades a changed version only on explicit action', async () => {
  const module = await compile('web/src/sharedBots.ts', '', environment()),
    calls: string[] = [],
    late = deferred<Response>(),
    busy: boolean[] = [];
  let grants = 0,
    selected: any[] = [];
  const client = module.createSharedBotClient({
    userId: ids.user,
    identity: () => ids.user,
    fetch: async (url: any) => {
      calls.push(String(url));
      if (String(url).endsWith('/files'))
        return json({ files: [fileGrant], selected: [], truncated: false });
      grants++;
      return grants === 1 ? late.promise : json(fileGrant);
    },
  });
  const ui = await harness(
    'web/src/components/SharedBotFiles.tsx',
    'SharedBotFilePicker',
    {
      client,
      userId: ids.user,
      endpoint: sourceFiles,
      files: [],
      disabled: false,
      onChange: (value: any[]) => {
        selected = value;
        ui.props({ files: value });
      },
      onBusy: (value: boolean) => busy.push(value),
    },
    async () => {
      throw Error('unused');
    },
  );
  try {
    await ui.flush();
    let checkbox = all(
      ui.tree,
      (node) => node.type === 'input' && node.props.type === 'checkbox',
    )[0];
    checkbox.props.onChange({ target: { checked: true } });
    await ui.flush();
    assert.equal(busy.at(-1), true);
    checkbox = all(ui.tree, (node) => node.type === 'input' && node.props.type === 'checkbox')[0];
    assert.equal(checkbox.props.checked, true);
    checkbox.props.onChange({ target: { checked: false } });
    await ui.flush();
    late.resolve(json(fileGrant));
    await ui.flush();
    assert.equal(selected.length, 0);
    assert.equal(busy.at(-1), false);
    checkbox.props.onChange({ target: { checked: true } });
    await ui.flush();
    assert.equal(selected[0].revision, fileGrant.revision);
    assert.equal(calls.filter((path) => path.endsWith('/file_1')).length, 2);
  } finally {
    ui.dispose();
    client.suspend();
  }
  let updated: any[] = [fileGrant],
    readLatest = 0;
  const changedClient = module.createSharedBotClient({
    userId: ids.user,
    identity: () => ids.user,
    fetch: async (url: any) =>
      String(url).endsWith('/files')
        ? json({
            files: [{ ...fileGrant, size: 5 }],
            selected: [{ ...fileGrant, status: 'changed' }],
            truncated: false,
          })
        : (readLatest++, json({ ...fileGrant, size: 5, revision: 'b'.repeat(64) })),
  });
  const changed = await harness(
    'web/src/components/SharedBotFiles.tsx',
    'SharedBotFilePicker',
    {
      client: changedClient,
      userId: ids.user,
      endpoint: sourceFiles,
      files: updated,
      disabled: false,
      onChange: (value: any[]) => {
        updated = value;
        changed.props({ files: value });
      },
      onBusy() {},
    },
    async () => {
      throw Error('unused');
    },
  );
  try {
    await changed.flush();
    assert.equal(readLatest, 0);
    assert.match(changed.copy, /来源已更新/);
    assert.equal(updated[0].revision, 'a'.repeat(64));
    changed.button('使用最新版本').props.onClick();
    await changed.flush();
    assert.equal(readLatest, 1);
    assert.equal(updated[0].revision, 'b'.repeat(64));
    assert.match(changed.copy, /保存并共享.*生效/);
  } finally {
    changed.dispose();
    changedClient.suspend();
  }
});
