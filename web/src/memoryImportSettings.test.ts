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
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import type { AppSettings, BotAgent, ModelProfile } from '../../shared/types';
import type { BotTeamPlan } from '../../shared/bot-team-plans';
import ts from 'typescript';
import {
  json,
  all,
  component,
  harness,
  base,
  env,
} from './testSupport/memoryImportSettingsFixture';

test('settings keeps the import panel mounted through model and primary setup and returns to its category without submitting', async () => {
  const events: any[] = [];
  const h = await harness(
    'web/src/components/WorkspaceSettingsDialog.tsx',
    'WorkspaceSettingsContent',
    {
      ...base,
      onClose: () => events.push('close'),
      onImported: () => events.push('import'),
      onSettingsChanged: (s: any) => events.push(['model', s]),
      onPrimaryChanged: (s: any) => events.push(['primary', s]),
    },
    env(),
  );
  try {
    await h.flush();
    component(h.tree, 'SettingsNavigation').props.onChange('memory');
    await h.flush();
    const panel = component(h.tree, 'MemoryImportPanel');
    assert.equal(panel.props.active, true);
    assert.equal(component(h.tree, 'SettingsDialog').props.active, false);
    panel.props.onActivity({ dirty: true, busy: false, pending: false });
    panel.props.onConfigureModel();
    await h.flush();
    assert.equal(component(h.tree, 'MemoryImportPanel').type, panel.type);
    assert.equal(component(h.tree, 'MemoryImportPanel').props.active, false);
    assert.equal(component(h.tree, 'SettingsDialog').props.active, true);
    component(h.tree, 'SettingsDialog').props.onSettingsChanged({ configured: true });
    component(h.tree, 'SettingsDialog').props.onClose();
    await h.flush();
    assert.equal(component(h.tree, 'MemoryImportPanel').props.active, true);
    component(h.tree, 'MemoryImportPanel').props.onConfigurePrimary();
    await h.flush();
    assert.equal(component(h.tree, 'MemoryImportPanel').props.active, false);
    component(h.tree, 'PrimaryBotDialog').props.onSaved({ agentId: 'chief' }, {});
    await h.flush();
    assert.equal(component(h.tree, 'MemoryImportPanel').props.active, true);
    assert.deepEqual(events, [
      ['model', { configured: true }],
      ['primary', { agentId: 'chief' }],
    ]);
  } finally {
    h.dispose();
  }
});

test('model configuration entry opens the model view directly, returns to the same general panel, and restricts members to general', async () => {
  for (const canManage of [true, false]) {
    const events: string[] = [];
    const h = await harness(
      'web/src/components/WorkspaceSettingsDialog.tsx',
      'WorkspaceSettingsContent',
      {
        ...base,
        canManage,
        initialView: 'models',
        onClose: () => events.push('close'),
        onImported: () => events.push('import'),
        onSettingsChanged() {},
        onPrimaryChanged() {},
      },
      env(),
    );
    try {
      await h.flush();
      const panel = component(h.tree, 'MemoryImportPanel');
      assert.equal(panel.props.active, false);
      assert.equal(component(h.tree, 'Dialog').props.active, !canManage);
      assert.equal(component(h.tree, 'AppearanceSettings').props.active, !canManage);
      if (canManage) {
        const model = component(h.tree, 'SettingsDialog');
        assert.equal(model.props.active, true);
        assert.equal(model.props.closeLabel, '返回通用设置');
        model.props.onClose();
        await h.flush();
        assert.equal(component(h.tree, 'MemoryImportPanel').type, panel.type);
        assert.equal(component(h.tree, 'MemoryImportPanel').props.active, false);
        assert.equal(component(h.tree, 'SettingsDialog').props.active, false);
        component(h.tree, 'SettingsNavigation').props.onChange('memory');
        await h.flush();
        assert.equal(component(h.tree, 'MemoryImportPanel').props.active, true);
        panel.props.onActivity({ dirty: true, busy: false, pending: false });
        panel.props.onConfigureModel();
        await h.flush();
        component(h.tree, 'SettingsDialog').props.onClose();
        await h.flush();
        component(h.tree, 'Dialog').props.onClose();
        await h.flush();
        assert.match(h.copy, /尚未提交的导入内容/);
      } else {
        assert.equal(all(h.tree, (node) => node.type?.name === 'SettingsDialog').length, 0);
        panel.props.onConfigureModel();
        await h.flush();
        assert.equal(component(h.tree, 'Dialog').props.active, true);
      }
      if (canManage) {
        panel.props.onConfigureModel();
        await h.flush();
        assert.equal(component(h.tree, 'AppearanceSettings').props.active, false);
        h.setProps({ canManage: false });
        await h.flush();
        assert.equal(component(h.tree, 'Dialog').props.active, true);
        assert.equal(component(h.tree, 'AppearanceSettings').props.active, true);
        assert.equal(component(h.tree, 'MemoryImportPanel').props.active, false);
      }
      assert.deepEqual(events, []);
    } finally {
      h.dispose();
    }
  }
});

