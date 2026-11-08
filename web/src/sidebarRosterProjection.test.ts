import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bootstrap, BotAgent, Conversation } from '../../shared/types';
import type { SidebarRosterEntry, SidebarRosterState } from '../../shared/sidebar-roster';
import { conversationRosterEntry, isConversationHidden, projectSidebar } from './sidebarRoster';

const bot = (id: string, name: string, role: string): BotAgent => ({
  id,
  name,
  role,
  description: '',
  instructions: '',
  avatar: 'orb',
  color: '#7733bb',
  status: 'idle',
});
const conversation = (id: string, agentIds: string[], isGroup = false): Conversation => ({
  id,
  title: id,
  agentIds,
  isGroup,
  pinned: false,
  unread: 0,
  updatedAt: '2026-11-05T08:00:00Z',
});
type Data = Pick<Bootstrap, 'agents' | 'conversations' | 'primaryBot' | 'sidebarRoster'>;
function fixture(): Data {
  return {
    agents: [bot('chief', '小欧', '协调'), bot('research', '研究员', 'Research')],
    conversations: [
      conversation('chief-current', ['chief']),
      { ...conversation('chief-earlier', ['chief']), updatedAt: '2026-11-04T08:00:00Z' },
      conversation('research-chat', ['research']),
      conversation('joint-work', ['chief', 'research'], true),
      conversation('single-bot-group', ['chief'], true),
    ],
    primaryBot: {
      available: true,
      revision: 'primary-revision',
      agentId: 'chief',
      conversationId: 'chief-current',
      checkIn: { enabled: true, time: '09:00' },
    },
    sidebarRoster: { revision: 'roster-revision', sections: [], entries: [] },
  };
}
const preference = (
  kind: 'bot' | 'conversation',
  id: string,
  values: Partial<SidebarRosterEntry> = {},
): SidebarRosterEntry => ({
  target: { kind, id },
  pinned: false,
  hidden: false,
  sectionId: null,
  ...values,
});
const shown = (projection: ReturnType<typeof projectSidebar>) =>
  [
    ...(projection.standalone ? [projection.standalone] : []),
    ...projection.pinned,
    ...projection.sections.flatMap((section) => section.conversations),
    ...projection.ungrouped,
  ].map((item) => item.id);

test('hiding one Bot removes every private chat from desktop and mobile while shared groups remain visible', () => {
  const data = fixture();
  data.sidebarRoster!.entries = [preference('bot', 'chief', { hidden: true })];
  for (const mobile of [false, true]) {
    const view = projectSidebar(data, '', mobile);
    assert.deepEqual([...shown(view)].sort(), ['joint-work', 'research-chat', 'single-bot-group']);
    assert.equal(view.standalone, undefined);
    assert.equal(
      view.visible.some(
        (item) => item.agentIds.length === 1 && !item.isGroup && item.agentIds[0] === 'chief',
      ),
      false,
    );
  }
  assert.equal(isConversationHidden(data.conversations[0], data.sidebarRoster), true);
  assert.equal(isConversationHidden(data.conversations[1], data.sidebarRoster), true);
  assert.equal(isConversationHidden(data.conversations[4], data.sidebarRoster), false);
  assert.equal(data.primaryBot!.agentId, 'chief');
  assert.equal(
    data.primaryBot!.checkIn.enabled,
    true,
    'hiding only changes presentation, not the primary configuration',
  );
});

test('hidden-list counts unique targets and offers one representative chat for a hidden primary Bot', () => {
  const data = fixture();
  data.sidebarRoster!.entries = [
    preference('bot', 'chief', { hidden: true }),
    preference('conversation', 'joint-work', { hidden: true }),
  ];
  const hidden = projectSidebar(data).hidden;
  assert.equal(hidden.length, 2, 'two private chats of one Bot are one restore operation');
  const primary = hidden.find((item) => item.target.kind === 'bot' && item.target.id === 'chief')!;
  assert.equal(primary.conversation.id, 'chief-current');
  assert.equal(primary.primary, true);
  assert.equal(hidden.find((item) => item.target.kind === 'conversation')!.primary, false);
});

test('a missing or invalid primary Bot never gains a primary entry or hidden-primary badge', () => {
  for (const invalid of [
    'missing-agent',
    'unavailable',
    'group-conversation',
    'wrong-agent',
  ] as const) {
    const data = fixture();
    if (invalid === 'missing-agent')
      data.agents = data.agents.filter((item) => item.id !== 'chief');
    if (invalid === 'unavailable') data.primaryBot!.available = false;
    if (invalid === 'group-conversation') data.primaryBot!.conversationId = 'single-bot-group';
    if (invalid === 'wrong-agent') data.primaryBot!.conversationId = 'research-chat';
    const view = projectSidebar(data);
    assert.equal(view.primary, undefined, invalid);
    assert.equal(view.standalone, undefined, invalid);
  }
  const missing = fixture();
  missing.agents = missing.agents.filter((item) => item.id !== 'chief');
  missing.sidebarRoster!.entries = [preference('bot', 'chief', { hidden: true })];
  assert.equal(
    projectSidebar(missing).hidden.some((item) => item.primary),
    false,
    'a stale preference must not label a deleted Bot as the active primary',
  );
});

