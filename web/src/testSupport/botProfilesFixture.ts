import { expandPureViews } from './expandPureViews';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
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
  const module = await compile(file, `\nexport { ${exportName} };`, {
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

export const agent: BotAgent = {
  id: 'bot-a',
  name: '小松',
  role: '项目协调',
  description: '整理重点',
  instructions: '先给结论',
  color: '#9363ed',
  avatar: 'orb',
  status: 'idle',
  configRevision: 'revision-a',
};

export const other: BotAgent = { ...agent, id: 'bot-b', name: '小叶', role: '资料研究' };

export const team: BotTeamPlan = {
  id: 'plan-a',
  requestId: 'start-a',
  revision: 'plan-revision-a',
  goal: '准备新品发布',
  status: 'ready',
  createdAt: '2026-11-05T00:00:00Z',
  updatedAt: '2026-11-05T00:00:00Z',
  draft: {
    title: '发布协作组',
    summary: '研究后汇总',
    leadKey: 'lead',
    members: [
      { key: 'lead', kind: 'reuse', agentId: agent.id, assignment: '协调与汇总' },
      { key: 'research', kind: 'reuse', agentId: other.id, assignment: '研究市场' },
    ],
  },
};

export function environment() {
  const intervals = new Set<() => void>();
  return {
    document: { hidden: false },
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

export const settingsProps = () => ({
  agent,
  workspaceId: 'space-a',
  userId: 'owner-a',
  readOnly: false,
  busy: false,
  deleteBlocked: '',
  boundScreen: false,
  skillCount: 2,
  fileCount: 3,
  onComputer() {},
  onSkills() {},
  onFiles() {},
  onClose() {},
  onSaved() {},
  onDeleted() {},
});

export const teamProps = () => ({
  agents: [agent, other],
  workspaceId: 'space-a',
  userId: 'owner-a',
  modelConfigured: true,
  modelLabel: 'GLM 工作模型',
  onBusy() {},
  onDirty() {},
  onCreated() {},
});

export const creationWorkspaceId = '11111111-1111-4111-8111-111111111111';

export function createdBotReceipt(body: any) {
  const created = { ...agent, ...body.profile };
  const conversation = {
    id: 'created-dm',
    title: created.name,
    isGroup: false,
    agentIds: [created.id],
    updatedAt: '2026-11-05T00:00:00Z',
    unread: 0,
    pinned: false,
  };
  return {
    requestId: body.requestId,
    kind: 'bot',
    status: 'created',
    agentIds: [created.id],
    conversationId: conversation.id,
    createdAt: '2026-11-05T00:00:00Z',
    userId: 'owner-a',
    workspaceId: creationWorkspaceId,
    conversation,
    agents: [created],
  };
}

export function teamBootstrap() {
  return {
    conversations: [
      {
        id: 'group-a',
        title: '真实群聊',
        isGroup: true,
        agentIds: ['bot-a', 'bot-b'],
        updatedAt: '2026-11-05T00:00:00Z',
        unread: 0,
        pinned: false,
      },
    ],
    agents: [agent, other],
  };
}

export const proposal: Proposal = {
  planId: team.id,
  revision: team.revision,
  status: 'ready',
  goal: team.goal,
  title: team.draft!.title,
  summary: team.draft!.summary,
  leadKey: 'lead',
  members: [
    {
      key: 'lead',
      kind: 'reuse',
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      assignment: '协调与汇总',
    },
    {
      key: 'research',
      kind: 'reuse',
      agentId: other.id,
      name: other.name,
      role: other.role,
      assignment: '研究市场',
    },
  ],
};

export const committedTeam: BotTeamPlan = {
  ...team,
  status: 'committed',
  result: {
    conversationId: 'group-a',
    createdAgentIds: [],
    memberAgentIds: ['bot-a', 'bot-b'],
    leadAgentId: 'bot-a',
  },
};

export const cardProps = () => ({
  proposal,
  sourceName: '首席助理',
  owner: true,
  scopeKey: 'owner-a:space-a',
  workspaceId: 'space-a',
  userId: 'owner-a',
  canOpenConversation: true,
  onOpenPlan() {},
  onOpenConversation() {},
});
