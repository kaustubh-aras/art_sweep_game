import Phaser from 'phaser';
import { Scenes } from '@/game/constants';
import { T, TX, FONT } from '@/ui/theme';
import type { Frame } from '@/ui/layout';
import { Button } from '@/ui/Button';
import { SweepClock } from '@/sweep/clock';
import { ClockFace } from '@/sweep/clockFace';
import { InkLayer } from '@/sweep/inkLayer';
import { Replayer } from '@/sweep/replay';
import { synthesizeWord } from '@/sweep/synth';
import { chain } from '@/sweep/session';
import { POINTS_MAX, POINTS_MIN } from '@/sweep/tuning';
import { sfx } from '@/audio/AudioManager';
import { SweepScene } from './SweepScene';

interface Card {
  title: string;
  body: string;
}

const CARDS: Card[] = [
  {
    title: 'THE HAND IS THE ERASER',
    body:
      'One rotation every 10 seconds.\n' +
      'Ink only survives in the wake behind it.\n' +
      'You never see the whole picture at once.',
  },
  {
    title: 'YOUR POINTS ARE LEAKING',
    body:
      '100 points the moment you open a link,\n' +
      '10 points a minute later.\n' +
      'A wrong guess costs you a whole sweep.',
  },
  {
    title: 'SOLVE IT, THEN DRAW THE NEXT',
    body:
      'Crack a link and the baton is yours.\n' +
      'Draw the next word in six sweeps —\n' +
      'behind the hand, and again on every pass.',
  },
];

/** The three explainer cards (GDD §7 screen 0). Skippable, and swipeable. */
export class TutorialScene extends SweepScene {
  private clock = new SweepClock();
  private face!: ClockFace;
  private ink!: InkLayer;
  private replay!: Replayer;

  private index = 0;
  private from: string = Scenes.Menu;

  private title!: Phaser.GameObjects.Text;
  private body!: Phaser.GameObjects.Text;
  private dots!: Phaser.GameObjects.Graphics;
  private demoBar!: Phaser.GameObjects.Graphics;
  private demoLabel!: Phaser.GameObjects.Text;
  private nextBtn!: Button;
  private skipBtn!: Button;
  private hint!: Phaser.GameObjects.Text;

  private dragX: number | null = null;
  private demoT = 0;

  constructor() {
    super(Scenes.Tutorial);
  }

  init(data: { from?: string }): void {
    this.index = 0;
    this.dragX = null;
    this.demoT = 0;
    this.from = data?.from ?? Scenes.Menu;
  }

