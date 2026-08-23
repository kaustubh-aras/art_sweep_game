import Phaser from 'phaser';
import { T, TX, FONT } from './theme';
import { dpr } from './viewport';

/**
 * Transient one-line feedback, lifted from the EditorScene toast in this repo
 * and given a backing plate so it stays readable over the radar field.
 */
export class Toast {
  private bg: Phaser.GameObjects.Graphics;
  private text: Phaser.GameObjects.Text;
  private cx = 0;
  private cy = 0;

  constructor(private scene: Phaser.Scene, depth: number) {
    this.bg = scene.add.graphics().setDepth(depth).setAlpha(0);
    this.text = scene.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '14px', color: TX.text })
      .setOrigin(0.5)
      .setDepth(depth + 1)
      .setAlpha(0);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  layout(cx: number, cy: number, fontPx: number): void {
    this.cx = cx;
    this.cy = cy;
    this.text.setFontSize(fontPx);
    this.text.setPosition(cx, cy);
    this.redraw();
  }

  show(msg: string, ms = 1500, color: string = TX.text): void {
    this.text.setText(msg).setColor(color).setPosition(this.cx, this.cy);
    this.redraw();
    this.scene.tweens.killTweensOf([this.text, this.bg]);
    this.text.setAlpha(1);
    this.bg.setAlpha(1);
    this.scene.tweens.add({
      targets: [this.text, this.bg],
      alpha: 0,
      delay: ms,
      duration: 320,
      ease: 'Quad.easeIn',
    });
  }

  private redraw(): void {
    const w = this.text.width + 26 * dpr();
    const h = this.text.height + 14 * dpr();
    this.bg.clear();
    this.bg.fillStyle(T.panel, 0.94);
    this.bg.fillRoundedRect(this.cx - w / 2, this.cy - h / 2, w, h, 8 * dpr());
    this.bg.lineStyle(1, T.panelEdge, 1);
    this.bg.strokeRoundedRect(this.cx - w / 2, this.cy - h / 2, w, h, 8 * dpr());
  }

  destroy(): void {
    this.bg.destroy();
    this.text.destroy();
  }
}
