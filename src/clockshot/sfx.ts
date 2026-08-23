/**
 * Clockshot's sound, synthesised on the fly.
 *
 * No audio files, for the same reason there are no image files: nothing to load
 * and nothing to fail inside a web view. The AudioContext is not even
 * constructed until the first real gesture, so no browser ever logs an autoplay
 * warning, and everything routes through one gain node so mute is instant and
 * total.
 */

const STORAGE_KEY = 'clockshot.muted';

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;

  constructor() {
    // A player who muted last time should not be shouted at on their next run.
    try {
      this.muted = localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      // Storage can throw in a locked-down web view; the default is fine.
    }
  }

  /** Called from the first pointer or key event. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume().catch(() => undefined);
      return;
    }
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      this.buildNoise();
    } catch {
      // Without audio the game still plays; it just plays quietly.
      this.ctx = null;
    }
  }

  private buildNoise(): void {
    if (!this.ctx) return;
    const len = Math.floor(this.ctx.sampleRate * 0.5);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
    try {
      localStorage.setItem(STORAGE_KEY, m ? '1' : '0');
    } catch {
      // Not being able to remember the choice is not worth failing over.
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  suspend(): void {
    void this.ctx?.suspend().catch(() => undefined);
  }

  resume(): void {
    void this.ctx?.resume().catch(() => undefined);
  }

  /* --------------------------------------------------------------------- */
  /* Primitives                                                             */
  /* --------------------------------------------------------------------- */

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    slideTo?: number,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime;

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);

    // A short attack keeps clicks out; the exponential tail keeps it musical.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, from: number, to: number, gain: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noiseBuffer || this.muted) return;

    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const g = ctx.createGain();
    const t = ctx.currentTime;

    src.buffer = this.noiseBuffer;
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur);
    filter.Q.value = 1.1;

    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(filter).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /* --------------------------------------------------------------------- */
  /* The game's voice                                                       */
  /* --------------------------------------------------------------------- */

  uiTap(): void {
    this.tone(520, 0.06, 'square', 0.06);
  }

  uiSelect(): void {
    this.tone(660, 0.09, 'square', 0.08);
    window.setTimeout(() => this.tone(990, 0.1, 'square', 0.06), 55);
  }

  /** Pitch rises as a pickup streak builds, so collecting has momentum. */
  collect(streak = 0): void {
    const base = 880 * Math.pow(1.06, Math.min(streak, 12));
    this.tone(base, 0.09, 'triangle', 0.10);
  }

  collectLarge(): void {
    this.tone(740, 0.13, 'triangle', 0.12);
    window.setTimeout(() => this.tone(1110, 0.14, 'triangle', 0.10), 60);
  }

  collectGolden(): void {
    [660, 880, 1320, 1760].forEach((f, i) => {
      window.setTimeout(() => this.tone(f, 0.18, 'triangle', 0.11), i * 70);
    });
  }

  /** Stealing sounds wrong on purpose — it is taken, not earned. */
  steal(): void {
    this.tone(420, 0.16, 'sawtooth', 0.09, 180);
  }

  grapple(): void {
    this.noise(0.13, 2400, 500, 0.14);
    this.tone(300, 0.12, 'square', 0.05, 720);
  }

  release(): void {
    this.tone(720, 0.09, 'sine', 0.06, 380);
  }

  shoot(): void {
    this.tone(880, 0.05, 'square', 0.05, 320);
    this.noise(0.05, 3200, 900, 0.05);
  }

  enemyHit(): void {
    this.noise(0.12, 1800, 260, 0.13);
    this.tone(180, 0.12, 'sawtooth', 0.07, 70);
  }

  hurt(): void {
    this.tone(220, 0.2, 'sawtooth', 0.11, 80);
    this.noise(0.18, 900, 120, 0.10);
  }

  fall(): void {
    this.tone(400, 0.35, 'sine', 0.10, 70);
  }

  jump(): void {
    this.tone(430, 0.07, 'sine', 0.05, 620);
  }

  /** The last ten seconds. `final` marks the last three ticks. */
  tick(final: boolean): void {
    this.tone(final ? 1200 : 880, final ? 0.1 : 0.06, 'square', final ? 0.11 : 0.06);
  }

  runStart(): void {
    [440, 660, 880].forEach((f, i) => {
      window.setTimeout(() => this.tone(f, 0.12, 'square', 0.09), i * 90);
    });
  }

  runEnd(): void {
    this.noise(0.4, 1400, 200, 0.10);
    this.tone(330, 0.4, 'triangle', 0.09, 160);
  }

  victory(): void {
    [523, 659, 784, 1047].forEach((f, i) => {
      window.setTimeout(() => this.tone(f, 0.3, 'triangle', 0.11), i * 110);
    });
  }

  defeat(): void {
    [440, 370, 294, 220].forEach((f, i) => {
      window.setTimeout(() => this.tone(f, 0.32, 'triangle', 0.10), i * 130);
    });
  }

  /** A lead change deserves its own sting — it is the community moment. */
  leadChange(): void {
    [784, 988, 1175].forEach((f, i) => {
      window.setTimeout(() => this.tone(f, 0.22, 'square', 0.09), i * 80);
    });
  }
}

export const sfx = new Sfx();
