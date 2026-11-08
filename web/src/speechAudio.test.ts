import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import {
  createAudioRecorder,
  encodeSpeechWav,
  resampleSpeech,
  SPEECH_BYTES,
  type RecorderEnvironment,
} from './speechAudio.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('speech WAV encodes mono PCM16 at 16 kHz with bounded duration and exact signed samples', async () => {
  const blob = encodeSpeechWav(new Float32Array([-2, -1, 0, 1, 2, NaN]));
  assert.equal(blob.type, 'audio/wav');
  const bytes = Buffer.from(await blob.arrayBuffer()),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 12);
  assert.deepEqual(
    Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true)),
    [-32768, -32768, 0, 32767, 32767, 0],
  );
  assert.equal(encodeSpeechWav(new Float32Array(960000)).size, 1920044);
  assert.ok(1920044 < SPEECH_BYTES);
  assert.throws(() => encodeSpeechWav(new Float32Array()), /录音为空/);
  assert.throws(() => encodeSpeechWav(new Float32Array(960001)), /60 秒/);
});

test('speech resampling supplies the actual device rate to OfflineAudioContext and bounds output at one minute', async () => {
  for (const rate of [44100, 48000, 96000]) {
    let input: unknown,
      target = 0,
      connected = 0,
      started = 0;
    const blob = await resampleSpeech(new Float32Array(rate / 10).fill(0.25), rate, (length) => {
      target = length;
      return {
        destination: {},
        createBuffer: (channels: number, frames: number, actual: number) => {
          input = [channels, frames, actual];
          return {
            copyToChannel: (samples: Float32Array, channel: number) => {
              assert.equal(samples[0], 0.25);
              assert.equal(channel, 0);
            },
          };
        },
        createBufferSource: () => ({
          connect() {
            connected++;
          },
          start() {
            started++;
          },
          disconnect() {},
        }),
        startRendering: async () => ({ getChannelData: () => new Float32Array(length).fill(0.25) }),
      } as unknown as OfflineAudioContext;
    });
    assert.deepEqual(input, [1, rate / 10, rate]);
    assert.equal(target, 1600);
    assert.equal(blob.size, 3244);
    assert.equal(connected, 1);
    assert.equal(started, 1);
  }
  await assert.rejects(resampleSpeech(new Float32Array(48001 * 60), 48000), /采样/);
  await assert.rejects(resampleSpeech(new Float32Array(1), NaN), /采样/);
});

test('actual worklet averages channels, handles variable block sizes, flushes once and enforces the frame cap', async () => {
  const code = await readFile(
    new URL('../public/pcm-recorder.worklet.js', import.meta.url),
    'utf8',
  );
  let Processor: any;
  const messages: any[] = [];
  runInNewContext(code, {
    sampleRate: 48000,
    Float32Array,
    AudioWorkletProcessor: class {
      port = {
        postMessage(value: unknown) {
          messages.push(value);
        },
        onmessage: undefined,
      };
    },
    registerProcessor(name: string, value: unknown) {
      assert.equal(name, 'openbot-pcm-recorder');
      Processor = value;
    },
  });
  const processor = new Processor({ processorOptions: { maxFrames: 200 } });
  assert.equal(
    processor.process([[new Float32Array(73).fill(1), new Float32Array(73).fill(-1)]]),
    true,
  );
  assert.equal(processor.process([[new Float32Array(160).fill(0.5)]]), false);
  assert.equal(messages[0].samples.length, 200);
  assert.equal(messages[0].samples[0], 0);
  assert.equal(messages[0].samples[73], 0.5);
  assert.deepEqual(
    messages.map((message) => message.type),
    ['chunk', 'stopped', 'limit'],
  );
  processor.port.onmessage({ data: { type: 'stop' } });
  assert.equal(messages.length, 3);
});

function recorderFixture() {
  const media = deferred<MediaStream>(),
    converted = deferred<Blob>();
  let stopped = 0,
    closed = 0,
    createdNodes = 0,
    inputRate = 0,
    frameCount = 0;
  const track = {
    onended: null,
    stop() {
      stopped++;
    },
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    close() {},
    postMessage() {
      queueMicrotask(() => port.onmessage?.({ data: { type: 'stopped' } } as MessageEvent));
    },
  };
  const connectable = () => ({ connect() {}, disconnect() {} });
  const context = {
    sampleRate: 48000,
    state: 'running',
    audioWorklet: {
      addModule: async (path: string) => assert.equal(path, '/pcm-recorder.worklet.js'),
    },
    resume: async () => {},
    close: async () => {
      closed++;
      context.state = 'closed';
    },
    createMediaStreamSource: connectable,
    createGain: () => ({ ...connectable(), gain: { value: 1 } }),
    destination: {},
  };
  const environment: RecorderEnvironment = {
    getMedia: () => media.promise,
    context: () => context as unknown as AudioContext,
    node: () => {
      createdNodes++;
      return { ...connectable(), port, onprocessorerror: null } as unknown as AudioWorkletNode;
    },
    convert: (samples, rate) => {
      inputRate = rate;
      frameCount = samples.length;
      return converted.promise;
    },
  };
  return {
    media,
    converted,
    stream,
    track,
    port,
    environment,
    stats: () => ({ stopped, closed, createdNodes, inputRate, frameCount }),
  };
}
test('recorder cancels pending permission and immediately stops a late microphone grant', async () => {
  const f = recorderFixture();
  const recorder = createAudioRecorder({ onTime() {}, onLimit() {}, onError() {} }, f.environment);
  const started = recorder.start();
  recorder.cancel();
  f.media.resolve(f.stream);
  await assert.rejects(started, { name: 'AbortError' });
  assert.equal(f.stats().stopped, 1);
  assert.equal(f.stats().closed, 1);
  assert.equal(f.stats().createdNodes, 0);
});
test('recorder stops tracks before conversion and rejects a conversion that finishes after cancellation', async () => {
  const f = recorderFixture();
  const times: number[] = [];
  const recorder = createAudioRecorder(
    { onTime: (ms) => times.push(ms), onLimit() {}, onError() {} },
    f.environment,
  );
  const started = recorder.start();
  f.media.resolve(f.stream);
  await started;
  f.port.onmessage?.({ data: { type: 'chunk', samples: new Float32Array(4800) } } as MessageEvent);
  const finished = recorder.finish();
  await flush();
  assert.equal(f.stats().inputRate, 48000);
  assert.equal(f.stats().frameCount, 4800);
  assert.ok(f.stats().stopped > 0);
  assert.equal(f.stats().closed, 1);
  assert.equal(times.at(-1), 100);
  recorder.cancel();
  f.converted.resolve(encodeSpeechWav(new Float32Array(1600)));
  await assert.rejects(finished, { name: 'AbortError' });
});
