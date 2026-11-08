import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';

// Compile the actual TSX and omit CSS only. No browser, microphone or computer is started.
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
  compile('web/src/components/RemoteShellDetails.tsx'),
  compile('web/src/components/computer/ComputerActionEntry.tsx', ''),
  compile('web/src/components/ChatComputerCard.tsx'),
]);
const render = (Component: any, props: Record<string, unknown>) =>
  renderToStaticMarkup(React.createElement(Component, props)) as string;
const action = {
  id: 'request-only-one',
  type: 'remote_shell',
  payload: {
    command: 'python3 - <<\'PY\'\nprint("<script>alert(1)</script>")\nPY',
    path: 'reports/本周',
  },
  status: 'pending',
  createdAt: '2026-11-05T03:00:00Z',
};
const success = {
  stdout: '完成\n<script>not executable</script>',
  stderr: '',
  exitCode: 0,
  truncated: false,
  timedOut: false,
  cancelled: false,
  durationMs: 1423,
};
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
}

test('remote shell approval renders the full command, relative directory and execution boundary as text', async () => {
  const [shell, dialog] = await compiled;
  const html = render(dialog.ComputerActionEntry, {
    action,
    busy: false,
    controlled: false,
    owner: true,
    onApprove() {
      throw Error('SSR must not approve');
    },
    onReject() {
      throw Error('SSR must not reject');
    },
  });
  for (const text of [
    '运行远程代码',
    'reports/本周',
    '最长 30 秒',
    '无网络访问',
    '删除工作区文件',
    '不会因失败、超时或取消而撤销',
    '批准仅适用于本次操作',
    '允许本次操作',
  ])
    assert.ok(html.includes(text), text);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<iframe|<a href|<form|<textarea/);
  assert.match(html, /tabindex="0" role="region" aria-label="完整执行命令"/);
  assert.match(render(shell.RemoteShellDetails, { payload: { command: 'pwd' } }), /工作区根目录/);
  const command = '#'.repeat(15950) + '\nLAST_COMMAND_LINE';
  assert.match(
    render(shell.RemoteShellDetails, { payload: { command, path: '.' } }),
    /LAST_COMMAND_LINE/,
  );
});

test('remote shell results distinguish success, nonzero exit, signal, timeout and cancellation', async () => {
  const [shell] = await compiled;
  for (const [result, label] of [
    [success, '已完成'],
    [{ ...success, exitCode: 2 }, '执行失败 · 退出码 2'],
    [{ ...success, exitCode: null, signal: 'SIGTERM' }, '执行已中断'],
    [{ ...success, exitCode: null, signal: 'SIGKILL', timedOut: true }, '执行超时'],
    [{ ...success, exitCode: null, cancelled: true }, '已取消'],
  ] as const) {
    const html = render(shell.RemoteShellResult, { result });
    assert.ok(html.includes(label), label);
    assert.match(html, /退出码/);
    assert.match(html, /标准输出（stdout）/);
    assert.match(html, /错误输出（stderr）/);
    assert.match(html, /1\.4 秒/);
    assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script|<iframe|<details[^>]*\sopen(?:\s|=|>)/);
  }
  const html = render(shell.RemoteShellResult, {
    result: {
      ...success,
      stdout: 'x'.repeat(20000) + 'FULL_RETAINED_TAIL',
      stderr: '<img src=x onerror=bad()>',
      truncated: true,
    },
  });
  assert.match(html, /FULL_RETAINED_TAIL/);
  assert.match(html, /输出达到保存上限/);
  assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/);
  assert.doesNotMatch(html, /<img|data:|base64/);
});

test('approval remains one explicit action and preserves busy, takeover and malformed-request restrictions', async () => {
  const [, dialog] = await compiled;
  let approvals = 0,
    rejections = 0;
  const props = {
    action,
    busy: false,
    controlled: false,
    owner: true,
    onApprove() {
      approvals++;
    },
    onReject() {
      rejections++;
    },
  };
  const get = (patch = {}) => dialog.ComputerActionEntry({ ...props, ...patch });
  const primary = (tree: any) =>
    find(tree, (node) => node.type === 'button' && node.props.className === 'primary-button');
  const secondary = (tree: any) =>
    find(tree, (node) => node.type === 'button' && node.props.className === 'secondary-button');
  assert.equal(approvals, 0);
  assert.equal(primary(get()).props.disabled, false);
  primary(get()).props.onClick();
  assert.equal(approvals, 1);
  assert.equal(rejections, 0);
  secondary(get()).props.onClick();
  assert.equal(rejections, 1);
  assert.equal(primary(get({ busy: true })).props.disabled, true);
  assert.equal(secondary(get({ busy: true })).props.disabled, true);
  assert.equal(primary(get({ controlled: true })).props.disabled, true);
  for (const payload of [
    {},
    { command: '' },
    { command: 'x'.repeat(16001) },
    { command: 'pwd', path: 7 },
  ]) {
    const tree = get({ action: { ...action, payload } });
    assert.equal(primary(tree).props.disabled, true);
    assert.match(renderToStaticMarkup(tree), /记录不完整/);
  }
  assert.equal(
    primary(get({ controlled: true, action: { ...action, type: 'upload_file' } })).props.disabled,
    false,
  );
  const terminal = renderToStaticMarkup(
    get({ action: { ...action, type: 'terminal_command', payload: { command: 'pwd' } } }),
  );
  assert.match(terminal, /运行命令/);
  assert.doesNotMatch(terminal, /remote-shell|无网络|最长 30 秒/);
});

