/**
 * Every sound in SWEEP is synthesized here — no audio files ship with the game
 * (GDD §8). One AudioContext, created on the first touch so no browser ever
 * logs an autoplay warning, and a music loop exactly one sweep long that is
 * driven by the sweep phase rather than by wall-clock, so the music and the
 * hand can never drift apart.
 */
class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private muted = false;
  private noiseBuf: AudioBuffer | null = null;

  private musicOn = false;
  private lastPhase = -1;
  private lastSecond = -1;

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** Called from the first pointer event; safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.0;
      this.musicGain.connect(this.master);
      this.buildNoise();
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Browser tab went away — stop making noise until we are back. */
  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  // ---- one-shots ---------------------------------------------------------

  tap(): void {
    this.blip(660, 0.05, 'square', 0.06);
  }

  select(): void {
    this.blip(880, 0.07, 'triangle', 0.09);
  }

  /** The second hand's soft tick. */
  tick(strong = false): void {
    this.blip(strong ? 1400 : 1050, 0.035, 'square', strong ? 0.075 : 0.038);
  }

  /** Ink being wiped as the hand comes round. */
  whoosh(): void {
    this.noise(0.34, 2600, 420, 0.075);
  }

  /** Pen down on the dial. */
  inkDown(ink: number): void {
    this.blip([520, 620, 760][ink] ?? 520, 0.05, 'sine', 0.05);
  }

  wrong(): void {
    this.blip(170, 0.16, 'sawtooth', 0.1);
    this.later(70, () => this.blip(120, 0.22, 'sawtooth', 0.09));
  }

  /** Lockout: a heavy clunk, then the door stays shut for a sweep. */
  lockout(): void {
    this.blip(92, 0.3, 'square', 0.13);
    this.noise(0.16, 900, 160, 0.06);
  }

  solve(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((n, i) => this.later(i * 78, () => this.blip(n, 0.42, 'triangle', 0.12)));
  }

  baton(): void {
    this.blip(1174.7, 0.9, 'sine', 0.11);
    this.later(120, () => this.blip(1567.98, 1.1, 'sine', 0.08));
  }

  post(): void {
    [392, 523.25, 659.25].forEach((n, i) =>
      this.later(i * 90, () => this.blip(n, 0.35, 'triangle', 0.1)),
    );
  }

  fail(): void {
    [330, 262, 196, 147].forEach((n, i) =>
      this.later(i * 130, () => this.blip(n, 0.5, 'sawtooth', 0.1)),
    );
  }

  victory(): void {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((n, i) =>
      this.later(i * 110, () => this.blip(n, 0.6, 'triangle', 0.12)),
    );
  }

  /** Decay warning pip; pitch rises as the points bar runs out. */
  decayPip(urgency: number): void {
    this.blip(520 + urgency * 620, 0.06, 'square', 0.05 + urgency * 0.05);
  }

  countdown(final: boolean): void {
    this.blip(final ? 1760 : 880, final ? 0.3 : 0.09, 'square', final ? 0.13 : 0.07);
  }

  stamp(): void {
    this.noise(0.12, 1800, 300, 0.09);
    this.blip(300, 0.1, 'square', 0.07);
  }

  // ---- sweep-locked music ------------------------------------------------

  /** A: 4 bars of an arpeggio that fits exactly one 10 s rotation. */
  private static readonly PATTERN: { at: number; f: number; d: number }[] = [
    { at: 0.0, f: 130.81, d: 1.4 },
    { at: 0.125, f: 196.0, d: 0.5 },
    { at: 0.25, f: 261.63, d: 0.5 },
    { at: 0.375, f: 311.13, d: 0.5 },
    { at: 0.5, f: 174.61, d: 1.4 },
    { at: 0.625, f: 261.63, d: 0.5 },
    { at: 0.75, f: 349.23, d: 0.5 },
    { at: 0.875, f: 392.0, d: 0.5 },
  ];

  startMusic(): void {
    this.musicOn = true;
    this.lastPhase = -1;
    this.lastSecond = -1;
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setTargetAtTime(0.5, this.ctx.currentTime, 0.4);
    }
  }

  stopMusic(): void {
    this.musicOn = false;
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
    }
  }

  /**
   * Drive the loop from the sweep. `phase` is 0..1 through one rotation, so
   * pausing the clock pauses the music, and every player hears the same note
   * under the same hand position.
   */
  updateMusic(phase: number, seconds: number): void {
    if (!this.ctx || !this.musicOn) return;
    if (this.lastPhase < 0) {
      this.lastPhase = phase;
      this.lastSecond = seconds;
      return;
    }
    const wrapped = phase < this.lastPhase;
    for (const n of AudioManager.PATTERN) {
      const crossed = wrapped
        ? n.at > this.lastPhase || n.at <= phase
        : n.at > this.lastPhase && n.at <= phase;
      if (crossed) this.pad(n.f, n.d);
    }
    // Soft tick each second (§8).
    const sec = Math.floor(seconds);
    if (sec !== this.lastSecond) {
      this.lastSecond = sec;
      this.tick(false);
    }
    this.lastPhase = phase;
  }

  // ---- primitives --------------------------------------------------------

  private buildNoise(): void {
    if (!this.ctx) return;
    const len = Math.floor(this.ctx.sampleRate * 0.5);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  private later(ms: number, fn: () => void): void {
    if (!this.ctx) return;
    setTimeout(fn, ms);
  }

  private blip(freq: number, dur: number, type: OscillatorType, gain: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private pad(freq: number, dur: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicGain || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const filt = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(1400, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(filt);
    filt.connect(g);
    g.connect(this.musicGain);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private noise(dur: number, from: number, to: number, gain: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuf || this.muted) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.value = 1.2;
    filt.frequency.setValueAtTime(from, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(60, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }
}

export const sfx = new AudioManager();
