import Phaser from 'phaser';
import { Scenes } from '@/game/constants';
import { T, TX, FONT } from '@/ui/theme';
import { computeFrame, type Frame } from '@/ui/layout';
import { Button } from '@/ui/Button';
import { chain, run } from '@/sweep/session';
import { sfx } from '@/audio/AudioManager';
import type { GuessScene } from './GuessScene';

/**
 * The pause menu, run as an overlay scene on top of a paused gameplay scene.
 *
 * Pausing the caller stops its `update`, which stops its `SweepClock` — so the
 * hand, the points decay and any lockout all freeze together and resume in
 * exactly the same relationship. No timer can drift across a pause.
 */
export class PauseScene extends Phaser.Scene {
  private caller: string = Scenes.Guess;
  private frame!: Frame;

  private plate!: Phaser.GameObjects.Graphics;
  private title!: Phaser.GameObjects.Text;
  private body!: Phaser.GameObjects.Text;
  private resumeBtn!: Button;
  private muteBtn!: Button;
  private quitBtn!: Button;

  constructor() {
    super(Scenes.Pause);
  }

  init(data: { caller?: string }): void {
    this.caller = data?.caller ?? Scenes.Guess;
  }

  create(): void {
    this.plate = this.add.graphics();
    this.title = this.add
      .text(0, 0, 'PAUSED', { fontFamily: FONT, fontSize: '24px', color: TX.green })
      .setOrigin(0.5);
    this.body = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '11px', color: TX.dim, align: 'center' })
      .setOrigin(0.5);

    this.resumeBtn = new Button(this, {
      label: 'RESUME',
      variant: 'primary',
      onClick: () => this.close(),
    });
    this.muteBtn = new Button(this, {
      label: '',
      variant: 'quiet',
      silent: true,
      onClick: () => this.toggleMute(),
    });
    this.quitBtn = new Button(this, {
      label: 'GIVE UP THE LINK',
      variant: 'danger',
      onClick: () => this.giveUp(),
    });

    this.refresh();
    this.frame = computeFrame(this.scale.width, this.scale.height);
    this.layout(this.frame);

    const onResize = (): void => {
      this.frame = computeFrame(this.scale.width, this.scale.height);
      this.layout(this.frame);
    };
    this.scale.on(Phaser.Scale.Events.RESIZE, onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, onResize);
    });

    this.input.keyboard?.on('keydown-ESC', () => this.close());
    this.cameras.main.fadeIn(160, 4, 7, 13);
  }

  private refresh(): void {
    this.muteBtn.setLabel(chain().muted ? '🔇  SOUND OFF' : '🔊  SOUND ON');
    this.body.setText(
      `link ${Math.min(run.linksSolved + 1, run.target)} of ${run.target}   ·   ${run.score} points banked\n` +
        'the hand is holding still while you are away',
    );
    this.quitBtn.setLabel(this.caller === Scenes.Draw ? 'ABANDON THE DRAWING' : 'GIVE UP THE LINK');
  }

  private toggleMute(): void {
    const c = chain();
    const next = !c.muted;
    c.setMuted(next);
    sfx.setMuted(next);
    this.refresh();
    if (!next) sfx.select();
  }

  private close(): void {
    this.scene.stop();
    this.scene.resume(this.caller);
  }

  private giveUp(): void {
    this.scene.stop();
    this.scene.resume(this.caller);
    if (this.caller === Scenes.Draw) {
      // Abandoning the drawing just breaks the chain, same as failing a link.
      run.finish('broken');
      chain().finishRun(run.linksSolved);
      this.scene.start(Scenes.Results);
      return;
    }
    const guess = this.scene.get(Scenes.Guess) as GuessScene | undefined;
    guess?.giveUp();
  }

  private layout(f: Frame): void {
    const w = Math.min(f.iw - 16 * f.ui, 400 * f.ui);
    const btnH = Math.max(48 * f.ui, Math.min(56 * f.ui, f.ih * 0.11));
    const h = Math.min(f.ih - 20 * f.ui, 130 * f.ui + btnH * 3 + 24 * f.ui);
    const x = f.x + (f.iw - w) / 2;
    const y = f.y + (f.ih - h) / 2;

    const g = this.plate;
    g.clear();
    g.fillStyle(0x04070d, 0.86);
    g.fillRect(0, 0, f.w, f.h);
    g.fillStyle(T.panel, 0.98);
    g.fillRoundedRect(x, y, w, h, 16 * f.ui);
    g.lineStyle(2, T.hand, 0.8);
    g.strokeRoundedRect(x, y, w, h, 16 * f.ui);

    this.title.setFontSize(Math.round(22 * f.ui)).setPosition(x + w / 2, y + 38 * f.ui);
    this.body
      .setFontSize(Math.round(10.5 * f.ui))
      .setLineSpacing(5 * f.ui)
      .setPosition(x + w / 2, y + 82 * f.ui);

    const bw = w - 32 * f.ui;
    let cy = y + 120 * f.ui + btnH / 2;
    this.resumeBtn.layout(x + w / 2, cy, bw, btnH).setFontSize(Math.round(16 * f.ui));
    cy += btnH + 8 * f.ui;
    this.muteBtn.layout(x + w / 2, cy, bw, btnH * 0.84).setFontSize(Math.round(12 * f.ui));
    cy += btnH + 8 * f.ui;
    this.quitBtn.layout(x + w / 2, cy, bw, btnH * 0.84).setFontSize(Math.round(12 * f.ui));
  }
}
