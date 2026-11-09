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
import type { BotAgent, Conversation } from '../../../shared/types';
import type { CreationReceipt, CreationRequest } from '../../../shared/creation-requests';

export const require = createRequire(import.meta.url);

export const workspaceId = '11111111-1111-4111-8111-111111111111';

export const userId = '22222222-2222-4222-8222-222222222222';

export const agent: BotAgent = {
  id: 'bot-a',
  name: 'Synthetic Bot',
  role: 'Coordinator',
  description: '',
  instructions: 'SYNTHETIC_PRIVATE_INSTRUCTIONS',
  avatar: 'orb',
  color: '#654321',
  status: 'idle',
};

export const peer: BotAgent = { ...agent, id: 'bot-b', name: 'Synthetic peer' };

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

export function storage() {
  const values = new Map<string, string>();
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

export type Call = { path: string; method: string; body?: any; headers: Headers };

export function receipt(input: CreationRequest): CreationReceipt {
  const agents =
    input.kind === 'bot' ? [{ ...agent, ...input.profile, id: 'created-bot' }] : [agent, peer];
  const conversation: Conversation = {
    id: 'created-chat',
    title: input.kind === 'bot' ? input.profile.name : input.title,
    agentIds: agents.map((item) => item.id),
    isGroup: input.kind === 'group',
    updatedAt: '2026-11-05T00:00:00.000Z',
    unread: 0,
    pinned: false,
  };
  return {
    requestId: input.requestId,
    kind: input.kind,
    status: 'created',
    agentIds: conversation.agentIds,
    conversationId: conversation.id,
    createdAt: conversation.updatedAt,
    userId,
    workspaceId,
    conversation,
    agents,
  };
}

export async function fixture(
  options: {
    memory?: ReturnType<typeof storage>;
    member?: boolean;
    transport?: (call: Call, fallback: () => Response) => Response | Promise<Response>;
    onCreated?: (c: Conversation, agents?: BotAgent[]) => void;
    mode?: 'bot' | 'group' | 'team';
  } = {},
) {
  const memory = options.memory || storage();
  const calls: Call[] = [],
    opened: Array<{ conversation: Conversation; agents?: BotAgent[] }> = [];
  let accepted: CreationReceipt | undefined;
  const props = {
    agents: [agent, peer],
    canCreateBot: !options.member,
    workspaceId,
    userId,
    modelConfigured: false,
    modelLabel: 'Fixture',
    settings: { configured: false },
    initialMode: options.mode,
    onClose() {},
    onCreated(c: Conversation, agents?: BotAgent[]) {
      options.onCreated?.(c, agents);
      opened.push({ conversation: c, agents });
    },
    onTeamCreated() {},
    onSettingsChanged() {},
  };
  const ui = await harness('web/src/components/CreateDialog.tsx', 'CreateDialogContent', props, {
    window: { location: { pathname: `/w/${workspaceId}/` }, dispatchEvent() {} },
    sessionStorage: memory,
    TextEncoder,
    Event,
    fetch: async (path: string, init: any) => {
      const call = {
        path: String(path),
        method: init.method,
        body: init.body && JSON.parse(init.body),
        headers: new Headers(init.headers),
      };
      calls.push(call);
      const fallback = () => {
        if (call.path.endsWith('/creation-requests') && call.method === 'POST') {
          accepted = receipt(call.body);
          return json(accepted, 201);
        }
        if (call.path.endsWith('/cancel'))
          return json(
            accepted || {
              requestId: call.path.split('/').at(-2),
              status: 'not_submitted',
              userId,
              workspaceId,
            },
          );
        return accepted ? json(accepted) : json({ error: '尚无回执' }, 404);
      };
      return options.transport ? options.transport(call, fallback) : fallback();
    },
  });
  await ui.flush();
  return {
    ui,
    calls,
    memory,
    opened,
    profile() {
      return component(ui.tree, 'BotProfileFields');
    },
    async fill(name = 'My synthetic Bot') {
      const fields = component(ui.tree, 'BotProfileFields');
      fields.props.onChange({
        ...fields.props.draft,
        name,
        role: 'Coordinator',
        instructions: agent.instructions,
      });
      await ui.flush();
    },
    async submit() {
      const form = all(ui.tree, (node) => node.type === 'form')[0];
      assert.ok(form);
      form.props.onSubmit({ preventDefault() {} });
      await ui.flush();
    },
  };
}

export async function until(ui: Awaited<ReturnType<typeof harness>>, check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < end, 'controlled UI did not settle');
    await new Promise((done) => setImmediate(done));
    await ui.flush();
  }
}

export async function click(ui: Awaited<ReturnType<typeof harness>>, label: string) {
  const node = ui.button(label);
  assert.equal(!!node.props.disabled, false, label);
  node.props.onClick();
  await ui.flush();
}

export const writes = (calls: Call[]) =>
  calls.filter((item) => item.method === 'POST' && item.path.endsWith('/creation-requests'));

export function text(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' ? text(node.props?.children) : String(node);
}

export function all(node: any, predicate: (value: any) => boolean): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => all(child, predicate));
  return [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)];
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
    useId() {
      const index = cursor++;
      slots[index] ||= { value: `fixture-${index}` };
      return slots[index].value;
    },
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
    useMemo(compute: () => unknown, deps: unknown[]) {
      const index = cursor++,
        before = slots[index];
      if (
        !before ||
        deps.length !== before.deps.length ||
        deps.some((value, i) => !Object.is(value, before.deps[i]))
      )
        slots[index] = { deps, value: compute() };
      return slots[index].value;
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
    structuredClone,
    crypto: webcrypto,
    fetch: async () => json([]),
    document: { hidden: false },
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: (callback: () => void) => callback(),
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
