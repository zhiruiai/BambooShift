import type { Message } from '../../shared/types';
import { ApiError } from './api';
import type { CallCapture } from './voiceCallCapture';
import {
  type CallTarget,
  type VoiceCall,
  createVoiceCallTransport,
  unknownVoiceWrite,
  voiceReceipt,
  voiceReply,
} from './voiceCallTransport';

type Phase =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'transcribing'
  | 'waiting'
  | 'speaking'
  | 'paused'
  | 'ending';
type CallError =
  | 'microphone'
  | 'denied'
  | 'noMicrophone'
  | 'unavailable'
  | 'unconfirmed'
  | 'busy'
  | 'reply'
  | 'playback'
  | 'ended';
export type VoiceCallState = { phase: Phase; muted: boolean; error?: CallError; call?: VoiceCall };
type Session = {
  id: string;
  target: CallTarget;
  transport: ReturnType<typeof createVoiceCallTransport>;
  capture?: CallCapture;
  call?: VoiceCall;
  starting?: Promise<VoiceCall>;
  turn?: { clientId: string; messageId?: string };
  abort: AbortController;
  playback?: AbortController;
  expiry?: ReturnType<typeof setTimeout>;
  confirmation?: ReturnType<typeof setTimeout>;
};

export const idleVoiceCall = (): VoiceCallState => ({ phase: 'idle', muted: false });
const sameTarget = (left: CallTarget, right?: CallTarget) =>
  !!right &&
  left.workspaceId === right.workspaceId &&
  left.userId === right.userId &&
  left.conversationId === right.conversationId &&
  left.agentId === right.agentId;

