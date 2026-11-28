class RingPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab, frames } = options.processorOptions;
    this.counters = new Int32Array(sab, 0, 2);
    this.samples = new Float32Array(sab, 8);
    this.frameMask = frames - 1;
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    const written = Atomics.load(this.counters, 0);
    const read = Atomics.load(this.counters, 1);
    if (((written - read) | 0) < left.length) return true;
    for (let i = 0; i < left.length; i++) {
      const frame = ((read + i) & this.frameMask) * 2;
      left[i] = this.samples[frame];
      if (right) right[i] = this.samples[frame + 1];
    }
    Atomics.store(this.counters, 1, (read + left.length) | 0);
    return true;
  }
}
registerProcessor('ring-player', RingPlayer);
