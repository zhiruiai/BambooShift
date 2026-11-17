import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, eventKey, dingtalkReplyUrl } from './protocol.mjs';
import { validateConfig } from './config.mjs';
import { createBridge } from './bridge.mjs';
import { openLedger } from './ledger.mjs';

export const binding = {
  senderId: 'sender',
  chatId: 'chat',
  threadId: '',
  allowGroup: false,
  workspaceId: 'workspace',
  userId: 'user',
  conversationId: 'conversation',
  agentId: 'agent',
  sessionEnv: 'BAMBOO_SESSION',
};
export function config(provider) {
  return validateConfig({
    version: 1,
    origin: 'http://127.0.0.1:3000',
    accounts: [
      {
        id: 'account',
        provider,
        clientId: 'bot',
        botId: 'bot',
        secretEnv: 'IM_SECRET',
        bindings: [binding],
      },
    ],
  });
}
export function fixture(provider, now = Date.now()) {
  if (provider === 'feishu')
    return {
      sender: { sender_type: 'user', sender_id: { open_id: 'sender' } },
      message: {
        message_type: 'text',
        message_id: 'message',
        chat_id: 'chat',
        chat_type: 'p2p',
        create_time: String(now),
        content: JSON.stringify({ text: 'check data' }),
      },
    };
  if (provider === 'dingtalk')
    return {
      headers: { messageId: 'frame' },
      data: JSON.stringify({
        msgtype: 'text',
        msgId: 'message',
        senderStaffId: 'sender',
        conversationId: 'chat',
        conversationType: '1',
        createAt: now,
        text: { content: 'check data' },
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?session=synthetic',
        sessionWebhookExpiredTime: now + 60000,
      }),
    };
  return {
    headers: { req_id: 'frame' },
    body: {
      aibotid: 'bot',
      msgid: 'message',
      msgtype: 'text',
      chattype: 'single',
      from: { userid: 'sender' },
      text: { content: 'check data' },
      create_time: Math.floor(now / 1000),
    },
  };
}
for (const provider of ['feishu', 'dingtalk', 'wecom'])
  test(
    provider + ' authenticated receive → explicit identity → same-channel reply, persistent dedup',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bambooshift-im-'));
      let ledger = openLedger(dir),
        calls = [],
        releases = [];
      const c = config(provider);
      if (provider === 'wecom') c.accounts[0].bindings = [{ ...binding, chatId: 'sender' }];
      const event = normalize(provider, 'account', fixture(provider), 'bot');
      const controller = new AbortController();
      const options = {
        config: c,
        ledger,
        signal: controller.signal,
        authorize: async (b) => assert.equal(b.userId, 'user'),
        dispatch: async (b, text, id) => {
          calls.push({ b, text, id });
          return '10 rows; 2 duplicates';
        },
        reply: async (e, content) => releases.push({ e, content }),
      };
      const bridge = createBridge(options);
      assert.equal(bridge.accept({ ...event, senderId: 'stranger' }), false);
      assert.equal(bridge.accept(event), true);
      assert.equal(bridge.accept(event), false);
      await bridge.drain();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].b.conversationId, 'conversation');
      assert.equal(releases[0].e.reply, event.reply);
      assert.match(releases[0].content, /duplicates/);
      ledger.close();
      ledger = openLedger(dir);
      assert.equal(createBridge({ ...options, ledger }).accept(event), false);
      assert.equal(eventKey(event), calls[0].id.slice(3));
      ledger.close();
      await rm(dir, { recursive: true });
    },
  );