export function createVoiceCallController(options: {
  target(): CallTarget | undefined;
  capture: (audio: (value: Promise<Blob>) => void, failed: (error: unknown) => void) => CallCapture;
  transcribe(audio: Blob, signal: AbortSignal, userId: string, callId: string): Promise<string>;
  speak(reply: Message, signal: AbortSignal): Promise<boolean>;
  refresh(): void;
  onState(state: VoiceCallState): void;
  id?(): string;
}) {
  let state = idleVoiceCall(),
    session: Session | undefined;
  let closing = false;
  const id = options.id || (() => crypto.randomUUID());
  const current = (item: Session) =>
    session === item && !item.abort.signal.aborted && sameTarget(item.target, options.target());
  const publish = (next: VoiceCallState) => {
    state = next;
    session?.capture?.listen(next.phase === 'listening' && !next.muted);
    options.onState(next);
  };
  const phase = (value: Phase, error?: CallError) => publish({ ...state, phase: value, error });

  function pause(item: Session, error: CallError) {
    if (!current(item)) return;
    clearTimeout(item.confirmation);
    item.turn = undefined;
    phase('paused', error);
  }

  function armExpiry(item: Session, call: VoiceCall) {
    clearTimeout(item.expiry);
    const duration = Date.parse(call.expiresAt) - Date.now();
    if (call.endedAt || duration <= 0) {
      void end('ended');
      return false;
    }
    item.expiry = setTimeout(() => {
      if (!current(item)) return;
      void item.transport
        .read(item.id)
        .then((renewed) => {
          if (current(item)) armExpiry(item, renewed);
        })
        .catch(() => {
          if (current(item)) void end('ended');
        });
    }, duration);
    return true;
  }

  async function end(error?: CallError) {
    const item = session;
    if (!item) return;
    session = undefined;
    item.abort.abort();
    item.playback?.abort();
    item.capture?.close();
    clearTimeout(item.expiry);
    clearTimeout(item.confirmation);
    if (item.call || item.starting) {
      closing = true;
      publish({ phase: 'ending', muted: false, error });
      try {
        const call = item.call || (await item.starting);
        if (call && !call.endedAt) await item.transport.end(item.id);
        if (sameTarget(item.target, options.target())) options.refresh();
      } catch {
        // The server also expires abandoned calls. Captured audio has already stopped.
      } finally {
        closing = false;
      }
    }
    if (!session) publish({ ...idleVoiceCall(), error });
  }

  function handleReceipt(item: Session, message: Message) {
    const turn = item.turn;
    if (!current(item) || !item.call || !turn || !voiceReceipt(message, item.call, turn.clientId))
      return;
    clearTimeout(item.confirmation);
    if (message.delivery?.state === 'cancelled' || message.delivery?.state === 'interrupted') {
      pause(item, 'reply');
      return;
    }
    if (!turn.messageId) {
      turn.messageId = message.id;
      phase('waiting');
    }
  }

  async function utterance(item: Session, audio: Promise<Blob>) {
    if (!current(item) || !item.call || state.phase !== 'listening' || state.muted) {
      void audio.catch(() => {});
      return;
    }
    phase('transcribing');
    let text: string;
    try {
      const blob = await audio;
      if (!current(item)) return;
      text = await options.transcribe(blob, item.abort.signal, item.target.userId, item.id);
    } catch (error) {
      if (!current(item)) return;
      if (error instanceof ApiError && error.status === 422) phase('listening');
      else if (
        error instanceof ApiError &&
        ['VOICE_CALL_ENDED', 'VOICE_CALL_NOT_FOUND'].includes(error.code || '')
      )
        void end('ended');
      else pause(item, 'unavailable');
      return;
    }
    if (!current(item)) return;
    const turn = { clientId: id(), messageId: undefined as string | undefined };
    item.turn = turn;
    phase('waiting');
    try {
      handleReceipt(item, await item.transport.send(item.id, turn.clientId, text));
    } catch (error) {
      if (!current(item) || item.turn !== turn || turn.messageId) return;
      if (!unknownVoiceWrite(error)) {
        const code = error instanceof ApiError ? error.code : undefined;
        if (code === 'VOICE_CALL_ENDED' || code === 'VOICE_CALL_NOT_FOUND') void end('ended');
        else pause(item, code === 'VOICE_CALL_BUSY' ? 'busy' : 'unavailable');
        return;
      }
    }
    if (!current(item) || item.turn !== turn || turn.messageId) return;
    options.refresh();
    item.confirmation = setTimeout(() => {
      if (current(item) && item.turn === turn && !turn.messageId) void end('unconfirmed');
    }, 10_000);
  }

  async function speak(item: Session, message: Message) {
    if (!current(item)) return;
    item.turn = undefined;
    if (message.status === 'error' || !message.content.trim()) {
      pause(item, 'reply');
      return;
    }
    const playback = new AbortController();
    item.playback = playback;
    phase('speaking');
    let played = false;
    try {
      played = await options.speak(message, playback.signal);
    } catch {
      /* Playback can fail independently. */
    }
    if (!current(item) || item.playback !== playback) return;
    item.playback = undefined;
    if (played) phase('listening');
    else pause(item, 'playback');
  }

  return {
    async start(target: CallTarget, transport: ReturnType<typeof createVoiceCallTransport>) {
      if (session || closing || !sameTarget(target, options.target())) return;
      const item: Session = { id: id(), target, transport, abort: new AbortController() };
      session = item;
      publish({ phase: 'connecting', muted: false });
      try {
        item.capture = options.capture(
          (audio) => void utterance(item, audio),
          () => {
            if (current(item)) void end('microphone');
          },
        );
        await item.capture.ready;
      } catch (error) {
        if (!current(item)) return;
        const name = error instanceof Error ? error.name : '';
        void end(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'denied'
            : name === 'NotFoundError'
              ? 'noMicrophone'
              : 'microphone',
        );
        return;
      }
      if (!current(item)) return;
      try {
        item.starting = transport.start(item.id);
        const call = await item.starting;
        if (!current(item)) return;
        item.call = call;
        if (armExpiry(item, call)) publish({ ...state, phase: 'listening', call });
      } catch (error) {
        if (current(item))
          void end(
            error instanceof ApiError && error.code === 'VOICE_CALL_ACTIVE'
              ? 'busy'
              : 'unavailable',
          );
      }
    },
    receive(messages: Message[]) {
      const item = session;
      if (!item || !current(item) || !item.call || !item.turn) return;
      for (const message of messages) handleReceipt(item, message);
      const inputId = item.turn?.messageId;
      if (!inputId) return;
      const reply = messages.findLast((message) => voiceReply(message, item.call!, inputId));
      if (reply) void speak(item, reply);
    },
    end,
    mute() {
      if (session && current(session)) publish({ ...state, muted: !state.muted });
    },
    resume() {
      const item = session;
      if (!item || !current(item) || (state.phase !== 'paused' && state.phase !== 'speaking'))
        return;
      item.playback?.abort();
      item.playback = undefined;
      phase('listening');
    },
  };
}
