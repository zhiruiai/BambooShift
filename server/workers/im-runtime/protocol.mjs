import { createHash } from 'node:crypto';

export const providers = Object.freeze(['feishu', 'dingtalk', 'wecom']);
export function required(value, maximum = 256) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f]/.test(value)
  )
    throw Error('Invalid channel identifier');
  return value;
}
export function eventKey(event) {
  return createHash('sha256')
    .update(JSON.stringify([event.provider, event.accountId, event.messageId]))
    .digest('hex');
}
export function routeKey(value) {
  return JSON.stringify([value.accountId, value.senderId, value.chatId, value.threadId || '']);
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 30000) return;
  return value.trim();
}
// Inputs must originate from the authenticated official SDK connection, never a public JSON endpoint.
export function normalize(provider, accountId, frame, botId, now = Date.now()) {
  let event;
  if (provider === 'feishu') {
    const { sender, message: m } = frame;
    if (
      sender?.sender_type !== 'user' ||
      m?.message_type !== 'text' ||
      !['p2p', 'group'].includes(m.chat_type)
    )
      return;
    const content = JSON.parse(m.content);
    const mentioned = (m.mentions || []).filter((x) => x.id?.open_id === botId);
    let body = content.text;
    for (const item of mentioned) body = body?.replaceAll(item.key, '');
    event = {
      messageId: m.message_id,
      senderId: sender.sender_id?.open_id,
      chatId: m.chat_id,
      threadId: m.thread_id || m.root_id || '',
      group: m.chat_type === 'group',
      mentioned: mentioned.length > 0,
      text: text(body),
      createdAt: Number(m.create_time),
      reply: { messageId: m.message_id },
    };
  } else if (provider === 'dingtalk') {
    const m = JSON.parse(frame.data);
    if (m.msgtype !== 'text' || !['1', '2'].includes(m.conversationType)) return;
    event = {
      messageId: m.msgId,
      senderId: m.senderStaffId,
      chatId: m.conversationId,
      threadId: '',
      group: m.conversationType === '2',
      mentioned: m.isInAtList === true,
      text: text(m.text?.content),
      createdAt: Number(m.createAt),
      reply: { webhook: m.sessionWebhook, expires: Number(m.sessionWebhookExpiredTime) },
    };
  } else if (provider === 'wecom') {
    const m = frame.body;
    if (
      m?.msgtype !== 'text' ||
      m.aibotid !== botId ||
      !['single', 'group'].includes(m.chattype) ||
      (m.chattype === 'group' && !m.chatid)
    )
      return;
    // The official AI-bot stream delivers group callbacks only after a bot mention.
    event = {
      messageId: m.msgid,
      senderId: m.from?.userid,
      chatId: m.chattype === 'group' ? m.chatid : m.from?.userid,
      threadId: '',
      group: m.chattype === 'group',
      mentioned: m.chattype === 'group',
      text: text(m.text?.content),
      createdAt: m.create_time ? Number(m.create_time) * 1000 : now,
      reply: { headers: { req_id: required(frame.headers?.req_id) } },
    };
  } else throw Error('Unsupported IM provider');
  if (!event.text) return;
  for (const key of ['messageId', 'senderId', 'chatId']) required(event[key]);
  if (event.threadId) required(event.threadId);
  if (
    !Number.isFinite(event.createdAt) ||
    event.createdAt < now - 300000 ||
    event.createdAt > now + 60000
  )
    return;
  return Object.freeze({ ...event, provider, accountId: required(accountId) });
}
export function dingtalkReplyUrl(reply, now = Date.now()) {
  const url = new URL(reply.webhook);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'oapi.dingtalk.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/robot/send' ||
    url.hash ||
    !url.searchParams.get('session') ||
    !Number.isFinite(reply.expires) ||
    reply.expires <= now
  )
    throw Error('Invalid or expired DingTalk reply target');
  return url.href;
}
