import { componentSource } from './testSupport/componentSource';
import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import type { AppAction, ConnectedApp } from '../../shared/app-connections';
import type { AppOAuthFlow } from '../../shared/app-oauth';
import { json, deferred, app, action, props, harness } from './testSupport/appsFixture';

test('retained app approval callbacks stop after requester, account, workspace, route or lifetime changes', async () => {
  for (const change of ['requester', 'user', 'workspace', 'path', 'unmount'] as const) {
    const calls: unknown[] = [];
    const window = Object.assign(new EventTarget(), { location: { pathname: '/w/space-a/' } });
    const ui = await harness(
      'web/src/components/AppActionCard.tsx',
      'AppActionContent',
      {
        action: { ...action, requester: { userId: 'member-a' } },
        owner: false,
        userId: 'member-a',
        workspaceId: 'space-a',
        onChanged: async () => {},
        onApps() {},
      },
      (async (...args) => {
        calls.push(args);
        return json(action);
      }) as typeof fetch,
      { window },
    );
    try {
      await ui.flush();
      const retained = ui.button('批准这一次').props.onClick;
      if (change === 'requester')
        ui.setProps({ action: { ...action, requester: { userId: 'other' } } });
      if (change === 'user') ui.setProps({ userId: 'owner-b', owner: true });
      if (change === 'workspace') ui.setProps({ workspaceId: 'space-b' });
      if (change === 'path') window.location.pathname = '/w/space-b/';
      if (change === 'unmount') ui.dispose();
      else await ui.flush();
      retained();
      await ui.flush();
      assert.equal(calls.length, 0, change);
    } finally {
      ui.dispose();
    }
  }
});

test('explicit file upload approves only its own requester using the original identity and suppresses late auto-approval', async () => {
  const context = {
    computerName: '工作电脑',
    computerMode: 'remote',
    computerConnected: true,
    conversationId: 'chat',
    conversationTitle: '会话',
  };
  for (const change of ['same', 'other-requester', 'account', 'unmount'] as const) {
    let account = {
      session: { user: { id: 'member-a' } },
      workspace: { id: 'space-a', role: 'member' },
    };
    const response = deferred<Response>(),
      calls: Array<{ url: string; init: RequestInit }> = [];
    const upload = {
      id: 'upload-a',
      type: 'upload_file',
      status: 'pending',
      payload: {},
      createdAt: action.createdAt,
      requester: { userId: change === 'other-requester' ? 'other' : 'member-a' },
    };
    const ui = await harness(
      'web/src/components/ComputerFiles.tsx',
      'TransferHarness',
      { context, onComplete: async () => {} },
      (async (url, init) => {
        calls.push({ url: String(url), init: init! });
        if (String(url).endsWith('/approve')) return json({ ...upload, status: 'done' });
        return response.promise;
      }) as typeof fetch,
      { account: () => account, setInterval: () => 1, clearInterval() {} },
      '\nfunction TransferHarness(props: any) { return useComputerTransfer(props.onComplete, props.context); }',
    );
    try {
      await ui.flush();
      const task = ui.tree.perform({ type: 'upload_file', fileId: 'file-a' }, context);
      assert.equal(calls.length, 1);
      if (change === 'account') {
        account = {
          session: { user: { id: 'owner-b' } },
          workspace: { id: 'space-a', role: 'owner' },
        };
        ui.setProps({});
        await ui.flush();
      }
      if (change === 'unmount') ui.dispose();
      response.resolve(json(upload));
      await task;
      await ui.flush();
      assert.equal(calls.length, change === 'same' ? 2 : 1, change);
      for (const call of calls) {
        assert.ok(call.url.startsWith('/api/workspaces/space-a/computer/actions'));
        assert.equal(new Headers(call.init.headers).get('X-OpenBot-Expected-User'), 'member-a');
      }
    } finally {
      response.resolve(json(upload));
      ui.dispose();
    }
  }
});
