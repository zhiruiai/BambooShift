import { expandPureViews } from './testSupport/expandPureViews';
import {
  workspaceSource,
  runInWorkspaceContext as runInNewContext,
} from './testSupport/workspaceSource';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import React from 'react';

const require = createRequire(import.meta.url);
function all(node: any, check: (value: any) => boolean): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((value) => all(value, check));
  return [...(check(node) ? [node] : []), ...all(node.props?.children, check)];
}
function text(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node !== 'object') return String(node);
  return node.type?.name === 'Highlight' ? node.props.text : text(node.props?.children);
}
async function appHandlers() {
  const source = await workspaceSource();
  const ast = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const functions: string[] = [];
  const props: Record<string, string> = {};
  function visit(node: ts.Node) {
    if (
      ts.isFunctionDeclaration(node) &&
      ['workspaceShortcut', 'openCreate'].includes(node.name?.text || '')
    )
      functions.push(node.getText(ast));
    if (ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      for (const name of tag === 'ConversationSearch'
        ? ['commands']
        : tag === 'CreateDialog'
          ? ['initialMode', 'initialPlanId']
          : []) {
        const attr = node.attributes.properties.find(
          (p) => ts.isJsxAttribute(p) && p.name.getText(ast) === name,
        ) as ts.JsxAttribute | undefined;
        if (
          attr?.initializer &&
          ts.isJsxExpression(attr.initializer) &&
          attr.initializer.expression
        )
          props[`${tag}_${name}`] = attr.initializer.expression.getText(ast);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(functions.length, 2);
  const code = ts.transpileModule(
    `${functions.join('\n')}\nexports.openCreate=openCreate;exports.shortcut=workspaceShortcut;\n${Object.entries(
      props,
    )
      .map(([key, value]) => `exports.${key}=()=>(${value});`)
      .join('\n')}`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } },
  ).outputText;
  const events: any[] = [];
  const context: any = {
    exports: {},
    canManage: true,
    active: true,
    modalRef: { current: null },
    createMode: undefined,
    teamPlanToOpen: undefined,
    sendScope: { ticket: () => 0, current: () => context.active },
    setModal: (value: any) => {
      context.modalRef.current = value;
      events.push(['modal', value]);
    },
    setTeamPlanToOpen: (value: any) => (context.teamPlanToOpen = value),
    setCreateMode: (value: any) => (context.createMode = value),
    setCreateProfile: () => {},
    shortcutActions: {
      current: {
        search: () => events.push('search'),
        group: () => events.push('group'),
        settings: () => events.push('settings'),
      },
    },
  };
  runInNewContext(code, context);
  return { context, events };
}
function key(overrides: any = {}) {
  const event: any = {
    key: 'N',
    metaKey: true,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    isComposing: false,
    keyCode: 78,
    prevented: 0,
    preventDefault() {
      this.prevented++;
    },
    ...overrides,
  };
  return event;
}
test('actual workspace keyboard handler opens new groups for both platforms and protects open drafts, IME and stale accounts', async () => {
  const { context, events } = await appHandlers();
  for (const event of [
    key(),
    key({ metaKey: false, ctrlKey: true, key: 'n' }),
    key({ key: 'k', shiftKey: false }),
  ]) {
    context.exports.shortcut(event);
    assert.equal(event.prevented, 1);
  }
  assert.deepEqual(events, ['group', 'group', 'search']);
  events.length = 0;
  for (const change of [
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
    { defaultPrevented: true },
    { altKey: true },
    { metaKey: false },
    { shiftKey: false },
    { key: 'K' },
  ])
    context.exports.shortcut(key(change));
  assert.deepEqual(events, []);
  for (const modal of ['create', 'settings', 'group', 'sharing']) {
    context.modalRef.current = modal;
    context.exports.shortcut(key());
  }
  assert.deepEqual(events, []);
  context.modalRef.current = 'search';
  context.exports.shortcut(key());
  assert.deepEqual(events, ['group']);
  context.modalRef.current = null;
  context.active = false;
  context.exports.shortcut(key());
  assert.equal(events.length, 1);
  context.active = true;
  context.shortcutActions.current.group = () => (events as unknown[]).push('new-handler');
  context.exports.shortcut(key());
  assert.equal(events.at(-1), 'new-handler');
});
test('App palette commands preserve creation mode, discard prior plan selection and do not expose owner-only actions to members', async () => {
  const { context, events } = await appHandlers();
  const commands = context.exports.ConversationSearch_commands();
  assert.deepEqual(
    Array.from(commands, (c: any) => c.id),
    ['new-group', 'smart-team', 'new-bot'],
  );
  for (const [id, mode] of [
    ['new-group', 'group'],
    ['smart-team', 'team'],
    ['new-bot', 'bot'],
  ]) {
    context.teamPlanToOpen = 'previous-plan';
    commands.find((c: any) => c.id === id).run();
    assert.equal(context.exports.CreateDialog_initialMode(), mode);
    assert.equal(context.exports.CreateDialog_initialPlanId(), undefined);
    assert.equal(context.modalRef.current, 'create');
  }
  context.canManage = false;
  assert.deepEqual(
    Array.from(context.exports.ConversationSearch_commands(), (c: any) => c.id),
    ['new-group'],
  );
  const before = events.length;
  context.exports.openCreate('owner-plan');
  assert.equal(events.length, before);
  context.active = false;
  commands[0].run();
  assert.equal(events.length, before);
});

async function palette(initial: any) {
  const output = await build({
    entryPoints: [resolve('web/src/components/ConversationSearch.tsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty' },
  });
  const slots: any[] = [];
  let cursor = 0,
    changed = true,
    props = initial,
    tree: any;
  const effects: Array<() => void> = [];
  const hooks = {
    ...React,
    useState(initial: any) {
      const i = cursor++;
      slots[i] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[i].value,
        (v: any) => {
          const next = typeof v === 'function' ? v(slots[i].value) : v;
          if (!Object.is(next, slots[i].value)) {
            slots[i].value = next;
            changed = true;
          }
        },
      ];
    },
    useRef(initial: any) {
      return (slots[cursor++] ||= { current: initial });
    },
    useId() {
      return 'palette-fixture';
    },
    useDeferredValue(value: any) {
      return value;
    },
    useMemo(fn: () => any) {
      return fn();
    },
    useEffect(fn: () => any, deps: any[]) {
      const i = cursor++,
        old = slots[i];
      if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) {
        const slot = { deps, cleanup: old?.cleanup };
        slots[i] = slot;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = fn();
        });
      }
    },
  };
  const module = { exports: {} as any };
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name: string) => (name === 'react' ? hooks : require(name)),
  });
  const inputTarget = {
    focus() {},
    getAttribute() {
      return undefined;
    },
  };
  const ui = {
    get tree() {
      return tree;
    },
    get options() {
      return all(tree, (n: any) => n.props?.role === 'option');
    },
    get input() {
      return all(tree, (n: any) => n.type === 'input')[0];
    },
    async flush() {
      for (let i = 0; i < 20; i++) {
        if (changed) {
          changed = false;
          cursor = 0;
          tree = expandPureViews(module.exports.ConversationSearch(props));
          ui.input.props.ref.current = inputTarget;
        }
        for (const effect of effects.splice(0)) effect();
        await new Promise((r) => setImmediate(r));
        if (!changed && !effects.length) return;
      }
      throw Error('Unsettled effects');
    },
    props(next: any) {
      props = { ...props, ...next };
      changed = true;
    },
    query(value: string) {
      ui.input.props.onChange({ target: { value } });
    },
    key(value: string, composing = false) {
      const wrap = all(tree, (n: any) => n.props?.className === 'history-search-content')[0];
      wrap.props.onKeyDown({
        key: value,
        target: inputTarget,
        nativeEvent: { isComposing: composing, keyCode: composing ? 229 : 0 },
        preventDefault() {},
      });
    },
    dispose() {
      for (const slot of slots) slot.cleanup?.();
    },
  };
  await ui.flush();
  return ui;
}
const data = {
  agents: [{ id: 'a', name: '研究员' }],
  conversations: [
    {
      id: 'chat',
      title: '研究计划',
      agentIds: ['a'],
      isGroup: false,
      updatedAt: '2026-11-05T00:00:00Z',
    },
  ],
  messages: [
    {
      id: 'message',
      conversationId: 'chat',
      role: 'user',
      content: '准备研究报告',
      createdAt: '2026-11-05T00:00:00Z',
    },
  ],
};
function props(events: any[]) {
  return {
    data,
    currentConversationId: 'chat',
    onClose: () => events.push('close'),
    onJump: (...v: any[]) => events.push(['jump', ...v]),
    commands: [
      {
        id: 'group',
        title: '新建群聊',
        description: '选择 Bot，一起工作',
        keywords: 'New group chat',
        run: () => events.push('group'),
      },
      {
        id: 'team',
        title: '智能组队',
        description: '规划成员和分工',
        run: () => events.push('team'),
      },
    ],
  };
}
test('palette filters commands, selects them by keyboard and closes before opening exactly once', async () => {
  const events: any[] = [];
  const ui = await palette(props(events));
  try {
    assert.equal(ui.options.length, 3);
    assert.match(text(ui.options[0]), /新建群聊/);
    ui.query('NEW GROUP');
    await ui.flush();
    assert.equal(ui.options.length, 1);
    ui.key('Enter', true);
    assert.deepEqual(events, []);
    ui.key('Enter');
    ui.options[0].props.onClick();
    assert.deepEqual(events, ['close', 'group']);
  } finally {
    ui.dispose();
  }
});
test('palette keeps local history navigation and current-chat search separate from commands', async () => {
  const events: any[] = [];
  const ui = await palette(props(events));
  try {
    ui.key('ArrowUp');
    await ui.flush();
    ui.key('Enter');
    assert.deepEqual(events, [['jump', 'chat', undefined], 'close']);
  } finally {
    ui.dispose();
  }
  events.length = 0;
  const current = await palette({ ...props(events), initialScope: 'current' });
  try {
    assert.equal(current.options.length, 1);
    current.query('报告');
    await current.flush();
    assert.equal(current.options.length, 1);
    current.options[0].props.onClick();
    assert.deepEqual(events, [['jump', 'chat', 'message'], 'close']);
  } finally {
    current.dispose();
  }
});
test('revoked palette commands and unmounted handlers cannot open another dialog', async () => {
  const events: any[] = [];
  const ui = await palette(props(events));
  const old = ui.options[1].props.onClick;
  ui.props({ commands: [props(events).commands[0]] });
  await ui.flush();
  old();
  assert.deepEqual(events, []);
  const group = ui.options[0].props.onClick;
  ui.dispose();
  group();
  assert.deepEqual(events, []);
});

