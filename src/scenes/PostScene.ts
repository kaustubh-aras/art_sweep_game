import Phaser from 'phaser';
import { Scenes } from '@/game/constants';
import { T, TX, FONT } from '@/ui/theme';
import type { Frame } from '@/ui/layout';
import { Button } from '@/ui/Button';
import { SweepClock } from '@/sweep/clock';
import { ClockFace } from '@/sweep/clockFace';
import { InkLayer } from '@/sweep/inkLayer';
import { Replayer } from '@/sweep/replay';
import type { Recording } from '@/sweep/strokes';
import { chain, run } from '@/sweep/session';
import type { Solver } from '@/sweep/chain';
import { HANDLES } from '@/sweep/chain';
import type { Word } from '@/sweep/words';
import {
  drawerTotal,
  formatClock,
  simulateSolves,
  type Readability,
  type SimSolve,
} from '@/sweep/scoring';
import { mulberry32 } from '@/sweep/synth';
import { HEAT_GRID } from '@/sweep/tuning';
import { sfx } from '@/audio/AudioManager';
import { SweepScene } from './SweepScene';

interface PostInit {
  word: Word;
  recording: Recording;
  readability: Readability;
}

const D = { dial: 1, ink: 3, hand: 4, hud: 10, panel: 20 } as const;

/**
 * Screen 5 (GDD §7): preview your drawing, post it, watch the sub crack it.
 *
 * The grade is the honest one: how much of your ink you laid down in the wake,
 * how often you came back and re-traced it, and how much of the dial you used.
 * All three are the sweep doing the grading — a drawing made without using the
 * hand simply is not there when a guesser looks.
 */
export class PostScene extends SweepScene {
  private clock = new SweepClock();
  private face!: ClockFace;
  private ink!: InkLayer;
  private replay!: Replayer;

  private word!: Word;
  private recording!: Recording;
  private read!: Readability;
  private solves: SimSolve[] = [];
  private revealed = 0;
  private posted = false;
  private tally = 0;

  private title!: Phaser.GameObjects.Text;
  private gradePlate!: Phaser.GameObjects.Graphics;
  private gradeText!: Phaser.GameObjects.Text;
  private breakdown!: Phaser.GameObjects.Text;
  private feed!: Phaser.GameObjects.Text;
  private postBtn!: Button;
  private nextBtn!: Button;
  private plateRect = { x: 0, y: 0, w: 10, h: 10 };

  constructor() {
    super(Scenes.Post);
  }

  init(data: PostInit): void {
    this.word = data.word;
    this.recording = data.recording;
    this.read = data.readability;
    this.solves = [];
    this.revealed = 0;
    this.posted = false;
    this.tally = 0;
    this.clock.reset();
  }

