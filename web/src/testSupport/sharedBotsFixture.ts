import { expandPureViews } from './expandPureViews';
import { componentSource } from './componentSource';
import { workspaceSource, runInWorkspaceContext as runInNewContext } from './workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import React from 'react';
import ts from 'typescript';

export const require = createRequire(import.meta.url);

export const ids = {
  user: '11111111-1111-4111-8111-111111111111',
  personal: '22222222-2222-4222-8222-222222222222',
  team: '33333333-3333-4333-8333-333333333333',
  share: '44444444-4444-4444-8444-444444444444',
  agent: '55555555-5555-4555-8555-555555555555',
  conversation: '66666666-6666-4666-8666-666666666666',
  revision: '77777777-7777-4777-8777-777777777777',
};

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };
}

export function environment() {
  return {
    window: Object.assign(new EventTarget(), {
      location: { pathname: `/w/${ids.team}`, origin: 'https://openbot.example' },
    }),
    sessionStorage: storage(),
  };
}

export async function compile(file: string, extra = '', globals: Record<string, unknown> = {}) {
  const path = resolve(componentSource(file, extra));
  const result = await build({
    stdin: {
      contents:
        (await readFile(path, 'utf8')).replace(
          /export function ManageSharedBotContent/g,
          'function ManageSharedBotContent',
        ) + extra,
      resolveDir: dirname(path),
      sourcefile: path,
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
    module,
    exports: module.exports,
    require,
    Error,
    TypeError,
    DOMException,
    AbortController,
    AbortSignal,
    Headers,
    Response,
    URL,
    Blob,
    Event,
    fetch,
    crypto: webcrypto,
    ...globals,
  });
  return module.exports;
}

export function text(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return text(node.props?.children);
}

export function all(node: any, match: (node: any) => boolean): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((item) => all(item, match));
  return [...(match(node) ? [node] : []), ...all(node.props?.children, match)];
}

export async function harness(
  file: string,
  name: string,
  initial: any,
  transport: typeof fetch,
  globals: Record<string, unknown> = {},
) {
  let cursor = 0,
    dirty = true,
    tree: any,
    props = initial;
  const slots: any[] = [],
    effects: Array<() => void> = [];
  const hooks = {
    ...React,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useContext: () => null,
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
  const exported = (await readFile(file, 'utf8')).includes(`export function ${name}(`);
  const module = await compile(file, exported ? '' : `\nexport { ${name} };`, {
    ...environment(),
    fetch: transport,
    require: (value: string) => (value === 'react' ? hooks : require(value)),
    ...globals,
  });
  return {
    async flush() {
      for (let i = 0; i < 30; i++) {
        if (dirty) {
          cursor = 0;
          dirty = false;
          tree = expandPureViews(module[name](props));
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
      const node = all(tree, (node) => node.type === 'button' && text(node).trim() === label)[0];
      assert.ok(node, `Missing ${label}`);
      return node;
    },
    field(label: string) {
      const row = all(tree, (node) => node.type === 'label' && text(node).startsWith(label))[0];
      assert.ok(row, label);
      return all(row, (node) => ['input', 'select', 'textarea'].includes(node.type))[0];
    },
    props(update: any) {
      props = { ...props, ...update };
      dirty = true;
    },
    dispose() {
      for (const slot of slots) slot.cleanup?.();
    },
  };
}

export const card = {
  id: ids.share,
  name: '小松',
  role: '研究助手',
  description: '持续更新的研究方法',
  avatar: 'leaf',
  color: '#55aa88',
  ownerName: '发布者林',
  sourceWorkspaceName: '研究空间',
  teamName: '研究团队',
  targetTeamId: ids.team,
  sourceRevision: 'a'.repeat(64),
  skillCount: 2,
};

export const alias = {
  id: ids.agent,
  name: card.name,
  role: card.role,
  description: card.description,
  instructions: '真实长期指令',
  color: card.color,
  avatar: 'leaf',
  status: 'idle',
  sharedBot: {
    shareId: ids.share,
    sourceRevision: card.sourceRevision,
    ownerName: card.ownerName,
    sourceWorkspaceName: card.sourceWorkspaceName,
    teamName: card.teamName,
    status: 'active',
  },
};

export const conversation = {
  id: ids.conversation,
  title: '小松',
  isGroup: false,
  agentIds: [ids.agent],
  updatedAt: '2026-11-05T00:00:00Z',
  unread: 0,
  pinned: false,
};

export const receipt = (requestId: string) => ({
  requestId,
  shareId: ids.share,
  actorId: ids.user,
  workspaceId: ids.personal,
  agentId: ids.agent,
  conversationId: ids.conversation,
  createdAt: '2026-11-05T00:00:00Z',
});

export const personal = {
  id: ids.personal,
  name: '我的空间',
  kind: 'personal',
  role: 'owner',
  status: 'active',
};

export const sharing = {
  share: null,
  teams: [
    {
      id: ids.team,
      name: '研究团队',
      members: [
        { userId: ids.user, name: '林' },
        { userId: ids.agent, name: '陈' },
      ],
    },
  ],
};

export const fileGrant = {
  fileId: 'file_1',
  revision: 'a'.repeat(64),
  name: '参考资料.txt',
  size: 4,
  type: 'text/plain',
};

export const sourceFiles = `/workspaces/${ids.team}/agents/${ids.agent}/sharing/files`;
