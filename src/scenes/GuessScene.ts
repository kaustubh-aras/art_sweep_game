import Phaser from 'phaser';
import { Scenes } from '@/game/constants';
import { T, TX, FONT } from '@/ui/theme';
import type { Frame } from '@/ui/layout';
import { Button } from '@/ui/Button';
import { Keyboard } from '@/ui/Keyboard';
import { Toast } from '@/ui/Toast';
import { SweepClock } from '@/sweep/clock';
import { ClockFace, heatCell, polar } from '@/sweep/clockFace';
import { InkLayer } from '@/sweep/inkLayer';
import { Replayer } from '@/sweep/replay';
import { chain, run } from '@/sweep/session';
import type { ChainLink } from '@/sweep/chain';
import { isCorrect, letterCount, letterPattern } from '@/sweep/words';
import { decayProgress, formatClock, lockoutMs, solverPoints } from '@/sweep/scoring';
import { GUESS_CAP, SWEEP_PERIOD, BATON_WINDOW, POINTS_WINDOW } from '@/sweep/tuning';
import { sfx } from '@/audio/AudioManager';
import { SweepScene } from './SweepScene';

const D = {
  dial: 1,
  heat: 2,
  ink: 3,
  hand: 4,
  marks: 5,
  hud: 10,
  panel: 20,
  overlay: 60,
  overlayText: 62,
} as const;

/**
 * Screen 2 (GDD §7): the replay and the guess.
 *
 * Everything on this screen is the timer. The dial is the clock and the
 * eraser; the points bar is the clock spending your score; the lockout after a
 * wrong guess is measured in sweeps, not seconds, so being wrong literally
 * costs you a rotation of the picture.
 */
export class GuessScene extends SweepScene {
  private clock = new SweepClock();
  private face!: ClockFace;
  private ink!: InkLayer;
  private replay!: Replayer;
  private link!: ChainLink;

  // ---- round state (all reset by init(), so restarts are clean) ----
  private typed = '';
  private hotSpot: number | null = null;
  private wrong = 0;
  private guesses = 0;
  private lockUntil = 0;
  private solved = false;
  private finishing = false;
  private lastPipBucket = -1;
  private lastLockSecond = -1;
  private watchers = 0;
  private spacedOnce = false;

  // ---- display ----
  private topLeft!: Phaser.GameObjects.Text;
  private topMid!: Phaser.GameObjects.Text;
  private pauseBtn!: Button;
  private heatBtn!: Button;
  private barGfx!: Phaser.GameObjects.Graphics;
  private pointsText!: Phaser.GameObjects.Text;
  private patternText!: Phaser.GameObjects.Text;
  private infoText!: Phaser.GameObjects.Text;
  private promptText!: Phaser.GameObjects.Text;
  private promptRing!: Phaser.GameObjects.Graphics;
  private marks!: Phaser.GameObjects.Graphics;
  private keyboard!: Keyboard;
  private guessBtn!: Button;
  private toast!: Toast;
  private burst!: Phaser.GameObjects.Particles.ParticleEmitter;

  // ---- solved overlay ----
  private overlay!: Phaser.GameObjects.Container;
  private overlayPlate!: Phaser.GameObjects.Graphics;
  private overlayTitle!: Phaser.GameObjects.Text;
  private overlayBody!: Phaser.GameObjects.Text;
  private overlayBaton!: Phaser.GameObjects.Text;
  private drawBtn!: Button;
  private passBtn!: Button;
  private batonLeft = BATON_WINDOW;

  private barRect = { x: 0, y: 0, w: 10, h: 10 };

  constructor() {
    super(Scenes.Guess);
  }

  init(data: { linkN?: number }): void {
    const c = chain();
    const found = c.links.find((l) => l.n === data?.linkN);
    this.link = found ?? c.nextForPlayer() ?? c.head();

    this.clock.reset();
    this.typed = '';
    this.hotSpot = null;
    this.wrong = 0;
    this.guesses = 0;
    this.lockUntil = 0;
    this.solved = false;
    this.finishing = false;
    this.lastPipBucket = -1;
    this.lastLockSecond = -1;
    this.spacedOnce = false;
    this.batonLeft = BATON_WINDOW;
    this.watchers = 2 + ((this.link.n * 7) % 9);
  }

