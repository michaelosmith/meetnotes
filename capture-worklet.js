// Downmixes input to mono and posts ~85 ms frames to the main thread.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const chans = input.length;
      const len = input[0].length;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < chans; c++) s += input[c][i];
        this.buf[this.n++] = s / chans;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
