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
  all,
  harness,
  alias,
  fileGrant,
  sourceFiles,
} from './testSupport/sharedBotsFixture';

test('download cancellation releases a late response without saving; mismatched content never creates an object URL', async () => {
  const env = environment(),
    late = deferred<Response>();
  let creations = 0,
    saves = 0,
    signal: AbortSignal | undefined;
  const FakeURL = class extends URL {
    static createObjectURL() {
      creations++;
      return 'blob:test';
    }
    static revokeObjectURL() {}
  };
  const module = await compile('web/src/sharedBotFiles.ts', '', {
      ...env,
      URL: FakeURL,
      setTimeout: () => 1,
      clearTimeout() {},
    }),
    scope = await compile('web/src/sharedBots.ts', '', env);
  const client = scope.createSharedBotClient({ userId: ids.user, identity: () => ids.user });
  const downloader = module.createSharedFileDownload({
    client,
    userId: ids.user,
    basePath: sourceFiles,
    fetch: async (_url: any, init: any) => {
      signal = init.signal;
      return late.promise;
    },
    save() {
      saves++;
    },
  });
  const pending = downloader.download(fileGrant);
  downloader.suspend();
  late.resolve(new Response('data'));
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(creations, 0);
  assert.equal(saves, 0);
  const wrong = module.createSharedFileDownload({
    client,
    userId: ids.user,
    basePath: sourceFiles,
    fetch: async () => new Response('too-long'),
    save() {
      saves++;
    },
  });
  await assert.rejects(wrong.download(fileGrant), /不一致/);
  assert.equal(creations, 0);
  wrong.suspend();
  client.suspend();
});

test('actual file search reaches the server beyond 200 candidates and old responses cannot replace newer search or selected versions', async () => {
  const env = environment(),
    module = await compile('web/src/sharedBots.ts', '', env),
    pending: ReturnType<typeof deferred<Response>>[] = [],
    calls: string[] = [],
    timers: (() => void)[] = [];
  const client = module.createSharedBotClient({
    userId: ids.user,
    identity: () => ids.user,
    fetch: async (url: any) => {
      calls.push(String(url));
      const wait = deferred<Response>();
      pending.push(wait);
      return wait.promise;
    },
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
        throw Error('search must not mutate selection');
      },
      onBusy() {},
    },
    async () => {
      throw Error('unused');
    },
    {
      setTimeout: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout() {},
    },
  );
  try {
    await ui.flush();
    pending[0].resolve(
      json({ files: [], selected: [{ ...fileGrant, status: 'available' }], truncated: true }),
    );
    await ui.flush();
    assert.match(ui.copy, /细化关键词/);
    const input = all(
      ui.tree,
      (node) => node.type === 'input' && node.props['aria-label'] === '搜索可共享资料',
    )[0];
    input.props.onChange({ target: { value: '旧关键词' } });
    await ui.flush();
    timers.shift()!();
    await ui.flush();
    input.props.onChange({ target: { value: '第201份资料' } });
    await ui.flush();
    pending[1].resolve(
      json({
        files: [{ ...fileGrant, fileId: 'old', name: '迟到旧结果' }],
        selected: [],
        truncated: false,
      }),
    );
    await ui.flush();
    assert.doesNotMatch(ui.copy, /迟到旧结果/);
    timers.shift()!();
    await ui.flush();
    assert.match(calls.at(-1)!, /\?query=/);
    assert.equal(
      new URL(calls.at(-1)!, 'https://fixture').searchParams.get('query'),
      '第201份资料',
    );
    pending[2].resolve(
      json({
        files: [{ ...fileGrant, fileId: 'new', name: '第201份资料' }],
        selected: [],
        truncated: false,
      }),
    );
    await ui.flush();
    assert.match(ui.copy, /第201份资料/);
    assert.match(ui.copy, /参考资料.txt/);
    assert.equal(
      all(
        ui.tree,
        (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked,
      ).length,
      1,
    );
  } finally {
    ui.dispose();
    client.suspend();
  }
});