test('palette opens matching files and routines only from the visible workspace snapshot', async () => {
  const events: any[] = [];
  const file = {
    id: 'report-file',
    name: '交付说明.md',
    conversationId: 'chat',
    createdAt: '2026-11-06T00:00:00Z',
  };
  const routine = {
    id: 'delivery-routine',
    title: '交付提醒',
    conversationId: 'chat',
    agentId: 'a',
  };
  const snapshot = {
    ...data,
    files: [
      file,
      { ...file, id: 'orphan', conversationId: 'missing' },
      { ...file, id: 'workspace', name: '交付模板.md', conversationId: undefined, size: 20 },
    ],
    routines: [routine, { ...routine, id: 'removed', agentId: 'missing' }],
  };
  const ui = await palette({
    ...props(events),
    data: snapshot,
    initialScope: 'current',
    onOpenFile: (value: any) => events.push(value.id),
    onOpenRoutine: (value: any) => events.push(value.id),
  });
  try {
    ui.query('交付');
    await ui.flush();
    assert.equal(ui.options.length, 2);
    assert.match(text(ui.options[0]), /交付说明\.md/);
    assert.match(text(ui.options[1]), /交付提醒/);
    const openFile = ui.options[0].props.onClick;
    ui.props({ data: { ...snapshot, files: [] } });
    await ui.flush();
    openFile();
    assert.deepEqual(events, []);
    ui.key('Enter');
    assert.deepEqual(events, [routine.id]);
  } finally {
    ui.dispose();
  }
});

test('settings shortcut works on both platforms while preserving active dialogs and IME input', async () => {
  const { context, events } = await appHandlers();
  for (const override of [{}, { metaKey: false, ctrlKey: true }]) {
    const event = key({ key: ',', shiftKey: false, ...override });
    context.exports.shortcut(event);
    assert.equal(event.prevented, 1);
  }
  assert.deepEqual(events, ['settings', 'settings']);
  events.length = 0;
  for (const modal of ['settings', 'create', 'agent', 'group']) {
    context.modalRef.current = modal;
    context.exports.shortcut(key({ key: ',', shiftKey: false }));
  }
  context.modalRef.current = null;
  for (const override of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { shiftKey: true },
    { altKey: true },
  ])
    context.exports.shortcut(key({ key: ',', shiftKey: false, ...override }));
  context.active = false;
  context.exports.shortcut(key({ key: ',', shiftKey: false }));
  assert.deepEqual(events, []);
});
