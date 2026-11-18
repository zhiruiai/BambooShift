import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Page } from 'playwright-core';
import { attachBrowserImage } from '../../../server/workers/computer-worker/attach-image.js';
import { createBrowserTabs } from '../../../server/workers/computer-runtime/browser-tabs.js';

test('an interrupted upload is ambiguous and cleanup cannot obscure a completed attachment', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'attachment-receipt-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const path = 'cover.png';
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  await writeFile(join(workspace, path), bytes);
  const url = 'https://writer.example.org';
  let attempts = 0;
  let failAfterSending = true;
  let switchDuringCheck = false;
  let active: Page | undefined;
  const frame = {};
  const input = {
    ownerFrame: async () => frame,
    evaluate: async () => {
      if (switchDuringCheck) active = undefined;
      return true;
    },
    setInputFiles: async () => {
      attempts++;
      if (failAfterSending) throw new Error('Transport closed while awaiting the response');
    },
    dispose: async () => {
      throw new Error('Page closed');
    },
  };
  const page = {
    isClosed: () => false,
    title: async () => 'Editor',
    url: () => url,
    mainFrame: () => frame,
    locator: () => ({ count: async () => 1, elementHandle: async () => input }),
  } as unknown as Page;
  active = page;
  const tabs = createBrowserTabs({
    pages: () => [page],
    active: () => active,
    select: (value) => {
      active = value;
    },
  });
  const tabId = (await tabs.list()).tabs[0].tabId;
  const attach = () =>
    attachBrowserImage(
      tabs,
      workspace,
      {
        type: 'browser_attach_image',
        path,
        selector: 'input[type=file]',
        tabId,
        url,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      {},
    );
  await assert.rejects(attach(), { code: 'BROWSER_IMAGE_ATTACHMENT_UNKNOWN', status: 502 });
  assert.equal(attempts, 1);
  failAfterSending = false;
  assert.equal((await attach()).attached, true);
  assert.equal(attempts, 2);
  switchDuringCheck = true;
  await assert.rejects(attach(), /活动标签页已变化/);
  assert.equal(attempts, 2);
});