  create(): void {
    this.face = new ClockFace(this, D.dial, D.dial, D.hand);
    this.ink = new InkLayer(this, D.ink);
    this.replay = new Replayer(this.recording, this.ink);

    this.title = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '15px', color: TX.gold, align: 'center' })
      .setOrigin(0.5)
      .setDepth(D.hud);
    this.gradePlate = this.add.graphics().setDepth(D.panel - 1);
    this.gradeText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '13px', color: TX.text, align: 'center' })
      .setOrigin(0.5)
      .setDepth(D.panel);
    this.breakdown = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '10.5px', color: TX.dim, align: 'left' })
      .setOrigin(0, 0.5)
      .setDepth(D.panel);
    this.feed = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '10.5px', color: TX.faint, align: 'left' })
      .setOrigin(0, 0)
      .setDepth(D.panel);

    this.postBtn = new Button(this, {
      label: 'POST TO r/sweep',
      variant: 'gold',
      onClick: () => this.post(),
    }).setDepth(D.panel);
    this.nextBtn = new Button(this, {
      label: 'NEXT LINK',
      variant: 'primary',
      onClick: () => this.continueRun(),
    }).setDepth(D.panel);
    this.nextBtn.setEnabled(false).setVisible(false);

    this.refreshPreview();
    this.startLayout();
    this.fadeIn();
    this.enableAudioUnlock();
  }

  update(_t: number, delta: number): void {
    this.clock.advance(delta);
    const hand = this.clock.handAngle();
    this.replay.update(this.clock.now());
    this.ink.update(hand);
    this.face.update(hand);
  }

  // ---- posting -----------------------------------------------------------

  private post(): void {
    if (this.posted) return;
    this.posted = true;
    sfx.post();

    const c = chain();
    const link = c.appendPlayerLink(this.word.word, this.word.tier, this.word.category, this.recording);

    const rand = mulberry32((link.n * 2654435761) >>> 0);
    const names = HANDLES.filter((h) => h !== 'you').sort(() => rand() - 0.5);
    this.solves = simulateSolves(this.read.score, this.word.tier, names, rand);
    const total = drawerTotal(this.solves);

    const solvers: Solver[] = this.solves.map((s) => ({
      name: s.name,
      ms: s.ms,
      cell: Math.floor(rand() * HEAT_GRID * HEAT_GRID),
      points: s.points,
    }));
    c.registerDrawTake(link, solvers, total);
    run.drawn.push({
      n: link.n,
      word: this.word.word,
      readability: this.read.score,
      solves: this.solves.length,
      points: total,
    });

    this.postBtn.setEnabled(false).setVisible(false);
    this.title.setText(`SWEEP #${link.n}  ·  drawn by u/you  ·  live`);

    // Comments land one at a time, the way they would in a real thread.
    this.revealSolves();
  }

  private revealSolves(): void {
    if (this.solves.length === 0) {
      this.feed.setText('no solves yet — the bounty starts climbing');
      this.finishReveal();
      return;
    }
    this.time.addEvent({
      delay: 420,
      repeat: this.solves.length - 1,
      callback: () => {
        const s = this.solves[this.revealed++];
        this.tally += s.drawerTake;
        sfx.stamp();
        this.feed.setText(this.feedText());
        this.refreshGrade();
        if (this.revealed >= this.solves.length) this.finishReveal();
      },
    });
  }

  private finishReveal(): void {
    sfx.solve();
    this.nextBtn.setEnabled(true).setVisible(true);
    this.layout(this.frame);
  }

  private feedText(): string {
    const lines = this.solves
      .slice(0, this.revealed)
      .map((s) => `u/${s.name} solved in ${formatClock(s.ms)}   +${s.drawerTake}`);
    return lines.join('\n');
  }

  private continueRun(): void {
    const next = chain().nextForPlayer(run.served);
    if (!next || run.linksSolved >= run.target) {
      run.finish('complete');
      chain().finishRun(run.linksSolved);
      this.scene.start(Scenes.Results);
      return;
    }
    run.serve(next);
    this.scene.start(Scenes.Guess, { linkN: next.n });
  }

  // ---- readouts ----------------------------------------------------------

  private refreshPreview(): void {
    this.title.setText(`PREVIEW  ·  ${this.word.word.toUpperCase()}  ·  ${this.word.tier}`);
    this.refreshGrade();
  }

  private refreshGrade(): void {
    const r = this.read;
    const grade = r.score >= 78 ? 'CRISP' : r.score >= 55 ? 'READABLE' : r.score >= 30 ? 'ROUGH' : 'A MESS';
    this.gradeText.setText(
      this.posted
        ? `${this.solves.length} SOLVE${this.solves.length === 1 ? '' : 'S'}   ·   +${this.tally} POINTS`
        : `READABILITY  ${r.score}/100   ·   ${grade}`,
    );
    this.breakdown.setText(
      [
        `${bar(r.wake)}  ink in the wake      ${pct(r.wake)}`,
        `${bar(r.retrace)}  re-traced on passes  ${pct(r.retrace)}`,
        `${bar(r.spread)}  spread on the dial   ${pct(r.spread)}`,
      ].join('\n'),
    );
  }

  // ---- layout ------------------------------------------------------------

  protected layout(f: Frame): void {
    if (!f) return;
    const { cx, cy, r } = f.clock;
    this.face.setGeometry(cx, cy, r);
    this.ink.setGeometry(cx, cy, r);

    const p = f.panel;
    const pad = 8 * f.ui;
    const btnH = Math.max(48 * f.ui, Math.min(58 * f.ui, p.h * 0.2));

    this.title
      .setFontSize(Math.round(13 * f.ui))
      .setPosition(f.x + f.iw / 2, f.y + f.topBarH / 2);

    const plateH = Math.min(p.h - btnH - pad * 3, 150 * f.ui);
    this.plateRect = { x: p.x + pad, y: p.y + pad, w: p.w - pad * 2, h: plateH };
    const g = this.gradePlate;
    g.clear();
    g.fillStyle(T.panel, 0.9);
    g.fillRoundedRect(this.plateRect.x, this.plateRect.y, this.plateRect.w, this.plateRect.h, 12 * f.ui);
    g.lineStyle(1.4, T.panelEdge, 1);
    g.strokeRoundedRect(this.plateRect.x, this.plateRect.y, this.plateRect.w, this.plateRect.h, 12 * f.ui);

    this.gradeText
      .setFontSize(Math.round(13 * f.ui))
      .setPosition(this.plateRect.x + this.plateRect.w / 2, this.plateRect.y + 22 * f.ui);
    this.breakdown
      .setFontSize(Math.round(10 * f.ui))
      .setLineSpacing(5 * f.ui)
      .setPosition(this.plateRect.x + 14 * f.ui, this.plateRect.y + this.plateRect.h * 0.62);
    this.feed
      .setFontSize(Math.round(10 * f.ui))
      .setLineSpacing(4 * f.ui)
      .setPosition(this.plateRect.x + 14 * f.ui, this.plateRect.y + this.plateRect.h + pad);

    const bw = Math.min(p.w - pad * 2, 420 * f.ui);
    this.postBtn
      .layout(p.x + p.w / 2, p.y + p.h - btnH / 2, bw, btnH)
      .setFontSize(Math.round(16 * f.ui));
    this.nextBtn
      .layout(p.x + p.w / 2, p.y + p.h - btnH / 2, bw, btnH)
      .setFontSize(Math.round(16 * f.ui));
  }
}

function bar(v: number): string {
  const n = Math.round(Math.max(0, Math.min(1, v)) * 8);
  return '█'.repeat(n) + '·'.repeat(8 - n);
}

function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`.padStart(4, ' ');
}
