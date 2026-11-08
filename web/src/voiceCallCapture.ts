import { resampleSpeech } from './speechAudio';

export function createVoiceSegmenter(
  sampleRate: number,
  utterance: (samples: Float32Array) => void,
) {
  const seconds = (value: number) => Math.ceil(sampleRate * value);
  let parts: Float32Array[] = [],
    frames = 0,
    voiced = 0,
    silence = 0,
    active = false;
  function reset() {
    parts = [];
    frames = 0;
    voiced = 0;
    silence = 0;
    active = false;
  }
  return {
    reset,
    push(samples: Float32Array) {
      if (!samples.length || samples.length > 8192) return;
      let energy = 0;
      for (const sample of samples) if (Number.isFinite(sample)) energy += sample * sample;
      const speech = Math.sqrt(energy / samples.length) >= 0.014;
      parts.push(samples);
      frames += samples.length;
      if (!active) {
        while (parts.length > 1 && frames - parts[0].length >= seconds(0.3))
          frames -= parts.shift()!.length;
        voiced = speech ? voiced + samples.length : 0;
        if (voiced >= seconds(0.18)) active = true;
        return;
      }
      if (speech) voiced += samples.length;
      silence = speech ? 0 : silence + samples.length;
      if (silence < seconds(0.65) && frames < seconds(25)) return;
      const result = voiced >= seconds(0.24) ? new Float32Array(frames) : undefined;
      if (result) {
        let offset = 0;
        for (const part of parts) {
          result.set(part, offset);
          offset += part.length;
        }
      }
      reset();
      if (result) utterance(result);
    },
  };
}

export type CallCapture = { ready: Promise<void>; listen(active: boolean): void; close(): void };

export function openCallCapture(
  utterance: (audio: Promise<Blob>) => void,
  failed: (error: unknown) => void,
): CallCapture {
  const context = new AudioContext();
  let stream: MediaStream | undefined, source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined, output: GainNode | undefined;
  let listening = false,
    closed = false;
  const segmenter = createVoiceSegmenter(context.sampleRate, (samples) => {
    if (listening && !closed) utterance(resampleSpeech(samples, context.sampleRate));
  });
  const listen = (active: boolean) => {
    if (closed || listening === active) return;
    listening = active;
    segmenter.reset();
    for (const track of stream?.getAudioTracks() || []) track.enabled = active;
  };
  function close() {
    if (closed) return;
    listen(false);
    closed = true;
    for (const track of stream?.getTracks() || []) track.stop();
    if (node) {
      node.port.onmessage = null;
      node.port.close();
      node.disconnect();
    }
    source?.disconnect();
    output?.disconnect();
    void context.close().catch(() => {});
  }
  // Acquire the microphone in the original click. Electron permits one capture per native gesture.
  const resumed = context.resume();
  const media = navigator.mediaDevices
    .getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    })
    .then((value) => {
      if (closed) {
        value.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = value;
      for (const track of value.getAudioTracks()) {
        track.enabled = listening;
        track.onended = () => {
          if (!closed) failed(new Error('NotReadableError'));
        };
      }
    });
  const ready = Promise.all([
    resumed,
    media,
    context.audioWorklet.addModule('/pcm-recorder.worklet.js'),
  ])
    .then(() => {
      if (closed) return;
      if (!stream?.getAudioTracks().length) throw new DOMException('', 'NotFoundError');
      node = new AudioWorkletNode(context, 'openbot-pcm-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { live: true, maxFrames: context.sampleRate * 3600 },
      });
      node.port.onmessage = (event) => {
        const value = event.data;
        if (closed) return;
        if (listening && value?.type === 'chunk' && value.samples instanceof Float32Array)
          segmenter.push(value.samples);
        if (value?.type === 'limit') failed(new Error('VOICE_CALL_CAPTURE_LIMIT'));
      };
      node.onprocessorerror = () => {
        if (!closed) failed(new Error('VOICE_CALL_CAPTURE_ERROR'));
      };
      source = context.createMediaStreamSource(stream);
      output = context.createGain();
      output.gain.value = 0;
      source.connect(node).connect(output).connect(context.destination);
    })
    .catch((error) => {
      close();
      throw error;
    });
  return { ready, listen, close };
}
