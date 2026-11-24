// audio.js: a plucked-string synthesizer (Karplus-Strong) using the Web Audio API.

const DURATION_S = 2.5; // length of each rendered note
const MAX_VOICE_GAIN = 0.8;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class StringSynth {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.muted = false;
    this.voices = new Map(); // one ringing note per string (key = string id)
  }

  // Must be called from a user click (browsers block audio otherwise)
  init() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;

    this.ctx = new AC();

    // master volume -> compressor (prevents clipping) -> speakers
    const compressor = this.ctx.createDynamicsCompressor();
    this.master = this.ctx.createGain();
    this.master.connect(compressor);
    compressor.connect(this.ctx.destination);
    this._applyGain();
    return true;
  }

  async resume() {
    if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume();
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    this._applyGain();
  }

  setMuted(m) {
    this.muted = m;
    this._applyGain();
  }

  _applyGain() {
    if (!this.master) return;
    // squaring the slider value feels more natural to the ear
    const g = this.muted ? 0 : this.volume * this.volume;
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }

  // freq in Hz, strength 0.15 - 1
    // freq in Hz, strength 0.15 - 1, voiceId = which string is playing
  pluck(freq, strength, voiceId = 0) {
    if (!this.ctx || this.ctx.state !== "running" || this.muted) return;

    const buffer = this._render(freq, strength);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;

    const gain = this.ctx.createGain();
    gain.gain.value = MAX_VOICE_GAIN * (0.25 + 0.75 * strength);

    src.connect(gain);
    gain.connect(this.master);

    // A string can only ring one note: quickly mute ITS previous note
    const prev = this.voices.get(voiceId);
    if (prev) this._release(prev, 0.06);

    const voice = { src, gain };
    this.voices.set(voiceId, voice);
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
      if (this.voices.get(voiceId) === voice) this.voices.delete(voiceId);
    };
    src.start();
  }

    _release(voice, seconds) {
    const t = this.ctx.currentTime;
    const g = voice.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + seconds);
    try {
      voice.src.stop(t + seconds + 0.01);
    } catch (e) {
      /* already stopped */
    }
  }
  // Karplus-Strong: build the whole note as an audio buffer
  _render(freq, strength) {
    const sr = this.ctx.sampleRate;
    const total = Math.floor(sr * DURATION_S);
    const buffer = this.ctx.createBuffer(1, total, sr);
    const out = buffer.getChannelData(0);

    // --- 1. Loop length. The averaging filter adds half a sample of delay,
    // and a tiny "allpass" filter adds the fractional part so the pitch is exact.
    const target = sr / freq - 0.5;
    let N = Math.floor(target);
    let frac = target - N;
    if (frac < 0.5) {
      N -= 1;
      frac += 1;
    }
    const C = (1 - frac) / (1 + frac); // allpass coefficient

    // --- 2. The "pluck": a burst of noise. Soft plucks are darker.
    const line = new Float32Array(N);
    const bright = 0.3 + 0.7 * strength; // 1 = harsh noise, low = mellow
    let prev = 0;
    let mean = 0;
    for (let i = 0; i < N; i++) {
      prev += bright * (Math.random() * 2 - 1 - prev);
      line[i] = prev;
      mean += prev;
    }
    mean /= N;
    let peak = 0.0001;
    for (let i = 0; i < N; i++) {
      line[i] -= mean; // remove DC offset so it doesn't ring forever
      peak = Math.max(peak, Math.abs(line[i]));
    }
    for (let i = 0; i < N; i++) line[i] /= peak;

    // --- 3. How quickly the note dies away. High notes fade faster, like real strings.
    const decaySeconds = clamp(3.2 * Math.pow(200 / freq, 0.35), 0.8, 3.5);
    const damping = Math.pow(0.001, 1 / (decaySeconds * freq)); // -60 dB over decaySeconds

    // --- 4. Run the loop
    let idx = 0;
    let lpPrev = 0;
    let apX1 = 0;
    let apY1 = 0;
    for (let n = 0; n < total; n++) {
      const x = line[idx]; // sample from one loop ago
      const lp = (x + lpPrev) * 0.5 * damping; // averaging = gentle low-pass
      lpPrev = x;
      const ap = C * lp + apX1 - C * apY1; // fine-tuning delay
      apX1 = lp;
      apY1 = ap;
      line[idx] = ap;
      idx = idx + 1 === N ? 0 : idx + 1;
      out[n] = x;
    }

    // --- 5. Short fade at the very end so there's never a click
    const fadeN = Math.floor(sr * 0.15);
    for (let i = 0; i < fadeN; i++) out[total - 1 - i] *= i / fadeN;

    return buffer;
  }
}