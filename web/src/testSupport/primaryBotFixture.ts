import { expandPureViews } from './expandPureViews';
import { workspaceSource, runInWorkspaceContext as runInNewContext } from './workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import React from 'react';
import type { Bootstrap, BotAgent, Conversation } from '../../../shared/types';
import type { PrimaryBotState } from '../../../shared/primary-bot';
import type { SidebarRosterState } from '../../../shared/sidebar-roster';
import { createWorkspaceSync } from '../workspaceSync';
import {
  confirmedPrimary,
  conversationSelectionKey,
  createPrimaryBotScope,
  defaultConversation,
  primaryConversation,
} from '../primaryBot';

export const require = createRequire(import.meta.url);

export const { renderToStaticMarkup } = require('react-dom/server');

export const render = (component: any, props: any) =>
  renderToStaticMarkup(React.createElement(component, props)) as string;

export const workspaceId = '11111111-1111-4111-8111-111111111111',
  userId = '22222222-2222-4222-8222-222222222222';

export const agent: BotAgent = {
  id: 'agent-a',
  name: '小松',
  role: '项目协调',
  description: '梳理工作',
  instructions: '',
  avatar: 'orb',
  color: '#9363ed',
  status: 'idle',
};

export const other: BotAgent = { ...agent, id: 'agent-b', name: '小叶' };

export const conversation: Conversation = {
  id: 'dm-a',
  title: '小松',
  agentIds: [agent.id],
  isGroup: false,
  updatedAt: '2026-11-05T00:00:00Z',
  pinned: false,
  unread: 0,
};

export const group: Conversation = {
  ...conversation,
  id: 'group-a',
  title: '协作组',
  agentIds: [agent.id, other.id],
  isGroup: true,
  pinned: true,
};

export const empty: PrimaryBotState = {
  available: true,
  revision: 'unset',
  agentId: null,
  conversationId: null,
  checkIn: { enabled: true, time: '09:00' },
};

export const selected: PrimaryBotState = {
  ...empty,
  revision: 'rev-a',
  agentId: agent.id,
  conversationId: conversation.id,
};

export const bootstrap = (state: PrimaryBotState = selected) =>
  ({
    primaryBot: state,
    agents: [agent, other],
    conversations: [group, conversation],
  }) as Bootstrap;

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function compile(file: string, extra = '', globals: Record<string, unknown> = {}) {
  const path = resolve(file),
    output = await build({
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
    AbortController,
    AbortSignal,
    DOMException,
    Response,
    URL,
    Event,
    fetch,
    ...globals,
  });
  return module.exports;
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
  const children =
    node.type?.name === 'BotProfileFields' ? node.type(node.props) : node.props?.children;
  return [...(match(node) ? [node] : []), ...all(children, match)];
}

export async function harness(
  overrides: Record<string, unknown> = {},
  transport: typeof fetch = async () => json(empty),
) {
  let cursor = 0,
    dirty = true,
    tree: any,
    props = {
      state: empty,
      agents: [agent, other],
      workspaceId,
      userId,
      team: false,
      onClose() {},
      onSaved() {},
      ...overrides,
    };
  const window = Object.assign(new EventTarget(), { location: { pathname: `/w/${workspaceId}` } });
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
  const component = (
    await compile('web/src/components/PrimaryBotDialog.tsx', '\nexport { PrimaryBotContent };', {
      require: (name: string) => (name === 'react' ? hooks : require(name)),
      window,
      fetch: transport,
    })
  ).PrimaryBotContent;
  const find = (match: (node: any) => boolean) => {
    const value = all(tree, match)[0];
    assert.ok(value, 'Expected element');
    return value;
  };
  return {
    async flush() {
      for (let i = 0; i < 30; i++) {
        if (dirty) {
          cursor = 0;
          dirty = false;
          tree = expandPureViews(component(props));
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
    get text() {
      return copy(tree);
    },
    window,
    button(label: string) {
      return find(
        (node) =>
          node.type === 'button' &&
          (copy(node).trim() === label || node.props['aria-label'] === label),
      );
    },
    field(label: string) {
      const parent = find((node) => node.type === 'label' && copy(node).startsWith(label));
      const result = all(parent, (node) => ['input', 'textarea'].includes(node.type))[0];
      assert.ok(result);
      return result;
    },
    choice(id: string) {
      return find((node) => node.type === 'button' && node.key === id);
    },
    submit() {
      find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
    },
    update(values: Record<string, unknown>) {
      props = { ...props, ...values };
      dirty = true;
    },
    dispose() {
      for (const slot of slots) slot.cleanup?.();
    },
  };
}

export async function appHookCallback(variable: string, property: string) {
  const source = await workspaceSource(),
    ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === variable &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const input = node.initializer.arguments[0];
      if (input && ts.isObjectLiteralExpression(input)) {
        const item = input.properties.find(
          (entry) => ts.isPropertyAssignment(entry) && entry.name.getText(ast) === property,
        );
        if (item && ts.isPropertyAssignment(item)) found = item.initializer;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found);
  return found.getText(ast);
}
