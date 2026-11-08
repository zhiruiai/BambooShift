import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../shared/types';
import { all, component, harness, text, workspaceId } from './testSupport/creationFlowFixture';

const message: Message = {
  id: 'original-1',
  conversationId: 'group-chat',
  role: 'assistant',
  agentId: 'bot-a',
  content: 'Synthetic message text',
  status: 'done',
  createdAt: '2026-11-06T00:00:00.000Z',
};
const english = { getItem: () => JSON.stringify({ version: 1, locale: 'en' }) };

async function toolbar(initial: Partial<Message> = {}) {
  const calls: unknown[][] = [];
  const document = new EventTarget();
  const window = {
    localStorage: english,
    location: { origin: 'https://synthetic.test', pathname: `/w/${workspaceId}/` },
  };
  const copy = async (value: string) => {
    calls.push(['copy', value]);
  };
  let live = true;
  let ui: Awaited<ReturnType<typeof harness>>;
  const rectangle = (top: number, bottom: number, left: number, right: number) => ({
    top,
    bottom,
    left,
    right,
    height: bottom - top,
  });
  const viewport = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => rectangle(0, 310, 0, 320),
  });
  const focus = (name: string) => () => {
    calls.push(['focus', name]);
  };
  const options = [{ focus: focus('first') }, { focus: focus('second') }];
  const panel = {
    dataset: {} as { below?: string },
    style: {} as { translate?: string },
    getBoundingClientRect: () => rectangle(-60, 20, 220, 365),
    querySelectorAll: () => options,
    contains: (target: unknown) => options.includes(target as (typeof options)[number]),
  };
  const root = {
    isConnected: true,
    closest: () => viewport,
    getBoundingClientRect: () => rectangle(25, 51, 220, 303),
    contains: (target: unknown) => target === root || panel.contains(target),
  };
  ui = await harness(
    'web/src/components/MessageActions.tsx',
    'MessageActions',
    {
      message: { ...message, ...initial },
      currentUserId: 'actor',
      current: () => live,
      voice: {},
      popup: null,
      busy: false,
      onPopup(popup: unknown) {
        ui.setProps({ popup });
      },
      onReply() {
        calls.push(['reply']);
      },
      onJump() {
        calls.push(['jump']);
      },
      onReact(emoji: string, active: boolean) {
        calls.push(['reaction', emoji, active]);
      },
      copy,
    },
    { window, document },
    (tree) => {
      tree.props.ref.current = root;
      const panelNode = all(tree, (node) => node.props?.role === 'group')[0];
      if (panelNode) panelNode.props.ref.current = panel;
      for (const node of all(tree, (node) => node.type === 'button' && node.props?.ref))
        node.props.ref.current = { focus: focus(node.props['aria-label']) };
    },
  );
  await ui.flush();
  const button = (label: string) => {
    const result = all(
      ui.tree,
      (node) =>
        node.type === 'button' &&
        (node.props['aria-label'] === label || text(node).trim() === label),
    )[0];
    assert.ok(result, `Missing button ${label}`);
    return result;
  };
  return {
    ui,
    calls,
    document,
    panel,
    options,
    button,
    stop() {
      live = false;
    },
  };
}

test('message popovers expose actual copy text, scoped links, quote jump and existing voice action', async () => {
  const f = await toolbar({ kind: 'file', content: '', metadata: { name: 'synthetic.txt' } });
  try {
    const more = () => f.button('More message actions');
    assert.equal(more().props['aria-expanded'], false);
    more().props.onClick();
    await f.ui.flush();
    assert.equal(more().props['aria-expanded'], true);
    assert.equal(f.panel.dataset.below, 'true');
    assert.equal(f.panel.style.translate, '-49px');
    assert.equal(component(f.ui.tree, 'VoiceMessageButton').props.message.kind, 'file');
    f.button('Copy message').props.onClick();
    await f.ui.flush();
    assert.deepEqual(f.calls.at(-1), ['copy', 'synthetic.txt']);
    assert.equal(more().props['aria-expanded'], false);
    more().props.onClick();
    await f.ui.flush();
    f.button('Copy message link').props.onClick();
    await f.ui.flush();
    assert.deepEqual(f.calls.at(-1), [
      'copy',
      `https://synthetic.test/w/${workspaceId}/?conversation=group-chat&message=original-1`,
    ]);
    more().props.onClick();
    await f.ui.flush();
    f.button('Jump to original message').props.onClick();
    assert.deepEqual(f.calls.at(-1), ['jump']);
    assert.doesNotMatch(f.ui.copy, /Delete|Forward/);
  } finally {
    f.ui.dispose();
  }
});

