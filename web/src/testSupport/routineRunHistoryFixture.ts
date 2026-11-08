import { expandPureViews } from './expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import type { Routine } from '../../../shared/types';
import type { RoutineRun } from '../../../shared/routine-runs';

export const require = createRequire(import.meta.url);

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
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' ? text(node.props?.children) : String(node);
}

export function all(node: any, predicate: (value: any) => boolean): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => all(child, predicate));
  return [
    ...(predicate(node) ? [node] : []),
    ...all(
      node.type?.name === 'TimeZoneSelect' ? node.type(node.props) : node.props?.children,
      predicate,
    ),
  ];
}

export const component = (tree: any, name: string) => {
  const result = all(tree, (node) => node.type?.name === name)[0];
  assert.ok(result, `Missing ${name}`);
  return result;
};

export async function harness(
  file: string,
  name: string,
  initial: any,
  globals: Record<string, any> = {},
  commit?: (tree: any) => void,
) {
  const path = resolve(file);
  const output = await build({
    stdin: {
      contents: `${await readFile(path, 'utf8')}\nexport { ${name} as Tested };`,
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
  let cursor = 0,
    changed = true,
    tree: any,
    props = initial;
  const slots: any[] = [],
    effects: Array<() => void> = [];
  const hooks = {
    ...React,
    useState(initial: any) {
      const index = cursor++;
      slots[index] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[index].value,
        (update: any) => {
          const next = typeof update === 'function' ? update(slots[index].value) : update;
          if (!Object.is(next, slots[index].value)) {
            slots[index].value = next;
            changed = true;
          }
        },
      ];
    },
    useRef(initial: any) {
      const index = cursor++;
      return (slots[index] ||= { current: initial });
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
  const module = { exports: {} as any };
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name: string) => (name === 'react' ? hooks : require(name)),
    Error,
    TypeError,
    DOMException,
    AbortSignal,
    AbortController,
    Response,
    URL,
    Event,
    TextEncoder,
    structuredClone,
    crypto: webcrypto,
    fetch: async () => json([]),
    document: { hidden: false },
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: (callback: () => void) => {
      callback();
      return 1;
    },
    cancelAnimationFrame() {},
    ...globals,
  });
  return {
    get tree() {
      return tree;
    },
    get copy() {
      return text(tree);
    },
    setProps(update: any) {
      props = { ...props, ...update };
      changed = true;
    },
    async flush() {
      for (let i = 0; i < 30; i++) {
        if (changed) {
          cursor = 0;
          changed = false;
          tree = expandPureViews(module.exports.Tested(props));
          commit?.(tree);
        }
        for (const effect of effects.splice(0)) effect();
        await new Promise((done) => setImmediate(done));
        if (!changed && !effects.length) return;
      }
      throw Error('Effects did not settle');
    },
    button(label: string) {
      const node = all(tree, (node) => node.type === 'button' && text(node).trim() === label)[0];
      assert.ok(node, `Missing button ${label}`);
      return node;
    },
    field(label: string) {
      const parent = all(tree, (node) => node.type === 'label' && text(node).startsWith(label))[0];
      assert.ok(parent, `Missing field ${label}`);
      return all(parent, (node) => ['input', 'select', 'textarea'].includes(node.type))[0];
    },
    dispose() {
      for (const slot of slots) slot.cleanup?.();
    },
  };
}

export const workspaceId = '11111111-1111-4111-8111-111111111111',
  userId = 'owner-a';

export const agent = {
  id: 'bot-a',
  name: '小松',
  role: '协调',
  description: '',
  instructions: '',
  avatar: 'orb',
  color: '#9363ed',
  status: 'idle',
};

export const chat = { id: 'chat-a', agentIds: [agent.id], title: '小松', isGroup: false };

export const routine: Routine = {
  id: 'routine-a',
  agentId: agent.id,
  conversationId: chat.id,
  title: '每日简报',
  prompt: '整理报告',
  schedule: 'daily:09:00',
  enabled: true,
  nextRunAt: '2030-11-05T01:00:00Z',
};

export const run: RoutineRun = {
  runId: 'run-a',
  routineId: routine.id,
  agentId: agent.id,
  conversationId: chat.id,
  inputMessageId: 'input-a',
  resultMessageId: 'result-a',
  trigger: 'scheduled',
  status: 'completed',
  startedAt: '2030-11-05T01:00:00Z',
  finishedAt: '2030-11-05T01:02:00Z',
};

export function env(fetch: typeof globalThis.fetch) {
  const saved = new Map<string, string>();
  return {
    fetch,
    window: Object.assign(new EventTarget(), { location: { pathname: `/w/${workspaceId}` } }),
    sessionStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    },
  };
}

export async function history(fetch: typeof globalThis.fetch, props: any = {}) {
  const h = await harness(
    'web/src/components/RoutineRunHistory.tsx',
    'RoutineRunHistory',
    { routineId: routine.id, workspaceId, userId, onOpenRun: async () => {}, ...props },
    env(fetch),
  );
  await h.flush();
  return h;
}

export async function dialog(props: any = {}) {
  const h = await harness(
    'web/src/components/RoutineDialog.tsx',
    'RoutineDialog',
    {
      agents: [agent],
      allAgents: [agent],
      conversations: [chat],
      routines: [routine],
      busy: false,
      conversationId: chat.id,
      workspaceId,
      userId,
      onClose() {},
      onSave: async () => {},
      onToggle: async () => {},
      onDelete: async () => {},
      ...props,
    },
    env(async () => json({ routineId: routine.id, runs: [run] })),
  );
  await h.flush();
  return h;
}

export function icon(h: any, label: string) {
  if (label.startsWith('编辑任务 ') || label === '删除任务') {
    const menu = all(h.tree, (node) => node.type?.name === 'RoutineActions')[0];
    assert.ok(menu, `Missing routine actions for ${label}`);
    return {
      props: {
        disabled: menu.props.disabled || (label === '删除任务' && menu.props.deleteDisabled),
        onClick: label === '删除任务' ? menu.props.onDelete : menu.props.onEdit,
      },
    };
  }
  const node = all(
    h.tree,
    (node) => node.type?.name === 'IconButton' && node.props.label === label,
  )[0];
  assert.ok(node, `Missing icon ${label}`);
  return node;
}
