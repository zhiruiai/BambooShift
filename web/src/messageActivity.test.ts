import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../shared/types';
import { all, harness, text } from './testSupport/creationFlowFixture';

const instruction = `${'Synthetic instruction to review a report. '.repeat(40)}\nSecond line <script>literal text</script>`;
const handoff: Message = {
  id: 'activity-one',
  conversationId: 'group-chat',
  agentId: 'target',
  role: 'system',
  kind: 'activity',
  createdAt: '2026-11-07T00:00:00.000Z',
  content: instruction,
  delivery: { state: 'queued', mode: 'followUp', agentId: 'target' },
  metadata: { delegation: { sourceAgentId: 'source', targetAgentId: 'target' } },
};
const agents = [
  { id: 'source', name: 'Aster' },
  { id: 'target', name: 'Birch' },
];

async function activity(message: Message, locale = 'en', targetName?: string) {
  const ui = await harness(
    'web/src/components/MessageActivity.tsx',
    'MessageActivity',
    {
      message,
      agents,
      targetName,
    },
    { window: { localStorage: { getItem: () => JSON.stringify({ version: 1, locale }) } } },
  );
  await ui.flush();
  const summary = () => text(all(ui.tree, (node) => node.type === 'summary')[0]);
  const detail = () =>
    text(all(ui.tree, (node) => node.props?.className === 'message-activity-details')[0]);
  return { ui, summary, detail };
}

test('delegation starts collapsed, preserves the complete plain-text instruction, and marks an admitted handoff accurately', async () => {
  const a = await activity(handoff);
  try {
    assert.equal(a.ui.tree.type, 'details');
    assert.equal(a.ui.tree.props.open, undefined);
    assert.equal(a.summary(), 'Aster → BirchQueued');
    assert.equal(a.detail(), instruction);
    assert.equal(all(a.ui.tree, (node) => node.type === 'script').length, 0);
    a.ui.setProps({
      message: { ...handoff, delivery: { ...handoff.delivery, state: 'delivered' } },
    });
    await a.ui.flush();
    assert.equal(a.summary(), 'Aster → BirchHanded off');
    assert.equal(a.ui.tree.props['data-tone'], 'neutral');
    assert.equal(a.detail(), instruction);
  } finally {
    a.ui.dispose();
  }
});

test('private delegation projection uses the latest persisted status and body', async () => {
  const projection = {
    ...handoff,
    role: 'assistant',
    delivery: undefined,
    metadata: { ...handoff.metadata, delegationProjection: true },
  } as const;
  const a = await activity({ ...projection, status: 'running' });
  try {
    assert.equal(a.summary(), 'Aster → BirchWorking');
    assert.equal(a.detail(), instruction);
    a.ui.setProps({ message: { ...projection, status: 'done', content: 'Synthetic result' } });
    await a.ui.flush();
    assert.equal(a.summary(), 'Aster → BirchComplete');
    assert.equal(a.detail(), 'Synthetic result');
    a.ui.setProps({ message: { ...projection, status: 'error', content: 'Synthetic reason' } });
    await a.ui.flush();
    assert.equal(a.summary(), 'Aster → BirchCompletion unconfirmed');
    assert.equal(a.ui.tree.props['data-tone'], 'error');
    assert.equal(a.detail(), 'Synthetic reason');
  } finally {
    a.ui.dispose();
  }
});

test('Chinese labels and cancellation details stay separate from the collapsed row', async () => {
  const a = await activity(
    {
      ...handoff,
      delivery: {
        ...handoff.delivery!,
        state: 'cancelled',
        reason: 'Synthetic cancellation reason',
      },
    },
    'zh-CN',
    'Historical Birch',
  );
  try {
    a.ui.setProps({ agents: [] });
    await a.ui.flush();
    assert.equal(a.summary(), '委派给 Historical Birch已取消');
    assert.match(a.detail(), /Synthetic cancellation reason$/);
    assert.equal(a.ui.tree.props['data-tone'], 'error');
  } finally {
    a.ui.dispose();
  }
});

test('generic activity does not claim a handoff and check-ins expose no internal execution prompt', async () => {
  const a = await activity({
    ...handoff,
    status: 'running',
    delivery: undefined,
    metadata: { delegation: { sourceAgentId: 'source', targetAgentId: 'other' } },
  });
  try {
    assert.equal(a.summary(), 'ActivityWorking');
    a.ui.setProps({
      message: {
        ...handoff,
        delivery: undefined,
        content: '',
        metadata: { primaryCheckIn: { id: 'check-in-one' } },
        executionPrompt: 'Synthetic internal prompt',
      },
    });
    await a.ui.flush();
    assert.equal(a.ui.tree.type, 'div');
    assert.equal(a.ui.copy, 'Daily check-in');
  } finally {
    a.ui.dispose();
  }
});