  create(): void {
    const c = chain();

    this.face = new ClockFace(this, D.dial, D.heat, D.hand);
    this.ink = new InkLayer(this, D.ink);
    this.replay = new Replayer(c.recordingFor(this.link), this.ink);
    this.marks = this.add.graphics().setDepth(D.marks);

    this.buildHud();
    this.buildPanel();
    this.buildOverlay();

    this.toast = new Toast(this, D.overlayText);
    this.burst = this.add
      .particles(0, 0, 'dot', {
        speed: { min: 60, max: 260 },
        angle: { min: 0, max: 360 },
        lifespan: { min: 260, max: 620 },
        scale: { start: 0.7, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [T.hand, T.gold, 0xffffff],
        emitting: false,
      })
      .setDepth(D.overlay);

    this.bindInput();
    this.startLayout();
    this.fadeIn();
    this.enableAudioUnlock();
    sfx.startMusic();

    // Coming back from the pause overlay must not leave the clock behind — and
    // the listeners are torn down on shutdown so a restart never stacks them.
    const onPause = () => this.clock.setPaused(true);
    const onResume = () => this.clock.setPaused(false);
    this.events.on(Phaser.Scenes.Events.PAUSE, onPause);
    this.events.on(Phaser.Scenes.Events.RESUME, onResume);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      sfx.stopMusic();
      this.events.off(Phaser.Scenes.Events.PAUSE, onPause);
      this.events.off(Phaser.Scenes.Events.RESUME, onResume);
    });
  }

  update(_t: number, delta: number): void {
    this.clock.advance(delta);
    const hand = this.clock.handAngle();

    this.replay.update(this.clock.now());
    this.ink.update(hand);
    this.face.update(hand);
    sfx.updateMusic(this.clock.sweepPhase(), this.clock.now() / 1000);

    if (this.solved) {
      this.updateBaton(delta);
      return;
    }

    this.updateDecay();
    this.updateLockout();
  }

  // ---- HUD ---------------------------------------------------------------

  private buildHud(): void {
    this.topLeft = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '11px', color: TX.dim })
      .setOrigin(0, 0.5)
      .setDepth(D.hud);
    this.topMid = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '11px', color: TX.faint })
      .setOrigin(0.5, 0.5)
      .setDepth(D.hud);
    this.pauseBtn = new Button(this, {
      label: '❙❙',
      variant: 'quiet',
      onClick: () => this.openPause(),
    }).setDepth(D.hud);
    this.heatBtn = new Button(this, {
      label: 'HEAT',
      variant: 'quiet',
      onClick: () => this.toggleHeat(),
    }).setDepth(D.hud);

    this.barGfx = this.add.graphics().setDepth(D.hud);
    this.pointsText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '20px', color: TX.green })
      .setOrigin(0.5, 0.5)
      .setDepth(D.hud);

    this.promptRing = this.add.graphics().setDepth(D.marks);
    this.promptText = this.add
      .text(0, 0, 'TAP WHERE YOU SAW SOMETHING', {
        fontFamily: FONT,
        fontSize: '11px',
        color: TX.gold,
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(D.marks);
    this.tweens.add({
      targets: this.promptText,
      alpha: { from: 1, to: 0.35 },
      duration: 900,
      yoyo: true,
      repeat: -1,
    });
  }

  private buildPanel(): void {
    this.patternText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '20px', color: TX.text })
      .setOrigin(0.5, 0.5)
      .setDepth(D.panel);
    this.infoText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '10px', color: TX.faint })
      .setOrigin(0.5, 0.5)
      .setDepth(D.panel);

    this.keyboard = new Keyboard(this).setDepth(D.panel);
    this.keyboard.on('key', (ch: string) => this.typeChar(ch));
    this.keyboard.on('del', () => this.backspace());

    this.guessBtn = new Button(this, {
      label: 'GUESS',
      variant: 'primary',
      onClick: () => this.submit(),
    }).setDepth(D.panel);

    this.keyboard.setEnabled(false);
    this.guessBtn.setEnabled(false);
    this.refreshPattern();
  }

  private buildOverlay(): void {
    this.overlayPlate = this.add.graphics();
    this.overlayTitle = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '22px', color: TX.green })
      .setOrigin(0.5);
    this.overlayBody = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '12px', color: TX.text, align: 'center' })
      .setOrigin(0.5);
    this.overlayBaton = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '11px', color: TX.gold, align: 'center' })
      .setOrigin(0.5);
    this.drawBtn = new Button(this, {
      label: 'DRAW THE NEXT WORD',
      variant: 'gold',
      onClick: () => this.takeBaton(),
    });
    this.passBtn = new Button(this, {
      label: 'PASS THE BATON',
      variant: 'quiet',
      onClick: () => this.passBaton(),
    });

    this.overlay = this.add
      .container(0, 0, [
        this.overlayPlate,
        this.overlayTitle,
        this.overlayBody,
        this.overlayBaton,
        this.drawBtn,
        this.passBtn,
      ])
      .setDepth(D.overlay)
      .setVisible(false);
  }

  // ---- input -------------------------------------------------------------

  private bindInput(): void {
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      sfx.unlock();
      if (this.solved || this.hotSpot !== null) return;
      if (!this.face.contains(p.x, p.y)) return;
      this.setHotSpot(p.x, p.y);
    });

    const kb = this.input.keyboard;
    if (!kb) return;
    kb.on('keydown', (e: KeyboardEvent) => {
      if (this.solved) {
        if (e.key === 'Enter') this.takeBaton();
        return;
      }
      if (e.key === 'Escape') {
        this.openPause();
        return;
      }
      if (e.key === 'Enter') {
        this.submit();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        this.backspace();
        return;
      }
      if (/^[a-zA-Z]$/.test(e.key)) this.keyboard.pressPhysical(e.key.toLowerCase());
    });
  }

  private setHotSpot(px: number, py: number): void {
    const u = this.face.toUnit(px, py);
    this.hotSpot = heatCell(u.x, u.y);
    sfx.stamp();
    this.burst.explode(14, px, py);
    this.cameras.main.shake(90, 0.004);

    this.tweens.add({ targets: [this.promptText, this.promptRing], alpha: 0, duration: 240 });
    this.keyboard.setEnabled(true);
    this.refreshGuessButton();
    this.drawMarks();
    this.toast.show('hot spot logged — now guess', 1400, TX.gold);
  }

  private typeChar(ch: string): void {
    if (this.solved || this.isLocked()) return;
    if (ch === ' ') {
      if (!this.spacedOnce) {
        this.spacedOnce = true;
        this.toast.show('spaces are filled in for you', 1500, TX.dim);
      }
      return;
    }
    if (this.typed.length >= letterCount(this.link.word)) return;
    this.typed += ch;
    this.refreshPattern();
    this.refreshGuessButton();
  }

  private backspace(): void {
    if (this.solved || this.isLocked() || this.typed.length === 0) return;
    this.typed = this.typed.slice(0, -1);
    this.refreshPattern();
    this.refreshGuessButton();
  }

  private submit(): void {
    if (this.solved || this.isLocked() || this.typed.length === 0) return;
    this.guesses++;

    if (isCorrect(this.typed, this.link.word)) {
      this.onSolved();
      return;
    }

    this.wrong++;
    this.typed = '';
    this.refreshPattern();
    this.refreshGuessButton();

    if (this.guesses >= GUESS_CAP) {
      this.onFailed();
      return;
    }

    this.lockUntil = this.clock.now() + lockoutMs(this.wrong);
    this.lastLockSecond = -1;
    this.keyboard.setEnabled(false);
    this.guessBtn.setEnabled(false);
    sfx.wrong();
    sfx.lockout();
    this.cameras.main.shake(180, 0.009);
    this.cameras.main.flash(120, 60, 8, 16);
    const sweeps = Math.round(lockoutMs(this.wrong) / SWEEP_PERIOD);
    this.toast.show(`WRONG · locked for ${sweeps} sweep${sweeps > 1 ? 's' : ''}`, 1800, TX.warn);
  }

  // ---- round outcomes ----------------------------------------------------

  private onSolved(): void {
    this.solved = true;
    const c = chain();
    const ms = this.clock.now();
    const points = solverPoints(ms);
    const bounty = c.bounty(this.link);
    const solverNo = this.link.solvers.length + 1;

    c.registerSolve(this.link, ms, this.hotSpot ?? 0, points, bounty);
    run.solved.push({ n: this.link.n, word: this.link.word, ms, points, bounty });

    this.keyboard.setEnabled(false);
    this.guessBtn.setEnabled(false);
    this.patternText.setText(this.link.word.toUpperCase().split('').join(' ')).setColor(TX.green);

    sfx.solve();
    this.cameras.main.flash(260, 20, 90, 60);
    this.cameras.main.shake(160, 0.006);
    const spot = this.hotSpotScreen();
    this.burst.explode(46, spot.x, spot.y);
    this.drawMarks();

    const complete = run.linksSolved >= run.target;
    this.overlayTitle.setText(complete ? 'CHAIN COMPLETE' : 'SOLVED');
    this.overlayBody.setText(
      `${this.link.word.toUpperCase()}  in  ${formatClock(ms)}\n` +
        `+${points} points${bounty > 0 ? `   ·   CRACK BOUNTY +${bounty}` : ''}\n` +
        `solver #${solverNo} on chain #${this.link.n}   ·   drawn by u/${this.link.drawer}`,
    );

    if (complete) {
      this.drawBtn.setLabel('SEE THE RESULTS').setVariant('primary');
      this.overlayBaton.setText('you carried the chain all the way');
      this.passBtn.setEnabled(false).setVisible(false);
    } else {
      this.drawBtn.setLabel('DRAW THE NEXT WORD').setVariant('gold');
      this.passBtn.setEnabled(true).setVisible(true);
      this.time.delayedCall(420, () => sfx.baton());
    }

    this.showOverlay();
  }

  private onFailed(): void {
    if (this.finishing) return;
    this.finishing = true;
    this.keyboard.setEnabled(false);
    this.guessBtn.setEnabled(false);
    sfx.fail();
    this.cameras.main.shake(320, 0.014);
    this.toast.show(`OUT OF GUESSES · it was ${this.link.word.toUpperCase()}`, 2200, TX.warn);
    run.finish('broken', this.link.word);
    chain().finishRun(run.linksSolved);
    this.time.delayedCall(1500, () => this.scene.start(Scenes.Results));
  }

  /** Called by the pause menu's Give up. */
  giveUp(): void {
    if (this.finishing || this.solved) return;
    this.finishing = true;
    run.finish('broken', this.link.word);
    chain().finishRun(run.linksSolved);
    this.scene.start(Scenes.Results);
  }

  private takeBaton(): void {
    if (this.finishing) return;
    this.finishing = true;
    if (run.linksSolved >= run.target) {
      run.finish('complete');
      chain().finishRun(run.linksSolved);
      this.scene.start(Scenes.Results);
      return;
    }
    this.scene.start(Scenes.Draw, { fromLinkN: this.link.n });
  }

  private passBaton(): void {
    if (this.finishing) return;
    this.finishing = true;
    const next = chain().nextForPlayer(run.served);
    if (!next) {
      run.finish('complete');
      chain().finishRun(run.linksSolved);
      this.scene.start(Scenes.Results);
      return;
    }
    run.serve(next);
    this.scene.start(Scenes.Guess, { linkN: next.n });
  }

  private openPause(): void {
    if (this.solved || this.finishing) return;
    this.scene.pause();
    this.scene.launch(Scenes.Pause, { caller: Scenes.Guess });
  }

  private toggleHeat(): void {
    if (this.face.heatVisible()) {
      this.face.hideHeat();
      this.heatBtn.setVariant('quiet');
      return;
    }
    const cells = new Map<number, number>();
    for (const [k, v] of Object.entries(this.link.heat)) cells.set(Number(k), v);
    if (this.hotSpot !== null) cells.set(this.hotSpot, (cells.get(this.hotSpot) ?? 0) + 1);
    if (cells.size === 0) {
      this.toast.show('nobody has looked here yet', 1400, TX.dim);
      return;
    }
    this.face.showHeat(cells);
    this.heatBtn.setVariant('gold');
  }

  // ---- per-frame updates -------------------------------------------------

  private updateDecay(): void {
    const elapsed = this.clock.now();
    const p = decayProgress(elapsed);
    const points = solverPoints(elapsed);
    this.drawBar(p, points);

    // The decay tick accelerates through the last fifth of the bar (GDD §8).
    if (p > 0.8 && p < 1) {
      const urgency = (p - 0.8) / 0.2;
      const rate = 900 - urgency * 620; // ms between pips
      const bucket = Math.floor((elapsed - POINTS_WINDOW * 0.8) / rate);
      if (bucket !== this.lastPipBucket) {
        this.lastPipBucket = bucket;
        sfx.decayPip(urgency);
        this.tweens.add({
          targets: this.pointsText,
          scale: { from: 1.18, to: 1 },
          duration: 180,
          ease: 'Quad.easeOut',
        });
      }
    } else if (p >= 1 && this.lastPipBucket !== -2) {
      // Floor reached: one last hit, then the bar stops nagging.
      this.lastPipBucket = -2;
      sfx.countdown(true);
      this.cameras.main.flash(160, 70, 12, 20);
      this.toast.show('points floored at 10 — solve it anyway', 1900, TX.warn);
    }
  }

  private updateLockout(): void {
    if (!this.isLocked()) {
      if (this.lockUntil > 0) {
        // Just came free.
        this.lockUntil = 0;
        if (this.hotSpot !== null) this.keyboard.setEnabled(true);
        this.refreshGuessButton();
        this.toast.show('unlocked', 900, TX.green);
        sfx.select();
      }
      this.refreshInfo();
      return;
    }
    const left = this.lockUntil - this.clock.now();
    const sec = Math.ceil(left / 1000);
    if (sec !== this.lastLockSecond) {
      this.lastLockSecond = sec;
      if (sec <= 3) sfx.countdown(sec <= 1);
    }
    this.refreshInfo();
  }

  private updateBaton(delta: number): void {
    if (run.linksSolved >= run.target) return;
    this.batonLeft = Math.max(0, this.batonLeft - delta);
    const total = Math.floor(this.batonLeft / 1000);
    const mm = Math.floor(total / 60);
    const ss = String(total % 60).padStart(2, '0');
    this.overlayBaton.setText(`YOU HOLD THE BATON  ·  ${mm}:${ss}`);
    if (this.batonLeft <= 0) this.passBaton();
  }

  private isLocked(): boolean {
    return this.lockUntil > this.clock.now();
  }

  // ---- text + drawing ----------------------------------------------------

  private refreshPattern(): void {
    let revealed = '';
    let i = 0;
    for (const ch of this.link.word) {
      if (ch === ' ') revealed += ' ';
      else revealed += this.typed[i++] ?? '_';
    }
    this.patternText.setText(letterPattern(this.link.word, revealed.toUpperCase()));
  }

  private refreshGuessButton(): void {
    this.guessBtn.setEnabled(!this.solved && !this.isLocked() && this.typed.length > 0);
  }

  private refreshInfo(): void {
    if (this.solved) return;
    if (this.isLocked()) {
      const left = Math.max(0, this.lockUntil - this.clock.now());
      this.infoText
        .setText(`LOCKED OUT  ·  ${formatClock(left)}  ·  the hand keeps turning`)
        .setColor(TX.warn);
      return;
    }
    const left = GUESS_CAP - this.guesses;
    this.infoText
      .setText(
        `${letterCount(this.link.word)} LETTERS  ·  ${this.link.category.toUpperCase()}  ·  ${left} GUESS${left === 1 ? '' : 'ES'} LEFT`,
      )
      .setColor(left <= 3 ? TX.warn : TX.faint);
  }

  private refreshTop(): void {
    this.topLeft.setText(`LINK ${run.linksSolved + 1}/${run.target}  ·  #${this.link.n}`);
    this.topMid.setText(
      `u/${this.link.drawer}  ·  ${this.watchers} WATCHING  ·  ${run.score} PTS`,
    );
  }

  private drawBar(p: number, points: number): void {
    const { x, y, w, h } = this.barRect;
    const g = this.barGfx;
    const colour = p > 0.8 ? T.warn : p > 0.5 ? T.gold : T.hand;
    const hexColour = p > 0.8 ? TX.warn : p > 0.5 ? TX.gold : TX.green;
    g.clear();
    g.fillStyle(T.panelEdge, 0.55);
    g.fillRoundedRect(x, y, w, h, h / 2);
    g.fillStyle(colour, 1);
    g.fillRoundedRect(x, y, Math.max(h, w * (1 - p)), h, h / 2);
    // Urgency pulse rides on the bar itself once it is nearly spent.
    if (p > 0.8) {
      const pulse = 0.25 + 0.25 * Math.sin(this.clock.now() / 90);
      g.fillStyle(colour, pulse);
      g.fillRoundedRect(x - 3, y - 3, w + 6, h + 6, (h + 6) / 2);
    }
    this.pointsText.setText(`${points}`).setColor(hexColour);
    this.refreshTop();
  }

  /** Solver pips around the rim plus the player's own hot spot. */
  private drawMarks(): void {
    const f = this.frame;
    if (!f) return;
    const { x: cx, y: cy, r } = this.face.center;
    const g = this.marks;
    g.clear();

    const solvers = this.link.solvers;
    for (let i = 0; i < solvers.length; i++) {
      const deg = (i / Math.max(8, solvers.length)) * 360;
      const p = polar(deg, r + 9 * f.ui);
      const mine = solvers[i].name === 'you';
      g.fillStyle(mine ? T.gold : T.tick, mine ? 1 : 0.7);
      g.fillCircle(cx + p.x, cy + p.y, (mine ? 4 : 2.6) * f.ui);
    }

    if (this.hotSpot !== null) {
      const s = this.hotSpotScreen();
      g.lineStyle(2 * f.ui, T.gold, 0.9);
      g.strokeCircle(s.x, s.y, 9 * f.ui);
      g.fillStyle(T.gold, 0.9);
      g.fillCircle(s.x, s.y, 2.5 * f.ui);
    }
  }

  private hotSpotScreen(): { x: number; y: number } {
    const { x: cx, y: cy } = this.face.center;
    if (this.hotSpot === null) return { x: cx, y: cy };
    const grid = 24;
    const gx = this.hotSpot % grid;
    const gy = Math.floor(this.hotSpot / grid);
    const ux = ((gx + 0.5) / grid) * 2 - 1;
    const uy = ((gy + 0.5) / grid) * 2 - 1;
    return this.face.toScreen(ux, uy);
  }

  private showOverlay(): void {
    this.overlay.setVisible(true).setAlpha(0);
    this.layoutOverlay(this.frame);
    this.tweens.add({ targets: this.overlay, alpha: 1, duration: 280, ease: 'Quad.easeOut' });
  }

  // ---- layout ------------------------------------------------------------

  protected layout(f: Frame): void {
    const { cx, cy, r } = f.clock;
    this.face.setGeometry(cx, cy, r);
    this.ink.setGeometry(cx, cy, r);

    // Top bar.
    const topY = f.y + f.topBarH / 2;
    this.topLeft.setFontSize(Math.round(10.5 * f.ui)).setPosition(f.x, topY);
    this.topMid.setFontSize(Math.round(10 * f.ui)).setPosition(f.x + f.iw / 2, topY + f.topBarH * 0.42);
    const btnW = 44 * f.ui;
    this.pauseBtn
      .layout(f.x + f.iw - btnW / 2, topY, btnW, 30 * f.ui)
      .setFontSize(Math.round(13 * f.ui));
    this.heatBtn
      .layout(f.x + f.iw - btnW - 46 * f.ui, topY, 56 * f.ui, 30 * f.ui)
      .setFontSize(Math.round(10 * f.ui));

    // Points bar sits directly under the dial: the score visibly draining.
    const barW = Math.min(f.portrait ? f.iw * 0.74 : r * 2, 320 * f.ui);
    const barH = Math.max(8, 11 * f.ui);
    this.barRect = {
      x: cx - barW / 2,
      y: cy + r + (f.portrait ? 22 : 18) * f.ui,
      w: barW,
      h: barH,
    };
    this.pointsText
      .setFontSize(Math.round(19 * f.ui))
      .setPosition(cx, this.barRect.y + barH + 18 * f.ui);

    this.promptText.setFontSize(Math.round(11 * f.ui)).setPosition(cx, cy + r * 0.52);
    this.promptRing.clear();
    if (this.hotSpot === null) {
      this.promptRing.lineStyle(1.5 * f.ui, T.gold, 0.35);
      this.promptRing.strokeCircle(cx, cy, r * 0.68);
    }

    // Panel: letter pattern, meta line, keyboard, submit.
    const p = f.panel;
    const pad = 6 * f.ui;
    const btnH = Math.max(46 * f.ui, Math.min(56 * f.ui, p.h * 0.22));
    const patternH = 30 * f.ui;
    const infoH = 16 * f.ui;
    const kbMax = Math.max(60, p.h - btnH - patternH - infoH - pad * 3);
    const kbH = Math.min(kbMax, Keyboard.heightFor(p.w - pad * 2, kbMax));

    let cursor = p.y + (p.h - (patternH + infoH + kbH + btnH + pad * 3)) / 2;
    // Fit the letter pattern to the panel: monospace glyphs are ~0.62em wide.
    const chars = Math.max(4, this.patternText.text.length);
    const fit = (p.w - pad * 4) / (chars * 0.62);
    this.patternText
      .setFontSize(Math.round(Math.max(11 * f.ui, Math.min(24 * f.ui, fit))))
      .setPosition(p.x + p.w / 2, cursor + patternH / 2);
    cursor += patternH + pad;
    this.infoText.setFontSize(Math.round(10 * f.ui)).setPosition(p.x + p.w / 2, cursor + infoH / 2);
    cursor += infoH + pad;
    this.keyboard.layout(p.x + pad, cursor, p.w - pad * 2, kbH);
    cursor += kbH + pad;
    this.guessBtn
      .layout(p.x + p.w / 2, cursor + btnH / 2, Math.min(p.w - pad * 2, 420 * f.ui), btnH)
      .setFontSize(Math.round(16 * f.ui));

    this.toast.layout(f.x + f.iw / 2, f.y + f.topBarH + 22 * f.ui, Math.round(12 * f.ui));
    this.drawMarks();
    this.refreshPattern();
    this.refreshInfo();
    this.refreshTop();
    this.drawBar(decayProgress(this.clock.now()), solverPoints(this.clock.now()));
    if (this.overlay.visible) this.layoutOverlay(f);
  }

  private layoutOverlay(f: Frame): void {
    const w = Math.min(f.iw - 16 * f.ui, 460 * f.ui);
    const h = Math.min(f.ih - 24 * f.ui, 300 * f.ui);
    const x = f.x + (f.iw - w) / 2;
    const y = f.y + (f.ih - h) / 2;

    const g = this.overlayPlate;
    g.clear();
    g.fillStyle(0x04070d, 0.9);
    g.fillRect(0, 0, f.w, f.h);
    g.fillStyle(T.panel, 0.98);
    g.fillRoundedRect(x, y, w, h, 16 * f.ui);
    g.lineStyle(2, T.hand, 0.85);
    g.strokeRoundedRect(x, y, w, h, 16 * f.ui);

    const complete = run.linksSolved >= run.target;
    const btnH = Math.max(46 * f.ui, Math.min(54 * f.ui, h * 0.18));
    this.overlayTitle.setFontSize(Math.round(22 * f.ui)).setPosition(x + w / 2, y + h * 0.16);
    this.overlayBody
      .setFontSize(Math.round(12 * f.ui))
      .setLineSpacing(6 * f.ui)
      .setPosition(x + w / 2, y + h * 0.42);
    this.overlayBaton.setFontSize(Math.round(11 * f.ui)).setPosition(x + w / 2, y + h * 0.63);

    const bw = Math.min(w - 32 * f.ui, 380 * f.ui);
    if (complete) {
      this.drawBtn.layout(x + w / 2, y + h - btnH * 0.9, bw, btnH).setFontSize(Math.round(15 * f.ui));
    } else {
      this.drawBtn
        .layout(x + w / 2, y + h - btnH * 1.7, bw, btnH)
        .setFontSize(Math.round(15 * f.ui));
      this.passBtn
        .layout(x + w / 2, y + h - btnH * 0.6, bw, btnH * 0.78)
        .setFontSize(Math.round(12 * f.ui));
    }
  }
}
