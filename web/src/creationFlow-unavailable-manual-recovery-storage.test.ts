import { expandPureViews } from './testSupport/expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import type { BotAgent, Conversation } from '../../shared/types';
import type { CreationReceipt, CreationRequest } from '../../shared/creation-requests';
import { storage, fixture, click, component } from './testSupport/creationFlowFixture';

test('unavailable manual recovery storage blocks manual creation without disabling intelligent teaming', async () => {
  const memory = storage();
  memory.getItem = () => {
    throw new Error('Synthetic storage denied');
  };
  const f = await fixture({ memory });
  try {
    assert.equal(f.profile().props.disabled, true);
    await click(f.ui, '智能组队');
    assert.equal(component(f.ui.tree, 'SmartTeamPanel').props.disabled, false);
    component(f.ui.tree, 'SmartTeamPanel').props.onConfigureModel();
    await f.ui.flush();
    assert.ok(component(f.ui.tree, 'SettingsDialog'));
    assert.equal(f.calls.length, 0);
  } finally {
    f.ui.dispose();
  }
});