test('resource limits have specific Chinese reasons without hiding cancellation or timeout', async () => {
  const [shell] = await compiled;
  for (const [resourceLimit, label, description] of [
    ['memory', '内存已达上限', '本次执行使用的内存达到上限，已停止。'],
    ['disk-reserve', '存储余量不足', '远程工作区可用存储低于保留余量，本次执行已停止。'],
    ['pids', '进程数已达上限', '本次执行达到进程数量上限，无法继续创建进程。'],
  ] as const) {
    const result = { ...success, exitCode: null, signal: 'SIGKILL', resourceLimit };
    const html = render(shell.RemoteShellResult, { result });
    assert.match(html, new RegExp(`查看执行结果 · ${label}`));
    assert.ok(html.includes(description));
    assert.match(html, /SIGKILL/);
    assert.doesNotMatch(html, /执行已中断|已完成|重新连接|<button/);
    const cancelled = render(shell.RemoteShellResult, { result: { ...result, cancelled: true } });
    assert.match(cancelled, /查看执行结果 · 已取消/);
    assert.ok(cancelled.includes(description));
    const timeout = render(shell.RemoteShellResult, { result: { ...result, timedOut: true } });
    assert.match(timeout, /查看执行结果 · 执行超时/);
    assert.ok(timeout.includes(description));
  }
  const unknown = render(shell.RemoteShellResult, {
    result: { ...success, resourceLimit: '__proto__' },
  });
  assert.match(unknown, /查看执行结果 · 已完成/);
  assert.doesNotMatch(unknown, /__proto__|达到上限|存储余量/);
});

test('chat records and approval history use the same shell details and do not mark unsuccessful runs complete', async () => {
  const [, dialog, app] = await compiled;
  let opened = 0;
  for (const [result, label] of [
    [success, '已完成'],
    [{ ...success, exitCode: 3, stderr: '具体失败原因' }, '执行失败 · 退出码 3'],
    [{ ...success, exitCode: null, timedOut: true }, '执行超时'],
    [{ ...success, exitCode: null, cancelled: true }, '已取消'],
    [{ ...success, exitCode: null, signal: 'SIGKILL', resourceLimit: 'memory' }, '内存已达上限'],
    [{ ...success, exitCode: null, resourceLimit: 'disk-reserve' }, '存储余量不足'],
    [{ ...success, exitCode: 1, resourceLimit: 'pids' }, '进程数已达上限'],
  ] as const) {
    const finished = { ...action, status: 'done', result };
    const message = {
      id: 'message',
      conversationId: 'conversation',
      role: 'tool',
      content: '原来的工作说明',
      status: 'done',
      createdAt: action.createdAt,
      metadata: { action: finished },
    };
    const card = render(app.ComputerRecord, {
      message,
      onClick() {
        opened++;
      },
    });
    const history = render(dialog.ComputerActionEntry, {
      action: finished,
      busy: false,
      controlled: false,
      owner: true,
      onApprove() {
        throw Error('not pending');
      },
      onReject() {},
    });
    for (const html of [card, history]) {
      assert.ok(html.includes(label));
      assert.match(html, /remote-shell-details/);
      assert.match(html, /remote-shell-result/);
      if (label !== '已完成') assert.doesNotMatch(html, /已完成/);
      assert.doesNotMatch(html, /允许本次操作|工作环境示意/);
    }
    assert.match(card, /原来的工作说明/);
    assert.match(card, /打开电脑面板/);
  }
  assert.equal(opened, 0);
});

test('chat computer cards state who may approve without presenting another person an approval entry', async () => {
  const [, , app] = await compiled;
  const message = {
    id: 'msg',
    conversationId: 'chat',
    agentId: 'bot-a',
    role: 'assistant',
    content: '电脑操作等待你批准。',
    kind: 'computer',
    status: 'done',
    createdAt: action.createdAt,
    metadata: { action: { ...action, requester: { userId: 'member-a', name: '林' } } },
  };
  const own = render(app.ComputerRecord, {
    message,
    userId: 'member-a',
    owner: false,
    onChanged: async () => {},
    onClick() {},
  });
  assert.match(own, /等待你批准/);
  assert.match(own, /允许一次/);
  assert.match(own, /打开电脑面板/);
  const other = render(app.ComputerRecord, {
    message,
    userId: 'owner-b',
    owner: true,
    onChanged: async () => {},
    onClick() {},
  });
  assert.match(other, /等待林批准/);
  assert.match(other, /打开电脑面板/);
  assert.doesNotMatch(other, /允许一次/);
  assert.match(other, /拥有者不能代为审批/);
  assert.doesNotMatch(other, /电脑操作等待你批准/);
  assert.doesNotMatch(own, /电脑操作等待你批准/);
});
