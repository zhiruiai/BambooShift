import test from 'node:test';
import assert from 'node:assert/strict';
import type { BotAgent, Conversation } from '../../shared/types';
import { newChatChoices, type NewChatSnapshot } from './newChatPicker';
import { all, text, harness } from './testSupport/creationFlowFixture';

const agent: BotAgent = {
  id: 'a',
  name: 'Mira',
  role: 'Research',
  description: '',
  instructions: 'Not searchable private instructions',
  avatar: 'orb',
  color: '#76568d',
  status: 'idle',
};
const peer: BotAgent = { ...agent, id: 'b', name: 'Taro', role: 'Writing' };
const dm: Conversation = {
  id: 'dm',
  title: 'Old Bot name',
  agentIds: ['a'],
  isGroup: false,
  updatedAt: '2026-11-06T12:00:00Z',
  unread: 0,
  pinned: false,
};
const group: Conversation = {
  ...dm,
  id: 'group',
  title: 'Launch group',
  agentIds: ['a', 'b'],
  isGroup: true,
  updatedAt: '2026-11-06T11:00:00Z',
};
const snapshot = (): NewChatSnapshot => ({
  agents: [agent, peer],
  conversations: [dm, group],
  sidebarRoster: {
    revision: 'one',
    sections: [],
    entries: [{ target: { kind: 'bot', id: 'a' }, pinned: false, hidden: true, sectionId: null }],
  },
});

async function fixture(options: { member?: boolean; data?: NewChatSnapshot } = {}) {
  const document = Object.assign(new EventTarget(), { activeElement: null as any });
  const focusHistory: string[] = [];
  const original = {
    isConnected: true,
    focus() {
      document.activeElement = original;
      focusHistory.push('trigger');
    },
  };
  document.activeElement = original;
  let valid = true;
  const opened: Conversation[] = [],
    created: string[] = [];
  let closed = 0,
    nodes: any[] = [];
  const elements = new Map<any, any>();
  const ui = await harness(
    'web/src/components/NewChatPicker.tsx',
    'NewChatPicker',
    {
      data: options.data || snapshot(),
      canCreateBot: !options.member,
      isCurrent: () => valid,
      onClose: () => {
        closed++;
      },
      onOpen: (conversation: Conversation) => opened.push(conversation),
      onCreate: (mode: string) => created.push(mode),
    },
    {
      document,
      fetch() {
        throw Error('Picker must not issue writes or create missing chats');
      },
    },
    (tree) => {
      const current = all(tree, (node) => ['input', 'button', 'div'].includes(node.type));
      nodes = current.map((node, index) => {
        const key = node.props.id || (node.type === 'input' ? 'search' : `${node.type}:${index}`);
        let element = elements.get(key);
        if (!element) {
          element = {
            isConnected: true,
            getClientRects: () => [{}],
            focus() {
              document.activeElement = element;
              focusHistory.push(key);
            },
            scrollIntoView() {},
          };
          elements.set(key, element);
        }
        element.props = node.props;
        element.tag = node.type;
        element.tabIndex =
          node.props.tabIndex ?? (['input', 'button'].includes(node.type) ? 0 : -1);
        if (node.props.ref) node.props.ref.current = element;
        return element;
      });
      for (const element of nodes) {
        element.querySelectorAll = () =>
          nodes.filter((node) => ['input', 'button'].includes(node.tag) && !node.props.disabled);
        element.querySelector = () => nodes.find((node) => node.props['aria-selected'] === true);
      }
    },
  );
  await ui.flush();
  const input = () => all(ui.tree, (node) => node.type === 'input')[0];
  const choose = (label: string) =>
    all(ui.tree, (node) => node.props?.role === 'option' && text(node).includes(label))[0];
  return {
    ui,
    opened,
    created,
    focusHistory,
    document,
    input,
    choose,
    focusClose() {
      nodes.find((node) => node.props['aria-label'] === '关闭聊天选择器')?.focus();
    },
    get closed() {
      return closed;
    },
    invalidate() {
      valid = false;
    },
    async query(value: string) {
      input().props.onChange({ target: { value } });
      await ui.flush();
    },
    async key(key: string, composing = false) {
      let prevented = false;
      input().props.onKeyDown({
        key,
        keyCode: composing ? 229 : 0,
        nativeEvent: { isComposing: composing },
        preventDefault() {
          prevented = true;
        },
      });
      await ui.flush();
      return prevented;
    },
    docKey(key: string, extra: Record<string, unknown> = {}) {
      const event = new Event('keydown', { cancelable: true });
      Object.assign(event, { key, ...extra });
      document.dispatchEvent(event);
      return event;
    },
  };
}

