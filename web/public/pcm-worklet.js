/* eslint-disable */
// AudioWorklet processor for meeting mic capture (replaces the deprecated
// ScriptProcessorNode). Runs off the main thread: buffers Float32 mono input,
// converts to 16-bit little-endian PCM, and posts { pcm: ArrayBuffer, level }
// to the main thread once per ~128ms frame.
//
// Served as a same-origin public asset (loaded via
// `${BASE_URL}pcm-worklet.js`) so it satisfies the app's CSP `script-src
// 'self'` — a blob: URL would be blocked. Keep this file dependency-free:
// AudioWorkletGlobalScope has no module imports.
const FRAME = 2048; // samples per posted chunk (~128ms @ 16 kHz)

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Int16Array(FRAME);
    this._n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        let s = ch[i];
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        this._buf[this._n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this._n === FRAME) {
          let sum = 0;
          for (let j = 0; j < FRAME; j++) { const v = this._buf[j] / 32768; sum += v * v; }
          const level = Math.min(100, Math.round(Math.sqrt(sum / FRAME) * 200));
          const out = this._buf.slice(0); // copy; transfer the copy's buffer
          this.port.postMessage({ pcm: out.buffer, level }, [out.buffer]);
          this._n = 0;
        }
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor("pcm-processor", PcmProcessor);
