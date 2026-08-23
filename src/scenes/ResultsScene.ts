import Phaser from 'phaser';
import { Scenes } from '@/game/constants';
import { T, TX, FONT } from '@/ui/theme';
import type { Frame } from '@/ui/layout';
import { Button } from '@/ui/Button';
import { SweepClock } from '@/sweep/clock';
import { ClockFace, polar } from '@/sweep/clockFace';
import { chain, run } from '@/sweep/session';
import { formatClock } from '@/sweep/scoring';
import { sfx } from '@/audio/AudioManager';
import { SweepScene } from './SweepScene';

const D = { dial: 1, hand: 4, marks: 5, hud: 10, panel: 20 } as const;

/**
 * The run is over (GDD §7 screens 3 and 7).
 *
 * One screen, two very different faces. A completed chain gets the green dial,
 * a rising fanfare and every link stamped around the rim; a broken chain gets
 * the red dial, the word you never got, and the stamps stop where you did.
 */
export class ResultsScene extends SweepScene {
  private clock = new SweepClock();
  private face!: ClockFace;
  private marks!: Phaser.GameObjects.Graphics;

  private title!: Phaser.GameObjects.Text;
  private sub!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private plate!: Phaser.GameObjects.Graphics;
  private breakdown!: Phaser.GameObjects.Text;
  private bestText!: Phaser.GameObjects.Text;
  private againBtn!: Button;
  private menuBtn!: Button;
  private won = false;
  private revealed = 0;

  constructor() {
    super(Scenes.Results);
  }

  init(): void {
    this.won = run.outcome === 'complete';
    this.revealed = 0;
    this.clock.reset();
  }

