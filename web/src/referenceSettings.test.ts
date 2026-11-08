import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { all, base, component, env, harness } from './testSupport/memoryImportSettingsFixture';
import { languageFixture } from './testSupport/languageFixture';

const props = () => ({
  ...base,
  onClose() {},
  onImported: async () => {},
  onTimeZoneChanged() {},
  onSettingsChanged() {},
  onPrimaryChanged() {},
});
const section = (h: any, value: string) =>
  component(h.tree, 'SettingsNavigation').props.onChange(value);

test('settings categories keep the same draft panels mounted and return from configuration to the originating category', async () => {
  let closed = 0;
  const h = await harness(
    'web/src/components/WorkspaceSettingsDialog.tsx',
    'WorkspaceSettingsContent',
    { ...props(), onClose: () => closed++ },
    env(),
  );
  try {
    await h.flush();
    const memory = component(h.tree, 'MemoryImportPanel'),
      zone = component(h.tree, 'WorkspaceTimeZoneSettings');
    assert.equal(memory.props.active, false);
    assert.equal(component(h.tree, 'AppearanceSettings').props.active, true);
    section(h, 'memory');
    await h.flush();
    assert.equal(component(h.tree, 'MemoryImportPanel').type, memory.type);
    assert.equal(component(h.tree, 'MemoryImportPanel').props.active, true);
    component(h.tree, 'MemoryImportPanel').props.onActivity({
      dirty: true,
      busy: false,
      pending: false,
    });
    component(h.tree, 'MemoryImportPanel').props.onConfigureModel();
    await h.flush();
    assert.equal(component(h.tree, 'SettingsDialog').props.active, true);
    assert.equal(component(h.tree, 'SettingsDialog').props.closeLabel, '返回记忆导入');
    component(h.tree, 'SettingsDialog').props.onClose();
    await h.flush();
    assert.equal(component(h.tree, 'MemoryImportPanel').props.active, true);
    section(h, 'work');
    await h.flush();
    assert.equal(component(h.tree, 'MemoryImportPanel').type, memory.type);
    assert.equal(component(h.tree, 'MemoryImportPanel').props.active, false);
    assert.equal(component(h.tree, 'WorkspaceTimeZoneSettings').type, zone.type);
    assert.equal(component(h.tree, 'WorkspaceTimeZoneSettings').props.active, true);
    section(h, 'devices');
    await h.flush();
    assert.equal(component(h.tree, 'SettingsNavigation').props.value, 'devices');
    assert.equal(all(h.tree, (node) => node.type?.name === 'DeviceSettings').length, 1);
    component(h.tree, 'Dialog').props.onClose();
    await h.flush();
    assert.equal(closed, 0);
    assert.match(h.copy, /尚未提交的导入内容/);
    h.button('继续编辑').props.onClick();
    await h.flush();
    section(h, 'memory');
    await h.flush();
    assert.equal(component(h.tree, 'MemoryImportPanel').type, memory.type);
    assert.equal(component(h.tree, 'MemoryImportPanel').props.active, true);
  } finally {
    h.dispose();
  }
});

test('a restored pending import remains reachable from general but blocks unrelated categories and stale account handlers', async () => {
  const h = await harness(
    'web/src/components/WorkspaceSettingsDialog.tsx',
    'WorkspaceSettingsContent',
    props(),
    env(),
  );
  try {
    await h.flush();
    const memory = component(h.tree, 'MemoryImportPanel');
    memory.props.onActivity({ dirty: false, busy: false, pending: true });
    section(h, 'models');
    await h.flush();
    assert.equal(component(h.tree, 'SettingsNavigation').props.value, 'general');
    assert.deepEqual(Array.from(component(h.tree, 'SettingsNavigation').props.recoverable), [
      'memory',
    ]);
    section(h, 'memory');
    await h.flush();
    assert.equal(component(h.tree, 'MemoryImportPanel').props.active, true);
    const priorNavigation = component(h.tree, 'SettingsNavigation').props.onChange;
    memory.props.onActivity({ dirty: false, busy: true, pending: true });
    priorNavigation('devices');
    await h.flush();
    assert.equal(component(h.tree, 'SettingsNavigation').props.value, 'memory');
    memory.props.onActivity({ dirty: false, busy: false, pending: false });
    h.setProps({ userId: 'different-account' });
    await h.flush();
    priorNavigation('devices');
    await h.flush();
    assert.equal(component(h.tree, 'SettingsNavigation').props.value, 'memory');
  } finally {
    h.dispose();
  }
});

