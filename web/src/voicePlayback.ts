import type { Bootstrap, Message } from '../../shared/types';
import { createLocalSpeech, type LocalSpeechState } from './localSpeech';
import type { createVoicePreferences, VoiceIdentity } from './voicePreferences';

export type VoiceContext = {
  conversationId: string;
  agentId?: string;
  enabled: boolean;
  blocked: boolean;
};
export const voiceContextKey = (context: VoiceContext) =>
  `${context.conversationId}:${context.agentId || ''}`;
export function canReadMessage(message: Message) {
  return (
    message.role === 'assistant' &&
    message.status === 'done' &&
    (message.kind === undefined || message.kind === 'text') &&
    !!message.content.trim() &&
    !message.metadata?.executionStatus &&
    !message.metadata?.teamProposal &&
    !message.metadata?.botTemplate
  );
}
const completionKey = (message: Message) =>
  canReadMessage(message) &&
  typeof message.metadata?.runId === 'string' &&
  !message.metadata.delegation
    ? `${message.agentId}:${message.metadata.runId}`
    : undefined;

export function createVoicePlayback(options: {
  identity: VoiceIdentity;
  preferences: ReturnType<typeof createVoicePreferences>;
  context: () => VoiceContext;
  current: () => boolean;
  synthesis?: SpeechSynthesis;
  utterance?: (text: string) => SpeechSynthesisUtterance;
}) {
  const listeners = new Set<() => void>(),
    messages = new Map<string, Message>(),
    seen = new Set<string>();
  let active = false,
    ready = false,
    session: string | undefined,
    playingContext: string | undefined;
  let speechState: LocalSpeechState = {
    voices: [],
    supported: !!options.synthesis && !!options.utterance,
  };
  let snapshot = { ...options.preferences.getSnapshot(), ...speechState, armed: false };
  const valid = () => active && options.current();
  const publish = () => {
    snapshot = { ...options.preferences.getSnapshot(), ...speechState, armed: !!session };
    listeners.forEach((listener) => listener());
  };
  const speech = createLocalSpeech({
    synthesis: options.synthesis,
    utterance: options.utterance,
    current: () =>
      valid() &&
      options.context().enabled &&
      !options.context().blocked &&
      voiceContextKey(options.context()) === playingContext,
    onChange: (state) => {
      speechState = state;
      publish();
    },
  });
  const read = (message: Message) => {
    const context = options.context();
    if (
      !valid() ||
      !context.enabled ||
      context.blocked ||
      message.conversationId !== context.conversationId ||
      !canReadMessage(message)
    )
      return false;
    playingContext = voiceContextKey(context);
    return speech.speak({
      id: message.id,
      text: message.content,
      ...options.preferences.getSnapshot(),
      language: /[\u3400-\u9fff]/.test(message.content) ? 'zh-CN' : 'en',
    });
  };
  function stop() {
    session = undefined;
    speech.stop();
    publish();
  }
  let unsubscribe: (() => void) | undefined;
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    baseline(data: Bootstrap) {
      if (!valid()) return;
      messages.clear();
      data.messages.forEach((message) => {
        messages.set(message.id, message);
        const key = completionKey(message);
        if (key) seen.add(key);
      });
      ready = true;
    },
    receive(message: Message) {
      if (!valid()) return;
      messages.set(message.id, message);
      const key = completionKey(message);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const context = options.context(),
        settings = options.preferences.getSnapshot();
      if (
        !ready ||
        !settings.autoRead ||
        !session ||
        session !== voiceContextKey(context) ||
        message.agentId !== context.agentId ||
        speechState.speakingId
      )
        return;
      const inputId = message.metadata?.inputMessageId;
      const input = typeof inputId === 'string' ? messages.get(inputId) : undefined;
      if (input?.role !== 'user' || input.userId !== options.identity.userId) return;
      read(message);
    },
    read,
    stop,
    stopReading: speech.stop,
    arm() {
      const context = options.context();
      if (
        !valid() ||
        !context.enabled ||
        context.blocked ||
        !context.agentId ||
        !speechState.supported ||
        !speechState.voices.length
      )
        return;
      options.preferences.update({ autoRead: true });
      session = voiceContextKey(context);
      publish();
    },
    update(value: Parameters<typeof options.preferences.update>[0]) {
      if (!valid()) return;
      speech.stop();
      options.preferences.update(value);
      if (value.autoRead === false) stop();
    },
    refresh() {
      if (valid()) speech.refresh();
    },
    suspend() {
      active = false;
      ready = false;
      stop();
      speech.suspend();
      unsubscribe?.();
      unsubscribe = undefined;
    },
    resume() {
      active = true;
      speech.resume();
      unsubscribe?.();
      unsubscribe = options.preferences.subscribe(() => {
        stop();
      });
    },
  };
}
