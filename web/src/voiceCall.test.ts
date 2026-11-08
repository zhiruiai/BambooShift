import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../shared/types';
import { ApiError } from './api';
import { createVoiceCallController, idleVoiceCall } from './voiceCall';
import { createVoiceSegmenter } from './voiceCallCapture';
import { createVoiceCallTransport, voiceTranscript } from './voiceCallTransport';
import type { FixedWorkspaceApi } from './fixedWorkspaceApi';

const target = { workspaceId: 'w', conversationId: 'c', userId: 'u', agentId: 'a' };
const id = '53fac6cf-a42a-4740-8d36-a7702340d431';
const record = {
  ...target,
  id,
  startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const wait = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(options: { unknown?: boolean; late?: boolean } = {}) {
  let selected = target;
  let state = idleVoiceCall();
  let captureCount = 0;
  let emit: ((audio: Promise<Blob>) => void) | undefined;
  let ready!: () => void;
  const listening: boolean[] = [];
  const requests: Array<{ path: string; method?: string; body?: any }> = [];
  const spoken: Message[] = [];
  let playing: AbortSignal | undefined;
  let playbackDone: ((success: boolean) => void) | undefined;
  let closed = 0;
  const api: FixedWorkspaceApi = async (path, method, body) => {
    requests.push({ path, method, body });
    if (path.endsWith('/voice-calls')) return { call: record } as never;
    if (path.endsWith('/end')) return {} as never;
    if (options.unknown) throw new ApiError('Uncertain', 503);
    return { message: human() } as never;
  };
  function human(): Message {
    const sent = requests.filter((request) => request.path.endsWith('/messages'));
    const request = sent.at(-1)?.body;
    return {
      id: `input-${sent.length}`,
      role: 'user',
      content: 'A question',
      userId: target.userId,
      conversationId: target.conversationId,
      createdAt: record.startedAt,
      metadata: { voiceCallId: id },
      delivery: { mode: 'followUp', state: 'delivered', clientId: request.clientId },
    };
  }
  function assistant(input: Message, extra: Partial<Message> = {}): Message {
    return {
      id: `reply-${input.id}`,
      role: 'assistant',
      status: 'done',
      agentId: target.agentId,
      conversationId: target.conversationId,
      createdAt: record.startedAt,
      content: 'A response',
      metadata: { voiceCallId: id, inputMessageId: input.id, voiceCallTerminal: true },
      ...extra,
    };
  }
  let counter = 0;
  const controller = createVoiceCallController({
    id: () => (counter++ === 0 ? id : `turn-${counter}`),
    target: () => selected,
    capture(audio) {
      captureCount++;
      emit = audio;
      return {
        ready: options.late
          ? new Promise<void>((resolve) => {
              ready = resolve;
            })
          : Promise.resolve(),
        listen: (active) => listening.push(active),
        close: () => {
          closed++;
        },
      };
    },
    transcribe: async () => 'A question',
    speak: (reply, signal) => {
      spoken.push(reply);
      playing = signal;
      return new Promise<boolean>((resolve) => {
        playbackDone = resolve;
      });
    },
    refresh: () => {},
    onState: (next) => {
      state = next;
    },
  });
  return {
    controller,
    requests,
    spoken,
    human,
    assistant,
    listening,
    captureCount: () => captureCount,
    state: () => state,
    closed: () => closed,
    start: () => controller.start(target, createVoiceCallTransport(api, target)),
    resolveCapture: () => ready(),
    finishPlayback: () => playbackDone?.(true),
    interrupted: () => playing?.aborted,
    speak: () => emit!(Promise.resolve(new Blob([new Uint8Array(48)], { type: 'audio/wav' }))),
    switchChat: () => {
      selected = { ...target, conversationId: 'other' };
    },
  };
}

test('one microphone capture serves two spoken turns, with scoped interruption and local cleanup', async () => {
  const f = fixture();
  await f.start();
  assert.equal(f.state().phase, 'listening');
  f.controller.mute();
  f.speak();
  assert.equal(f.requests.length, 1);
  assert.equal(f.listening.at(-1), false);
  f.controller.mute();
  f.speak();
  await wait();
  const first = f.human();
  f.controller.receive([first, f.assistant(first, { agentId: 'other' })]);
  f.controller.receive([
    first,
    f.assistant(first, { metadata: { ...f.assistant(first).metadata, voiceCallTerminal: false } }),
  ]);
  assert.equal(f.state().phase, 'waiting');
  f.controller.receive([first, f.assistant(first)]);
  assert.equal(f.state().phase, 'speaking');
  assert.equal(f.listening.at(-1), false);
  f.controller.resume();
  assert.equal(f.interrupted(), true);
  assert.equal(f.state().phase, 'listening');
  f.speak();
  await wait();
  const second = f.human();
  f.controller.receive([first, f.assistant(first), second, f.assistant(second)]);
  f.finishPlayback();
  await wait();
  assert.equal(f.state().phase, 'listening');
  assert.deepEqual(
    f.spoken.map((message) => message.id),
    ['reply-input-1', 'reply-input-2'],
  );
  assert.equal(f.captureCount(), 1);
  await f.controller.end();
  assert.equal(f.closed(), 1);
  assert.equal(f.state().phase, 'idle');
  assert.ok(f.requests.at(-1)?.path.endsWith('/end'));
  assert.ok(!f.requests.some((request) => request.path.endsWith('/stop')));
});

test('uncertain message POST is reconciled with the same receipt and never retransmitted', async () => {
  const f = fixture({ unknown: true });
  await f.start();
  f.speak();
  await wait();
  const input = f.human();
  f.controller.receive([{ ...input, userId: 'other' }, f.assistant(input)]);
  assert.equal(f.spoken.length, 0);
  f.controller.receive([input, f.assistant(input)]);
  assert.equal(f.spoken.length, 1);
  assert.equal(f.requests.filter((request) => request.path.endsWith('/messages')).length, 1);
  assert.deepEqual(
    voiceTranscript([input, f.assistant(input), { ...input, userId: 'other' }], record).map(
      (message) => message.id,
    ),
    [input.id, f.assistant(input).id],
  );
  await f.controller.end();
});

test('closing before late microphone permission cannot start a server call', async () => {
  const f = fixture({ late: true });
  const opening = f.start();
  f.switchChat();
  await f.controller.end();
  f.resolveCapture();
  await opening;
  assert.equal(f.closed(), 1);
  assert.equal(f.requests.length, 0);
});

test('a lost start response reads the exact server call instead of creating another', async () => {
  const paths: string[] = [];
  const api: FixedWorkspaceApi = async (path, method = 'GET') => {
    paths.push(`${method} ${path}`);
    if (method === 'POST') throw new ApiError('Lost response', 0);
    return { call: record } as never;
  };
  assert.deepEqual(await createVoiceCallTransport(api, target).start(id), record);
  assert.deepEqual(paths, [
    'POST /conversations/c/voice-calls',
    `GET /conversations/c/voice-calls/${id}`,
  ]);
});

test('bounded segmentation ignores ambient silence and emits one clip after trailing silence', () => {
  const clips: Float32Array[] = [];
  const segmenter = createVoiceSegmenter(16000, (samples) => clips.push(samples));
  const part = (volume: number, count: number) => {
    for (let index = 0; index < count; index++) segmenter.push(new Float32Array(1600).fill(volume));
  };
  part(0.001, 25);
  assert.equal(clips.length, 0);
  part(0.2, 6);
  part(0, 10);
  assert.equal(clips.length, 1);
  assert.ok(clips[0].length < 16000 * 2);
  part(0.2, 2);
  segmenter.reset();
  part(0, 10);
  assert.equal(clips.length, 1);
});