test('snapshot choices search safe names and roles, deduplicate Bot chats and preserve hidden preferences', () => {
  const data = snapshot();
  data.conversations.push({ ...dm, id: 'older-dm', updatedAt: '2026-11-05T00:00:00Z' });
  data.agents.push({ ...agent, id: 'no-chat', name: 'Not yet a chat' });
  const before = structuredClone(data);
  assert.deepEqual(
    newChatChoices(data).map((item) => item.conversation.id),
    ['dm', 'group'],
  );
  assert.equal(newChatChoices(data, 'mira research')[0].hidden, true);
  assert.equal(newChatChoices(data, 'launch taro')[0].conversation.id, 'group');
  assert.equal(newChatChoices(data, 'private instructions').length, 0);
  assert.equal(newChatChoices(data, 'not yet').length, 0);
  assert.deepEqual(data, before);
});

test('an exact Bot name ranks ahead of groups that only contain that member', async () => {
  const data = snapshot();
  data.conversations.push({
    ...dm,
    id: 'peer-dm',
    agentIds: [peer.id],
    title: peer.name,
    updatedAt: '2026-11-05T00:00:00Z',
  });
  assert.deepEqual(
    newChatChoices(data, peer.name).map((choice) => choice.conversation.id),
    ['peer-dm', 'group'],
  );
  const f = await fixture({ data });
  try {
    await f.ui.flush();
    await f.query(peer.name);
    await f.key('Enter');
    assert.equal(f.opened[0]?.id, 'peer-dm');
  } finally {
    f.ui.dispose();
  }
});

test('unavailable shared Bots, missing or duplicate members and invalid private chats are never offered', () => {
  const data = snapshot();
  data.agents = [{ ...agent, sharedBot: { status: 'revoked' } as BotAgent['sharedBot'] }, peer];
  data.conversations.push(
    { ...dm, id: 'missing', agentIds: ['foreign'] },
    { ...dm, id: 'duplicate', isGroup: true, agentIds: ['b', 'b'] },
    { ...dm, id: 'fake-dm', agentIds: ['b', 'b'] },
  );
  assert.deepEqual(newChatChoices(data), []);
});

test('real search and arrow handlers open the existing selected group without creating anything', async () => {
  const f = await fixture();
  try {
    assert.equal(f.focusHistory[0], 'search');
    assert.equal(f.input().props['aria-activedescendant'], 'new-chat-result-0');
    assert.equal(await f.key('ArrowDown'), true);
    assert.equal(f.input().props['aria-activedescendant'], 'new-chat-result-1');
    assert.equal(await f.key('Enter'), true);
    assert.deepEqual(f.opened, [group]);
    assert.equal(f.closed, 1);
    assert.deepEqual(f.created, []);
    f.choose('Mira').props.onClick();
    assert.equal(f.opened.length, 1, 'late double clicks cannot select another chat');
  } finally {
    f.ui.dispose();
  }
});

test('Chinese composition does not submit or close; empty search is recoverable and hidden chat navigation stays read only', async () => {
  const f = await fixture();
  try {
    f.input().props.onCompositionStart();
    await f.key('Enter');
    f.docKey('Escape');
    assert.equal(f.closed, 0);
    assert.equal(f.opened.length, 0);
    f.input().props.onCompositionEnd();
    await f.key('Enter', true);
    assert.equal(f.opened.length, 0);
    await f.query('no such chat');
    assert.match(f.ui.copy, /没有找到匹配/);
    await f.key('ArrowDown');
    await f.key('Enter');
    assert.equal(f.opened.length, 0);
    await f.query('Research');
    assert.match(f.ui.copy, /已隐藏/);
    await f.key('Enter');
    assert.equal(f.opened[0].id, 'dm');
    assert.equal(snapshot().sidebarRoster?.entries[0].hidden, true);
  } finally {
    f.ui.dispose();
  }
});

test('outside click, Escape and focus wrapping close safely and restore the invoking control', async () => {
  const f = await fixture();
  try {
    f.focusClose();
    const wrapped = f.docKey('Tab', { shiftKey: true });
    assert.equal(wrapped.defaultPrevented, true);
    assert.equal(text({ props: f.document.activeElement.props }), '智能组队');
    f.docKey('Tab');
    assert.equal(f.document.activeElement.props['aria-label'], '关闭聊天选择器');
    const overlay = all(f.ui.tree, (node) => node.props?.className === 'new-chat-overlay')[0];
    overlay.props.onPointerDown({ target: {}, currentTarget: {} });
    assert.equal(f.closed, 0);
    const backdrop = {};
    overlay.props.onPointerDown({ target: backdrop, currentTarget: backdrop });
    assert.equal(f.closed, 1);
  } finally {
    f.ui.dispose();
  }
  assert.equal(f.focusHistory.at(-1), 'trigger');
  const g = await fixture();
  g.docKey('Escape');
  assert.equal(g.closed, 1);
  g.ui.dispose();
});

