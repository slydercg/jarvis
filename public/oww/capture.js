// AudioWorklet: hands openWakeWord 80 ms chunks (1280 samples at the
// context's 16 kHz), scaled to int16 range as its models expect.
class OwwCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(1280)
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = Math.max(-1, Math.min(1, ch[i])) * 32767
        if (this.n === 1280) {
          this.port.postMessage(this.buf, [this.buf.buffer])
          this.buf = new Float32Array(1280)
          this.n = 0
        }
      }
    }
    return true
  }
}
registerProcessor('oww-capture', OwwCapture)
