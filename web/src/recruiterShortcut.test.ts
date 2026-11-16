import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bootstrap, Conversation } from '../../shared/types';
import { emptyComposer, type ComposerState } from './chatDrafts';
import { createChatSendScope } from './chatSendScope';
import { bot, composerFixture } from './testSupport/composerCommandsFixture';
import { harness } from './testSupport/creationFlowFixture';
import { replaceCommand } from './workspace/composerCommands';
import { recruiterMentionToken } from './workspace/recruiterMention';
import type { RecruiterShortcut } from './workspace/useRecruiterShortcut';

test('recruiter aliases keep their full token and reject ordinary words and addresses', () => {
  for (const alias of ['@招聘助理', '@AI 同事招募员', '@Recruiter', '@AI Staff Recruiter']) {
    const draft = `Review: ${alias} please find a QA specialist`;
    const end = 'Review: '.length + alias.length;
    const token = recruiterMentionToken(draft, end, end);
    assert.equal(token?.value, alias);
    assert.equal(replaceCommand(draft, token!)?.text, 'Review:  please find a QA specialist');
  }
  const multiword = '@AI 同事招募员 新项目';
  assert.equal(recruiterMentionToken(multiword, 3, 3)?.value, '@AI 同事招募员');
  for (const draft of [
    'someone@recruiter',
    'https://example.test/@Recruiter',
    '@RecruiterName',
    '@',
  ]) {
    assert.equal(recruiterMentionToken(draft, draft.length, draft.length), undefined);
  }
});

test('owner selects recruiter navigation without changing the source or group recipient', async () => {
  const f = await composerFixture({ draft: '需要测试同事 @AI 同事招募员' });
  const briefs: string[] = [];
  const recruiter = {
    pending: false,
    async open(brief: string) {
      briefs.push(brief.trim());
    },
  };
  try {
    await f.change({ recruiter, conversation: { ...f.props.conversation, isGroup: true } });
    await f.focus();
    assert.ok(f.option('打开单聊'));
    assert.equal(f.input().props['aria-activedescendant'], 'mention-option-recruiter-navigation');
    assert.equal((await f.key('Enter')).prevented, true);
    assert.deepEqual(briefs, ['需要测试同事']);
    assert.equal(f.props.draft, '需要测试同事 @AI 同事招募员');
    assert.equal(f.props.currentComposer.mentions, undefined);
    assert.equal(f.props.currentComposer.replyTo?.id, 'quoted');
    assert.equal(f.calls.includes('send'), false);

    await f.change({ recruiter: { ...recruiter, pending: true } });
    assert.ok(f.option('正在打开单聊').props['aria-disabled']);
    await f.key('Enter');
    assert.equal(briefs.length, 1);
    assert.equal(f.calls.includes('send'), false);

    await f.change({ canManage: false });
    assert.equal(f.option('招聘助理'), undefined);
    await f.type('@As');
    assert.ok(f.option('Aster'));
  } finally {
    f.dispose();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => (resolve = complete));
  return { promise, resolve };
}

const source: Conversation = {
  id: 'chat-a',
  title: 'Current project',
  agentIds: ['bot-a'],
  isGroup: true,
  updatedAt: '',
  unread: 0,
  pinned: false,
};
const agent = { ...bot, id: 'recruiter-a', name: 'AI Staff Recruiter', role: 'Recruiter' };
const conversation = {
  ...source,
  id: 'recruiter-chat',
  title: agent.name,
  agentIds: [agent.id],
  isGroup: false,
};
const response = { agentId: agent.id, conversationId: conversation.id, agent, conversation };

async function recruiterFixture(
  request: () => Promise<unknown>,
  sourceDraft = { ...emptyComposer(), text: 'Need a QA specialist @Recruiter' },
  destination = emptyComposer(),
  entry: 'composer' | 'create' = 'composer',
) {
  const identity = { workspaceId: 'workspace-a', userId: 'owner-a' };
  const sendScope = createChatSendScope({
    ...identity,
    identity: () => identity,
    locationWorkspace: () => identity.workspaceId,
  });
  sendScope.resume();
  const calls: unknown[][] = [];
  const drafts = { [source.id]: sourceDraft, [conversation.id]: destination };
  let snapshot = { agents: [bot], conversations: [source] } as Bootstrap;
  let toast = '';
  const selected = entry === 'create' ? '' : source.id;
  const selectedRef = { current: selected };
  const composerKeyRef = { current: selected };
  let model = {
    selected,
    selectedRef,
    conversation: entry === 'create' ? undefined : source,
    composerKey: selected,
    composerKeyRef,
    currentComposer: sourceDraft,
    canManage: true,
    modal: entry === 'create' ? 'create' : null,
    navigationScope: 'owner-a:workspace-a',
    sendScope,
    async api(...args: unknown[]) {
      calls.push(args);
      return request();
    },
    sync: { written: () => calls.push(['written']) },
    setData(update: (previous: Bootstrap) => Bootstrap) {
      snapshot = update(snapshot);
    },
    setToast(update: string | ((previous: string) => string)) {
      const next = typeof update === 'string' ? update : update(toast);
      if (next !== toast) calls.push(['toast', (toast = next)]);
    },
    setModal(value: string | null) {
      calls.push(['modal', value]);
    },
    openConversation(value: Conversation) {
      calls.push(['open', value.id]);
    },
    updateComposer(id: string, update: (previous: ComposerState) => ComposerState) {
      drafts[id] = update(drafts[id]);
    },
    async refresh() {
      calls.push(['refresh']);
    },
  };
  const ui = await harness(
    'web/src/workspace/useRecruiterShortcut.ts',
    'useRecruiterShortcut',
    { model, entry },
    {
      window: {
        localStorage: { getItem: () => JSON.stringify({ version: 1, locale: 'en' }) },
      },
    },
  );
  await ui.flush();
  return {
    ui,
    calls,
    drafts,
    snapshot: () => snapshot,
    shortcut: () => ui.tree as RecruiterShortcut,
    async navigate(value: Conversation) {
      selectedRef.current = composerKeyRef.current = value.id;
      model = { ...model, selected: value.id, composerKey: value.id, conversation: value };
      ui.setProps({ model });
      await ui.flush();
    },
    async closeCreate() {
      model = { ...model, modal: null };
      ui.setProps({ model });
      await ui.flush();
    },
    switchIdentity() {
      identity.userId = 'different-owner';
    },
    dispose() {
      ui.dispose();
      sendScope.suspend();
    },
  };
}

test('opens the scoped direct chat once and copies only a plain unsent brief', async () => {
  const receipt = deferred<typeof response>();
  const f = await recruiterFixture(() => receipt.promise);
  try {
    const opening = f.shortcut().open(' Need a QA specialist ');
    await f.ui.flush();
    assert.equal(f.shortcut().pending, true);
    await f.shortcut().open('Repeated');
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
      ['/recruiter', 'POST', { locale: 'en' }],
    ]);
    receipt.resolve(response);
    await opening;
    await f.ui.flush();
    assert.deepEqual(f.calls.slice(1), [['written'], ['open', conversation.id], ['refresh']]);
    assert.equal(f.drafts[source.id].text, 'Need a QA specialist @Recruiter');
    assert.equal(f.drafts[conversation.id].text, 'Need a QA specialist');
    assert.ok(f.snapshot().agents.some((item) => item.id === agent.id));
    assert.ok(f.snapshot().conversations.some((item) => item.id === conversation.id));
    assert.equal(f.shortcut().pending, false);
  } finally {
    f.dispose();
  }
});

