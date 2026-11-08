import { uiText } from './i18n';
import { SPEECH_LIMITS } from '../../shared/speech';

export const SPEECH_SECONDS = SPEECH_LIMITS.maxSeconds;
export const SPEECH_RATE = 16000;
export const SPEECH_BYTES = SPEECH_LIMITS.maxBytes;

export function encodeSpeechWav(samples: Float32Array): Blob {
  if (!samples.length || samples.length > SPEECH_SECONDS * SPEECH_RATE)
    throw new Error(uiText('common:text_1a195ff3ff68'));
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SPEECH_RATE, true);
  view.setUint32(28, SPEECH_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export async function resampleSpeech(
  samples: Float32Array,
  inputRate: number,
  offline = (length: number) => new OfflineAudioContext(1, length, SPEECH_RATE),
): Promise<Blob> {
  if (
    !Number.isFinite(inputRate) ||
    inputRate < 8000 ||
    inputRate > 192000 ||
    !samples.length ||
    samples.length > inputRate * SPEECH_SECONDS
  )
    throw new Error(uiText('common:text_c24af2c0c3b2'));
  if (inputRate === SPEECH_RATE) return encodeSpeechWav(samples);
  const length = Math.min(
    SPEECH_SECONDS * SPEECH_RATE,
    Math.ceil((samples.length * SPEECH_RATE) / inputRate),
  );
  const context = offline(length);
  const buffer = context.createBuffer(1, samples.length, inputRate);
  buffer.copyToChannel(new Float32Array(samples), 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  source.disconnect();
  return encodeSpeechWav(rendered.getChannelData(0));
}

export function audioSupportError(): string {
  if (typeof window === 'undefined' || !window.isSecureContext)
    return uiText('common:text_9462c1309b11');
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof AudioContext === 'undefined' ||
    typeof AudioWorkletNode === 'undefined' ||
    typeof OfflineAudioContext === 'undefined'
  )
    return uiText('common:text_d614b4b97f24');
  return '';
}
export function audioError(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return uiText('common:text_6e91a142818d');
  if (name === 'NotFoundError') return uiText('common:text_b1301111ce3c');
  if (name === 'NotReadableError') return uiText('common:text_5a5946ad5491');
  return error instanceof Error ? error.message : uiText('common:text_28895e9a289f');
}

export type AudioRecorder = { start(): Promise<void>; finish(): Promise<Blob>; cancel(): void };
export type RecorderCallbacks = {
  onTime(ms: number): void;
  onLimit(): void;
  onError(error: Error): void;
};
export type RecorderEnvironment = {
  getMedia(): Promise<MediaStream>;
  context(): AudioContext;
  node(context: AudioContext): AudioWorkletNode;
  convert(samples: Float32Array, inputRate: number): Promise<Blob>;
};

/** Each instance owns one capture. Cancellation also disposes a late permission grant. */
export function createAudioRecorder(
  callbacks: RecorderCallbacks,
  environment?: RecorderEnvironment,
): AudioRecorder {
  const env = environment || {
    getMedia: () =>
      navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false }),
    context: () => new AudioContext(),
    node: (context: AudioContext) =>
      new AudioWorkletNode(context, 'openbot-pcm-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { maxFrames: Math.floor(context.sampleRate * SPEECH_SECONDS) },
      }),
    convert: resampleSpeech,
  };
  let context: AudioContext | undefined, stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined,
    node: AudioWorkletNode | undefined,
    mute: GainNode | undefined;
  let cancelled = false,
    started = false,
    recording = false,
    stopped = false,
    limitSent = false;
  let chunks: Float32Array[] = [],
    frames = 0;
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let finishPromise: Promise<Blob> | undefined;
  let stopResolve: (() => void) | undefined, stopReject: ((error: Error) => void) | undefined;
  const aborted = () => new DOMException(uiText('common:text_d09ddef05902'), 'AbortError');
  function stopTracks() {
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
  }
  function release() {
    clearTimeout(limitTimer);
    clearTimeout(stopTimer);
    stopTracks();
    source?.disconnect();
    node?.disconnect();
    mute?.disconnect();
    if (node) {
      node.port.onmessage = null;
      node.onprocessorerror = null;
      node.port.close();
    }
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }
  function limit() {
    if (cancelled || !recording || limitSent) return;
    limitSent = true;
    callbacks.onTime(SPEECH_SECONDS * 1000);
    callbacks.onLimit();
  }
  function cancel() {
    cancelled = true;
    recording = false;
    stopReject?.(aborted());
    stopReject = undefined;
    stopResolve = undefined;
    chunks = [];
    frames = 0;
    release();
  }
  return {
    async start() {
      if (started || cancelled) throw aborted();
      started = true;
      try {
        if (!environment) {
          const error = audioSupportError();
          if (error) throw new Error(error);
        }
        context = env.context();
        if (
          !context.audioWorklet ||
          !Number.isFinite(context.sampleRate) ||
          context.sampleRate < 8000 ||
          context.sampleRate > 192000
        )
          throw new Error(uiText('common:text_1597c0fa0eee'));
        // Start both native requests in the original click, before any network await.
        const resume = context.resume();
        const media = env.getMedia().then((value) => {
          if (cancelled) {
            value.getTracks().forEach((track) => track.stop());
            throw aborted();
          }
          stream = value;
        });
        await Promise.all([
          resume,
          media,
          context.audioWorklet.addModule('/pcm-recorder.worklet.js').catch(() => {
            throw new Error(uiText('common:text_75b8393ae748'));
          }),
        ]);
        if (cancelled) throw aborted();
        if (!stream?.getAudioTracks().length) throw new Error(uiText('common:text_794fad07eacb'));
        node = env.node(context);
        node.port.onmessage = (event: MessageEvent) => {
          if (cancelled) return;
          const value = event.data;
          if (value?.type === 'chunk' && value.samples instanceof Float32Array) {
            const remaining = Math.floor(context!.sampleRate * SPEECH_SECONDS) - frames;
            const samples = value.samples.subarray(0, Math.max(0, remaining));
            if (samples.length) {
              chunks.push(samples);
              frames += samples.length;
            }
            callbacks.onTime(
              Math.min(SPEECH_SECONDS * 1000, Math.floor((frames / context!.sampleRate) * 1000)),
            );
          } else if (value?.type === 'stopped') {
            stopped = true;
            stopResolve?.();
          } else if (value?.type === 'limit') limit();
        };
        node.onprocessorerror = () => {
          if (!cancelled) callbacks.onError(new Error(uiText('common:text_48369d0089ab')));
        };
        for (const track of stream.getAudioTracks())
          track.onended = () => {
            if (recording && !cancelled)
              callbacks.onError(new Error(uiText('common:text_161cc8ad54f5')));
          };
        source = context.createMediaStreamSource(stream);
        mute = context.createGain();
        mute.gain.value = 0;
        source.connect(node);
        node.connect(mute);
        mute.connect(context.destination);
        recording = true;
        limitTimer = setTimeout(limit, SPEECH_SECONDS * 1000);
      } catch (error) {
        cancel();
        throw error;
      }
    },
    finish() {
      if (finishPromise) return finishPromise;
      if (cancelled || !recording || !context || !node) return Promise.reject(aborted());
      recording = false;
      clearTimeout(limitTimer);
      stopTracks();
      finishPromise = (async () => {
        try {
          if (!stopped)
            await new Promise<void>((resolve, reject) => {
              stopResolve = resolve;
              stopReject = reject;
              stopTimer = setTimeout(
                () => reject(new Error(uiText('common:text_3233576a0746'))),
                1500,
              );
              node!.port.postMessage({ type: 'stop' });
            });
          release();
          if (cancelled) throw aborted();
          const samples = new Float32Array(frames);
          let offset = 0;
          for (const part of chunks) {
            samples.set(part, offset);
            offset += part.length;
          }
          chunks = [];
          const blob = await env.convert(samples, context!.sampleRate);
          if (cancelled) throw aborted();
          if (blob.size > SPEECH_BYTES) throw new Error(uiText('common:text_b656ffbd141b'));
          return blob;
        } finally {
          release();
          chunks = [];
          stopReject = undefined;
          stopResolve = undefined;
        }
      })();
      return finishPromise;
    },
    cancel,
  };
}
