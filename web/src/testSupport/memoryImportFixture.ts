import { expandPureViews } from './expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { webcrypto } from 'node:crypto';

export const require = createRequire(import.meta.url);

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
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    Error,
    TypeError,
    Event,
    TextEncoder,
    AbortController,
    AbortSignal,
    DOMException,
    Response,
    Blob,
    URL,
    fetch,
    structuredClone,
    crypto: webcrypto,
    ...globals,
  });
  return module.exports;
}

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
  const module = await compile(file, `\nexport { ${exportName} };`, {
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

export const userId = 'user-a';

export const workspaceId = '11111111-1111-4111-8111-111111111111';

export const revision = '22222222-2222-4222-8222-222222222222';

export const requestId = '33333333-3333-4333-8333-333333333333';

export const metadata = { requestId, expectedPrimaryRevision: revision };

export const storeKey = `openbot-memory-import:${JSON.stringify([userId, workspaceId])}`;

export function storageFixture(initial?: unknown) {
  const values = new Map<string, string>();
  if (initial) values.set(storeKey, JSON.stringify(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

export const windowFixture = () =>
  Object.assign(new EventTarget(), {
    location: { pathname: `/w/${workspaceId}` },
  });

export const ready = (extra: any = {}) => ({
  available: true,
  modelConfigured: true,
  primary: {
    available: true,
    revision,
    agentId: 'primary-a',
    conversationId: 'private-a',
    checkIn: { enabled: false, time: '09:00' },
  },
  ...extra,
});

export const receipt = (request: any = metadata, extra: any = {}) => ({
  requestId: request.requestId,
  primaryRevision: request.expectedPrimaryRevision,
  userId,
  workspaceId,
  agentId: 'primary-a',
  conversationId: 'private-a',
  messageId: 'message-a',
  createdAt: '2026-11-05T00:00:00Z',
  status: 'queued',
  ...extra,
});

export async function panel(transport: typeof fetch, options: any = {}, globals: any = {}) {
  return harness(
    'web/src/components/MemoryImportPanel.tsx',
    'MemoryImportContent',
    {
      userId,
      workspaceId,
      active: true,
      onConfigurePrimary() {},
      onConfigureModel() {},
      onImported() {},
      ...options,
    },
    transport,
    {
      window: windowFixture(),
      sessionStorage: storageFixture(),
      navigator: { clipboard: { writeText: async () => {} } },
      ...globals,
    },
  );
}

export const input = (ui: any) => ui.field('2. 粘贴');

export function paste(ui: any, content = '我喜欢简洁的中文回复。') {
  input(ui).props.onChange({ target: { value: content } });
}