test('settings guards dirty navigation and busy imports before a parent rerender and rejects stale account callbacks', async () => {
  let closed = 0;
  const runtime = env();
  const h = await harness(
    'web/src/components/WorkspaceSettingsDialog.tsx',
    'WorkspaceSettingsContent',
    {
      ...base,
      onClose: () => closed++,
      onImported: async () => {},
      onSettingsChanged() {},
      onPrimaryChanged() {},
    },
    runtime,
  );
  try {
    await h.flush();
    component(h.tree, 'SettingsNavigation').props.onChange('memory');
    await h.flush();
    const panel = component(h.tree, 'MemoryImportPanel');
    panel.props.onActivity({ dirty: true, busy: true, pending: true });
    component(h.tree, 'Dialog').props.onClose();
    panel.props.onConfigureModel();
    await h.flush();
    assert.equal(closed, 0);
    assert.equal(component(h.tree, 'SettingsDialog').props.active, false);
    panel.props.onActivity({ dirty: true, busy: false, pending: false });
    component(h.tree, 'SettingsAccountCard').props.onAccount();
    await h.flush();
    assert.deepEqual(runtime.navigations, []);
    h.button('继续编辑').props.onClick();
    await h.flush();
    assert.equal(closed, 0);
    component(h.tree, 'Dialog').props.onClose();
    await h.flush();
    h.button('放弃本页内容并继续').props.onClick();
    assert.equal(closed, 1);
    h.setProps({ userId: 'different-account' });
    await h.flush();
    panel.props.onConfigureModel();
    await h.flush();
    assert.equal(component(h.tree, 'SettingsDialog').props.active, false);
    await assert.rejects(panel.props.onImported({}), /账户已变化/);
  } finally {
    h.dispose();
  }
});

test('hidden model settings makes no reads until visible and does not save through an old hidden form handler', async () => {
  let reads = 0,
    writes = 0;
  const profiles = {
    activeProfileId: 'm',
    profiles: [
      {
        id: 'm',
        name: 'Model',
        provider: 'custom',
        model: 'test',
        baseUrl: 'https://example.test',
        vision: false,
        configured: true,
        hasApiKey: false,
      },
    ],
  };
  const h = await harness(
    'web/src/components/SettingsDialog.tsx',
    'ModelSettingsDialog',
    {
      settings: { profileId: 'm', configured: true },
      workspaceId: '00000000-0000-4000-8000-000000000001',
      userId: 'user-a',
      showManagement: false,
      active: false,
      onClose() {},
      onSettingsChanged() {},
    },
    {
      ...env(),
      fetch: async (_url: any, init: any) => {
        if (init.method === 'POST') writes++;
        else reads++;
        return json(profiles);
      },
    },
  );
  try {
    await h.flush();
    assert.equal(reads, 0);
    h.setProps({ active: true });
    await h.flush();
    assert.equal(reads, 1);
    h.field('配置名称').props.onChange({ target: { value: 'Draft preserved' } });
    await h.flush();
    const form = all(h.tree, (n) => n.type === 'form')[0];
    h.setProps({ active: false });
    await h.flush();
    form.props.onSubmit({ preventDefault() {} });
    await h.flush();
    assert.equal(writes, 0);
    h.setProps({ active: true });
    await h.flush();
    assert.equal(h.field('配置名称').props.value, 'Draft preserved');
  } finally {
    h.dispose();
  }
});