  create(): void {
    this.face = new ClockFace(this, D.dial, D.dial, D.hand);
    this.marks = this.add.graphics().setDepth(D.marks);

    this.title = this.add
      .text(0, 0, this.won ? 'CHAIN COMPLETE' : 'CHAIN BROKEN', {
        fontFamily: FONT,
        fontSize: '26px',
        color: this.won ? TX.green : TX.warn,
      })
      .setOrigin(0.5)
      .setDepth(D.hud);
    this.sub = this.add
      .text(0, 0, '', {
        fontFamily: FONT,
        fontSize: '11px',
        color: TX.dim,
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(D.hud);
    this.scoreText = this.add
      .text(0, 0, '0', { fontFamily: FONT, fontSize: '40px', color: TX.gold })
      .setOrigin(0.5)
      .setDepth(D.hud);

    this.plate = this.add.graphics().setDepth(D.panel - 1);
    this.breakdown = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '11px', color: TX.text })
      .setOrigin(0, 0)
      .setDepth(D.panel);
    this.bestText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '10px', color: TX.faint, align: 'center' })
      .setOrigin(0.5)
      .setDepth(D.panel);

    this.againBtn = new Button(this, {
      label: '↻  RUN IT AGAIN',
      variant: 'primary',
      onClick: () => this.again(),
    }).setDepth(D.panel);
    this.menuBtn = new Button(this, {
      label: 'BACK TO THE FEED',
      variant: 'ghost',
      onClick: () => this.scene.start(Scenes.Menu),
    }).setDepth(D.panel);

    this.refreshText();
    this.startLayout();
    this.fadeIn(320);
    this.enableAudioUnlock();

    // Count the score up rather than printing it: the run's last little beat.
    const target = run.score;
    this.tweens.addCounter({
      from: 0,
      to: target,
      duration: 900,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => this.scoreText.setText(`${Math.round(tw.getValue() ?? 0)}`),
      onComplete: () => this.scoreText.setText(`${target}`),
    });

    // Stamp each solved link around the rim, one beat at a time.
    if (run.solved.length > 0) {
      this.time.addEvent({
        delay: 260,
        repeat: run.solved.length - 1,
        callback: () => {
          this.revealed++;
          sfx.stamp();
          this.drawMarks();
        },
      });
    }
    this.time.delayedCall(260, () => (this.won ? sfx.victory() : sfx.fail()));
  }

  update(_t: number, delta: number): void {
    this.clock.advance(delta);
    this.face.update(this.clock.handAngle(), this.won ? 1 : 0.5);
  }

  private again(): void {
    run.start();
    const link = chain().nextForPlayer();
    if (!link) {
      this.scene.start(Scenes.Menu);
      return;
    }
    run.serve(link);
    this.scene.start(Scenes.Guess, { linkN: link.n });
  }

  private refreshText(): void {
    const p = chain().profile;
    this.sub.setText(
      this.won
        ? `you carried ${run.linksSolved} links and drew ${run.drawn.length}`
        : run.failedWord
          ? `it was "${run.failedWord.toUpperCase()}" — the baton fell open`
          : 'the baton fell open',
    );

    const best = run.bestSolveMs;
    const lines = [
      `SOLVES        ${String(run.linksSolved).padStart(2, ' ')} / ${run.target}      ${run.solveScore}`,
      `CRACK BOUNTY  ${run.bountyScore > 0 ? 'taken' : '  —  '}          ${run.bountyScore}`,
      `LINKS DRAWN   ${String(run.drawn.length).padStart(2, ' ')}            ${run.drawScore}`,
      `FASTEST SOLVE ${best === null ? '  —  ' : formatClock(best).padStart(5, ' ')}`,
    ];
    this.breakdown.setText(lines.join('\n'));
    this.bestText.setText(
      `best chain ${p.bestChain}/${run.target}   ·   ${p.points} lifetime points   ·   run ${p.runs}`,
    );
  }

  private drawMarks(): void {
    const f = this.frame;
    if (!f) return;
    const { x: cx, y: cy, r } = this.face.center;
    const g = this.marks;
    g.clear();
    const total = run.target;
    for (let i = 0; i < total; i++) {
      const deg = (i / total) * 360;
      const at = polar(deg, r * 0.72);
      const lit = i < this.revealed;
      g.lineStyle(2 * f.ui, lit ? T.hand : T.panelEdge, lit ? 1 : 0.6);
      g.strokeCircle(cx + at.x, cy + at.y, 9 * f.ui);
      if (lit) {
        g.fillStyle(T.hand, 0.9);
        g.fillCircle(cx + at.x, cy + at.y, 4 * f.ui);
      }
    }
  }

  protected layout(f: Frame): void {
    const r = Math.min(f.portrait ? f.iw * 0.3 : f.ih * 0.3, f.ih * 0.22);
    const cx = f.portrait ? f.w / 2 : f.x + r + 16 * f.ui;
    const cy = f.portrait ? f.y + r + 44 * f.ui : f.y + f.ih / 2;
    this.face.setGeometry(cx, cy, r);

    const btnH = Math.max(48 * f.ui, Math.min(56 * f.ui, f.ih * 0.1));

    if (f.portrait) {
      this.title.setFontSize(Math.round(23 * f.ui)).setPosition(f.w / 2, f.y + 20 * f.ui);
      this.scoreText.setFontSize(Math.round(34 * f.ui)).setPosition(cx, cy - 4 * f.ui);
      this.sub
        .setFontSize(Math.round(10.5 * f.ui))
        .setLineSpacing(4 * f.ui)
        .setPosition(f.w / 2, cy + r + 20 * f.ui);

      const pw = Math.min(f.iw - 16 * f.ui, 400 * f.ui);
      const ph = 108 * f.ui;
      const px = f.x + (f.iw - pw) / 2;
      const py = f.y + f.ih - btnH * 2 - 30 * f.ui - ph;
      this.drawPlate(f, px, py, pw, ph);
      this.bestText
        .setFontSize(Math.round(9.5 * f.ui))
        .setPosition(f.w / 2, py + ph + 14 * f.ui);
      this.againBtn
        .layout(f.w / 2, f.y + f.ih - btnH * 1.6, pw, btnH)
        .setFontSize(Math.round(16 * f.ui));
      this.menuBtn
        .layout(f.w / 2, f.y + f.ih - btnH * 0.5, pw, btnH * 0.84)
        .setFontSize(Math.round(12 * f.ui));
    } else {
      const px = cx + r + 24 * f.ui;
      const pw = Math.max(220 * f.ui, f.x + f.iw - px);
      const pcx = px + pw / 2;
      this.title.setFontSize(Math.round(21 * f.ui)).setPosition(pcx, f.y + 18 * f.ui);
      this.sub.setFontSize(Math.round(10 * f.ui)).setPosition(pcx, f.y + 44 * f.ui);
      this.scoreText.setFontSize(Math.round(30 * f.ui)).setPosition(cx, cy - 2 * f.ui);

      const ph = 100 * f.ui;
      const py = f.y + 62 * f.ui;
      this.drawPlate(f, px, py, pw, ph);
      this.bestText.setFontSize(Math.round(9.5 * f.ui)).setPosition(pcx, py + ph + 12 * f.ui);
      this.againBtn
        .layout(pcx, f.y + f.ih - btnH * 1.6, pw, btnH)
        .setFontSize(Math.round(15 * f.ui));
      this.menuBtn
        .layout(pcx, f.y + f.ih - btnH * 0.5, pw, btnH * 0.84)
        .setFontSize(Math.round(12 * f.ui));
    }
    this.drawMarks();
  }

  private drawPlate(f: Frame, x: number, y: number, w: number, h: number): void {
    const g = this.plate;
    g.clear();
    g.fillStyle(T.panel, 0.92);
    g.fillRoundedRect(x, y, w, h, 12 * f.ui);
    g.lineStyle(1.4, this.won ? T.hand : T.warn, 0.7);
    g.strokeRoundedRect(x, y, w, h, 12 * f.ui);
    const fit = Math.min(11 * f.ui, (w - 28 * f.ui) / (30 * 0.62));
    this.breakdown
      .setFontSize(Math.round(Math.max(8 * f.ui, fit)))
      .setLineSpacing(6 * f.ui)
      .setPosition(x + 14 * f.ui, y + 14 * f.ui);
  }
}
