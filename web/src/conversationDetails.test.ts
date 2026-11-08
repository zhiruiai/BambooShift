import test from 'node:test';
import assert from 'node:assert/strict';
import {
  all,
  component,
  harness,
  agent,
  chat,
  routine,
} from './testSupport/routineRunHistoryFixture';

const base = () => ({
  showDetail: true,
  conversation: chat,
  members: [agent],
  lead: agent,
  detailTab: 'details',
  setDetailTab() {},
  toggleDetails() {},
  account: undefined,
  data: { agents: [agent] },
  setModal() {},
  sidebarComputer: { computer: undefined },
  selectedComputerAgent: agent,
  selectedComputerAgentId: agent.id,
  setConversationScreens() {},
  navigationScope: 'owner-a:space-a',
  selected: chat.id,
  currentUserId: 'owner-a',
  modal: null,
  openComputer() {},
  canManage: true,
  setRoutineToEdit() {},
  setRoutineInitialAction() {},
  busy: false,
  sendScope: { ticket: () => 0, current: () => true },
  routines: [routine],
  action() {},
  api() {},
  memories: [],
  skills: [],
  setInspected() {},
  files: [],
  uploading: new Set(),
  fileRef: { current: null },
  setTransferFile() {},
});

test('details show routines while computer is an independent pane and memory/member entries remain reachable', async () => {
  const h = await harness('web/src/workspace/ConversationDetails.tsx', 'ConversationDetails', base());
  try {
    await h.flush();
    assert.ok(component(h.tree, 'ConversationRoutines'));
    assert.equal(all(h.tree, (node) => node.type?.name === 'ConversationComputer').length, 0);
    h.setProps({ detailTab: 'computer' });
    await h.flush();
    assert.ok(component(h.tree, 'ConversationComputer'));
    assert.equal(all(h.tree, (node) => node.type?.name === 'ConversationRoutines').length, 0);
    assert.equal(
      all(h.tree, (node) => node.props?.role === 'tabpanel')[0].props.id,
      'detail-content-computer',
    );
    h.setProps({ detailTab: 'members' });
    await h.flush();
    assert.match(h.copy, /记忆/);
    h.setProps({ conversation: { ...chat, isGroup: true }, detailTab: 'members' });
    await h.flush();
    assert.ok(component(h.tree, 'BotTeamBrief'));
    assert.match(h.copy, /小松/);
  } finally {
    h.dispose();
  }
});

test('detail tabs retain all four destinations and arrow/Home/End focus follows the active panel', async () => {
  const changed: string[] = [],
    focused: string[] = [];
  const h = await harness('web/src/workspace/details/DetailTabs.tsx', 'DetailTabs', {
    value: 'details',
    group: false,
    onChange: (value: string) => changed.push(value),
  });
  try {
    await h.flush();
    let tabs = all(h.tree, (node) => node.props?.role === 'tab');
    assert.equal(tabs.length, 4);
    assert.deepEqual(
      tabs.map((node) => node.props.tabIndex),
      [0, -1, -1, -1],
    );
    assert.match(h.copy, /电脑/);
    assert.match(h.copy, /记忆/);
    const press = (index: number, key: string) =>
      tabs[index].props.onKeyDown({
        key,
        preventDefault() {},
        currentTarget: {
          parentElement: {
            querySelector: (selector: string) => ({ focus: () => focused.push(selector) }),
          },
        },
      });
    press(0, 'ArrowRight');
    assert.equal(changed.at(-1), 'files');
    assert.equal(focused.at(-1), '#detail-tab-files');
    press(0, 'ArrowLeft');
    assert.equal(changed.at(-1), 'members');
    press(0, 'End');
    assert.equal(changed.at(-1), 'members');
    press(3, 'Home');
    assert.equal(changed.at(-1), 'details');
    h.setProps({ value: 'computer', group: true });
    await h.flush();
    tabs = all(h.tree, (node) => node.props?.role === 'tab');
    assert.deepEqual(
      tabs.map((node) => node.props.tabIndex),
      [-1, -1, 0, -1],
    );
    assert.match(h.copy, /成员/);
    assert.doesNotMatch(h.copy, /记忆/);
  } finally {
    h.dispose();
  }
});