test('preserves existing destination drafts and leaves contextual text in its source', async () => {
  for (const caseName of ['destination', 'quotation']) {
    const saved = { ...emptyComposer(), text: 'Existing recruiter draft' };
    const contextual = {
      ...emptyComposer(),
      text: 'From this source',
      ...(caseName === 'quotation'
        ? { replyTo: { id: 'quote', author: 'Aster', content: 'Source', kind: 'text' as const } }
        : {}),
    };
    const destination = caseName === 'destination' ? saved : emptyComposer();
    const f = await recruiterFixture(async () => response, contextual, destination);
    try {
      await f.shortcut().open('Brief');
      assert.equal(f.drafts[source.id], contextual);
      assert.equal(f.drafts[conversation.id], destination);
      assert.ok(f.calls.some(([action]) => action === 'open'));
    } finally {
      f.dispose();
    }
  }
});

test('late recruiter response cannot navigate after changing source or account', async () => {
  for (const reason of ['source', 'account']) {
    const receipt = deferred<typeof response>();
    const f = await recruiterFixture(() => receipt.promise);
    try {
      const opening = f.shortcut().open('Brief');
      if (reason === 'source') {
        await f.navigate({ ...source, id: 'chat-b' });
        await f.navigate(source);
      } else f.switchIdentity();
      receipt.resolve(response);
      await opening;
      assert.equal(f.calls.length, 1);
      assert.equal(f.drafts[conversation.id].text, '');
    } finally {
      f.dispose();
    }
  }
});

test('an invalid receipt offers retry without opening or changing a draft', async () => {
  let attempts = 0;
  const f = await recruiterFixture(async () =>
    attempts++ === 0 ? { ...response, conversation: { ...conversation, isGroup: true } } : response,
  );
  try {
    await f.shortcut().open('Brief');
    await f.ui.flush();
    assert.equal(f.shortcut().pending, false);
    assert.equal(f.calls[1]?.[0], 'toast');
    assert.equal(f.drafts[conversation.id].text, '');
    await f.shortcut().open('Brief');
    assert.ok(f.calls.some(([action]) => action === 'open'));
    assert.ok(f.calls.some(([action, message]) => action === 'toast' && message === ''));
    assert.equal(attempts, 2);
  } finally {
    f.dispose();
  }
});

test('the creation entry opens a verified recruiter even without a selected chat', async () => {
  for (const closeWhileLoading of [false, true]) {
    const receipt = deferred<typeof response>();
    const f = await recruiterFixture(
      () => receipt.promise,
      emptyComposer(),
      emptyComposer(),
      'create',
    );
    try {
      const opening = f.shortcut().open('The create form stays local');
      if (closeWhileLoading) await f.closeCreate();
      receipt.resolve(response);
      await opening;
      assert.deepEqual(
        f.calls.slice(1),
        closeWhileLoading
          ? []
          : [['written'], ['open', conversation.id], ['modal', null], ['refresh']],
      );
      assert.equal(f.drafts[conversation.id].text, '');
    } finally {
      f.dispose();
    }
  }
});
