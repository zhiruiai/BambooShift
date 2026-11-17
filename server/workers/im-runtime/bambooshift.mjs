import { setTimeout as wait } from 'node:timers/promises';
import { resolveSecret } from './config.mjs';

export function createBambooShiftClient(
  origin,
  { env = process.env, fetcher = fetch, interval = 1000 } = {},
) {
  async function request(binding, path, body, signal) {
    const response = await fetcher(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        Origin: origin,
        Cookie: resolveSecret(binding.sessionEnv, env),
        'X-OpenBot-Expected-User': binding.userId,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw Error('BambooShift session or operation unavailable');
    let bytes = 0,
      chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) throw Error('BambooShift response exceeded limit');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const base = (b) => '/api/workspaces/' + encodeURIComponent(b.workspaceId);
  async function authorize(binding, signal) {
    const session = await request(binding, '/api/account/session', undefined, signal);
    if (
      !session.authenticated ||
      session.user?.id !== binding.userId ||
      !session.workspaces?.some((w) => w.id === binding.workspaceId)
    )
      throw Error('Bound user is no longer authorized');
  }
  async function dispatch(binding, content, clientId, signal) {
    await authorize(binding, signal);
    const boot = await request(binding, base(binding) + '/bootstrap', undefined, signal);
    const chat = boot.conversations?.find((c) => c.id === binding.conversationId);
    if (
      !chat ||
      chat.isGroup ||
      chat.agentIds?.length !== 1 ||
      chat.agentIds[0] !== binding.agentId ||
      boot.runningConversationIds?.includes(chat.id)
    )
      throw Error('Dedicated channel conversation is unavailable or busy');
    const submit = await request(
      binding,
      base(binding) + '/conversations/' + encodeURIComponent(chat.id) + '/messages',
      { content, clientId, agentId: binding.agentId, mode: 'followUp' },
      signal,
    );
    const inputId = submit.message?.id;
    if (!inputId) throw Error('BambooShift submission was not confirmed');
    for (let tick = 0; tick < 180; tick++) {
      signal.throwIfAborted();
      const current = await request(binding, base(binding) + '/bootstrap', undefined, signal);
      const replies = current.messages?.filter(
        (m) =>
          m.conversationId === chat.id &&
          m.role === 'assistant' &&
          m.agentId === binding.agentId &&
          m.metadata?.inputMessageId === inputId &&
          m.kind === 'text',
      );
      const answer = replies?.findLast(
        (m) => m.status === 'done' && typeof m.content === 'string' && m.content.trim(),
      );
      if (answer) return answer.content;
      if (replies?.some((m) => m.status === 'error' || m.status === 'stopped'))
        throw Error('BambooShift task did not finish');
      await wait(interval, undefined, { signal });
    }
    // Do not cancel by conversation ID: another task may have started meanwhile.
    throw Error('BambooShift result not confirmed; inspect the original conversation');
  }
  return { authorize, dispatch };
}
