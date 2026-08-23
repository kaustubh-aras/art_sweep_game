import Phaser from 'phaser';
import { Scenes } from '@/game/constants';
import { T, TX, FONT, INK_NAMES } from '@/ui/theme';
import type { Frame } from '@/ui/layout';
import { Button } from '@/ui/Button';
import { Toast } from '@/ui/Toast';
import { SweepClock, angleOf, freshness } from '@/sweep/clock';
import { ClockFace, heatCell, polar } from '@/sweep/clockFace';
import { GhostLayer, InkLayer } from '@/sweep/inkLayer';
import { clampToCircle, toQuant, type InkIndex, type Recording, type Stroke } from '@/sweep/strokes';
import { chain, run } from '@/sweep/session';
import { threeChoices, type Word } from '@/sweep/words';
import { newDrawStats, readability, type DrawStats } from '@/sweep/scoring';
import { mulberry32 } from '@/sweep/synth';
import {
  DRAW_SWEEPS,
  DRAW_MIN_SWEEPS,
  MAX_STROKE_POINTS,
  SWEEP_PERIOD,
} from '@/sweep/tuning';
import { sfx } from '@/audio/AudioManager';
import { SweepScene } from './SweepScene';

const D = {
  dial: 1,
  ghost: 2,
  ink: 3,
  hand: 4,
  marks: 5,
  hud: 10,
  panel: 20,
  overlay: 60,
} as const;

/** Minimum unit-space distance between recorded points (thins the payload). */
const MIN_STEP = 0.014;
/** How fresh the wake must be for a point to count as "drawn behind the hand". */
const WAKE_THRESHOLD = 0.86;

/**
 * Screen 4 (GDD §7): draw the next word in six sweeps.
 *
 * This is the timer at its most physical. The hand wipes what you just drew, so
 * the only way to leave a readable picture behind is to chase it — lay a shape
 * down right after the hand clears it, then come back and trace it again on the
 * next pass. The faint ghost of your erased strokes is the only help you get.
 */
export class DrawScene extends SweepScene {
  private clock = new SweepClock();
  private face!: ClockFace;
  private ink!: InkLayer;
  private ghost!: GhostLayer;

  // ---- session state ----
  private phase: 'choose' | 'draw' = 'choose';
  private choices: Word[] = [];
  private word: Word | null = null;
  private strokes: Stroke[] = [];
  private current: Stroke | null = null;
  private lastPt: { x: number; y: number } | null = null;
  private drawPointer: number | null = null;
  private inkIndex: InkIndex = 0;
  private stats: DrawStats = newDrawStats();
  private points = 0;
  private started = false;
  private finishing = false;
  private lastSweepHeard = -1;

  // ---- display ----
  private topLeft!: Phaser.GameObjects.Text;
  private wordText!: Phaser.GameObjects.Text;
  private sweepText!: Phaser.GameObjects.Text;
  private ringGfx!: Phaser.GameObjects.Graphics;
  private hintText!: Phaser.GameObjects.Text;
  private inkBtns: Button[] = [];
  private doneBtn!: Button;
  private pauseBtn!: Button;
  private toast!: Toast;

  // ---- word choice overlay ----
  private chooser!: Phaser.GameObjects.Container;
  private chooserPlate!: Phaser.GameObjects.Graphics;
  private chooserTitle!: Phaser.GameObjects.Text;
  private chooserSub!: Phaser.GameObjects.Text;
  private choiceBtns: Button[] = [];

  constructor() {
    super(Scenes.Draw);
  }

  init(): void {
    this.phase = 'choose';
    this.word = null;
    this.strokes = [];
    this.current = null;
    this.lastPt = null;
    this.drawPointer = null;
    this.inkIndex = 0;
    this.stats = newDrawStats();
    this.points = 0;
    this.started = false;
    this.finishing = false;
    this.lastSweepHeard = -1;
    this.clock.reset();
    this.clock.setPaused(true); // the session clock does not run until DRAW starts
    this.inkBtns = [];
    this.choiceBtns = [];

    const rand = mulberry32((Date.now() ^ (run.linksSolved * 7919)) >>> 0);
    this.choices = threeChoices(rand);
  }