test('creation actions only enter the existing explicit flow, with member role restrictions', async () => {
  for (const [label, mode] of [
    ['创建 Bot', 'bot'],
    ['创建工作组', 'group'],
    ['智能组队', 'team'],
  ]) {
    const f = await fixture();
    try {
      f.ui.button(label).props.onClick();
      assert.deepEqual(f.created, [mode]);
      assert.equal(f.closed, 1);
      assert.deepEqual(f.opened, []);
    } finally {
      f.ui.dispose();
    }
  }
  const member = await fixture({ member: true, data: { agents: [], conversations: [] } });
  try {
    assert.match(member.ui.copy, /还没有可打开/);
    assert.equal(
      all(
        member.ui.tree,
        (node) => node.type === 'button' && ['创建 Bot', '智能组队'].includes(text(node)),
      ).length,
      0,
    );
    member.ui.button('创建工作组').props.onClick();
    assert.deepEqual(member.created, ['group']);
  } finally {
    member.ui.dispose();
  }
});

test('retained handlers obey current snapshot, role, account lifetime and actual unmount', async () => {
  const f = await fixture();
  const oldRow = f.choose('Mira').props.onClick;
  const oldCreate = f.ui.button('创建 Bot').props.onClick;
  f.ui.setProps({ data: { agents: [peer], conversations: [] }, canCreateBot: false });
  await f.ui.flush();
  oldRow();
  oldCreate();
  assert.equal(f.opened.length, 0);
  assert.equal(f.created.length, 0);
  f.invalidate();
  f.ui.button('创建工作组').props.onClick();
  f.docKey('Escape');
  assert.equal(f.closed, 0);
  assert.equal(f.created.length, 0);
  f.ui.dispose();
  oldRow();
  assert.equal(f.focusHistory.includes('trigger'), false, 'stale scope cannot steal focus');
  const g = await fixture();
  const retained = g.choose('Mira').props.onClick;
  g.ui.dispose();
  retained();
  assert.equal(g.opened.length, 0);
});

test('actual sidebar plus and mobile entry open the picker while creation modes and scope invalidation remain intact', async () => {
  const creates: unknown[] = [];
  const scope = { current: () => true, ticket: () => 1 };
  const props = {
    mobileHome: true,
    account: null,
    online: true,
    canManage: true,
    search: '',
    data: snapshot(),
    sidebar: { visible: [dm, group] },
    selected: 'dm',
    sendScope: scope,
    conversationWorking: () => false,
    sync: {},
    navigationScope: 'actor:space-one',
    modal: null,
    openCreate: (...args: unknown[]) => creates.push(args),
    openConversation() {},
    openSettings() {},
    openApps() {},
    openSearch() {},
    refresh() {},
    setSearch() {},
    openRoster() {},
    openPrimary() {},
    setToast() {},
  };
  const ui = await harness('web/src/workspace/WorkspaceSidebar.tsx', 'WorkspaceSidebar', props);
  try {
    await ui.flush();
    const mobile = all(ui.tree, (node) => node.type?.name === 'MobileHomeHeader')[0];
    assert.equal(mobile.props.createLabel, '开始聊天');
    mobile.props.onCreate();
    await ui.flush();
    let picker = all(ui.tree, (node) => node.type?.name === 'NewChatPicker')[0];
    assert.ok(picker);
    assert.deepEqual(creates, []);
    picker.props.onCreate('group');
    assert.deepEqual(creates, [[undefined, 'group']]);
    const retainedCurrent = picker.props.isCurrent;
    ui.setProps({ navigationScope: 'actor:space-two' });
    await ui.flush();
    assert.equal(retainedCurrent(), false);
    assert.equal(all(ui.tree, (node) => node.type?.name === 'NewChatPicker').length, 0);
    const plus = all(
      ui.tree,
      (node) => node.type?.name === 'IconButton' && node.props.label === '开始聊天',
    )[0];
    plus.props.onClick();
    await ui.flush();
    picker = all(ui.tree, (node) => node.type?.name === 'NewChatPicker')[0];
    assert.ok(picker);
    ui.setProps({ modal: 'create' });
    await ui.flush();
    assert.equal(picker.props.isCurrent(), false);
    assert.equal(all(ui.tree, (node) => node.type?.name === 'NewChatPicker').length, 0);
  } finally {
    ui.dispose();
  }
});
