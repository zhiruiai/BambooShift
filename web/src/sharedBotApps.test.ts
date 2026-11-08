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
  environment,
  compile,
  text,
  all,
  harness,
  connectionId,
  version2,
  firstTool,
  secondTool,
  catalog,
  grant,
  view,
  options,
  endpoint,
  sharing,
  ownerProps,
  input,
  clientFixture,
} from './testSupport/sharedBotAppsFixture';

test('shared application intent recovery accepts exact versions only, preserves legacy omission and rejects duplicate, extra and oversized grants', async () => {
  const { validSharingAttempt, sharingDraft } = await compile('web/src/sharedBots.ts');
  const { sharedAppSelections } = await compile('web/src/sharedBotApps.ts');
  const selection = { connectionId, connectionRevision: ids.revision, tools: grant.tools };
  const body = {
    requestId: ids.share,
    expectedRevision: 'unset',
    targetTeamId: ids.team,
    audience: 'team',
    memberIds: [],
  };
  assert.equal(validSharingAttempt({ method: 'PUT', body }), true);
  assert.equal(validSharingAttempt({ method: 'PUT', body: { ...body, apps: [selection] } }), true);
  assert.equal(
    validSharingAttempt({
      method: 'PUT',
      body: { ...body, apps: [{ ...selection, url: 'https://private.example' }] },
    }),
    false,
  );
  for (const invalid of [
    [selection, selection],
    [{ ...selection, tools: [...grant.tools, ...grant.tools] }],
    [{ ...selection, tools: [] }],
    [{ ...selection, connectionRevision: 'old' }],
    [{ ...selection, tools: [{ name: 'x', revision: 'invalid' }] }],
    Array.from({ length: 21 }, (_, i) => ({ ...selection, connectionId: `app-${i}` })),
    [
      {
        ...selection,
        tools: Array.from({ length: 65 }, (_, i) => ({
          name: `tool-${i}`,
          revision: firstTool.revision,
        })),
      },
    ],
  ])
    assert.equal(sharedAppSelections(invalid), false);
  assert.deepEqual(Array.from(sharingDraft(sharing).apps), []);
});

test('actual owner picker reads real tools without granting, then selects exact versions and ignores late results after identity loss', async () => {
  const late = deferred<Response>(),
    calls: any[] = [],
    busy: boolean[] = [],
    changes: any[] = [];
  let catalogReads = 0;
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url, init });
    return String(url).endsWith('/apps')
      ? json(options)
      : ++catalogReads === 1
        ? json(catalog)
        : late.promise;
  };
  const ctx = await clientFixture(transport);
  let ui: any;
  ui = await harness(
    'web/src/components/SharedBotApps.tsx',
    'SharedBotAppPicker',
    {
      client: ctx.client,
      endpoint,
      apps: [],
      disabled: false,
      onBusy: (value: boolean) => busy.push(value),
      onChange: (apps: any[]) => {
        changes.push(apps);
        ui.props({ apps });
      },
    },
    transport,
    ctx.env,
  );
  try {
    await ui.flush();
    ui.button('选择工具').props.onClick();
    assert.equal(busy.at(-1), true);
    await ui.flush();
    assert.equal(changes.length, 0);
    input(ui, '授权工具 报告应用 report.read').props.onChange({ target: { checked: true } });
    await ui.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(changes[0])), [grant]);
    assert.equal(calls[1].url, `/api${endpoint}/${connectionId}`);
    assert.equal(calls[1].init.headers['X-OpenBot-Expected-User'], ids.user);
    const oldChoice = input(ui, '授权工具 报告应用 report.write').props.onChange;
    ui.button('刷新工具').props.onClick();
    await ui.flush();
    ctx.changeUser();
    late.resolve(json({ ...catalog, connectionRevision: version2 }));
    await ui.flush();
    oldChoice({ target: { checked: true } });
    await ui.flush();
    assert.equal(changes.length, 1);
  } finally {
    ui.dispose();
    ctx.client.suspend();
  }
});

