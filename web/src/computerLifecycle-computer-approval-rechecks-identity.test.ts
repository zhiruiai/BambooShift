import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import {
  deferred,
  dialogHarness,
  approvalTransport,
  humanAccount,
  computerRequest,
} from './testSupport/computerLifecycleFixture';

test('computer approval rechecks identity and live action after deferred onAction, and drops old decisions after unmount', async () => {
  for (const change of ['account', 'workspace', 'unmount', 'status', 'same'] as const) {
    const calls: Array<{ url: string; init: RequestInit }> = [],
      dispatches: Array<() => Promise<unknown>> = [];
    const request = { ...computerRequest };
    const ui = await dialogHarness(approvalTransport(request, calls), {
      account: humanAccount('member-a'),
      onAction: async (work) => {
        dispatches.push(work);
      },
    });
    try {
      await ui.flush();
      const retained = ui.action().props.onApprove;
      retained();
      await ui.flush();
      assert.equal(dispatches.length, 1);
      assert.equal(calls.length, 0);
      if (change === 'account') ui.setAccount(humanAccount('owner-b', 'owner'));
      if (change === 'workspace')
        ui.setAccount({
          ...humanAccount('member-a'),
          workspace: { id: 'workspace-b', role: 'member' },
        });
      if (change === 'unmount') ui.dispose();
      // busy here comes from the parent executing the same action; it must not block its guarded dispatch.
      if (change === 'same') ui.setBusy(true);
      if (change === 'status') {
        // Use the actual row object held by the authoritative action list.
        ui.action().props.action.status = 'rejected';
      }
      await ui.flush();
      await dispatches[0]().catch((error) => assert.equal(error.name, 'AbortError'));
      assert.equal(calls.length, change === 'same' ? 1 : 0, change);
      if (change !== 'same') {
        retained();
        await ui.flush();
        assert.equal(
          calls.length,
          0,
          'the retained child handler cannot send under the new identity',
        );
      }
    } finally {
      ui.dispose();
    }
  }
});
