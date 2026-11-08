import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const sources = `
export { initializeLanguage } from './i18n';
export { serviceText } from './i18n/serviceText';
export { AppActionCard } from './components/AppActionCard';
export { AppOAuthPanel } from './components/AppOAuthPanel';
export { CloudComputerCard } from './components/CloudComputerCard';
export { ComputerStatusView } from './components/computer/ComputerStatusView';
export { ComputerActionEntry } from './components/computer/ComputerActionEntry';
export { ComputerSurface } from './components/ComputerSurface';
export { BotScreenPicker } from './components/BotScreenPicker';
export { AppConnectionDetailsView } from './components/apps/AppConnectionDetailsView';
`;
const userId = '00000000-0000-4000-8000-000000000001';
const appId = '00000000-0000-4000-8000-000000000002';
const account = {
  session: { user: { id: userId, name: '我的名字' } },
  workspace: { id: 'space-a', role: 'owner' },
};
let bundle: Promise<string> | undefined;
async function fixture() {
  bundle ??= build({
    stdin: { contents: sources, resolveDir: resolve('web/src'), loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty' },
  }).then((output) => output.outputFiles[0].text);
  const values = new Map<string, string>();
  const window = Object.assign(new EventTarget(), {
    location: { pathname: '/w/space-a/' },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  let supplied: unknown;
  const hooks = {
    ...React,
    useContext: () => account,
    useRef: (value: unknown) => ({ current: value }),
    useState: (initial: unknown) => [
      initial === null && supplied !== undefined
        ? supplied
        : initial === true
          ? false
          : typeof initial === 'function'
            ? initial()
            : initial,
      () => {},
    ],
    useEffect: () => {},
    useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  };
  const module = { exports: {} as Record<string, any> };
  runInNewContext(await bundle, {
    module,
    exports: module.exports,
    require: (name: string) => (name === 'react' ? hooks : require(name)),
    window,
    document: { documentElement: { lang: '', dataset: {} } },
    console,
    AbortController,
    AbortSignal,
    DOMException,
    URL,
    Response,
    TextEncoder,
  });
  const api = module.exports;
  return {
    api,
    language: api.initializeLanguage(),
    render(name: string, props: Record<string, unknown>, state?: unknown) {
      supplied = state;
      return renderToStaticMarkup(React.createElement(api[name], props));
    },
  };
}
const dto = () => ({
  action: {
    id: appId,
    conversationId: 'chat',
    agentId: 'bot',
    connectionId: appId,
    appName: '授权已取消。',
    toolName: 'do_work',
    arguments: { userText: '我的任务：授权已取消。' },
    status: 'error',
    createdAt: '2026-11-06T00:00:00Z',
    expiresAt: '2026-11-06T00:05:00Z',
    error: '应用连接已撤销，原审批已失效。',
    result: { text: '外部结果：授权已取消。', isError: true },
  },
  oauth: {
    id: appId,
    connectionId: appId,
    connectionRevision: appId,
    appName: '用户应用名',
    status: 'error',
    expiresAt: '2026-11-06T00:05:00Z',
    scopes: [],
    error: '授权未能确认完成，请重新开始；不会自动重试兑换。',
  },
  cloud: {
    configured: true,
    name: '我的云电脑',
    state: 'unknown',
    canStart: false,
    expiresAt: null,
    observedAt: '2026-11-06T00:00:00Z',
    worker: { connected: false, reconnectRequired: false },
    notice: '启动请求可能已发送，请刷新状态确认；不会自动重试。',
    error: { code: 'CLOUD_CONFIG_INVALID', message: '云电脑私有配置不可用，请联系空间管理员。' },
  },
});

test('HTTP 200 service fields render in English while original DTOs, names, arguments and external results stay unchanged', async () => {
  const body = dto();
  const serialized = JSON.stringify(body);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(serialized);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/service-status`);
    assert.equal(response.status, 200);
    const data = await response.json();
    const f = await fixture();
    f.language.setLanguage('en');
    const action = f.render('AppActionCard', {
      action: data.action,
      owner: true,
      userId,
      workspaceId: 'space-a',
      onChanged: async () => {},
      onApps: () => {},
    });
    assert.match(action, /application connection was revoked/);
    assert.match(action, /授权已取消。/);
    assert.match(action, /我的任务/);
    assert.match(action, /外部结果/);
    assert.doesNotMatch(action, /应用连接已撤销，原审批已失效/);
    const oauth = f.render(
      'AppOAuthPanel',
      {
        app: { id: appId, revision: appId, name: '用户应用名', status: 'needs_auth' },
        workspaceId: 'space-a',
        userId,
        onBusy: () => {},
        onChanged: () => {},
      },
      data.oauth,
    );
    assert.match(oauth, /Authorization completion could not be confirmed/);
    assert.doesNotMatch(oauth, /授权未能确认完成/);
    const cloud = f.render(
      'CloudComputerCard',
      { onPendingChange: () => {}, onStateChange: () => {}, onStarted: async () => {} },
      data.cloud,
    );
    assert.match(cloud, /start request may have been sent/);
    assert.match(cloud, /cloud computer configuration is unavailable/);
    assert.match(cloud, /我的云电脑/);
    assert.equal(JSON.stringify(data), serialized);
    f.language.setLanguage('zh-CN');
    assert.equal(f.api.serviceText(data.action.error), data.action.error);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('computer status, desktop permission and approval errors translate only their service fields', async () => {
  const f = await fixture();
  f.language.setLanguage('en');
  const machine = {
    connected: false,
    mode: 'remote',
    surface: 'desktop',
    name: '保留这台电脑的名称',
    status: '原电脑操作清理尚未确认，请维护后重新连接。',
    capabilities: [],
    desktop: {
      kind: 'virtual',
      available: false,
      enabled: false,
      authorized: false,
      permissions: { screenRecording: 'denied', accessibility: 'denied' },
      reason: '平台执行空间不能控制宿主整机桌面。',
    },
  };
  // Inspect the real status view's own nodes without mounting its network-driven children.
  const view = f.api.ComputerStatusView({
    machine,
    computer: machine,
    canManage: false,
    data: { agents: [] },
    panel: 'machine',
  });
  const section = view.props.children[0];
  const status = renderToStaticMarkup(section);
  assert.match(status, /Cleanup of the previous computer action is unconfirmed/);
  assert.match(status, /保留这台电脑的名称/);
  const local = { ...machine, mode: 'local', connected: true, targetRevision: 'revision' };
  const shared = f.api.ComputerStatusView({
    machine: local,
    computer: {
      ...local,
      status: 'Fresh shared browser status',
      botScreen: { agentId: 'bot', shared: true, status: 'ready' },
    },
    canManage: false,
    data: { agents: [] },
    panel: 'machine',
  });
  const sharedStatus = renderToStaticMarkup(shared.props.children[0]);
  assert.match(sharedStatus, /Fresh shared browser status/);
  assert.doesNotMatch(sharedStatus, /Cleanup of the previous computer action is unconfirmed/);
  const surface = f.render('ComputerSurface', {
    computer: machine,
    busy: false,
    checking: false,
    onCheck: () => {},
    onSelect: () => {},
  });
  assert.match(surface, /cannot control the host computer/);
  const action = f.render('ComputerActionEntry', {
    action: {
      id: appId,
      type: 'browser_type',
      payload: { text: '用户已拒绝此电脑操作。' },
      status: 'error',
      createdAt: '2026-11-06T00:00:00Z',
      error: '用户已拒绝此电脑操作。',
    },
    busy: false,
    controlled: false,
    owner: true,
    onReject: () => {},
    onApprove: () => {},
  });
  assert.match(action, /requester rejected this computer action/);
  assert.match(action, /<code>用户已拒绝此电脑操作。<\/code>/);
  assert.equal(machine.desktop.reason, '平台执行空间不能控制宿主整机桌面。');
});

test('known safe terminal reasons switch language live and unmatched external details are never rewritten', async () => {
  const f = await fixture();
  const reason = '本次运行已停止，已执行的操作不会自动撤回。';
  assert.equal(f.api.serviceText(reason), reason);
  f.language.setLanguage('en');
  assert.match(f.api.serviceText(reason), /Completed actions are not automatically undone/);
  assert.equal(f.api.serviceText('供应商原文：测试模型不存在'), '供应商原文：测试模型不存在');
  assert.equal(f.api.serviceText('Request rejected by provider'), 'Request rejected by provider');
  assert.equal(f.api.serviceText(undefined), '');
  f.language.setLanguage('zh-CN');
  assert.equal(f.api.serviceText(reason), reason);
});