test('detail routine menu opens the exact edit/delete intent, keeps paused frequency and never deletes directly', async () => {
  const calls: unknown[] = [];
  let current = true;
  const props = {
    ...base(),
    routines: [{ ...routine, enabled: false }],
    setRoutineToEdit: (id: string) => calls.push(['select', id]),
    setRoutineInitialAction: (value: string) => calls.push(['intent', value]),
    setModal: (value: string) => calls.push(['modal', value]),
    sendScope: { ticket: () => 0, current: () => current },
    api: (...args: unknown[]) => calls.push(['api', ...args]),
    action: (work: () => void) => work(),
  };
  const h = await harness(
    'web/src/workspace/details/ConversationRoutines.tsx',
    'ConversationRoutines',
    props,
  );
  try {
    await h.flush();
    assert.match(h.copy, /已暂停.*每天 09:00.*北京时间/);
    component(h.tree, 'RoutineActions').props.onEdit();
    assert.deepEqual(calls, [
      ['select', routine.id],
      ['intent', 'edit'],
      ['modal', 'routine'],
    ]);
    calls.length = 0;
    component(h.tree, 'RoutineActions').props.onDelete();
    assert.deepEqual(calls, [
      ['select', routine.id],
      ['intent', 'delete'],
      ['modal', 'routine'],
    ]);
    assert.equal(
      calls.some((entry: any) => entry[0] === 'api'),
      false,
    );
    calls.length = 0;
    component(h.tree, 'RoutineActions').props.onToggle();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      ['api', `/routines/${routine.id}`, 'PATCH', { enabled: true }],
    ]);
    calls.length = 0;
    current = false;
    component(h.tree, 'RoutineActions').props.onDelete();
    assert.deepEqual(calls, []);
    h.setProps({ canManage: false });
    await h.flush();
    assert.equal(component(h.tree, 'RoutineActions').props.canManage, false);
    assert.equal(all(h.tree, (node) => node.props?.role === 'switch').length, 0);
  } finally {
    h.dispose();
  }
});

test('computer pane keeps the actual Bot screen selection and scopes the existing preview without preparing another screen', async () => {
  const selected: unknown[] = [];
  const computer = {
    connected: true,
    botScreen: { agentId: agent.id, screenId: 'screen-a', status: 'ready' },
  };
  const h = await harness(
    'web/src/workspace/details/ConversationComputer.tsx',
    'ConversationComputer',
    {
      ...base(),
      conversation: { ...chat, isGroup: true },
      sidebarComputer: { computer, inventory: [] },
      setConversationScreens: (update: (before: unknown) => unknown) => selected.push(update({})),
    },
    { window: { location: { pathname: '/w/space-a' } } },
  );
  try {
    await h.flush();
    const preview = component(h.tree, 'ComputerPreview');
    assert.equal(preview.props.computer, computer);
    assert.equal(preview.props.agentName, agent.name);
    assert.equal(preview.props.userId, 'owner-a');
    assert.equal(preview.props.active, true);
    component(h.tree, 'BotScreenPicker').props.onSelect('bot-b');
    assert.equal((selected[0] as Record<string, string>)['owner-a:space-a:chat-a'], 'bot-b');
    h.setProps({ modal: 'routine' });
    await h.flush();
    assert.equal(component(h.tree, 'ComputerPreview').props.active, false);
  } finally {
    h.dispose();
  }
});

test('ordinary routine selection clears a previous destructive initial intent', async () => {
  const h = await harness(
    'web/src/workspace/useWorkspaceState.ts',
    'useWorkspaceState',
    {
      selectionKey: 'selection-fixture',
      canManage: true,
    },
    {
      URLSearchParams,
      window: { innerWidth: 1400, location: { search: '' } },
      localStorage: { getItem: () => null },
    },
  );
  try {
    await h.flush();
    h.tree.setRoutineToEdit('routine-a');
    h.tree.setRoutineInitialAction('delete');
    await h.flush();
    assert.equal(h.tree.routineInitialAction, 'delete');
    h.tree.setRoutineToEdit('routine-b');
    await h.flush();
    assert.equal(h.tree.routineToEdit, 'routine-b');
    assert.equal(h.tree.routineInitialAction, 'view');
  } finally {
    h.dispose();
  }
});