test('actual owner picker requires explicit version confirmation and never adds newly discovered tools when upgrading selected permissions', async () => {
  const current = {
    ...catalog,
    connectionRevision: version2,
    tools: [{ ...firstTool, revision: 'c'.repeat(64) }, secondTool],
  };
  const transport: typeof fetch = async (url) =>
    String(url).endsWith('/apps')
      ? json({ ...options, selected: [{ ...view, status: 'changed' }] })
      : json(current);
  const ctx = await clientFixture(transport);
  let ui: any;
  const changes: any[] = [];
  ui = await harness(
    'web/src/components/SharedBotApps.tsx',
    'SharedBotAppPicker',
    {
      client: ctx.client,
      endpoint,
      apps: [grant],
      disabled: false,
      onBusy() {},
      onChange: (apps: any[]) => {
        changes.push(apps);
        ui.props({ apps });
      },
    },
    transport,
    ctx.env,
  );
  try {
    await ui.flush();
    ui.button('选择工具').props.onClick();
    await ui.flush();
    assert.equal(changes.length, 0);
    assert.equal(input(ui, '授权工具 报告应用 report.write').props.disabled, true);
    ui.button('使用所选工具的当前版本').props.onClick();
    await ui.flush();
    assert.equal(changes.length, 1);
    assert.equal(changes[0][0].connectionRevision, version2);
    assert.deepEqual(JSON.parse(JSON.stringify(changes[0][0].tools)), [
      { name: firstTool.name, revision: 'c'.repeat(64) },
    ]);
    assert.equal(input(ui, '授权工具 报告应用 report.write').props.checked, false);
    ui.button('取消此应用授权').props.onClick();
    await ui.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(changes.at(-1))), []);
  } finally {
    ui.dispose();
    ctx.client.suspend();
  }
});

test('actual shared manager combines apps, files and audience in one CAS; unknown save restores and replays the exact intent after remount', async () => {
  const env = environment(),
    calls: any[] = [],
    savedFile = {
      fileId: 'file-a',
      revision: 'd'.repeat(64),
      name: '材料.txt',
      size: 3,
      type: 'text/plain',
    };
  let puts = 0,
    closed = 0;
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === 'GET') return json(sharing);
    if (++puts === 1) throw new TypeError('offline');
    return json({
      ...sharing,
      share: {
        id: ids.share,
        revision: version2,
        status: 'active',
        targetTeamId: ids.team,
        audience: 'team',
        memberIds: [],
        files: [savedFile],
        apps: [grant],
      },
    });
  };
  const ui = await harness(
    'web/src/components/SharedBotsDialog.tsx',
    'ManageSharedBotContent',
    { ...ownerProps, onClose: () => closed++ },
    transport,
    env,
  );
  await ui.flush();
  const picker = all(ui.tree, (node) => node.type?.name === 'SharedBotAppPicker')[0];
  const files = all(ui.tree, (node) => node.type?.name === 'SharedBotFilePicker')[0];
  picker.props.onBusy(true);
  ui.tree.props.onClose();
  all(ui.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  await ui.flush();
  assert.equal(puts, 0);
  assert.equal(closed, 0);
  picker.props.onChange([grant]);
  files.props.onChange([savedFile]);
  picker.props.onBusy(false);
  await ui.flush();
  all(ui.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  await ui.flush();
  assert.equal(puts, 1);
  const original = JSON.parse(String(calls.find((call) => call.init.method === 'PUT').init.body));
  assert.equal(original.expectedRevision, 'unset');
  assert.deepEqual(original.apps, [
    { connectionId, connectionRevision: ids.revision, tools: grant.tools },
  ]);
  assert.deepEqual(original.files, [{ fileId: savedFile.fileId, revision: savedFile.revision }]);
  assert.doesNotMatch(JSON.stringify(original), /inputSchema|description/);
  ui.dispose();
  const restored = await harness(
    'web/src/components/SharedBotsDialog.tsx',
    'ManageSharedBotContent',
    ownerProps,
    transport,
    env,
  );
  try {
    await restored.flush();
    assert.match(restored.copy, /精确工具版本/);
    assert.equal(all(restored.tree, (node) => node.type?.name === 'SharedBotAppPicker').length, 0);
    restored.button('重试原请求').props.onClick();
    await restored.flush();
    assert.equal(puts, 2);
    const replay = JSON.parse(
      String(calls.filter((call) => call.init.method === 'PUT')[1].init.body),
    );
    assert.deepEqual(replay, original);
    assert.equal(env.sessionStorage.values.size, 0);
  } finally {
    restored.dispose();
  }
});