test('primary chat occupies exactly one rendered location when standalone, pinned or moved to a section', () => {
  const data = fixture();
  data.sidebarRoster!.sections = [{ id: 'section-a', name: '项目', collapsed: false }];
  for (const values of [
    {},
    { pinned: true },
    { sectionId: 'section-a' },
    { pinned: true, sectionId: 'section-a' },
  ]) {
    data.sidebarRoster!.entries = [preference('bot', 'chief', values)];
    const view = projectSidebar(data);
    assert.equal(shown(view).filter((id) => id === 'chief-current').length, 1);
    assert.equal(
      shown(view).length,
      data.conversations.length,
      'moving or pinning does not duplicate or discard other conversations',
    );
    if (values.pinned)
      assert.equal(
        view.pinned.some((item) => item.id === 'chief-current'),
        true,
      );
    else if (values.sectionId)
      assert.equal(
        view.sections[0].conversations.some((item) => item.id === 'chief-current'),
        true,
      );
    else assert.equal(view.standalone!.id, 'chief-current');
  }
});

test('pinning temporarily lifts a section member and unpinning returns it to its saved section', () => {
  const data = fixture();
  data.sidebarRoster!.sections = [{ id: 'section-a', name: '研究', collapsed: false }];
  data.sidebarRoster!.entries = [
    preference('bot', 'research', { pinned: true, sectionId: 'section-a' }),
  ];
  const pinned = projectSidebar(data);
  assert.deepEqual(
    pinned.pinned.map((item) => item.id),
    ['research-chat'],
  );
  assert.equal(pinned.sections[0].conversations.length, 0);
  assert.equal(
    conversationRosterEntry(data.conversations[2], data.sidebarRoster).sectionId,
    'section-a',
  );
  data.sidebarRoster!.entries[0].pinned = false;
  const returned = projectSidebar(data);
  assert.equal(returned.pinned.length, 0);
  assert.deepEqual(
    returned.sections[0].conversations.map((item) => item.id),
    ['research-chat'],
  );
});

test('search temporarily expands matching collapsed sections without saving collapse changes or surfacing hidden targets', () => {
  const data = fixture();
  data.sidebarRoster!.sections = [{ id: 'section-a', name: '资料', collapsed: true }];
  data.sidebarRoster!.entries = [
    preference('bot', 'research', { sectionId: 'section-a' }),
    preference('bot', 'chief', { hidden: true }),
  ];
  const before = structuredClone(data);
  const initial = projectSidebar(data);
  assert.equal(initial.sections[0].expanded, false);
  const searching = projectSidebar(data, 'RESEARCH');
  assert.equal(searching.sections[0].expanded, true);
  assert.deepEqual(
    searching.sections[0].conversations.map((item) => item.id),
    ['research-chat'],
  );
  assert.equal(shown(projectSidebar(data, '小欧')).includes('chief-current'), false);
  assert.equal(projectSidebar(data).sections[0].expanded, false);
  assert.deepEqual(data, before);
});

test('projection distinguishes unmatched search, all hidden conversations and an empty workspace', () => {
  const data = fixture();
  const unmatched = projectSidebar(data, '没有这个名字');
  assert.equal(unmatched.matchCount, 0);
  assert.ok(unmatched.visible.length > 0);
  assert.ok(unmatched.total > 0);
  data.sidebarRoster!.entries = [
    preference('bot', 'chief', { hidden: true }),
    preference('bot', 'research', { hidden: true }),
    preference('conversation', 'joint-work', { hidden: true }),
    preference('conversation', 'single-bot-group', { hidden: true }),
  ];
  const allHidden = projectSidebar(data);
  assert.equal(allHidden.matchCount, 0);
  assert.equal(allHidden.visible.length, 0);
  assert.equal(allHidden.total, 5);
  assert.equal(allHidden.hidden.length, 4);
  const empty = projectSidebar({
    agents: [],
    conversations: [],
    sidebarRoster: { revision: 'unset', entries: [], sections: [] },
  });
  assert.equal(empty.total, 0);
  assert.equal(empty.visible.length, 0);
  assert.equal(empty.hidden.length, 0);
  assert.equal(empty.matchCount, 0);
});

test('persisted per-user defaults override old shared pins; only old-server compatibility uses conversation pins', () => {
  const data = fixture(),
    chat = data.conversations[2];
  chat.pinned = true;
  assert.equal(conversationRosterEntry(chat).pinned, true);
  assert.equal(
    projectSidebar({ ...data, sidebarRoster: undefined }).pinned.some(
      (item) => item.id === chat.id,
    ),
    true,
  );
  const state: SidebarRosterState = {
    revision: 'saved-personal-revision',
    sections: [],
    entries: [],
  };
  assert.equal(conversationRosterEntry(chat, state).pinned, false);
  assert.equal(
    projectSidebar({ ...data, sidebarRoster: state }).pinned.some((item) => item.id === chat.id),
    false,
  );
});
