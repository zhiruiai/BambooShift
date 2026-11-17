import { normalize, dingtalkReplyUrl } from './protocol.mjs';
import { resolveSecret } from './config.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
function safeReply(value, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw Error('Empty channel reply');
  if (Buffer.byteLength(value) <= maximum) return value;
  let bytes = 0,
    content = '';
  for (const char of value) {
    const next = Buffer.byteLength(char);
    if (bytes + next > maximum - 3) break;
    content += char;
    bytes += next;
  }
  return content + '…';
}
export async function createSdkAdapter(
  account,
  accept,
  { env = process.env, load = (name) => import(name), fetcher = fetch, report = () => {} } = {},
) {
  const secret = resolveSecret(account.secretEnv, env);
  const receive = (frame) => {
    try {
      return accept(
        normalize(account.provider, account.id, frame, account.botId || account.clientId),
      );
    } catch {
      report({ accountId: account.id, status: 'invalid-event' });
      return false;
    }
  };
  if (account.provider === 'feishu') {
    const sdk = await load('@larksuiteoapi/node-sdk');
    const options = { appId: account.clientId, appSecret: secret, logger: quiet };
    const api = new sdk.Client(options),
      socket = new sdk.WSClient(options);
    return {
      start: () =>
        socket.start({
          eventDispatcher: new sdk.EventDispatcher({}).register({
            'im.message.receive_v1': receive,
          }),
        }),
      close: () => socket.close(),
      reply: async (event, content, signal) => {
        signal.throwIfAborted();
        const result = await api.im.message.reply({
          path: { message_id: event.reply.messageId },
          data: {
            content: JSON.stringify({ text: safeReply(content, 18000) }),
            msg_type: 'text',
            reply_in_thread: Boolean(event.threadId),
          },
        });
        if (result.code !== 0) throw Error('Feishu reply not confirmed');
      },
    };
  }
  if (account.provider === 'dingtalk') {
    const sdk = await load('dingtalk-stream');
    const client = new sdk.DWClient({
      clientId: account.clientId,
      clientSecret: secret,
      debug: false,
    });
    client.registerCallbackListener(sdk.TOPIC_ROBOT, (frame) => {
      receive(frame);
      // ACK receipt after local admission; unknown deliveries remain in the private ledger.
      client.socketCallBackResponse(frame.headers.messageId, { status: 'SUCCESS' });
    });
    return {
      start: () => client.connect(),
      close: () => client.disconnect(),
      reply: async (event, content, signal) => {
        const url = dingtalkReplyUrl(event.reply);
        const token = await client.getAccessToken();
        signal.throwIfAborted();
        const response = await fetcher(url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
          body: JSON.stringify({ msgtype: 'text', text: { content: safeReply(content, 18000) } }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw Error('DingTalk reply not confirmed');
        const result = await response.json();
        if (result.errcode !== 0) throw Error('DingTalk reply rejected');
      },
    };
  }
  if (account.provider === 'wecom') {
    const sdk = await load('@wecom/aibot-node-sdk');
    const WSClient = sdk.WSClient || sdk.default?.WSClient;
    const client = new WSClient({ botId: account.clientId, secret, logger: quiet });
    client.on('message.text', receive);
    client.on('error', () => report({ accountId: account.id, status: 'connection-error' }));
    return {
      start: () => client.connect(),
      close: () => client.disconnect(),
      reply: async (event, content, signal) => {
        signal.throwIfAborted();
        await client.replyStream(
          event.reply,
          'bambooshift-' + event.messageId,
          safeReply(content, 20000),
          true,
        );
      },
    };
  }
  throw Error('Unsupported channel SDK');
}
