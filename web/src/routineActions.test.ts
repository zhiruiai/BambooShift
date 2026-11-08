import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, dialog, routine, all } from './testSupport/routineRunHistoryFixture';

function walk(tree: any, match: (node: any) => boolean): any[] {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((node) => walk(node, match));
  return [...(match(tree) ? [tree] : []), ...walk(tree.props?.children ?? tree.children, match)];
}
function event(key = '') {
  return {
    key,
    shiftKey: false,
    clientX: 310,
    clientY: 590,
    preventDefault() {},
    stopPropagation() {},
  };
}
async function menuFixture(overrides: Record<string, unknown> = {}) {
  class Element extends EventTarget {
    nodeType = 1;
    nodes: Element[] = [];
    focus() {
      document.activeElement = this;
    }
    contains(node: unknown): boolean {
      return node === this || this.nodes.some((item) => item.contains(node));
    }
    getBoundingClientRect() {
      return { right: 310, bottom: 590 };
    }
    querySelectorAll() {
      return this.nodes;
    }
    querySelector() {
      return this.nodes[0];
    }
  }
  const document = Object.assign(new Element(), {
    body: new Element(),
    activeElement: null as Element | null,
  });
  const window = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 600 });
  const root = new Element(),
    trigger = new Element(),
    menu = new Element();
  const items = [new Element(), new Element(), new Element()];
  root.nodes = [trigger];
  menu.nodes = items;
  const calls: string[] = [];
  const h = await harness(
    'web/src/components/RoutineActions.tsx',
    'RoutineActions',
    {
      title: routine.title,
      enabled: true,
      children: 'Task',
      onToggle() {
        calls.push('toggle');
      },
      onEdit() {
        calls.push('edit');
      },
      onDelete() {
        calls.push('delete');
      },
      ...overrides,
    },
    { Node: Element, document, window },
    (tree) => {
      tree.props.ref.current = root;
      const button = walk(
        tree,
        (node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu',
      )[0];
      if (button) button.props.ref.current = trigger;
      const panel = walk(tree, (node) => node.props?.role === 'menu')[0];
      if (panel) panel.props.ref.current = menu;
    },
  );
  await h.flush();
  return {
    h,
    calls,
    document,
    window,
    root,
    trigger,
    menu,
    items,
    triggerButton: () =>
      walk(h.tree, (node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu')[0],
    panel: () => walk(h.tree, (node) => node.props?.role === 'menu')[0],
    options: () => walk(h.tree, (node) => node.props?.role === 'menuitem'),
  };
}

test('routine menu supports a visible trigger, real context menu, bounded positioning and keyboard selection', async () => {
  const f = await menuFixture();
  try {
    f.triggerButton().props.onClick();
    await f.h.flush();
    assert.equal(f.options().length, 3);
    assert.equal(f.document.activeElement, f.items[0]);
    assert.ok(f.panel().props.style.left >= 8 && f.panel().props.style.left <= 88);
    assert.ok(f.panel().props.style.top <= 444);
    f.panel().props.onKeyDown(event('ArrowDown'));
    assert.equal(f.document.activeElement, f.items[1]);
    f.panel().props.onKeyDown(event('End'));
    assert.equal(f.document.activeElement, f.items[2]);
    f.panel().props.onKeyDown(event('Home'));
    assert.equal(f.document.activeElement, f.items[0]);
    f.options()[1].props.onClick();
    await f.h.flush();
    assert.deepEqual(f.calls, ['edit']);
    assert.equal(f.document.activeElement, f.trigger);
    assert.equal(f.panel(), undefined);
    f.h.tree.props.onContextMenu(event());
    await f.h.flush();
    assert.ok(f.panel());
    f.panel().props.onKeyDown(event('Escape'));
    await f.h.flush();
    assert.equal(f.panel(), undefined);
    assert.equal(f.document.activeElement, f.trigger);
    f.h.tree.props.onKeyDown({ ...event('F10'), shiftKey: true });
    await f.h.flush();
    assert.ok(f.panel());
  } finally {
    f.h.dispose();
  }
});

test('outside pointer and resize close the menu; permission, busy, and unmount reject retained action callbacks', async () => {
  for (const mode of ['outside', 'resize', 'permission', 'busy', 'unmount']) {
    const f = await menuFixture();
    f.triggerButton().props.onClick();
    await f.h.flush();
    const oldDelete = f.options()[2].props.onClick;
    if (mode === 'outside') f.document.dispatchEvent(new Event('pointerdown'));
    if (mode === 'resize') f.window.dispatchEvent(new Event('resize'));
    if (mode === 'permission') f.h.setProps({ canManage: false });
    if (mode === 'busy') f.h.setProps({ disabled: true });
    if (mode === 'unmount') f.h.dispose();
    else await f.h.flush();
    if (mode !== 'unmount') assert.equal(f.panel(), undefined);
    if (['permission', 'busy', 'unmount'].includes(mode)) {
      oldDelete();
      assert.deepEqual(f.calls, []);
    }
    if (mode !== 'unmount') f.h.dispose();
  }
});

test('recipient read-only rows have no menu and unknown operation blocks delete without hiding pause', async () => {
  const f = await menuFixture({ deleteDisabled: true });
  try {
    f.triggerButton().props.onClick();
    await f.h.flush();
    assert.equal(f.options()[2].props.disabled, true);
    f.options()[2].props.onClick();
    assert.deepEqual(f.calls, []);
    f.options()[0].props.onClick();
    assert.deepEqual(f.calls, ['toggle']);
    f.h.setProps({ canManage: false });
    await f.h.flush();
    assert.equal(f.triggerButton(), undefined);
  } finally {
    f.h.dispose();
  }
});

test('explicit detail edit initializes the existing editor once, while delete still needs original confirmation', async () => {
  let consumed = 0,
    deleted = 0;
  const editing = await dialog({
    initialRoutineId: routine.id,
    initialAction: 'edit',
    onInitialActionConsumed() {
      consumed++;
    },
  });
  try {
    assert.equal(editing.field('任务名称').props.value, routine.title);
    editing.field('任务名称').props.onChange({ target: { value: 'Preserved draft' } });
    editing.setProps({
      initialAction: 'view',
      routines: [{ ...routine, title: 'Changed remotely' }],
    });
    await editing.flush();
    assert.equal(editing.field('任务名称').props.value, 'Preserved draft');
    assert.equal(consumed, 1);
  } finally {
    editing.dispose();
  }
  const deleting = await dialog({
    initialRoutineId: routine.id,
    initialAction: 'delete',
    onDelete: async () => {
      deleted++;
    },
  });
  try {
    assert.match(deleting.copy, /已开始的工作不会停止/);
    assert.equal(deleted, 0);
    deleting.button('取消删除').props.onClick();
    await deleting.flush();
    assert.equal(deleted, 0);
    assert.equal(
      all(
        deleting.tree,
        (node) => node.props?.className === 'routine-delete-confirm bot-form-notice',
      ).length,
      0,
    );
  } finally {
    deleting.dispose();
  }
});

test('a transfer entry invokes the dedicated confirmation flow and disappears when unavailable', async () => {
  let transfers = 0;
  const f = await menuFixture({
    onTransfer() {
      transfers++;
    },
  });
  try {
    f.triggerButton().props.onClick();
    await f.h.flush();
    assert.equal(f.options().length, 4);
    const transfer = f.options().find((node) => String(node.props.children?.[1]).includes('转交'));
    assert.ok(transfer);
    transfer.props.onClick();
    await f.h.flush();
    assert.equal(transfers, 1);
    assert.deepEqual(f.calls, []);
    f.h.setProps({ onTransfer: undefined });
    await f.h.flush();
    f.triggerButton().props.onClick();
    await f.h.flush();
    assert.equal(f.options().length, 3);
    transfer.props.onClick();
    assert.equal(transfers, 1);
  } finally {
    f.h.dispose();
  }
});
