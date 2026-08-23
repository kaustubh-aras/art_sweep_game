import Phaser from 'phaser';
import { Scenes } from '@/game/constants';
import { T, TX, FONT } from '@/ui/theme';
import type { Frame } from '@/ui/layout';
import { SweepClock } from '@/sweep/clock';
import { ClockFace } from '@/sweep/clockFace';
import { InkLayer } from '@/sweep/inkLayer';
import { Replayer } from '@/sweep/replay';
import { synthesizeWord } from '@/sweep/synth';
import { chain } from '@/sweep/session';
import { SweepScene } from './SweepScene';

/**
 * BootScene: the loading screen.
 *
 * It bakes the shared procedural textures (there is no art pipeline — the game
 * ships no image files) and, while it does, runs a live miniature of the sweep
 * so the very first thing a player sees is the mechanic itself.
 */
export class BootScene extends SweepScene {
  private clock = new SweepClock();
  private face!: ClockFace;
  private ink!: InkLayer;
  private replay!: Replayer;

  private title!: Phaser.GameObjects.Text;
  private tagline!: Phaser.GameObjects.Text;
  private status!: Phaser.GameObjects.Text;
  private barBg!: Phaser.GameObjects.Graphics;
  private progress = 0;
  private done = false;
  private held = 0;

  constructor() {
    super(Scenes.Boot);
  }

  create(): void {
    this.createTextures();

    this.face = new ClockFace(this, 0, 1, 3);
    this.ink = new InkLayer(this, 2);
    const rec = synthesizeWord('clock', 1234) ?? { length: 60_000, strokes: [] };
    this.replay = new Replayer(rec, this.ink);

    this.title = this.add
      .text(0, 0, 'S W E E P', { fontFamily: FONT, fontSize: '28px', color: TX.green })
      .setOrigin(0.5);
    this.tagline = this.add
      .text(0, 0, 'draw in the wake', { fontFamily: FONT, fontSize: '12px', color: TX.dim })
      .setOrigin(0.5);
    this.status = this.add
      .text(0, 0, 'priming the dial', { fontFamily: FONT, fontSize: '11px', color: TX.faint })
      .setOrigin(0.5);
    this.barBg = this.add.graphics();

    // Touching localStorage can be slow on a cold mobile webview, so the chain
    // is warmed here rather than on the first frame of the menu.
    this.time.delayedCall(60, () => {
      chain();
      this.progress = 1;
    });

    this.startLayout();
    this.fadeIn(260);
  }

  update(_t: number, delta: number): void {
    this.clock.advance(delta);
    const hand = this.clock.handAngle();
    this.replay.update(this.clock.now());
    this.ink.update(hand);
    this.face.update(hand);

    // Never flash past the loading screen: hold it long enough to be read.
    this.held += delta;
    this.drawBar();
    if (!this.done && this.progress >= 1 && this.held > 1100) {
      this.done = true;
      this.status.setText('ready');
      this.time.delayedCall(260, () => this.scene.start(Scenes.Menu));
    }
  }

  protected layout(f: Frame): void {
    const r = Math.min(f.iw * 0.3, f.ih * 0.24);
    const cy = f.y + f.ih * (f.portrait ? 0.36 : 0.4);
    this.face.setGeometry(f.w / 2, cy, r);
    this.ink.setGeometry(f.w / 2, cy, r);

    this.title.setFontSize(Math.round(26 * f.ui)).setPosition(f.w / 2, cy + r + 34 * f.ui);
    this.tagline.setFontSize(Math.round(12 * f.ui)).setPosition(f.w / 2, cy + r + 62 * f.ui);
    this.status.setFontSize(Math.round(11 * f.ui)).setPosition(f.w / 2, cy + r + 112 * f.ui);
    this.drawBar();
  }

  private drawBar(): void {
    const f = this.frame;
    if (!f) return;
    const w = Math.min(f.iw * 0.6, 260 * f.ui);
    const h = Math.max(3, 4 * f.ui);
    const x = f.w / 2 - w / 2;
    const y = this.status.y - 18 * f.ui;
    const g = this.barBg;
    g.clear();
    g.fillStyle(T.panelEdge, 0.7);
    g.fillRoundedRect(x, y, w, h, h / 2);
    g.fillStyle(T.hand, 1);
    g.fillRoundedRect(x, y, Math.max(h, w * this.progress), h, h / 2);
  }

  /** Bake the tiny procedural textures shared across scenes. */
  private createTextures(): void {
    if (!this.textures.exists('spark')) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0xffffff, 1);
      g.fillRect(0, 0, 6, 6); // white square — tinted per-particle at emit time
      g.generateTexture('spark', 6, 6);
      g.destroy();
    }
    if (!this.textures.exists('dot')) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0xffffff, 1);
      g.fillCircle(8, 8, 8); // soft round particle for ink bursts and stamps
      g.generateTexture('dot', 16, 16);
      g.destroy();
    }
  }
}
