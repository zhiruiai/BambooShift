import { expandPureViews } from './expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import ts from 'typescript';
import type { BotAgent } from '../../../shared/types';
import type { BotTeamPlan, BotTeamProposalCard as Proposal } from '../../../shared/bot-team-plans';
import { webcrypto } from 'node:crypto';

export const require = createRequire(import.meta.url);

export const { renderToStaticMarkup } = require('react-dom/server');

export async function compile(file: string, extra = '', globals: Record<string, unknown> = {}) {
  const path = resolve(file);
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
  const recovery = new Map<string, string>();
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
    Blob,
    URL,
    fetch,
    structuredClone,
    crypto: webcrypto,
    TextEncoder,
    sessionStorage: {
      getItem: (key: string) => recovery.get(key) ?? null,
      setItem: (key: string, value: string) => recovery.set(key, value),
      removeItem: (key: string) => recovery.delete(key),
    },
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

export function text(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return text(node.props?.children);
}

export function all(node: any, match: (node: any) => boolean): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => all(child, match));
  const children =
    node.type?.name === 'BotProfileFields' ? node.type(node.props) : node.props?.children;
  return [...(match(node) ? [node] : []), ...all(children, match)];
}

export async function harness(
  file: string,
  exportName: string,
  initial: any,
  transport: typeof fetch,
  globals: Record<string, unknown> = {},
) {
  let cursor = 0,
    dirty = true,
    tree: any,
    current = initial;
  const slots: any[] = [],
    effects: Array<() => void> = [];
  const hooks = {
    ...React,
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
  const exported = (await readFile(file, 'utf8')).includes(`export function ${exportName}(`);
  const module = await compile(file, exported ? '' : `\nexport { ${exportName} };`, {
    require: (name: string) => (name === 'react' ? hooks : require(name)),
    fetch: transport,
    ...(file.endsWith('/CreateDialog.tsx')
      ? {
          window: {
            location: { pathname: initial.workspaceId ? `/w/${initial.workspaceId}/` : '/' },
            dispatchEvent() {},
          },
        }
      : {}),
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

export const workspaceId = '11111111-1111-4111-8111-111111111111',
  userId = 'member-a';

export const agents = Array.from({ length: 8 }, (_, index) => ({
  id: `bot-${index + 1}`,
  name: `伙伴${index + 1}`,
  role: index === 7 ? '研究报告' : '项目协作',
  description: '',
  instructions: '',
  color: '#9363ed',
  avatar: 'orb',
  status: 'idle',
}));

export const env = () => ({
  window: Object.assign(new EventTarget(), { location: { pathname: `/w/${workspaceId}` } }),
  document: { hidden: false },
  setInterval: () => 1,
  clearInterval() {},
});

export const createProps = (extra: any = {}) => ({
  agents,
  canCreateBot: true,
  workspaceId,
  userId,
  modelConfigured: true,
  modelLabel: 'GLM',
  onClose() {},
  onCreated() {},
  onTeamCreated() {},
  ...extra,
});

export const recipients = (ui: any) =>
  all(ui.tree, (node) => node.type?.name === 'GroupRecipients')[0];

export const checkbox = (ui: any, name: string) => {
  const value = all(
    ui.tree,
    (node) => node.type === 'input' && node.props['aria-label'] === name,
  )[0];
  assert.ok(value, name);
  return value;
};

export const plan = (count: number) => ({
  id: 'plan-a',
  requestId: 'start-a',
  revision: 'revision-a',
  status: 'ready',
  goal: '准备研究报告',
  createdAt: '2026-11-05T00:00:00Z',
  updatedAt: '2026-11-05T00:00:00Z',
  draft: {
    title: '研究团队',
    summary: '按分工研究',
    leadKey: 'member1',
    members: agents.slice(0, count).map((agent, index) => ({
      key: `member${index + 1}`,
      kind: 'reuse',
      agentId: agent.id,
      assignment: `负责第${index + 1}部分`,
    })),
  },
});
