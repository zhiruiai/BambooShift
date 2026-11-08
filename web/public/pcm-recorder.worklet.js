class OpenBotPcmRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const seconds = options.processorOptions.live === true ? 3600 : 60;
    this.limit = Math.min(Math.floor(sampleRate * seconds), options.processorOptions.maxFrames);
    this.frames = 0;
    this.buffer = new Float32Array(4096);
    this.used = 0;
    this.done = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'stop') this.stop(false);
    };
  }
  flush() {
    if (!this.used) return;
    const samples = this.buffer.slice(0, this.used);
    this.used = 0;
    this.port.postMessage({ type: 'chunk', samples }, [samples.buffer]);
  }
  stop(limited) {
    if (this.done) return;
    this.done = true;
    this.flush();
    this.port.postMessage({ type: 'stopped' });
    if (limited) this.port.postMessage({ type: 'limit' });
  }
  process(inputs) {
    if (this.done) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    // Do not assume a fixed render quantum; average every available input channel.
    for (let i = 0; i < channels[0].length && !this.done; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      this.buffer[this.used++] = sample / channels.length;
      this.frames++;
      if (this.used === this.buffer.length) this.flush();
      if (this.frames >= this.limit) this.stop(true);
    }
    // Output remains silence. Audio is only transferred to the owning page.
    return !this.done;
  }
}
registerProcessor('openbot-pcm-recorder', OpenBotPcmRecorder);
