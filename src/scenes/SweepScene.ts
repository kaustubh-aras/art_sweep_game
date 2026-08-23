import Phaser from 'phaser';
import { computeFrame, type Frame } from '@/ui/layout';
import { T } from '@/ui/theme';
import { sfx } from '@/audio/AudioManager';

/**
 * Shared plumbing for every SWEEP screen.
 *
 * One rule holds the whole game together: a scene never hard-codes a
 * coordinate. It reads the current `Frame` and lays itself out, and it does the
 * same thing again whenever the viewport changes — rotation, an address bar
 * sliding away, a desktop window drag. Because `layout()` is the only place
 * positions are decided, no screen can ever end up bigger than the viewport,
 * which is what keeps the game unscrollable.
 */
export abstract class SweepScene extends Phaser.Scene {
  protected frame!: Frame;
  private backdrop?: Phaser.GameObjects.Graphics;

  /** Position everything for the given frame. Called on create and on resize. */
  protected abstract layout(frame: Frame): void;

  /** Call at the end of `create()`. */
  protected startLayout(withBackdrop = true): void {
    if (withBackdrop) this.backdrop = this.add.graphics().setDepth(-100);
    this.frame = computeFrame(this.scale.width, this.scale.height);

    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    });

    this.applyLayout();
  }

  private handleResize(): void {
    this.frame = computeFrame(this.scale.width, this.scale.height);
    this.applyLayout();
  }

  private applyLayout(): void {
    if (this.backdrop) this.paintBackdrop(this.backdrop, this.frame);
    this.layout(this.frame);
  }

  /** The field behind every screen: a dark wash with a faint horizon grid. */
  protected paintBackdrop(g: Phaser.GameObjects.Graphics, f: Frame): void {
    g.clear();
    g.fillStyle(T.bg, 1);
    g.fillRect(0, 0, f.w, f.h);

    const step = Math.max(28, 46 * f.ui);
    g.lineStyle(1, T.ring, 0.16);
    for (let x = step; x < f.w; x += step) g.lineBetween(x, 0, x, f.h);
    for (let y = step; y < f.h; y += step) g.lineBetween(0, y, f.w, y);
  }

  /** Fade the scene in so screen changes never snap. */
  protected fadeIn(ms = 220): void {
    this.cameras.main.fadeIn(ms, 4, 7, 13);
  }

  /** A pointer anywhere is a user gesture — the only moment audio may start. */
  protected enableAudioUnlock(): void {
    this.input.once(Phaser.Input.Events.POINTER_DOWN, () => sfx.unlock());
  }
}
