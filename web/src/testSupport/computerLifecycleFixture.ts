import { expandPureViews } from './expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import React from 'react';

export const require = createRequire(import.meta.url);

export const { renderToStaticMarkup } = require('react-dom/server');

export async function compile(path: string, extra = '', globals: Record<string, unknown> = {}) {
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
  runInNewContext(result.outputFiles[0].text, {
    require,
    module,
    exports: module.exports,
    AbortController,
    AbortSignal,
    DOMException,
    Response,
    Headers,
    fetch,
    ...globals,
  });
  return module.exports;
}

export const modules = Promise.all([
  compile('web/src/computerLifecycle.ts'),
  compile('web/src/components/ComputerLifecycle.tsx'),
  compile('web/src/computerScope.ts'),
]);

export const ready = {
  agentId: 'bot-a',
  screenId: 'screen-a',
  assignmentRevision: 'revision-a',
  status: 'ready',
  task: { status: 'idle', queued: 0 },
  lifecycle: { state: 'ready', releaseAllowed: true, resetAllowed: false },
};

export const saved = {
  ...ready,
  status: 'unavailable',
  lifecycle: {
    state: 'blocked',
    releaseAllowed: false,
    resetAllowed: false,
    reason: '上次清理尚未确认。',
    operation: { id: 'operation-a', kind: 'release' },
  },
};

export const resettable = {
  ...ready,
  status: 'unavailable',
  task: { status: 'blocked', queued: 0 },
  lifecycle: {
    state: 'blocked',
    releaseAllowed: false,
    resetAllowed: true,
    reason: '画面需要恢复。',
  },
};

export const render = (C: any, props: any) =>
  renderToStaticMarkup(React.createElement(C, props)) as string;

export const noop = () => {
  throw Error('Rendering must not start a mutation');
};

export const view = {
  screen: ready,
  name: '小松',
  owner: true,
  busy: false,
  pending: false,
  uncertain: false,
  confirmation: null,
  error: '',
  notice: '',
  localBlock: '',
  onChoose: noop,
  onCancel: noop,
  onConfirm: noop,
  onRefresh: noop,
};

export function buttons(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(buttons);
  return [...(node.type === 'button' ? [node] : []), ...buttons(node.props?.children)];
}

export const buttonText = (node: any): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
      ? node.map(buttonText).join('')
      : node?.props
        ? buttonText(node.props.children)
        : '';

export const has = (tree: any, label: string) => buttons(tree).find((b) => buttonText(b) === label);

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export async function dialogHarness(
  transport: typeof fetch,
  options: { account?: any; onAction?: (work: () => Promise<unknown>) => Promise<unknown> } = {},
) {
  const slots: any[] = [];
  let cursor = 0,
    dirty = true,
    tree: any;
  const effects: Array<() => void> = [];
  let account =
    options.account === undefined
      ? {
          session: { user: { id: 'owner-a' } },
          workspace: { id: 'workspace-a', role: 'owner' },
        }
      : options.account;
  const hooks = {
    ...React,
    useContext: () => account,
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[index].value,
        (update: any) => {
          const before = slots[index].value,
            next = typeof update === 'function' ? update(before) : update;
          if (!Object.is(before, next)) {
            slots[index].value = next;
            dirty = true;
          }
        },
      ];
    },
    useRef(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const index = cursor++,
        old = slots[index];
      if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps?.[i]))) {
        const slot = { deps, cleanup: old?.cleanup };
        slots[index] = slot;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect();
        });
      }
    },
  };
  const module = await compile('web/src/components/ComputerDialog.tsx', '', {
    require: (name: string) => (name === 'react' ? hooks : require(name)),
    fetch: transport,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    URL,
  });
  const agent = {
    id: 'bot-a',
    name: '小松',
    role: '助理',
    description: '',
    color: '#8877aa',
    avatar: 'orb',
    instructions: '',
    status: 'idle',
  };
  let closes = 0,
    switches = 0;
  const props = {
    data: {
      computer: {
        connected: true,
        name: '电脑',
        mode: 'remote',
        surface: 'browser',
        capabilities: [],
        status: 'ready',
      },
      agents: [agent],
    },
    agentId: 'bot-a',
    conversationId: 'chat',
    conversationTitle: '会话',
    busy: false,
    onSelectBot: () => {
      switches++;
    },
    onClose: () => {
      closes++;
    },
    onAction: options.onAction || (async (work: () => Promise<unknown>) => work()),
    refresh: async () => {},
  };
  function renderDialog() {
    cursor = 0;
    dirty = false;
    tree = expandPureViews(module.ComputerDialog(props));
  }
  function find(node: any, name: string): any {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = find(child, name);
        if (found) return found;
      }
      return;
    }
    return node.type?.name === name ? node : find(node.props?.children, name);
  }
  return {
    async flush() {
      for (let i = 0; i < 30; i++) {
        if (dirty) renderDialog();
        for (const effect of effects.splice(0)) effect();
        await new Promise((r) => setImmediate(r));
        if (!dirty && !effects.length) return;
      }
      throw Error('Component effects did not settle');
    },
    setAccount(value: any) {
      account = value;
      dirty = true;
    },
    setBusy(value: boolean) {
      props.busy = value;
      dirty = true;
    },
    action() {
      const node = find(tree, 'ComputerActionEntry');
      assert.ok(node, 'real action row must be rendered');
      return { props: node.props, view: node.type(node.props) };
    },
    lifecycle() {
      const node = find(tree, 'ComputerLifecycle');
      assert.ok(node);
      return { props: node.props, view: node.type(node.props) };
    },
    click(label: string) {
      const button = has(this.lifecycle().view, label);
      assert.ok(button, label);
      assert.equal(!!button.props.disabled, false, `${label} must be enabled`);
      button.props.onClick();
    },
    close() {
      tree.props.onClose();
    },
    selectOther() {
      find(tree, 'BotScreenPicker').props.onSelect('bot-b');
    },
    counts() {
      return { closes, switches };
    },
    rootButton(label: string) {
      return has(tree, label);
    },
    dispose() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

export function approvalTransport(action: any, calls: Array<{ url: string; init: RequestInit }>) {
  return (async (url, init = {}) => {
    const path = String(url);
    if (init.method === 'POST') {
      calls.push({ url: path, init });
      if (/\/(approve|reject)$/.test(path)) return json({ ...action, status: 'rejected' });
      throw Error(`Unexpected mutation ${path}`);
    }
    if (path.endsWith('/bots'))
      return json({ capacity: { max: 2, configured: 2, ready: 2, assigned: 1 }, bots: [ready] });
    if (path.endsWith('/takeover/status')) return json({ active: false, width: 1440, height: 900 });
    if (path.endsWith('/status'))
      return json({
        connected: true,
        name: '电脑',
        mode: 'remote',
        surface: 'browser',
        capabilities: [],
        status: 'ready',
        botScreen: ready,
      });
    if (path.endsWith('/actions')) return json([action]);
    throw Error(`Unexpected request ${path}`);
  }) as typeof fetch;
}

export const humanAccount = (userId: string, role = 'member') => ({
  session: { user: { id: userId } },
  workspace: { id: 'workspace-a', role },
});

export const computerRequest = {
  id: 'approval-a',
  type: 'remote_shell',
  payload: { command: 'printf ready', path: '.' },
  status: 'pending',
  createdAt: '2026-11-05T09:00:00Z',
  requester: { userId: 'member-a', name: '林' },
};