test('group/thread/account isolation and no inherited owner binding', () => {
  const c = config('feishu');
  const event = normalize('feishu', 'account', fixture('feishu'), 'bot');
  const bridge = createBridge({
    config: c,
    ledger: {
      claim: () => {
        throw Error('Must reject before admission');
      },
    },
    signal: new AbortController().signal,
  });
  for (const changed of [
    { accountId: 'other' },
    { chatId: 'other' },
    { threadId: 'other' },
    { provider: 'wecom' },
    { group: true, mentioned: true },
  ])
    assert.equal(bridge.accept({ ...event, ...changed }), false);
  const copied = structuredClone(c);
  copied.accounts.push({ ...copied.accounts[0], id: 'other' });
  assert.throws(() => validateConfig(copied), /separate dedicated/);
});
test('cancel/revocation/unknown send do not retry or expose credentials', async () => {
  for (const scenario of ['cancel', 'revoke', 'unknown']) {
    const dir = await mkdtemp(join(tmpdir(), 'bambooshift-im-')),
      ledger = openLedger(dir);
    const controller = new AbortController(),
      reports = [];
    let sent = 0,
      checks = 0;
    const bridge = createBridge({
      config: config('feishu'),
      ledger,
      signal: controller.signal,
      report: (r) => reports.push(r),
      authorize: async () => {
        if (++checks === 2 && scenario === 'revoke') throw Error('secret-session-value');
      },
      dispatch: async () => {
        if (scenario === 'cancel') controller.abort();
        return 'result';
      },
      reply: async () => {
        sent++;
        throw Error('secret-session-value');
      },
    });
    const event = normalize('feishu', 'account', fixture('feishu'), 'bot');
    bridge.accept(event);
    await bridge.drain();
    assert.equal(sent, scenario === 'unknown' ? 1 : 0);
    assert.equal(bridge.accept(event), false);
    assert.doesNotMatch(JSON.stringify(reports), /secret-session/);
    ledger.close();
    await rm(dir, { recursive: true });
  }
});
test('reject stale/bot events and arbitrary or expired reply URLs', () => {
  const now = Date.now(),
    raw = fixture('feishu', now - 600000);
  assert.equal(normalize('feishu', 'account', raw, 'bot', now), undefined);
  raw.sender.sender_type = 'app';
  assert.equal(normalize('feishu', 'account', raw, 'bot', now), undefined);
  for (const webhook of [
    'http://oapi.dingtalk.com/robot/send?session=x',
    'https://evil.test/robot/send?session=x',
    'https://oapi.dingtalk.com:444/robot/send?session=x',
    'https://oapi.dingtalk.com/other?session=x',
  ])
    assert.throws(() => dingtalkReplyUrl({ webhook, expires: now + 1000 }, now));
  assert.throws(() =>
    dingtalkReplyUrl(
      { webhook: 'https://oapi.dingtalk.com/robot/send?session=x', expires: now - 1 },
      now,
    ),
  );
});

test('dedicated CLI suppresses SDK console arguments and restores host console', async () => {
  const { shieldSdkConsole } = await import('./diagnostics.mjs');
  const previous = console.warn,
    reports = [];
  const restore = shieldSdkConsole((value) => reports.push(value));
  try {
    console.warn('private-session-cookie', {
      secret: 'private-secret',
      url: 'https://private.invalid',
    });
  } finally {
    restore();
  }
  assert.equal(console.warn, previous);
  assert.deepEqual(reports, [{ status: 'sdk-diagnostic', level: 'warn' }]);
});

test('same identity runs serially with bounded queue and cancellation discards waiting work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'im-queue-')),
    ledger = openLedger(dir);
  const controller = new AbortController(),
    calls = [],
    reports = [];
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const bridge = createBridge({
    config: config('feishu'),
    ledger,
    signal: controller.signal,
    authorize: async () => {},
    report: (value) => reports.push(value),
    dispatch: async (_binding, text) => {
      calls.push(text);
      await hold;
      return 'done';
    },
    reply: async () => {},
  });
  const base = normalize('feishu', 'account', fixture('feishu'), 'bot');
  for (let i = 0; i < 4; i++)
    assert.equal(bridge.accept({ ...base, messageId: 'event-' + i, text: String(i) }), true);
  assert.equal(bridge.accept({ ...base, messageId: 'overflow' }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['0']);
  controller.abort();
  release();
  await bridge.drain();
  assert.deepEqual(calls, ['0']);
  assert.ok(reports.some((x) => x.status === 'capacity-reached'));
  ledger.close();
  await rm(dir, { recursive: true });
});
