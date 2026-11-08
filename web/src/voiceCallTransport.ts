import type { Message } from '../../shared/types';
import { ApiError } from './api';
import type { FixedWorkspaceApi } from './fixedWorkspaceApi';

export type CallTarget = {
  workspaceId: string;
  userId: string;
  conversationId: string;
  agentId: string;
};
export type VoiceCall = Omit<CallTarget, 'workspaceId'> & {
  id: string;
  startedAt: string;
  expiresAt: string;
  endedAt?: string;
};

export const validVoiceCallId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

const time = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

export function voiceCallRecord(value: unknown, target: CallTarget, id: string): VoiceCall {
  const call = value as Partial<VoiceCall> | undefined;
  if (
    !call ||
    call.id !== id ||
    !validVoiceCallId(id) ||
    call.userId !== target.userId ||
    call.agentId !== target.agentId ||
    call.conversationId !== target.conversationId ||
    !time(call.startedAt) ||
    !time(call.expiresAt) ||
    Date.parse(call.expiresAt) < Date.parse(call.startedAt) ||
    (call.endedAt !== undefined && !time(call.endedAt))
  )
    throw new Error('VOICE_CALL_RESPONSE');
  return call as VoiceCall;
}

export function unknownVoiceWrite(error: unknown): boolean {
  return (
    !(error instanceof ApiError) ||
    error.status === 0 ||
    error.status === 408 ||
    error.status >= 500
  );
}

export function createVoiceCallTransport(api: FixedWorkspaceApi, target: CallTarget) {
  const path = `/conversations/${encodeURIComponent(target.conversationId)}`;
  const calls = `${path}/voice-calls`;
  const read = async (id: string) =>
    voiceCallRecord((await api<{ call: VoiceCall }>(`${calls}/${id}`)).call, target, id);
  return {
    read,
    async start(id: string) {
      try {
        return voiceCallRecord(
          (await api<{ call: VoiceCall }>(calls, 'POST', { id })).call,
          target,
          id,
        );
      } catch (error) {
        if (!unknownVoiceWrite(error)) throw error;
        // A missing response cannot authorize creation of a replacement call.
        return read(id);
      }
    },
    async end(id: string) {
      await api(`${calls}/${id}/end`, 'POST', {});
    },
    async send(callId: string, clientId: string, content: string) {
      const { message } = await api<{ message: Message }>(`${path}/messages`, 'POST', {
        clientId,
        content,
        mode: 'followUp',
        voiceCallId: callId,
      });
      return message;
    },
  };
}

export function voiceReceipt(message: Message, call: VoiceCall, clientId: string): boolean {
  return (
    message.role === 'user' &&
    message.userId === call.userId &&
    message.conversationId === call.conversationId &&
    message.metadata?.voiceCallId === call.id &&
    message.delivery?.clientId === clientId
  );
}

export function voiceReply(message: Message, call: VoiceCall, inputId: string): boolean {
  return (
    message.role === 'assistant' &&
    message.agentId === call.agentId &&
    message.conversationId === call.conversationId &&
    message.metadata?.voiceCallId === call.id &&
    message.metadata?.inputMessageId === inputId &&
    message.metadata?.voiceCallTerminal === true &&
    !message.metadata?.delegation &&
    (message.kind === undefined || message.kind === 'text') &&
    (message.status === 'done' || message.status === 'error')
  );
}

export function voiceTranscript(
  messages: Message[],
  call: Pick<VoiceCall, 'id' | 'conversationId' | 'userId'> & { agentId?: string },
) {
  const sameCall = (message: Message) =>
    message.conversationId === call.conversationId &&
    message.metadata?.voiceCallId === call.id &&
    !message.threadRootId &&
    (message.kind === undefined || message.kind === 'text') &&
    !!message.content.trim();
  const human = (message: Message) => message.role === 'user' && message.userId === call.userId;
  const inputs = new Map(
    messages
      .filter((message) => sameCall(message) && human(message))
      .map((message) => [message.id, message.delivery?.agentId]),
  );
  return messages.filter(
    (message) =>
      sameCall(message) &&
      (human(message) ||
        (message.role === 'assistant' &&
          !!message.agentId &&
          message.status === 'done' &&
          message.metadata?.voiceCallTerminal === true &&
          !message.metadata.delegation &&
          typeof message.metadata.inputMessageId === 'string' &&
          inputs.has(message.metadata.inputMessageId) &&
          message.agentId === (call.agentId || inputs.get(message.metadata.inputMessageId)))),
  );
}
