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
import type { Bootstrap, BotAgent, Conversation } from '../../../shared/types';
import type { SidebarRosterState, SidebarRosterOperation } from '../../../shared/sidebar-roster';

export const require = createRequire(import.meta.url);

export const workspaceId = '11111111-1111-4111-8111-111111111111';

export const userId = '22222222-2222-4222-8222-222222222222';

export const empty: SidebarRosterState = { revision: 'r1', sections: [], entries: [] };

export const section = { id: 'section-a', name: '研究', collapsed: false };

export const withSection: SidebarRosterState = { ...empty, sections: [section] };

export const target = { kind: 'bot' as const, id: 'bot-a' };

export const agent: BotAgent = {
  id: target.id,
  name: '小松',
  role: '研究',
  description: '整理重点',
  instructions: '',
  color: '#9363ed',
  avatar: 'orb',
  status: 'idle',
};

export const conversation: Conversation = {
  id: 'dm-a',
  title: agent.name,
  agentIds: [agent.id],
  isGroup: false,
  updatedAt: '2026-11-05T00:00:00Z',
  pinned: false,
  unread: 0,
};

export const data = (roster = empty) =>
  ({
    agents: [agent],
    conversations: [conversation],
    messages: [],
    sidebarRoster: roster,
  }) as unknown as Bootstrap;

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function copy(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(copy).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return copy(node.props?.children);
}

export function all(node: any, match: (node: any) => boolean): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => all(child, match));
  return [...(match(node) ? [node] : []), ...all(node.props?.children, match)];
}

export async function harness(
  file: string,
  name: string,
  initial: any,
  transport: typeof fetch = async () => json(empty),
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
    useState(value: any) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = { value: typeof value === 'function' ? value() : value };
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
      return (slots[cursor++] ||= { current: value });
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
  const path = resolve(componentSource(file, name)),
    source = await readFile(path, 'utf8');
  const output = await build({
    stdin: {
      contents: source + `\nexport { ${name} as Tested };`,
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
  const window = Object.assign(new EventTarget(), {
    location: { pathname: `/w/${workspaceId}` },
    innerWidth: 900,
    innerHeight: 900,
  });
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name: string) => (name === 'react' ? hooks : require(name)),
    Error,
    TypeError,
    AbortController,
    AbortSignal,
    DOMException,
    Response,
    URL,
    Event,
    fetch: transport,
    window,
    ...globals,
  });
  return {
    window,
    async flush() {
      for (let i = 0; i < 30; i++) {
        if (dirty) {
          cursor = 0;
          dirty = false;
          tree = expandPureViews(module.exports.Tested(current));
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
      return copy(tree);
    },
    button(label: string) {
      const result = all(
        tree,
        (node) =>
          node.type === 'button' &&
          (copy(node).trim() === label || node.props['aria-label'] === label),
      )[0];
      assert.ok(result, `Missing button ${label}`);
      return result;
    },
    field(label: string) {
      const parent = all(tree, (node) => node.type === 'label' && copy(node).startsWith(label))[0];
      assert.ok(parent, `Missing field ${label}`);
      return all(parent, (node) => ['input', 'select', 'textarea'].includes(node.type))[0];
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

export const hookFile = 'web/src/useSidebarRoster.ts',
  componentFile = 'web/src/components/SidebarRoster.tsx';

export const baseController = (state: SidebarRosterState = empty) => ({
  state,
  busy: false,
  needsSync: false,
  error: '',
  async read() {
    return state;
  },
  async write(_operation: SidebarRosterOperation, _revision?: string) {
    return { ok: true as const, state };
  },
});

export const dialogProps = (request: any, state = empty) => ({
  request,
  data: data(state),
  roster: baseController(state),
  workspaceId,
  userId,
  onClose() {},
  onOpen() {},
  onNotice() {},
  onPrimary() {},
});
