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
import type { AppSettings, BotAgent, ModelProfile } from '../../../shared/types';
import type { BotTeamPlan } from '../../../shared/bot-team-plans';

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
  const recovery = new Map<string, string>();
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
    TextEncoder,
    sessionStorage: {
      getItem: (key: string) => recovery.get(key) ?? null,
      setItem: (key: string, value: string) => recovery.set(key, value),
      removeItem: (key: string) => recovery.delete(key),
    },
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

export const settings: AppSettings = {
  profileId: 'empty',
  profileName: '尚未配置',
  provider: 'custom',
  model: 'test-model',
  configured: false,
  hasApiKey: false,
  runtime: 'pi',
  workspace: 'workspace',
  language: 'zh',
};

export const profile: ModelProfile = {
  id: 'glm',
  name: 'GLM 工作模型',
  provider: 'custom',
  model: 'synthetic-model',
  baseUrl: 'https://model.example.test/v1',
  vision: false,
  configured: true,
  hasApiKey: true,
  credentialSource: 'saved',
};

export const configured = {
  ...settings,
  profileId: profile.id,
  profileName: profile.name,
  configured: true,
  hasApiKey: true,
};

export const agent: BotAgent = {
  id: 'a',
  name: '协调',
  role: '协调',
  description: '',
  instructions: '',
  color: '#9363ed',
  avatar: 'orb',
  status: 'idle',
};

export const team: BotTeamPlan = {
  id: 'plan',
  requestId: 'request',
  revision: 'revision',
  goal: '准备发布',
  status: 'ready',
  createdAt: '2026-11-05T00:00:00Z',
  updatedAt: '2026-11-05T00:00:00Z',
  draft: {
    title: '发布组',
    summary: '汇总与研究',
    leadKey: 'lead',
    members: [
      { key: 'lead', kind: 'reuse', agentId: 'a', assignment: '汇总' },
      { key: 'research', kind: 'reuse', agentId: 'b', assignment: '研究' },
    ],
  },
};

export const parentProps = () => ({
  agents: [agent, { ...agent, id: 'b' }],
  canCreateBot: true,
  workspaceId: 'space-a',
  userId: 'owner-a',
  settings,
  modelConfigured: false,
  modelLabel: '',
  onClose() {},
  onCreated() {},
  onTeamCreated() {},
  onSettingsChanged() {},
});

for (const invalidation of ['unmount', 'identity', 'navigation'] as const)
  test(`late model save cannot update the returned team after ${invalidation}`, async () => {
    const late = deferred<Response>(),
      changes: AppSettings[] = [],
      calls: any[] = [];
    const window = { location: { pathname: '/w/space-a/' } };
    const ui = await harness(
      'web/src/components/SettingsDialog.tsx',
      'ModelSettingsDialog',
      {
        settings: configured,
        workspaceId: 'space-a',
        userId: 'owner-a',
        showManagement: false,
        onClose() {},
        onSettingsChanged: (value: AppSettings) => changes.push(value),
      },
      {
        window,
        fetch: async (url: any, init: any) => {
          if (init.method === 'GET')
            return json({ activeProfileId: profile.id, profiles: [profile] });
          calls.push({ url: String(url), init });
          return late.promise;
        },
      },
    );
    await ui.flush();
    ui.field('配置名称').props.onChange({ target: { value: '修改名称' } });
    await ui.flush();
    const submit = all(ui.tree, (node) => node.type === 'form')[0].props.onSubmit;
    submit({ preventDefault() {} });
    await ui.flush();
    assert.equal(calls.length, 1);
    assert.equal(new Headers(calls[0].init.headers).get('X-OpenBot-Expected-User'), 'owner-a');
    if (invalidation === 'unmount') {
      ui.dispose();
      assert.equal(calls[0].init.signal.aborted, true);
    }
    if (invalidation === 'identity') {
      ui.setProps({ userId: 'owner-b', workspaceId: 'space-b' });
      await ui.flush();
    }
    if (invalidation === 'navigation') window.location.pathname = '/w/space-b/';
    late.resolve(json({ profile: { ...profile, name: '修改名称' }, settings: configured }));
    await ui.flush();
    assert.equal(changes.length, 0);
    submit({ preventDefault() {} });
    await ui.flush();
    assert.equal(calls.length, 1);
    ui.dispose();
  });