  create(): void {
    this.face = new ClockFace(this, D.dial, D.dial, D.hand);
    this.ghost = new GhostLayer(this, D.ghost);
    this.ink = new InkLayer(this, D.ink);

    this.topLeft = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '11px', color: TX.dim })
      .setOrigin(0, 0.5)
      .setDepth(D.hud);
    this.wordText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '18px', color: TX.gold })
      .setOrigin(0.5, 0.5)
      .setDepth(D.hud);
    this.sweepText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '12px', color: TX.dim })
      .setOrigin(0.5, 0.5)
      .setDepth(D.hud);
    this.hintText = this.add
      .text(0, 0, 'draw right behind the hand', {
        fontFamily: FONT,
        fontSize: '11px',
        color: TX.faint,
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(D.hud);
    this.ringGfx = this.add.graphics().setDepth(D.marks);

    for (let i = 0; i < 3; i++) {
      const idx = i as InkIndex;
      this.inkBtns.push(
        new Button(this, {
          label: INK_NAMES[i],
          variant: 'quiet',
          onClick: () => this.pickInk(idx),
        }).setDepth(D.panel),
      );
    }
    this.doneBtn = new Button(this, {
      label: 'DONE',
      variant: 'primary',
      onClick: () => this.finish(),
    }).setDepth(D.panel);
    this.pauseBtn = new Button(this, {
      label: '❙❙',
      variant: 'quiet',
      onClick: () => this.openPause(),
    }).setDepth(D.hud);

    this.buildChooser();
    this.toast = new Toast(this, D.overlay + 2);

    this.bindInput();
    this.startLayout();
    this.fadeIn();
    this.enableAudioUnlock();

    const onPause = (): void => this.clock.setPaused(true);
    const onResume = (): void => {
      if (this.phase === 'draw') this.clock.setPaused(false);
    };
    this.events.on(Phaser.Scenes.Events.PAUSE, onPause);
    this.events.on(Phaser.Scenes.Events.RESUME, onResume);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      sfx.stopMusic();
      this.events.off(Phaser.Scenes.Events.PAUSE, onPause);
      this.events.off(Phaser.Scenes.Events.RESUME, onResume);
    });

    this.refreshInk();
  }

  update(_t: number, delta: number): void {
    this.clock.advance(delta);
    const hand = this.clock.handAngle();
    this.ink.update(hand);
    this.face.update(hand);

    if (this.phase !== 'draw') return;

    sfx.updateMusic(this.clock.sweepPhase(), this.clock.now() / 1000);

    // A whoosh on every rotation: the sound of the field being wiped.
    const sweep = this.clock.sweepIndex();
    if (sweep !== this.lastSweepHeard) {
      this.lastSweepHeard = sweep;
      if (this.started) sfx.whoosh();
      this.refreshSweepReadout();
      if (sweep === DRAW_MIN_SWEEPS) {
        this.doneBtn.setEnabled(true);
        this.toast.show('DONE unlocked — post any time now', 1600, TX.green);
      }
      if (sweep >= DRAW_SWEEPS) {
        this.toast.show('SESSION OVER', 1400, TX.warn);
        this.finish();
        return;
      }
      if (sweep === DRAW_SWEEPS - 1) {
        sfx.countdown(true);
        this.cameras.main.flash(180, 70, 12, 20);
        this.toast.show('LAST SWEEP', 1500, TX.warn);
      }
    }

    this.drawRing();
    if (this.started) this.refreshSweepReadout();
  }

  // ---- word choice -------------------------------------------------------

  private buildChooser(): void {
    this.chooserPlate = this.add.graphics();
    this.chooserTitle = this.add
      .text(0, 0, 'YOU HOLD THE BATON', { fontFamily: FONT, fontSize: '18px', color: TX.gold })
      .setOrigin(0.5);
    this.chooserSub = this.add
      .text(0, 0, 'pick a word · six sweeps · no undo', {
        fontFamily: FONT,
        fontSize: '11px',
        color: TX.dim,
        align: 'center',
      })
      .setOrigin(0.5);

    for (const w of this.choices) {
      this.choiceBtns.push(
        new Button(this, {
          label: `${w.word.toUpperCase()}   ·   ${w.tier}`,
          variant: w.tier === 'hard' ? 'gold' : w.tier === 'medium' ? 'primary' : 'ghost',
          onClick: () => this.chooseWord(w),
        }),
      );
    }

    this.chooser = this.add
      .container(0, 0, [this.chooserPlate, this.chooserTitle, this.chooserSub, ...this.choiceBtns])
      .setDepth(D.overlay);
  }

  private chooseWord(w: Word): void {
    if (this.phase !== 'choose') return;
    this.word = w;
    this.phase = 'draw';
    this.clock.reset();
    this.clock.setPaused(false);
    this.lastSweepHeard = -1;
    this.doneBtn.setEnabled(false);
    this.wordText.setText(w.word.toUpperCase());
    sfx.select();
    sfx.startMusic();
    this.tweens.add({
      targets: this.chooser,
      alpha: 0,
      duration: 260,
      onComplete: () => this.chooser.setVisible(false),
    });
    this.refreshSweepReadout();
    this.toast.show('draw in the wake — the hand erases everything', 2200, TX.gold);
  }

  // ---- drawing -----------------------------------------------------------

  private bindInput(): void {
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      sfx.unlock();
      if (this.phase !== 'draw' || this.finishing) return;
      if (this.drawPointer !== null) return; // one thumb draws; the other can hit buttons
      if (!this.face.contains(p.x, p.y)) return;
      this.drawPointer = p.id;
      this.beginStroke();
      this.addPoint(p.x, p.y);
    });

    this.input.on(Phaser.Input.Events.POINTER_MOVE, (p: Phaser.Input.Pointer) => {
      if (this.drawPointer !== p.id) return;
      this.addPoint(p.x, p.y);
    });

    const end = (p: Phaser.Input.Pointer): void => {
      if (this.drawPointer !== p.id) return;
      this.drawPointer = null;
      this.endStroke();
    };
    this.input.on(Phaser.Input.Events.POINTER_UP, end);
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, end);

    const kb = this.input.keyboard;
    if (!kb) return;
    kb.on('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.openPause();
      else if (e.key === '1') this.pickInk(0);
      else if (e.key === '2') this.pickInk(1);
      else if (e.key === '3') this.pickInk(2);
      else if (e.key === 'Enter' && this.doneBtn.isEnabled()) this.finish();
    });
  }

  private beginStroke(): void {
    this.current = { ink: this.inkIndex, pts: [] };
    this.strokes.push(this.current);
    this.lastPt = null;
    this.started = true;
    sfx.inkDown(this.inkIndex);
  }

  private endStroke(): void {
    this.ink.endStroke();
    this.ghost.endStroke();
    if (this.current && this.current.pts.length === 0) this.strokes.pop();
    this.current = null;
    this.lastPt = null;
  }

  private addPoint(px: number, py: number): void {
    if (!this.current || this.points >= MAX_STROKE_POINTS) return;
    const raw = this.face.toUnit(px, py);
    const u = clampToCircle(raw.x, raw.y);
    if (this.lastPt && Math.hypot(u.x - this.lastPt.x, u.y - this.lastPt.y) < MIN_STEP) return;

    const t = Math.round(this.clock.now());
    this.current.pts.push(toQuant(u.x), toQuant(u.y), t);
    this.lastPt = u;
    this.points++;

    const strokeId = this.strokes.length;
    this.ink.addPoint(u.x, u.y, this.current.ink, strokeId);
    this.ghost.addPoint(u.x, u.y, this.current.ink, strokeId);

    // Score the moment it is laid down: was this in the wake, and is this cell
    // being re-traced on a later pass? Both are pure timer skill (GDD §3).
    this.stats.points++;
    if (freshness(this.clock.handAngle(), angleOf(u.x, u.y)) >= WAKE_THRESHOLD) {
      this.stats.wakePoints++;
    }
    const cell = heatCell(u.x, u.y);
    const sweepBit = 1 << Math.min(15, this.clock.sweepIndex());
    this.stats.cells.set(cell, (this.stats.cells.get(cell) ?? 0) | sweepBit);
  }

  private pickInk(i: InkIndex): void {
    this.inkIndex = i;
    this.refreshInk();
    sfx.inkDown(i);
  }

  private refreshInk(): void {
    this.inkBtns.forEach((b, i) => b.setVariant(i === this.inkIndex ? 'primary' : 'quiet'));
  }

  // ---- finish ------------------------------------------------------------

  private finish(): void {
    if (this.finishing || this.phase !== 'draw') return;
    if (this.clock.sweepIndex() < DRAW_MIN_SWEEPS && this.clock.sweeps() < DRAW_SWEEPS) {
      this.toast.show(`draw for ${DRAW_MIN_SWEEPS} sweeps first`, 1500, TX.warn);
      return;
    }
    this.finishing = true;
    this.clock.setPaused(true);
    this.endStroke();

    const w = this.word;
    if (!w) return;
    // Round the replay length up to a whole number of rotations so the loop
    // seam always falls with the hand at 12 o'clock and is therefore invisible.
    const sweepsUsed = Math.max(DRAW_MIN_SWEEPS, Math.ceil(this.clock.now() / SWEEP_PERIOD));
    const rec: Recording = {
      length: Math.min(DRAW_SWEEPS, sweepsUsed) * SWEEP_PERIOD,
      strokes: this.strokes,
    };
    const r = readability(this.stats);
    sfx.post();
    this.scene.start(Scenes.Post, { word: w, recording: rec, readability: r });
  }

  private openPause(): void {
    if (this.finishing) return;
    this.scene.pause();
    this.scene.launch(Scenes.Pause, { caller: Scenes.Draw });
  }

  // ---- readouts ----------------------------------------------------------

  private refreshSweepReadout(): void {
    const done = Math.min(DRAW_SWEEPS, this.clock.sweeps());
    const left = Math.max(0, DRAW_SWEEPS * SWEEP_PERIOD - this.clock.now());
    const urgent = done >= DRAW_SWEEPS - 1;
    this.sweepText
      .setText(`SWEEP ${Math.min(DRAW_SWEEPS, Math.floor(done) + 1)}/${DRAW_SWEEPS}  ·  ${(left / 1000).toFixed(1)}s`)
      .setColor(urgent ? TX.warn : TX.dim);
    this.topLeft.setText(`DRAWING LINK #${chain().head().n + 1}  ·  ${this.points} pts of ink`);
  }

  /** Ring around the dial showing how much of the session is spent. */
  private drawRing(): void {
    const f = this.frame;
    if (!f) return;
    const { x: cx, y: cy, r } = this.face.center;
    const g = this.ringGfx;
    const p = Math.min(1, this.clock.now() / (DRAW_SWEEPS * SWEEP_PERIOD));
    g.clear();
    g.lineStyle(3 * f.ui, T.panelEdge, 0.8);
    g.strokeCircle(cx, cy, r + 8 * f.ui);
    const colour = p > 0.84 ? T.warn : p > 0.6 ? T.gold : T.hand;
    g.lineStyle(3 * f.ui, colour, 1);
    g.beginPath();
    g.arc(cx, cy, r + 8 * f.ui, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2, false);
    g.strokePath();

    // Tick per completed sweep, so the six passes are countable at a glance.
    for (let i = 1; i < DRAW_SWEEPS; i++) {
      const a = polar((i / DRAW_SWEEPS) * 360, r + 8 * f.ui);
      g.fillStyle(T.bg, 1);
      g.fillCircle(cx + a.x, cy + a.y, 2.4 * f.ui);
    }
  }

  // ---- layout ------------------------------------------------------------

  protected layout(f: Frame): void {
    const { cx, cy, r } = f.clock;
    this.face.setGeometry(cx, cy, r);
    this.ink.setGeometry(cx, cy, r);
    this.ghost.setGeometry(cx, cy, r);

    const topY = f.y + f.topBarH / 2;
    this.topLeft.setFontSize(Math.round(10.5 * f.ui)).setPosition(f.x, topY);
    const btnW = 44 * f.ui;
    this.pauseBtn
      .layout(f.x + f.iw - btnW / 2, topY, btnW, 30 * f.ui)
      .setFontSize(Math.round(13 * f.ui));

    const p = f.panel;
    const pad = 8 * f.ui;
    const btnH = Math.max(46 * f.ui, Math.min(58 * f.ui, p.h * 0.24));

    this.wordText.setFontSize(Math.round(20 * f.ui)).setPosition(p.x + p.w / 2, p.y + 20 * f.ui);
    this.sweepText.setFontSize(Math.round(12 * f.ui)).setPosition(p.x + p.w / 2, p.y + 46 * f.ui);
    this.hintText.setFontSize(Math.round(10.5 * f.ui)).setPosition(p.x + p.w / 2, p.y + 68 * f.ui);

    // Ink swatches sit above the Done button, thumb-height on both layouts.
    const swRowY = p.y + p.h - btnH - pad - btnH * 0.82 / 2;
    const swW = Math.min((p.w - pad * 4) / 3, 150 * f.ui);
    this.inkBtns.forEach((b, i) => {
      b.layout(
        p.x + p.w / 2 + (i - 1) * (swW + pad),
        swRowY,
        swW,
        btnH * 0.82,
      ).setFontSize(Math.round(11 * f.ui));
    });
    this.doneBtn
      .layout(p.x + p.w / 2, p.y + p.h - btnH / 2, Math.min(p.w - pad * 2, 420 * f.ui), btnH)
      .setFontSize(Math.round(16 * f.ui));

    this.toast.layout(f.x + f.iw / 2, f.y + f.topBarH + 20 * f.ui, Math.round(12 * f.ui));
    this.layoutChooser(f);
    this.drawRing();
    this.refreshSweepReadout();
  }

  private layoutChooser(f: Frame): void {
    const w = Math.min(f.iw - 16 * f.ui, 440 * f.ui);
    const btnH = Math.max(48 * f.ui, Math.min(58 * f.ui, f.ih * 0.11));
    const h = Math.min(f.ih - 20 * f.ui, 106 * f.ui + btnH * 3 + 24 * f.ui);
    const x = f.x + (f.iw - w) / 2;
    const y = f.y + (f.ih - h) / 2;

    const g = this.chooserPlate;
    g.clear();
    g.fillStyle(0x04070d, 0.92);
    g.fillRect(0, 0, f.w, f.h);
    g.fillStyle(T.panel, 0.98);
    g.fillRoundedRect(x, y, w, h, 16 * f.ui);
    g.lineStyle(2, T.gold, 0.85);
    g.strokeRoundedRect(x, y, w, h, 16 * f.ui);

    this.chooserTitle.setFontSize(Math.round(17 * f.ui)).setPosition(x + w / 2, y + 32 * f.ui);
    this.chooserSub.setFontSize(Math.round(11 * f.ui)).setPosition(x + w / 2, y + 60 * f.ui);
    this.choiceBtns.forEach((b, i) => {
      b.layout(
        x + w / 2,
        y + 92 * f.ui + btnH / 2 + i * (btnH + 8 * f.ui),
        w - 32 * f.ui,
        btnH,
      ).setFontSize(Math.round(14 * f.ui));
    });
  }
}