  create(): void {
    this.face = new ClockFace(this, 0, 1, 3);
    this.ink = new InkLayer(this, 2);
    this.replay = new Replayer(
      synthesizeWord('candle', 77) ?? { length: 60_000, strokes: [] },
      this.ink,
    );

    this.title = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '15px', color: TX.green, align: 'center' })
      .setOrigin(0.5);
    this.body = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '12px', color: TX.text, align: 'center' })
      .setOrigin(0.5);
    this.hint = this.add
      .text(0, 0, 'swipe or tap to continue', {
        fontFamily: FONT,
        fontSize: '10px',
        color: TX.faint,
      })
      .setOrigin(0.5);
    this.dots = this.add.graphics();
    this.demoBar = this.add.graphics();
    this.demoLabel = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '11px', color: TX.gold })
      .setOrigin(0.5);

    this.nextBtn = new Button(this, { label: 'NEXT', variant: 'primary', onClick: () => this.advance(1) });
    this.skipBtn = new Button(this, { label: 'SKIP', variant: 'quiet', onClick: () => this.finish() });

    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      sfx.unlock();
      this.dragX = p.x;
    });
    this.input.on(Phaser.Input.Events.POINTER_UP, (p: Phaser.Input.Pointer) => {
      if (this.dragX === null) return;
      const dx = p.x - this.dragX;
      this.dragX = null;
      const threshold = this.frame ? 30 * this.frame.ui : 40;
      if (dx < -threshold) this.advance(1);
      else if (dx > threshold) this.advance(-1);
    });

    this.showCard(0, false);
    this.startLayout();
    this.fadeIn();
  }

  update(_t: number, delta: number): void {
    this.clock.advance(delta);
    const hand = this.clock.handAngle();
    this.replay.update(this.clock.now());
    this.ink.update(hand);
    this.face.update(hand);

    if (this.index === 1) {
      this.demoT = (this.demoT + delta) % 4200;
      this.drawDemoBar();
    }
  }

  private advance(dir: number): void {
    const next = this.index + dir;
    if (next < 0) return;
    if (next >= CARDS.length) {
      this.finish();
      return;
    }
    sfx.select();
    this.showCard(next, true);
  }

  private showCard(i: number, animate: boolean): void {
    this.index = i;
    const card = CARDS[i];
    this.title.setText(card.title);
    this.body.setText(card.body);
    this.nextBtn.setLabel(i === CARDS.length - 1 ? "LET'S GO" : 'NEXT');
    this.demoBar.setVisible(i === 1);
    this.demoLabel.setVisible(i === 1);
    if (i !== 1) this.demoT = 0;
    this.drawDots();
    if (animate) {
      for (const t of [this.title, this.body]) {
        t.setAlpha(0);
        this.tweens.add({ targets: t, alpha: 1, duration: 220, ease: 'Quad.easeOut' });
      }
    }
  }

  private finish(): void {
    chain().markTutorialSeen();
    this.scene.start(this.from);
  }

  private drawDots(): void {
    const f = this.frame;
    if (!f) return;
    const g = this.dots;
    const r = 4 * f.ui;
    const gap = 16 * f.ui;
    const y = this.hint.y - 20 * f.ui;
    const total = CARDS.length;
    g.clear();
    for (let i = 0; i < total; i++) {
      const x = f.w / 2 + (i - (total - 1) / 2) * gap;
      g.fillStyle(i === this.index ? T.hand : T.panelEdge, 1);
      g.fillCircle(x, y, i === this.index ? r : r * 0.62);
    }
  }

  private drawDemoBar(): void {
    const f = this.frame;
    if (!f) return;
    const p = Math.min(1, this.demoT / 3400);
    const pts = Math.round(POINTS_MAX - (POINTS_MAX - POINTS_MIN) * p);
    const w = Math.min(f.iw * 0.7, 300 * f.ui);
    const h = 10 * f.ui;
    const x = f.w / 2 - w / 2;
    const y = this.body.y + this.body.height / 2 + 20 * f.ui;
    const g = this.demoBar;
    g.clear();
    g.fillStyle(T.panelEdge, 0.6);
    g.fillRoundedRect(x, y, w, h, h / 2);
    const colour = p > 0.75 ? T.warn : p > 0.45 ? T.gold : T.hand;
    g.fillStyle(colour, 1);
    g.fillRoundedRect(x, y, Math.max(h, w * (1 - p)), h, h / 2);
    this.demoLabel
      .setText(`${pts} PTS`)
      .setColor(p > 0.75 ? TX.warn : p > 0.45 ? TX.gold : TX.green)
      .setFontSize(Math.round(11 * f.ui))
      .setPosition(f.w / 2, y + h + 14 * f.ui);
  }

  protected layout(f: Frame): void {
    const btnH = Math.max(44 * f.ui, Math.min(52 * f.ui, f.ih * 0.09));

    if (f.portrait) {
      const r = Math.min(f.iw * 0.3, f.ih * 0.19);
      const cy = f.y + r + 12 * f.ui;
      this.face.setGeometry(f.w / 2, cy, r);
      this.ink.setGeometry(f.w / 2, cy, r);

      this.title.setFontSize(Math.round(15 * f.ui)).setPosition(f.w / 2, cy + r + 30 * f.ui);
      this.body
        .setFontSize(Math.round(12 * f.ui))
        .setLineSpacing(6 * f.ui)
        .setPosition(f.w / 2, cy + r + 78 * f.ui);
      this.hint.setFontSize(Math.round(10 * f.ui)).setPosition(f.w / 2, f.y + f.ih - btnH - 30 * f.ui);
      const bw = Math.min(f.iw - 16 * f.ui, 340 * f.ui);
      this.nextBtn
        .layout(f.w / 2, f.y + f.ih - btnH / 2, bw, btnH)
        .setFontSize(Math.round(15 * f.ui));
      this.skipBtn
        .layout(f.x + f.iw - 34 * f.ui, f.y + 16 * f.ui, 58 * f.ui, 28 * f.ui)
        .setFontSize(Math.round(10 * f.ui));
    } else {
      const r = Math.min(f.ih * 0.36, f.iw * 0.2);
      const cx = f.x + r + 16 * f.ui;
      const cy = f.y + f.ih / 2;
      this.face.setGeometry(cx, cy, r);
      this.ink.setGeometry(cx, cy, r);

      const px = cx + r + 24 * f.ui;
      const pw = Math.max(200 * f.ui, f.x + f.iw - px);
      const pcx = px + pw / 2;
      this.title.setFontSize(Math.round(15 * f.ui)).setPosition(pcx, f.y + f.ih * 0.22);
      this.body
        .setFontSize(Math.round(12 * f.ui))
        .setLineSpacing(6 * f.ui)
        .setPosition(pcx, f.y + f.ih * 0.44);
      this.hint.setFontSize(Math.round(10 * f.ui)).setPosition(pcx, f.y + f.ih - btnH - 26 * f.ui);
      this.nextBtn
        .layout(pcx, f.y + f.ih - btnH / 2, Math.min(pw, 320 * f.ui), btnH)
        .setFontSize(Math.round(14 * f.ui));
      this.skipBtn
        .layout(f.x + f.iw - 34 * f.ui, f.y + 16 * f.ui, 58 * f.ui, 28 * f.ui)
        .setFontSize(Math.round(10 * f.ui));
    }
    this.drawDots();
    this.drawDemoBar();
  }
}
