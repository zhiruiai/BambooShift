import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../shared/types';
import { compile, harness, json, render } from './testSupport/appsFixture';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const action = {
  id: 'launch-request',
  agentId: 'bot-a',
  conversationId: 'conversation-a',
  type: 'desktop_ax_open',
  status: 'pending',
  createdAt: '2026-11-07T10:00:00Z',
  requester: { userId: 'member-a', name: 'Reader' },
  payload: { type: 'desktop_ax_open', bundleId: 'com.apple.textedit' },
  target: { app: 'TextEdit', bundleId: 'com.apple.TextEdit' },
  execution: {
    location: 'server',
    surface: 'accessibility',
    targetRevision: '33333333-3333-4333-8333-333333333333',
  },
};

function environment(locale = 'en') {
  return {
    Event,
    window: Object.assign(new EventTarget(), {
      location: { pathname: `/w/${workspaceId}/` },
      localStorage: { getItem: () => JSON.stringify({ version: 1, locale }) },
    }),
  };
}

function launchMessage(value: Record<string, unknown>): Message {
  return {
    id: 'message-a',
    conversationId: action.conversationId,
    threadRootId: 'thread-root',
    agentId: action.agentId,
    role: 'assistant',
    kind: 'computer',
    status: 'done',
    createdAt: action.createdAt,
    content: '电脑操作等待发起人批准。',
    metadata: { action: value },
  };
}

async function open(
  value: Record<string, unknown>,
  transport: typeof fetch = async () => json([]),
  locale = 'en',
) {
  const ui = await harness(
    'web/src/components/ChatComputerCard.tsx',
    'ApprovalHarness',
    {
      message: launchMessage(value),
      workspaceId,
      userId: action.requester.userId,
      owner: false,
      onChanged: async () => {},
      onOpenCurrentComputer() {},
    },
    transport,
    environment(locale),
    '\nfunction ApprovalHarness(props: any) { return ComputerRecord(props); }',
  );
  await ui.flush();
  return ui;
}

test('chat Mac launch reviews canonical app and bundle ID before approval and in its receipt', async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const completed = {
    ...action,
    status: 'done',
    result: { opened: true, identity: 'private-launch-identity', text: 'private-result' },
  };
  const ui = await open(action, async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return init?.method === 'GET' ? json([action]) : json(completed);
  });
  try {
    assert.match(ui.copy, /Open Mac app/);
    assert.match(ui.copy, /This Mac · Mac apps/);
    assert.match(ui.copy, /TextEdit · com.apple.TextEdit/);
    assert.equal(ui.button('Allow once').props.disabled, false);
    assert.deepEqual(calls, []);
    ui.button('Allow once').props.onClick();
    await ui.flush();
    const path = `/api/workspaces/${workspaceId}/computer/bots/bot-a/actions`;
    assert.deepEqual(calls, [
      { url: path, method: 'GET' },
      { url: `${path}/launch-request/approve`, method: 'POST' },
    ]);
    assert.match(ui.copy, /Completed/);
    assert.match(ui.copy, /TextEdit · com.apple.TextEdit/);
    assert.doesNotMatch(ui.copy, /private-launch-identity|private-result/);
    assert.equal(ui.maybeButton('Allow once'), undefined);
  } finally {
    ui.dispose();
  }
});

test('chat Mac launch disables approval when the canonical target is absent, invalid or mismatched', async () => {
  for (const target of [
    undefined,
    { app: 'TextEdit', bundleId: 'com.apple.TextEdit\n' },
    { app: 'Calculator', bundleId: 'com.apple.calculator' },
  ]) {
    const ui = await open({ ...action, target });
    try {
      assert.equal(ui.button('Allow once').props.disabled, true);
      assert.equal(ui.button('Deny').props.disabled, false);
      assert.match(ui.copy, /look up the installed app again/);
      assert.doesNotMatch(ui.copy, /com\.apple\./);
    } finally {
      ui.dispose();
    }
  }
});

test('computer activity lists the Mac launch review and hides internal fields in its localized receipt', async () => {
  const dialog = await compile(
    'web/src/components/computer/ComputerActionEntry.tsx',
    '',
    environment('zh-CN'),
  );
  const props = {
    owner: false,
    userId: action.requester.userId,
    busy: false,
    controlled: false,
    onApprove() {},
    onReject() {},
  };
  const html = render(dialog.ComputerActionEntry, {
    ...props,
    action: { ...action, status: 'done', result: { text: 'private-result' } },
  });
  assert.match(html, /打开 Mac 应用/);
  assert.match(html, /TextEdit · com.apple.TextEdit/);
  assert.match(html, /已完成/);
  assert.doesNotMatch(html, /private-result|允许本次操作/);
});
