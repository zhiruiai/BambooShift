import { componentSource } from './componentSource';
import { expandPureViews } from './expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import type { AppAction, ConnectedApp } from '../../../shared/app-connections';
import type { AppOAuthFlow } from '../../../shared/app-oauth';

export const require = createRequire(import.meta.url);

export const { renderToStaticMarkup } = require('react-dom/server');

export async function compile(file: string, extra = '', globals: Record<string, unknown> = {}) {
  const path = resolve(componentSource(file, extra));
  const output = await build({
    stdin: {
      contents: (await readFile(path, 'utf8')) + extra,
      resolveDir: dirname(path),
      sourcefile: path,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty' },
  });
  const module = { exports: {} as Record<string, any> };
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    Error,
    TypeError,
    AbortController,
    AbortSignal,
    DOMException,
    Response,
    URL,
    fetch,
    ...globals,
  });
  return module.exports;
}

export const render = (component: any, props: any) =>
  renderToStaticMarkup(React.createElement(component, props)) as string;

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const app: ConnectedApp = {
  id: 'app-a',
  name: '团队资料',
  url: 'https://example.com/mcp',
  revision: 'revision-a',
  authType: 'bearer',
  hasCredential: true,
  status: 'connected',
  toolCount: 1,
  createdAt: '2026-11-05T09:00:00Z',
  checkedAt: '2026-11-05T09:00:00Z',
};

export const action: AppAction = {
  id: 'action-a',
  conversationId: 'chat-a',
  agentId: 'bot-a',
  connectionId: app.id,
  appName: app.name,
  toolName: 'document.update',
  arguments: { target: '报告', content: '<script>unsafe()</script>', approved: false },
  status: 'pending',
  createdAt: '2026-11-05T09:00:00Z',
  expiresAt: '2099-11-05T09:00:00Z',
};

export const props = () => ({
  workspaceId: 'space-a',
  userId: 'owner-a',
  workspaceName: '产品团队',
  team: true,
  canManage: true,
  computerConnected: true,
  modelLabel: '工作模型',
  modelConfigured: true,
  onFiles() {},
  onComputer() {},
  onSettings() {},
  onClose() {},
  onChanged() {},
});

export const oauthIds = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  flowId: '33333333-3333-4333-8333-333333333333',
  userId: '44444444-4444-4444-8444-444444444444',
};

export const oauthApp: ConnectedApp = {
  ...app,
  id: oauthIds.connectionId,
  authType: 'oauth',
  status: 'needs_auth',
  hasCredential: false,
};

export const oauthFlow: AppOAuthFlow = {
  id: oauthIds.flowId,
  connectionId: oauthApp.id,
  connectionRevision: oauthApp.revision,
  appName: oauthApp.name,
  status: 'pending',
  expiresAt: '2099-01-01T00:00:00Z',
  issuer: 'https://provider.example',
  authorizationOrigin: 'https://provider.example',
  scopes: ['documents.read'],
  launchPath: `/app-authorize/${oauthIds.workspaceId}/${oauthIds.connectionId}/${oauthIds.flowId}`,
};

export function oauthEnvironment() {
  const navigations: string[] = [];
  const window = Object.assign(new EventTarget(), {
    location: { assign: (url: string) => navigations.push(url) },
  }) as EventTarget & {
    location: { assign: (url: string) => void };
    openbotAuthorization?: { open: (value: any) => Promise<{ opened: boolean }> };
  };
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    documentElement: { dataset: {} as Record<string, string> },
  });
  const intervals = new Set<() => void>();
  return {
    window,
    document,
    Event,
    navigations,
    setInterval: (callback: () => void) => {
      intervals.add(callback);
      return callback;
    },
    clearInterval: (callback: () => void) => intervals.delete(callback),
    tick: () => {
      for (const callback of intervals) callback();
    },
  };
}

export function text(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return text(node.type?.name === 'AppToolDetails' ? node.type(node.props) : node.props?.children);
}

export function all(node: any, match: (node: any) => boolean): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => all(child, match));
  return [...(match(node) ? [node] : []), ...all(node.props?.children, match)];
}

export async function harness(
  file: string,
  exportName: string,
  initial: any,
  transport: typeof fetch,
  globals: Record<string, unknown> = {},
  extra = '',
) {
  let cursor = 0,
    dirty = true,
    tree: any,
    current = initial;
  const slots: any[] = [],
    effects: Array<() => void> = [];
  const hooks = {
    ...React,
    useContext: () => (typeof globals.account === 'function' ? globals.account() : null),
    useState(initialValue: any) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = {
          value: typeof initialValue === 'function' ? initialValue() : initialValue,
        };
      return [
        slots[index].value,
        (update: any) => {
          const next = typeof update === 'function' ? update(slots[index].value) : update;
          if (!Object.is(next, slots[index].value)) {
            slots[index].value = next;
            dirty = true;
          }
        },
      ];
    },
    useRef(value: any) {
      const index = cursor++;
      return (slots[index] ||= { current: value });
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const index = cursor++,
        before = slots[index];
      if (!before || !deps || deps.some((value, i) => !Object.is(value, before.deps?.[i]))) {
        const slot = { deps, cleanup: before?.cleanup };
        slots[index] = slot;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect();
        });
      }
    },
  };
  const module = await compile(file, `${extra}\nexport { ${exportName} };`, {
    require: (name: string) => (name === 'react' ? hooks : require(name)),
    fetch: transport,
    ...globals,
  });
  return {
    async flush() {
      for (let i = 0; i < 30; i++) {
        if (dirty) {
          cursor = 0;
          dirty = false;
          tree = expandPureViews(module[exportName](current));
        }
        for (const effect of effects.splice(0)) effect();
        await new Promise((done) => setImmediate(done));
        if (!dirty && !effects.length) return;
      }
      throw Error('Effects did not settle');
    },
    get tree() {
      return tree;
    },
    get copy() {
      return text(tree);
    },
    button(label: string) {
      const result = all(
        tree,
        (node) =>
          node.type === 'button' &&
          (text(node).trim() === label || node.props['aria-label'] === label),
      )[0];
      assert.ok(result, `Missing button ${label}`);
      return result;
    },
    maybeButton(label: string) {
      return all(tree, (node) => node.type === 'button' && text(node).trim() === label)[0];
    },
    field(label: string) {
      const parent = all(tree, (node) => node.type === 'label' && text(node).startsWith(label))[0];
      assert.ok(parent, `Missing field ${label}`);
      const result = all(parent, (node) => ['input', 'select', 'textarea'].includes(node.type))[0];
      assert.ok(result);
      return result;
    },
    form() {
      const result = all(tree, (node) => node.type === 'form')[0];
      assert.ok(result);
      return result;
    },
    setProps(update: any) {
      current = { ...current, ...update };
      dirty = true;
    },
    dispose() {
      for (const slot of slots) slot.cleanup?.();
    },
  };
}
