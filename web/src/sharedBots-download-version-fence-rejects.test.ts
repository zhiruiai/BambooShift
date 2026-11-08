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
  harness,
  alias,
  fileGrant,
} from './testSupport/sharedBotsFixture';

test('download version fence rejects a late streamed body even when transport ignores cancellation and identity remains valid', async () => {
  const env = environment(),
    late = deferred<ReadableStreamReadResult<Uint8Array>>();
  let version = 'r1',
    created = 0,
    saved = 0,
    cancelled = 0;
  const FakeURL = class extends URL {
    static createObjectURL() {
      created++;
      return 'blob:late';
    }
    static revokeObjectURL() {}
  };
  const module = await compile('web/src/sharedBotFiles.ts', '', {
    ...env,
    URL: FakeURL,
    setTimeout: () => 1,
    clearTimeout() {},
  });
  const scope = { ticket: () => 0, current: () => true };
  const downloader = module.createSharedFileDownload({
    client: scope,
    userId: ids.user,
    basePath: `/shared-bots/${ids.share}/files`,
    version: () => version,
    allowed: () => true,
    fetch: async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: () => late.promise,
          async cancel() {
            cancelled++;
          },
          releaseLock() {},
        }),
      },
    }),
    save() {
      saved++;
    },
  });
  const work = downloader.download(fileGrant);
  await new Promise((done) => setImmediate(done));
  version = 'r2';
  late.resolve({ done: false, value: new TextEncoder().encode('data') });
  await work;
  assert.equal(cancelled, 1);
  assert.equal(created, 0);
  assert.equal(saved, 0);
  downloader.suspend();
});

test('actual same-user filesRevision change aborts pending download, rejects stale row clicks and allows a fresh authorized download', async () => {
  const late = deferred<ReadableStreamReadResult<Uint8Array>>(),
    calls: any[] = [],
    created: string[] = [],
    saved: string[] = [],
    revoked: string[] = [];
  let listCount = 0,
    downloads = 0,
    cancelled = 0;
  const FakeURL = class extends URL {
    static createObjectURL() {
      const url = `blob:confirmed-${created.length}`;
      created.push(url);
      return url;
    }
    static revokeObjectURL(url: string) {
      revoked.push(url);
    }
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
  const agent = (filesRevision: string) => ({
    ...alias,
    sharedBot: { ...alias.sharedBot, fileCount: 1, filesRevision, status: 'active' },
  });
  const ui = await harness(
    'web/src/components/SharedBotFiles.tsx',
    'SharedBotFilesContent',
    { agent: agent('r1'), userId: ids.user },
    async (url, init) => {
      calls.push({ url, init });
      if (!String(url).includes('/download?')) {
        listCount++;
        return json([
          {
            ...fileGrant,
            revision: listCount === 1 ? 'a'.repeat(64) : 'b'.repeat(64),
            status: 'available',
          },
        ]);
      }
      downloads++;
      return downloads === 1
        ? ({
            ok: true,
            body: {
              getReader: () => ({
                read: () => late.promise,
                async cancel() {
                  cancelled++;
                },
                releaseLock() {},
              }),
            },
          } as unknown as Response)
        : new Response('data');
    },
    { URL: FakeURL, document: fakeDocument, setTimeout: () => 1, clearTimeout() {} },
  );
  try {
    await ui.flush();
    const oldClick = ui.button('下载已确认版本').props.onClick;
    oldClick();
    await ui.flush();
    assert.equal(downloads, 1);
    const oldSignal = calls.find((call) => String(call.url).includes('/download?')).init.signal;
    ui.props({ agent: agent('r2') });
    await ui.flush();
    assert.equal(oldSignal.aborted, true);
    oldClick();
    await ui.flush();
    assert.equal(downloads, 1);
    late.resolve({ done: false, value: new TextEncoder().encode('data') });
    await ui.flush();
    assert.equal(cancelled, 1);
    assert.equal(created.length, 0);
    assert.equal(saved.length, 0);
    ui.button('下载已确认版本').props.onClick();
    await ui.flush();
    assert.equal(downloads, 2);
    assert.deepEqual(saved, ['blob:confirmed-0']);
    assert.match(calls.at(-1).url, new RegExp(`revision=${'b'.repeat(64)}$`));
  } finally {
    ui.dispose();
  }
  assert.deepEqual(revoked, created);
});
