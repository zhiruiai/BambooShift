import { componentSource } from './componentSource';
import { expandPureViews } from './expandPureViews';
import { workspaceSource, runInWorkspaceContext as runInNewContext } from './workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
import type { BotBlueprint } from '../../../shared/bot-blueprint';
import type { BotTemplate } from '../../../shared/bot-templates';
import {
  createBotInstaller,
  createBotTemplateScope,
  fetchBotTemplateAvatar,
  safeTemplateAvatarPath,
  parseBotTemplateCard,
} from '../botTemplates';

export const require = createRequire(import.meta.url);

export const workspaceId = '11111111-1111-4111-8111-111111111111',
  userId = '22222222-2222-4222-8222-222222222222',
  templateId = '33333333-3333-4333-8333-333333333333',
  token = 'a'.repeat(43);

export const blueprint: BotBlueprint = {
  version: 1,
  profile: {
    name: '研究伙伴',
    role: '资料整理',
    description: '整理与核对',
    instructions: '核对来源后再输出',
    color: '#9363ed',
    avatar: 'leaf',
  },
  skills: [{ name: '查证', description: '核对信息', content: '使用原始资料并列出来源' }],
  routines: [
    { title: '每周总结', prompt: '汇总本周进展', schedule: 'weekly:1,3,5:09:00', enabled: true },
  ],
};

export const template: BotTemplate = {
  id: templateId,
  sourceAgentId: 'bot-source',
  sourceConversationId: 'source-dm',
  messageId: 'card-a',
  sequence: 1,
  revision: 'r1',
  draftRevision: 'd1',
  draftDigest: 'digest1',
  blueprint,
  projectionPending: false,
  createdAt: '2026-11-05T00:00:00Z',
  updatedAt: '2026-11-05T00:00:00Z',
};

export const receipt = {
  requestId: '44444444-4444-4444-8444-444444444444',
  agentId: 'new-bot',
  conversationId: 'new-dm',
  skillIds: ['new-skill'],
  routineIds: ['new-routine'],
  createdAt: '2026-11-05T00:00:00Z',
};

export const installed = {
  agents: [{ ...blueprint.profile, id: receipt.agentId, status: 'idle' }],
  conversations: [{ id: receipt.conversationId, agentIds: [receipt.agentId], isGroup: false }],
};

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) || null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    map,
  };
}

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
  transport: typeof fetch = async () => json(template),
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
      contents:
        source +
        `\nexport { ${name} as Tested };` +
        (file.endsWith('BotTemplateDialog.tsx')
          ? `\nexport { createBotTemplateScope as Scoped } from '${file.endsWith('BotTemplateDialog.tsx') && name !== 'BotTemplateDialog' ? '../../botTemplates' : '../botTemplates'}';`
          : ''),
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
    crypto: webcrypto,
    Blob,
    window,
    ...globals,
  });
  if (module.exports.Scoped)
    current.scope = module.exports.Scoped({
      workspaceId: current.workspaceId,
      userId: current.userId,
      identity: () => current,
      fetch: transport,
      locationPath: () => `/w/${workspaceId}`,
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

export function scope(
  transport: typeof fetch,
  identity = () => ({ workspaceId, userId }),
  path = () => `/w/${workspaceId}`,
) {
  return createBotTemplateScope({
    workspaceId,
    userId,
    identity,
    locationPath: path,
    fetch: transport,
  });
}

export const copyInput = {
  kind: 'copy' as const,
  agentId: 'bot-source',
  expectedSourceRevision: 'source-r1',
  name: '新的伙伴',
  routineMode: 'preserve' as const,
};

export const dialogFile = 'web/src/components/BotTemplateDialog.tsx';

export function common(transport: typeof fetch) {
  return {
    scope: scope(transport),
    workspaceId,
    userId,
    owner: true,
    team: false,
    onClose() {},
    onCreated() {},
    onChanged() {},
    onBack() {},
    onManage() {},
    request: { kind: 'library' },
  };
}
