import Phaser from 'phaser';
import { C, FONT } from '@/clockshot/theme';
import { sfx } from '@/clockshot/sfx';
import { Button, layoutOf, text } from '@/clockshot/ui';

/**
 * Pause menu, drawn over a paused gameplay scene.
 *
 * The run clock genuinely stops here, because it is the player's fuel rather
 * than a countdown they are racing. Pausing costs nothing, so the screen does
 * not need to warn anybody about it.
 */
export class PauseScene extends Phaser.Scene {
  private from = 'cs-play';
  private quitTo = 'cs-menu';
  private quitCaption = 'ABANDON RUN';
  private soundBtn!: Button;
  private resumeBtn!: Button;
  private quitBtn!: Button;
  private bg!: Phaser.GameObjects.Graphics;
  private title!: Phaser.GameObjects.Text;
  private warn!: Phaser.GameObjects.Text;

  constructor() {
    super('cs-pause');
  }

  init(data: { from?: string; quitTo?: string; quitCaption?: string }): void {
    this.from = data.from ?? 'cs-play';
    // Where quitting goes, and what it is called. A test run leaves to the
    // editor and is ended rather than abandoned.
    this.quitTo = data.quitTo ?? 'cs-menu';
    this.quitCaption = data.quitCaption ?? 'ABANDON RUN';
  }

  create(): void {
    this.bg = this.add.graphics();

    this.title = text(this, 0, 0, 'PAUSED', 26, C.ink);
    this.title.setStyle({ fontFamily: FONT, fontStyle: 'bold' });
    this.warn = text(this, 0, 0, 'Your clock is paused.\nTake your time.', 12, C.dim);
    this.warn.setAlign('center').setLineSpacing(5);

    this.resumeBtn = new Button(this, 0, 0, 'RESUME', { width: 240, variant: 'primary', color: C.good }, () =>
      this.resume_(),
    );
    this.soundBtn = new Button(this, 0, 0, this.soundCaption(), { width: 240, variant: 'ghost' }, () => {
      sfx.toggleMute();
      this.soundBtn.setCaption(this.soundCaption());
    });
    this.quitBtn = new Button(this, 0, 0, this.quitCaption, { width: 240, variant: 'danger' }, () => {
      // Abandoning simply stops playing; the run is never submitted, so it
      // expires on the server and costs the team nothing.
      this.scene.stop(this.from);
      this.scene.stop();
      this.scene.start(this.quitTo);
    });

    const kb = this.input.keyboard;
    kb?.on('keydown-ESC', this.resume_, this);
    kb?.on('keydown-P', this.resume_, this);

    this.relayout();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
      kb?.off('keydown-ESC', this.resume_, this);
      kb?.off('keydown-P', this.resume_, this);
    });
  }

  private soundCaption(): string {
    return sfx.isMuted ? 'SOUND: OFF' : 'SOUND: ON';
  }

  private resume_(): void {
    this.scene.stop();
    this.scene.resume(this.from);
  }

  private relayout(): void {
    const L = layoutOf(this);
    const g = this.bg;
    g.clear();
    // A wash rather than a solid, so the arena stays visible behind it.
    g.fillStyle(C.bg, 0.86);
    g.fillRect(0, 0, L.w, L.h);

    const panelH = 300 * L.ui;
    const panelW = Math.min(340 * L.ui, L.iw);
    const px = L.cx - panelW / 2;
    const py = L.y + (L.ih - panelH) / 2;
    g.fillStyle(C.panel, 0.97);
    g.fillRoundedRect(px, py, panelW, panelH, 18 * L.ui);
    g.lineStyle(1.5, C.panelEdge, 0.8);
    g.strokeRoundedRect(px, py, panelW, panelH, 18 * L.ui);

    this.title.setPosition(L.cx, py + 44 * L.ui).setFontSize(Math.round(25 * L.ui));
    this.warn.setPosition(L.cx, py + 92 * L.ui).setFontSize(Math.round(11.5 * L.ui));

    const bw = panelW - 44 * L.ui;
    const bh = 52 * L.ui;
    this.resumeBtn.setPosition(L.cx, py + 152 * L.ui).setSize(bw, bh);
    this.soundBtn.setPosition(L.cx, py + 152 * L.ui + bh + 12 * L.ui).setSize(bw, bh);
    this.quitBtn.setPosition(L.cx, py + 152 * L.ui + (bh + 12 * L.ui) * 2).setSize(bw, bh);
  }
}
