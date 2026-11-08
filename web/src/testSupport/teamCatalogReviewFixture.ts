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
import type { BotAgent } from '../../../shared/types';
import type { BotTeamPlan, BotTeamCatalogReview } from '../../../shared/bot-team-plans';

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

export const first: BotAgent = {
  id: 'a',
  name: '协调',
  role: '负责汇总',
  description: '最新简介',
  instructions: '核对来源再汇总',
  avatar: 'orb',
  color: '#9363ed',
  status: 'idle',
  configRevision: 'config-2',
};

export const second = { ...first, id: 'b', name: '研究', role: '研究资料' };

export const fresh = { ...first, id: 'c', name: '新加入的 Bot', role: '核对事实' };

export const initialPlan: BotTeamPlan = {
  id: 'plan',
  requestId: 'generation',
  revision: 'revision-1',
  goal: '保留原目标',
  status: 'ready',
  createdAt: '2026-11-05T00:00:00Z',
  updatedAt: '2026-11-05T00:00:00Z',
  draft: {
    title: '原方案',
    summary: '分工协作',
    leadKey: 'lead',
    members: [
      { key: 'lead', kind: 'reuse', agentId: 'a', assignment: '汇总' },
      { key: 'second', kind: 'reuse', agentId: 'b', assignment: '研究' },
      {
        key: 'new',
        kind: 'create',
        name: '新 Bot 草稿',
        role: '编辑',
        description: '保留我的简介',
        instructions: '私有长指令不得落入恢复存储',
        avatar: 'leaf',
        color: '#3294f9',
        avatarImageId: '11111111-1111-4111-8111-111111111111',
        assignment: '保留编辑分工',
      },
    ],
  },
};

export function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

export type Call = { path: string; method: string; body?: any; headers: Headers };

export async function fixture(
  options: {
    transport?: (call: Call, fallback: () => Response) => Response | Promise<Response>;
    storage?: ReturnType<typeof storage>;
    plan?: BotTeamPlan;
  } = {},
) {
  const saved = structuredClone(options.plan || initialPlan);
  const agents = [first, second, fresh];
  const calls: Call[] = [];
  const memory = options.storage || storage();
  const state = { busy: false, dirty: false, created: 0 };
  const ui = await harness(
    'web/src/components/SmartTeamPanel.tsx',
    'SmartTeamContent',
    {
      agents,
      workspaceId: 'space-a',
      userId: 'owner-a',
      modelConfigured: true,
      modelLabel: '测试模型',
      initialPlanId: saved.id,
      onBusy: (value: boolean) => (state.busy = value),
      onDirty: (value: boolean) => (state.dirty = value),
      onCreated: () => state.created++,
    },
    {
      window: { location: { pathname: '/w/space-a/' }, dispatchEvent() {} },
      sessionStorage: memory,
      Event,
      fetch: async (url: string, init: any) => {
        const call: Call = {
          path: String(url),
          method: init.method,
          body: init.body && JSON.parse(init.body),
          headers: new Headers(init.headers),
        };
        calls.push(call);
        const fallback = () => {
          if (call.path.endsWith('/review-bots'))
            return json({
              planId: saved.id,
              expectedRevision: call.body.expectedRevision,
              reviewToken: 'review-token',
              draftDigest: 'digest',
              members: call.body.draft.members
                .filter((member: any) => member.kind === 'reuse')
                .map((member: any, index: number) => ({
                  key: member.key,
                  agentId: member.agentId,
                  version: 'version-' + member.agentId,
                  state: member.agentId === 'c' ? 'added' : index ? 'unchanged' : 'changed',
                  profile: agents.find((agent) => agent.id === member.agentId),
                })),
            } satisfies BotTeamCatalogReview);
          if (call.path.endsWith('/refresh-bots'))
            return json({
              requestId: call.body.requestId,
              planId: saved.id,
              appliedRevision: 'revision-2',
              plan: { ...saved, revision: 'revision-2', draft: call.body.draft },
            });
          if (call.path.includes('/catalog-refreshes/')) return json({ error: '尚无回执' }, 404);
          if (call.path.endsWith('/revise'))
            return json({ ...saved, revision: 'revision-fenced', draft: call.body.draft });
          return json(saved);
        };
        return options.transport ? options.transport(call, fallback) : fallback();
      },
    },
  );
  await ui.flush();
  return { ui, calls, memory, state, saved };
}

export const clicks = async (ui: Awaited<ReturnType<typeof harness>>, name: string) => {
  const button = ui.button(name);
  assert.equal(!!button.props.disabled, false, `${name} is disabled`);
  button.props.onClick();
  await ui.flush();
};

export const writes = (calls: Call[]) =>
  calls.filter((call) => call.method === 'POST' && !call.path.endsWith('/review-bots'));

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
