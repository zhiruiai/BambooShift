import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require('react-dom/server');
async function compile(path: string, extra = '') {
  const filename = resolve(path);
  const result = await build({
    stdin: {
      contents: (await readFile(filename, 'utf8')) + extra,
      resolveDir: dirname(filename),
      sourcefile: filename,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty' },
  });
  const module = { exports: {} as Record<string, any> };
  runInNewContext(result.outputFiles[0].text, { require, module, exports: module.exports });
  return module.exports;
}
const compiled = Promise.all([
  compile('web/src/components/ComputerSurface.tsx'),
  Promise.all([
    compile('web/src/components/computer/ComputerInputControls.tsx'),
    compile('web/src/components/ComputerDialog.tsx'),
  ]).then(([controls, dialog]) => ({ ...controls, ...dialog })),
]);
const render = (Component: any, props: Record<string, unknown>) =>
  renderToStaticMarkup(React.createElement(Component, props)) as string;
const computer = {
  connected: true,
  name: '远程工作电脑',
  mode: 'remote',
  surface: 'desktop',
  platform: 'linux',
  capabilities: ['virtual-desktop-v1'],
  status: 'ready',
  desktop: {
    kind: 'virtual',
    available: true,
    authorized: true,
    enabled: true,
    width: 1440,
    height: 900,
    permissions: { screenRecording: 'granted', accessibility: 'granted' },
  },
};
const noop = () => {
  throw Error('Rendering must not start an operation');
};

test('virtual desktop uses existing surface controls with truthful offline scope and approval text', async () => {
  const [surface] = await compiled;
  const html = render(surface.ComputerSurface, {
    computer,
    busy: false,
    checking: false,
    onCheck: noop,
    onSelect: noop,
  });
  for (const text of [
    '远程桌面已启用',
    'Linux 桌面',
    '仅支持离线应用',
    '删除工作区文件',
    '截图会发送到你配置的模型',
    'Bot 操作仍需批准',
    '手动接管立即执行',
    '重新检查桌面',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /macOS|辅助功能|屏幕录制|整机桌面|系统设置|自动恢复|每个 Bot/);
  assert.match(html, /segmented surface-choices/);
  assert.match(html, /aria-label="电脑操作范围"/);
});

test('virtual unavailable state explains a missing session without asking for Mac permissions', async () => {
  const [surface] = await compiled;
  const html = render(surface.ComputerSurface, {
    computer: {
      ...computer,
      desktop: {
        ...computer.desktop,
        available: false,
        authorized: false,
        reason: '远程桌面会话已结束',
      },
    },
    busy: false,
    checking: true,
    onCheck: noop,
    onSelect: noop,
  });
  assert.match(html, /远程桌面会话已结束/);
  assert.match(html, /远程桌面当前不可用/);
  assert.doesNotMatch(html, /macOS|系统设置|桌面控制助手|desktop control helper/);
  assert.match(html, /disabled=""/);
});

test('host desktop retains existing Mac permissions and explicit selection boundary', async () => {
  const [surface] = await compiled;
  const html = render(surface.ComputerSurface, {
    computer: { ...computer, desktop: { ...computer.desktop, kind: 'host', authorized: false } },
    busy: false,
    checking: false,
    onCheck: noop,
    onSelect: noop,
  });
  assert.match(html, /整机桌面/);
  assert.match(html, /macOS/);
  assert.match(html, /屏幕录制/);
  assert.match(html, /辅助功能/);
  assert.match(html, /安装 BambooShift 的这台 Mac/);
  assert.match(html, /安装的 BambooShift.app/);
  assert.match(html, /名称以 macOS 显示为准/);
  assert.match(html, /重新检查权限/);
  assert.match(html, /不会自动弹出授权或打开系统设置/);
  assert.doesNotMatch(html, /data\/native|Codex/);
  assert.doesNotMatch(html, /Linux 桌面|仅支持离线应用/);
});

test('full computer dialog requires an explicitly selected Bot before exposing its desktop', async () => {
  const [, dialog] = await compiled;
  const html = render(dialog.ComputerDialog, {
    data: { computer },
    conversationId: 'chat',
    conversationTitle: '示例会话',
    busy: false,
    onClose: noop,
    onAction: noop,
    refresh: noop,
  });
  for (const text of [
    '工作电脑',
    '请先选择一位 Bot',
    '接管电脑',
    '请选择一位 Bot，查看它的画面。',
    '每位 Bot 使用自己的画面',
    '工作文件',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /整机主屏幕|系统设置|macOS|系统搜索/);
});

test('actual shortcut handlers retain Mac copy/paste and label Linux keys without promising clipboard behavior', async () => {
  const [, dialog] = await compiled;
  for (const virtual of [true, false]) {
    const sent: string[] = [];
    const props = { virtual, disabled: false, onKey: (key: string) => sent.push(key) };
    const html = render(dialog.ComputerDesktopShortcuts, props);
    assert.match(html, virtual ? /切换窗口/ : /系统搜索/);
    assert.doesNotMatch(html, virtual ? /系统搜索/ : /切换窗口/);
    const buttons = dialog.ComputerDesktopShortcuts(props).props.children.filter(Boolean);
    assert.equal(sent.length, 0);
    for (const button of buttons) button.props.onClick();
    assert.deepEqual(
      sent,
      virtual
        ? ['ControlOrMeta+C', 'Alt+Tab']
        : ['ControlOrMeta+C', 'ControlOrMeta+V', 'Meta+Space'],
    );
    if (virtual) {
      assert.match(html, /Ctrl\+C/);
      assert.doesNotMatch(html, /复制|粘贴/);
    }
    const disabled = dialog.ComputerDesktopShortcuts({ ...props, disabled: true });
    for (const button of disabled.props.children.filter(Boolean))
      assert.equal(button.props.disabled, true);
  }
});

test('virtual text paste discloses temporary remote clipboard and rejects long input without truncating it', async () => {
  const [, dialog] = await compiled;
  const sent: string[] = [];
  const props = {
    desktop: true,
    virtual: true,
    disabled: false,
    value: '你好🐷',
    onChange: noop,
    onSend: (value: string) => sent.push(value),
  };
  const html = render(dialog.ComputerTextInput, props);
  for (const text of ['粘贴文本', '远程临时剪贴板', '最多 300', '长内容请上传文件', '不会自动重发'])
    assert.ok(html.includes(text), text);
  const submit = (patch = {}) =>
    dialog.ComputerTextInput({ ...props, ...patch }).props.onSubmit({ preventDefault() {} });
  assert.equal(sent.length, 0);
  submit();
  submit({ value: '🙂'.repeat(150) });
  for (const patch of [
    { value: '中'.repeat(301) },
    { value: '🙂'.repeat(151) },
    { disabled: true },
    { value: '' },
  ])
    submit(patch);
  assert.deepEqual(sent, ['你好🐷', '🙂'.repeat(150)]);
  const long = render(dialog.ComputerTextInput, { ...props, value: 'x'.repeat(301) });
  assert.match(long, /aria-invalid="true"/);
  assert.match(long, /当前已输入 301/);
  assert.ok(long.includes(`value="${'x'.repeat(301)}"`));
  assert.doesNotMatch(long, /maxlength=/);
  const host = render(dialog.ComputerTextInput, {
    ...props,
    virtual: false,
    value: 'x'.repeat(301),
  });
  assert.doesNotMatch(host, /临时剪贴板|最多 300|aria-invalid|disabled=/);
});
