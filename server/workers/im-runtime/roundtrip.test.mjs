import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBambooShiftClient } from './bambooshift.mjs';
import { createSdkAdapter } from './sdk-adapters.mjs';
import { createBridge } from './bridge.mjs';
import { openLedger } from './ledger.mjs';
import { validateConfig } from './config.mjs';

const binding = {
  senderId: 'sender',
  chatId: 'chat',
  allowGroup: false,
  workspaceId: 'workspace',
  userId: 'user',
  conversationId: 'conversation',
  agentId: 'agent',
  sessionEnv: 'BAMBOO_SESSION',
};
function sdkFixture(provider, sent) {
  let callback;
  class Client {
    constructor() {
      this.im = {
        message: {
          reply: async (data) => {
            sent.push(data);
            return { code: 0 };
          },
        },
      };
    }
    on(name, fn) {
      if (name === 'message.text') callback = fn;
    }
    start({ eventDispatcher }) {
      callback = eventDispatcher.handler;
    }
    registerCallbackListener(_topic, fn) {
      callback = fn;
    }
    connect() {}
    disconnect() {}
    close() {}
    socketCallBackResponse() {}
    getAccessToken() {
      return 'synthetic-token';
    }
    replyStream(...args) {
      sent.push(args);
    }
  }
  class EventDispatcher {
    register(events) {
      this.handler = events['im.message.receive_v1'];
      return this;
    }
  }
  const sdk = {
    Client,
    WSClient: Client,
    DWClient: Client,
    EventDispatcher,
    TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
  };
  const now = Date.now();
  const frames = {
    feishu: {
      sender: { sender_type: 'user', sender_id: { open_id: 'sender' } },
      message: {
        message_type: 'text',
        message_id: 'incoming',
        chat_id: 'chat',
        chat_type: 'p2p',
        create_time: String(now),
        content: '{"text":"Analyze the data"}',
      },
    },
    dingtalk: {
      headers: { messageId: 'frame' },
      data: JSON.stringify({
        msgtype: 'text',
        msgId: 'incoming',
        senderStaffId: 'sender',
        conversationId: 'chat',
        conversationType: '1',
        createAt: now,
        text: { content: 'Analyze the data' },
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?session=fixture',
        sessionWebhookExpiredTime: now + 60000,
      }),
    },
    wecom: {
      headers: { req_id: 'request' },
      body: {
        aibotid: 'bot',
        msgid: 'incoming',
        msgtype: 'text',
        chattype: 'single',
        from: { userid: 'sender' },
        text: { content: 'Analyze the data' },
      },
    },
  };
  return { sdk, emit: () => callback(frames[provider]) };
}
for (const provider of ['feishu', 'dingtalk', 'wecom'])
  test(
    provider + ' SDK → BambooShift authenticated HTTP contract → exact response target',
    async () => {
      let posted,
        sessionChecks = 0,
        authorized = true;
      const paths = [];
      const server = createServer(async (req, res) => {
        assert.equal(req.headers.cookie, 'synthetic-session-cookie');
        assert.equal(req.headers['x-openbot-expected-user'], 'user');
        paths.push(req.method + ' ' + req.url);
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/account/session') {
          sessionChecks++;
          res.end(
            JSON.stringify({
              authenticated: authorized,
              user: { id: 'user' },
              workspaces: [{ id: 'workspace' }],
            }),
          );
        } else if (req.url.endsWith('/messages')) {
          let text = '';
          for await (const chunk of req) text += chunk;
          posted = JSON.parse(text);
          res.statusCode = 202;
          res.end('{"message":{"id":"input"}}');
        } else {
          res.end(
            JSON.stringify({
              conversations: [{ id: 'conversation', isGroup: false, agentIds: ['agent'] }],
              runningConversationIds: [],
              messages: posted
                ? [
                    {
                      id: 'reply',
                      role: 'assistant',
                      conversationId: 'conversation',
                      agentId: 'agent',
                      kind: 'text',
                      status: 'done',
                      content: 'Checked: 10 rows, 2 duplicates.',
                      metadata: { inputMessageId: 'input' },
                    },
                    {
                      role: 'assistant',
                      conversationId: 'conversation',
                      agentId: 'agent',
                      kind: 'text',
                      status: 'done',
                      content: 'UNRELATED PRIVATE TASK',
                      metadata: { inputMessageId: 'another-input' },
                    },
                  ]
                : [],
            }),
          );
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const dir = await mkdtemp(join(tmpdir(), 'im-roundtrip-')),
        ledger = openLedger(dir);
      const sent = [],
        controller = new AbortController();
      const account = {
        id: 'account',
        provider,
        clientId: 'bot',
        botId: 'bot',
        secretEnv: 'IM_SECRET',
        bindings: [{ ...binding, ...(provider === 'wecom' ? { chatId: 'sender' } : {}) }],
      };
      const config = validateConfig({
        version: 1,
        origin: 'http://127.0.0.1:' + server.address().port,
        accounts: [account],
      });
      const env = {
        BAMBOO_SESSION: 'synthetic-session-cookie',
        IM_SECRET: 'synthetic-platform-secret',
      };
      const client = createBambooShiftClient(config.origin, { env, interval: 1 });
      let adapter;
      const bridge = createBridge({
        config,
        ledger,
        ...client,
        signal: controller.signal,
        reply: (...args) => adapter.reply(...args),
      });
      const fixture = sdkFixture(provider, sent);
      try {
        adapter = await createSdkAdapter(account, bridge.accept, {
          env,
          load: async () => fixture.sdk,
          fetcher: async (url, options) => {
            sent.push({ url, options });
            return new Response('{"errcode":0}');
          },
        });
        await adapter.start();
        fixture.emit();
        await bridge.drain();
        assert.equal(sent.length, 1);
        assert.match(JSON.stringify(sent), /10 rows/);
        assert.doesNotMatch(JSON.stringify(sent), /UNRELATED PRIVATE/);
        assert.equal(posted.mode, 'followUp');
        assert.equal(posted.agentId, 'agent');
        assert.equal(posted.content, 'Analyze the data');
        assert.ok(sessionChecks >= 3);
        assert.equal(paths.filter((p) => p.startsWith('POST')).length, 1);
        if (provider === 'feishu') assert.equal(sent[0].path.message_id, 'incoming');
        if (provider === 'wecom') assert.equal(sent[0][0].headers.req_id, 'request');
        if (provider === 'dingtalk')
          assert.equal(sent[0].url, 'https://oapi.dingtalk.com/robot/send?session=fixture');
        fixture.emit();
        await bridge.drain();
        assert.equal(sent.length, 1);
        authorized = false;
        await assert.rejects(client.authorize(binding, controller.signal));
      } finally {
        controller.abort();
        await adapter?.close();
        ledger.close();
        server.close();
        await rm(dir, { recursive: true });
      }
    },
  );
