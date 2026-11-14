import { expandPureViews } from './testSupport/expandPureViews';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotAgent, Conversation, Message } from '../../shared/types';
import { composerModelConfigured } from './workspace/composerModel';
import { agent } from './testSupport/creationFlowFixture';

const lead: BotAgent = {
  ...agent,
  id: 'lead',
  name: 'Lead',
  modelConfigured: true,
  modelProfileId: 'configured-choice',
};
const peer: BotAgent = {
  ...agent,
  id: 'peer',
  name: 'Researcher',
  modelConfigured: false,
  modelProfileId: 'missing-choice',
};
const group: Conversation = {
  id: 'synthetic-group',
  title: 'Synthetic group',
  agentIds: [lead.id, peer.id],
  isGroup: true,
  updatedAt: '2030-01-01T00:00:00Z',
  unread: 0,
  pinned: false,
};

test('the composer uses the dispatch leader rather than global Bot order or workspace default', () => {
  assert.equal(composerModelConfigured({}, [peer, lead], group, false), true);
  assert.equal(composerModelConfigured({ agentId: peer.id }, [lead, peer], group, true), false);
  const direct = { ...group, isGroup: false, agentIds: [lead.id] };
  assert.equal(composerModelConfigured({}, [lead], direct, false), true);
  assert.equal(composerModelConfigured({ agentId: 'outside' }, [lead], direct, true), false);
});

test('explicit model failure is not replaced by a configured default and older records inherit', () => {
  assert.equal(composerModelConfigured({}, [peer], { ...group, agentIds: [peer.id] }, true), false);
  const legacy = { ...agent, id: lead.id };
  assert.equal(composerModelConfigured({}, [legacy], group, true), true);
  assert.equal(composerModelConfigured({}, [legacy], group, false), false);
});

test('mentioned recipients each need an available model, while shared Bots use the execution default', () => {
  assert.equal(
    composerModelConfigured({ mentions: { agentIds: [lead.id] } }, [peer, lead], group, false),
    true,
  );
  assert.equal(
    composerModelConfigured({ mentions: { agentIds: [peer.id] } }, [peer, lead], group, true),
    false,
  );
  assert.equal(
    composerModelConfigured({ mentions: { everyone: true } }, [peer, lead], group, true),
    false,
  );
  const shared = {
    ...lead,
    sharedBot: { shareId: 'synthetic-share', status: 'active' },
  } as BotAgent;
  assert.equal(composerModelConfigured({}, [shared], group, false), false);
  assert.equal(
    composerModelConfigured({}, [{ ...shared, modelConfigured: false }], group, true),
    true,
  );
});

const chatMessage = (patch: Partial<Message>): Message => ({
  id: 'synthetic-message',
  conversationId: group.id,
  role: 'assistant',
  content: 'Synthetic reply',
  createdAt: group.updatedAt,
  ...patch,
});

test('reply routing uses the author Bot before the conversation leader and checks membership', () => {
  const reply = chatMessage({ agentId: peer.id });
  const draft = { replyTo: { id: reply.id, author: peer.name, content: reply.content } };
  assert.equal(
    composerModelConfigured(draft, [lead, peer], group, true, { messages: [reply] }),
    false,
  );
  assert.equal(
    composerModelConfigured(draft, [lead, peer], group, true, {
      messages: [{ ...reply, agentId: 'former-member' }],
    }),
    true,
  );
  assert.equal(
    composerModelConfigured({ ...draft, agentId: lead.id }, [lead, peer], group, true, {
      messages: [reply],
    }),
    true,
  );
});

test('legacy text mentions follow stored Bot order and take priority over replies', () => {
  const reply = chatMessage({ agentId: lead.id });
  const draft = {
    text: `Please ask @${peer.name} for a review`,
    replyTo: { id: reply.id, author: lead.name, content: reply.content },
  };
  assert.equal(
    composerModelConfigured(draft, [lead, peer], group, true, { messages: [reply] }),
    false,
  );
  assert.equal(
    composerModelConfigured({ text: `@${lead.name} @${peer.name}` }, [peer, lead], group, true),
    false,
  );
  assert.equal(
    composerModelConfigured(
      { ...draft, mentions: { agentIds: [lead.id] } },
      [lead, peer],
      group,
      false,
    ),
    true,
  );
});

test('thread replies use the root author or its delivered recipient, not the group leader', () => {
  const root = chatMessage({
    id: 'synthetic-root',
    role: 'user',
    delivery: { state: 'delivered', mode: 'followUp', agentId: peer.id },
  });
  const context = { threadRootId: root.id, messages: [root] };
  assert.equal(composerModelConfigured({}, [lead, peer], group, true, context), false);
  assert.equal(
    composerModelConfigured({}, [lead, peer], group, true, {
      ...context,
      messages: [{ ...root, role: 'assistant', agentId: lead.id }],
    }),
    true,
  );
  assert.equal(
    composerModelConfigured({}, [lead, peer], group, true, {
      threadRootId: 'unavailable-root',
    }),
    undefined,
  );
});

test('an unknown live group recipient hides the optional setup hint and other threads do not interfere', () => {
  const root = chatMessage({ id: 'synthetic-root', role: 'user' });
  const context = {
    messages: [root],
    threadRootId: root.id,
    runningRequests: [{ conversationId: group.id, threadRootId: root.id }],
  };
  assert.equal(composerModelConfigured({}, [lead, peer], group, false, context), undefined);
  assert.equal(
    composerModelConfigured({ agentId: peer.id }, [lead, peer], group, true, context),
    false,
  );
  assert.equal(
    composerModelConfigured({}, [lead, peer], group, false, {
      ...context,
      threadRootId: undefined,
    }),
    true,
  );
  assert.equal(
    composerModelConfigured({}, [peer], { ...group, agentIds: [peer.id], isGroup: false }, true, {
      runningRequests: [{ conversationId: group.id }],
    }),
    false,
  );
});

test('unresolved active routing is not rendered as missing model configuration', async () => {
  const { compile, all } = await import('./testSupport/botProfilesFixture');
  const { ComposerModelNoticeView } = await compile('web/src/workspace/ComposerModelNotice.tsx');
  for (const canManage of [true, false]) {
    const view = ComposerModelNoticeView({ configured: undefined, canManage, onConfigure() {} });
    assert.equal(all(view, (node) => node.props?.className === 'setup-note').length, 0);
  }
});

test('the rendered composer and voice-memo entry follow this Bot even when another model is configured', async () => {
  const { compile, all } = await import('./testSupport/botProfilesFixture');
  const { ChatComposer } = await compile('web/src/workspace/ChatComposer.tsx');
  for (const configured of [true, false]) {
    const bot = { ...lead, modelConfigured: configured };
    const view = expandPureViews(
      ChatComposer({
        conversation: { ...group, isGroup: false, agentIds: [bot.id] },
        lead: bot,
        members: [bot],
        selected: group.id,
        account: { workspace: { kind: 'personal', role: 'owner' } },
        data: { settings: { configured: !configured }, skills: [], voiceMemo: { available: true } },
        currentComposer: { text: '', attachments: [], mode: 'steer' },
        sendErrors: {},
        sending: new Set(),
        uploading: new Set(),
        attachments: [],
        draft: '',
        canManage: true,
        receipts: { pending: () => 0 },
        dictation: { busy: false },
        voice: {},
      }),
    );
    assert.equal(
      all(view, (node) => node.props?.className === 'setup-note').length,
      configured ? 0 : 1,
    );
    assert.equal(
      all(view, (node) => node.type?.name === 'VoiceMemoRequest').length,
      configured ? 1 : 0,
    );
  }
});
