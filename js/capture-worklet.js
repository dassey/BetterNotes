/* BetterNotes — AudioWorklet processor: mixes the microphone to mono, low-passes and
   resamples it to 16 kHz, and posts Float32 blocks to the page. Runs on the audio thread. */
'use strict';

class BNCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.lp = 0;
    this.lpA = 1 - Math.exp((-2 * Math.PI * 6500) / sampleRate);
    this.carry = new Float32Array(0);
    this.pos = 0;
    this.block = new Float32Array(1024);
    this.n = 0;
    this.active = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        if (this.n) this.port.postMessage(this.block.slice(0, this.n));
        this.n = 0;
        this.active = false;
      }
    };
  }

  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    if (!input || !input.length || !input[0].length) return true;
    const len = input[0].length;
    const chans = input.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < chans; c++) {
      const ch = input[c];
      for (let i = 0; i < len; i++) mono[i] += ch[i];
    }
    if (chans > 1) for (let i = 0; i < len; i++) mono[i] /= chans;
    if (this.ratio === 1) { this.emit(mono); return true; }

    let lp = this.lp;
    const a = this.lpA;
    for (let i = 0; i < len; i++) { lp += a * (mono[i] - lp); mono[i] = lp; }
    this.lp = lp;

    const buf = new Float32Array(this.carry.length + len);
    buf.set(this.carry, 0);
    buf.set(mono, this.carry.length);
    let pos = this.pos;
    const out = [];
    while (pos + 1 < buf.length) {
      const i = Math.floor(pos);
      const f = pos - i;
      out.push(buf[i] + (buf[i + 1] - buf[i]) * f);
      pos += this.ratio;
    }
    const keepFrom = Math.max(0, Math.floor(pos) - 1);
    this.carry = buf.slice(keepFrom);
    this.pos = pos - keepFrom;
    if (out.length) this.emit(Float32Array.from(out));
    return true;
  }

  emit(samples) {
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(samples.length - i, this.block.length - this.n);
      this.block.set(samples.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.block.length) {
        const b = this.block;
        this.port.postMessage(b, [b.buffer]);
        this.block = new Float32Array(1024);
        this.n = 0;
      }
    }
  }
}

registerProcessor('bn-capture', BNCaptureProcessor);