test('desktop shared download invokes the narrow bridge synchronously from the click and never falls back to cookie/blob requests', async () => {
  const env = environment(),
    calls: any[] = [],
    late = deferred<{ status: string }>();
  let active = true,
    fetches = 0;
  Object.assign(env.window, {
    openbotFiles: {
      downloadSharedFile(input: any) {
        calls.push(input);
        return late.promise;
      },
    },
  });
  const module = await compile('web/src/sharedBotFiles.ts', '', {
    ...env,
    setTimeout: () => 1,
    clearTimeout() {},
  });
  const client = { ticket: () => 0, current: () => active };
  const downloader = module.createSharedFileDownload({
    client,
    userId: ids.user,
    basePath: sourceFiles,
    fetch: async () => {
      fetches++;
      throw Error('must not fall back');
    },
  });
  const promise = downloader.download(fileGrant);
  assert.equal(calls.length, 1, 'bridge starts before first await');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    path: `/api${sourceFiles}/file_1/download?revision=${fileGrant.revision}`,
    expectedUser: ids.user,
    name: fileGrant.name,
  });
  active = false;
  late.resolve({ status: 'saved' });
  await promise;
  assert.equal(fetches, 0);
  downloader.suspend();
  active = true;
  Object.assign(env.window, {
    openbotFiles: {
      async downloadSharedFile() {
        throw Error('原生保存被取消');
      },
    },
  });
  const failed = module.createSharedFileDownload({
    client,
    userId: ids.user,
    basePath: sourceFiles,
    fetch: async () => {
      fetches++;
      throw Error('no');
    },
  });
  await assert.rejects(failed.download(fileGrant), /原生保存被取消/);
  assert.equal(fetches, 0);
  failed.suspend();
});

test('actual recipient list refreshes same-count authorizations on filesRevision and rejects a slower prior list after rerender', async () => {
  const pending: ReturnType<typeof deferred<Response>>[] = [],
    calls: any[] = [];
  const agent = (filesRevision: string) => ({
    ...alias,
    sharedBot: { ...alias.sharedBot, fileCount: 1, filesRevision },
  });
  const ui = await harness(
    'web/src/components/SharedBotFiles.tsx',
    'SharedBotFilesContent',
    { agent: agent('r1'), userId: ids.user },
    async (url, init) => {
      calls.push({ url, init });
      const wait = deferred<Response>();
      pending.push(wait);
      return wait.promise;
    },
  );
  try {
    await ui.flush();
    assert.equal(calls.length, 1);
    pending[0].resolve(json([{ ...fileGrant, status: 'available', name: '最初版本.txt' }]));
    await ui.flush();
    assert.match(ui.copy, /最初版本/);
    ui.props({ agent: agent('r2') });
    await ui.flush();
    assert.equal(
      calls.length,
      2,
      'same count and source definition still refetch on grant revision',
    );
    ui.props({ agent: agent('r3') });
    await ui.flush();
    assert.equal(calls.length, 3);
    pending[2].resolve(
      json([
        { ...fileGrant, revision: 'c'.repeat(64), status: 'available', name: '最新确认版本.txt' },
      ]),
    );
    await ui.flush();
    assert.match(ui.copy, /最新确认版本/);
    pending[1].resolve(
      json([
        { ...fileGrant, revision: 'b'.repeat(64), status: 'available', name: '迟到中间版本.txt' },
      ]),
    );
    await ui.flush();
    assert.doesNotMatch(ui.copy, /迟到中间版本|最初版本/);
    assert.match(ui.copy, /最新确认版本/);
    assert.ok(calls.every((call) => call.init.headers['X-OpenBot-Expected-User'] === ids.user));
    ui.props({ agent: agent('r3') });
    await ui.flush();
    assert.equal(calls.length, 3, 'unchanged revision does not fetch again');
  } finally {
    ui.dispose();
  }
});