test('reaction and more controls accept keyboard focus, restore it on Escape, and close on outside input', async () => {
  const f = await toolbar();
  try {
    const reaction = () => f.button('React to this message');
    const key = async (key: string, extra = {}) => {
      let prevented = false;
      f.ui.tree.props.onKeyDown({
        key,
        target: f.options[0],
        nativeEvent: {},
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {},
        ...extra,
      });
      await f.ui.flush();
      return prevented;
    };
    reaction().props.onClick();
    await f.ui.flush();
    assert.equal(reaction().props['aria-expanded'], true);
    assert.deepEqual(f.calls.at(-1), ['focus', 'first']);
    assert.equal(await key('ArrowRight'), true);
    assert.deepEqual(f.calls.at(-1), ['focus', 'second']);
    component(f.ui.tree, 'ReactionChoices').props.onReact('🎉', true);
    assert.deepEqual(f.calls.at(-1), ['reaction', '🎉', true]);
    assert.equal(await key('Escape'), true);
    assert.equal(reaction().props['aria-expanded'], false);
    assert.deepEqual(f.calls.at(-1), ['focus', 'React to this message']);
    assert.equal(await key('F10', { shiftKey: true }), true);
    assert.equal(f.button('More message actions').props['aria-expanded'], true);
    f.document.dispatchEvent(new Event('pointerdown'));
    await f.ui.flush();
    assert.equal(f.button('More message actions').props['aria-expanded'], false);
    f.button('Reply to this message').props.onClick();
    assert.deepEqual(f.calls.at(-1), ['reply']);
  } finally {
    f.ui.dispose();
  }
});

test('a stale message toolbar cannot copy or mutate after the chat scope expires', async () => {
  const f = await toolbar();
  try {
    f.button('More message actions').props.onClick();
    await f.ui.flush();
    const copy = f.button('Copy message').props.onClick;
    const reply = f.button('Reply to this message').props.onClick;
    f.stop();
    copy();
    reply();
    assert.ok(f.calls.every(([action]) => action === 'focus'));
  } finally {
    f.ui.dispose();
  }
});

test('group reaction counts and add or remove affordances reflect the current actor', async () => {
  const calls: unknown[][] = [];
  const ui = await harness(
    'web/src/components/MessageExtras.tsx',
    'ReactionButtons',
    {
      message: {
        ...message,
        reactions: ['👍', '❤️'],
        reactionMembers: { '👍': ['actor', 'peer'], '❤️': ['peer'] },
      },
      currentUserId: 'actor',
      busy: false,
      chips: true,
      onReact(...args: unknown[]) {
        calls.push(args);
      },
    },
    { window: { localStorage: english } },
  );
  try {
    await ui.flush();
    const [mine, other] = all(ui.tree, (node) => node.type === 'button');
    assert.equal(mine.props['aria-pressed'], true);
    assert.equal(text(mine), '👍2');
    assert.equal(other.props['aria-pressed'], false);
    assert.equal(text(other), '❤️1');
    mine.props.onClick();
    other.props.onClick();
    assert.deepEqual(calls, [
      ['👍', false],
      ['❤️', true],
    ]);
  } finally {
    ui.dispose();
  }
});

test('group authors follow the date and actor, and file, approval and status rows expose supported actions', async () => {
  const nextDay = '2026-11-07T00:00:00.000Z';
  const messages: Message[] = [
    message,
    { ...message, id: 'next', createdAt: nextDay, kind: 'file' },
    { ...message, id: 'approval', createdAt: nextDay, kind: 'approval' },
    { ...message, id: 'status', createdAt: nextDay, role: 'system', kind: 'activity' },
    { ...message, id: 'teammate', createdAt: nextDay, role: 'user', userId: 'peer' },
    { ...message, id: 'system', createdAt: nextDay, role: 'system' },
  ];
  const calls: unknown[][] = [];
  let selection = '';
  const ui = await harness(
    'web/src/workspace/ChatMessages.tsx',
    'ChatMessages',
    {
      conversation: { id: message.conversationId, isGroup: true, agentIds: ['bot-a', 'bot-b'] },
      data: { agents: [{ id: 'bot-a', name: 'Synthetic Bot', color: '#123456' }] },
      messages,
      navigationScope: 'actor:workspace',
      ownMessage: () => false,
      userName: () => 'Synthetic teammate',
      appearance: {},
      currentUserId: 'actor',
      sendScope: { ticket: () => 1, current: () => true },
      reactionPicker: null,
      setReactionPicker() {},
      reactionPending: new Set(),
      async reactToMessage(...args: unknown[]) {
        calls.push(['reaction', ...args]);
      },
      beginReply(...args: unknown[]) {
        calls.push(['reply', ...args]);
      },
    },
    { window: { localStorage: english, getSelection: () => selection } },
  );
  try {
    await ui.flush();
    const authors = all(ui.tree, (node) => node.props?.className === 'message-author').map(text);
    assert.deepEqual(authors, ['Synthetic Bot', 'Synthetic Bot', 'Synthetic teammate']);
    const action = (id: string) =>
      all(
        ui.tree,
        (node) => node.type?.name === 'MessageActions' && node.props.message.id === id,
      )[0].props;
    action('next').onReact('👍', true);
    action('approval').onReply();
    assert.deepEqual(calls, [
      ['reaction', messages[1], '👍', true],
      ['reply', messages[2]],
    ]);
    for (const id of ['status', 'system']) {
      assert.equal(action(id).onReact, undefined);
      assert.equal(action(id).onReply, undefined);
    }
    const status = all(ui.tree, (node) => node.props?.id === 'message-status')[0];
    let intercepted = false;
    status.props.onContextMenu({
      target: { closest: () => true },
      preventDefault() {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false);
    selection = 'Selected message text';
    status.props.onContextMenu({
      target: { closest: () => null },
      preventDefault() {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false);
    selection = '';
    status.props.onContextMenu({
      target: { closest: () => null },
      preventDefault() {
        intercepted = true;
      },
    });
    assert.equal(intercepted, true);
    await ui.flush();
    assert.equal(action('status').popup, 'more');
    assert.equal(action('system').popup, null);
  } finally {
    ui.dispose();
  }
});