test('members retain appearance, readonly work settings and device categories without model or primary mutation access', async () => {
  const h = await harness(
    'web/src/components/WorkspaceSettingsDialog.tsx',
    'WorkspaceSettingsContent',
    { ...props(), canManage: false, team: true },
    env(),
  );
  try {
    await h.flush();
    assert.equal(component(h.tree, 'SettingsNavigation').props.canManage, false);
    section(h, 'work');
    await h.flush();
    assert.equal(component(h.tree, 'WorkspaceTimeZoneSettings').props.canManage, false);
    assert.equal(component(h.tree, 'WorkspaceTimeZoneSettings').props.active, true);
    component(h.tree, 'MemoryImportPanel').props.onConfigurePrimary();
    section(h, 'models');
    await h.flush();
    assert.equal(
      all(h.tree, (node) => ['SettingsDialog', 'PrimaryBotDialog'].includes(node.type?.name))
        .length,
      0,
    );
    assert.equal(component(h.tree, 'SettingsNavigation').props.value, 'work');
  } finally {
    h.dispose();
  }
});

test('settings category navigation supports keyboard focus and exposes the recovery destination while blocked', async () => {
  const chosen: string[] = [];
  const h = await harness(
    'web/src/components/workspaceSettings/SettingsNavigation.tsx',
    'SettingsNavigation',
    {
      value: 'general',
      canManage: true,
      blocked: false,
      onChange: (value: string) => chosen.push(value),
    },
  );
  try {
    await h.flush();
    const buttons = all(h.tree, (node) => node.type === 'button');
    assert.equal(buttons.length, 8);
    const focused: number[] = [];
    const dom = buttons.map((_: unknown, i: number) => ({ focus: () => focused.push(i) }));
    buttons[0].props.onKeyDown({
      key: 'End',
      preventDefault() {},
      currentTarget: Object.assign(dom[0], { parentElement: { querySelectorAll: () => dom } }),
    });
    assert.deepEqual(focused, [buttons.length - 1]);
    buttons[2].props.onClick();
    assert.deepEqual(chosen, ['memory']);
    h.setProps({ blocked: true, recoverable: ['memory'] });
    await h.flush();
    const blocked = all(h.tree, (node) => node.type === 'button');
    assert.equal(blocked[1].props.disabled, true);
    assert.equal(blocked[2].props.disabled, false);
    assert.match(h.copy, /需要核对/);
    h.setProps({ blocked: false, canManage: false });
    await h.flush();
    assert.equal(all(h.tree, (node) => node.type === 'button').length, 7);
  } finally {
    h.dispose();
  }
});

test('the account card renders the current account context only and keeps the real account settings link', async () => {
  const result = await build({
    stdin: {
      contents:
        "export { SettingsAccountCard } from './components/workspaceSettings/SettingsAccountCard'; export { AccountContext } from './AccountContext';",
      resolveDir: resolve('web/src'),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*'],
    loader: { '.css': 'empty' },
  });
  const module = { exports: {} as any };
  runInNewContext(result.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
  });
  const { SettingsAccountCard, AccountContext } = module.exports;
  const value = {
    session: {
      authenticated: true,
      user: { id: 'user-a', name: 'Example Person', email: 'person@example.test' },
      workspaces: [],
    },
    workspace: { id: base.workspaceId },
  };
  const render = (id?: string) =>
    renderToStaticMarkup(
      React.createElement(
        AccountContext.Provider,
        { value },
        React.createElement(SettingsAccountCard, { userId: id, onAccount() {} }),
      ),
    );
  const html = render('user-a');
  assert.match(html, /Example Person/);
  assert.match(html, /person@example\.test/);
  assert.match(html, /href="\/account"/);
  assert.doesNotMatch(render('another-user'), /Example Person|person@example/);
  assert.doesNotMatch(render(), /href="\/account"/);
});

test('appearance displays theme, accent, language and spelling together before original avatar themes in both languages', async () => {
  const { api } = await languageFixture();
  for (const locale of ['zh-CN', 'en']) {
    api.initializeLanguage().setLanguage(locale);
    const html = renderToStaticMarkup(
      React.createElement(api.AppearanceSettings, { active: true }),
    );
    const positions = [
      'value="system"',
      'value="bot"',
      'value="zh-CN"',
      'type="checkbox"',
      'class="appearance-avatar-themes"',
    ].map((value) => html.indexOf(value));
    assert.ok(positions.every((value) => value >= 0));
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions,
    );
    if (locale === 'en') assert.doesNotMatch(html, /[\u3400-\u9fff]/);
  }
});
