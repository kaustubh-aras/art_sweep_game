import Phaser from 'phaser';
import { sfx } from '@/clockshot/sfx';
import { esc, mountForScene, type UiScreen } from '@/clockshot/uiLayer';

/**
 * Pause menu, over a paused gameplay scene.
 *
 * The run clock genuinely stops here, because it is the player's fuel rather
 * than a countdown they are racing. Pausing costs nothing, so the screen does
 * not need to warn anybody about it.
 *
 * Built on the DOM layer, like the menu and the results card. The canvas
 * version drew a panel of a fixed 300 units and then placed its contents at
 * fixed offsets inside it — a title at 44, a note at 92, and three 52-high
 * buttons from 152 with 12 between them, which comes to 332. The last button
 * hung outside the panel it was supposed to be in, and on a short viewport the
 * whole panel was centred to a negative offset and ran off the top of the
 * screen. A panel that is sized by its contents cannot have either problem.
 */
export class PauseScene extends Phaser.Scene {
  private ui!: UiScreen;
  private from = 'cs-play';
  private quitTo = 'cs-menu';
  private quitCaption = 'ABANDON RUN';

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
    this.ui = mountForScene(this, this.markup());

    this.ui.onClick('[data-act="resume"]', () => this.resume_());
    this.ui.onClick('[data-act="sound"]', () => {
      sfx.toggleMute();
      this.renderSound();
    });
    this.ui.onClick('[data-act="quit"]', () => {
      // Abandoning simply stops playing; the run is never submitted, so it
      // expires on the server on its own.
      this.scene.stop(this.from);
      this.scene.stop();
      this.scene.start(this.quitTo);
    });

    this.renderSound();
    // The way out should be the thing under your thumb, and the thing a
    // keyboard lands on first.
    this.ui.find<HTMLButtonElement>('[data-act="resume"]').focus();

    const kb = this.input.keyboard;
    kb?.on('keydown-ESC', this.resume_, this);
    kb?.on('keydown-P', this.resume_, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      kb?.off('keydown-ESC', this.resume_, this);
      kb?.off('keydown-P', this.resume_, this);
    });
  }

  private markup(): string {
    return `
      <div class="cs-pause-wash">
        <div class="cs-card cs-pause cs-glass cs-glass-dense" role="dialog"
             aria-modal="true" aria-label="Paused">
          <div class="cs-pause-head">
            <h1 class="cs-pause-title">PAUSED</h1>
            <p class="cs-pause-note">Your clock is paused.<br />Take your time.</p>
          </div>

          <div class="cs-actions">
            <button type="button" class="cs-btn cs-btn-primary cs-btn-resume"
                    data-act="resume">RESUME</button>
            <button type="button" class="cs-btn cs-btn-ghost" data-act="sound"></button>
            <button type="button" class="cs-btn cs-btn-danger"
                    data-act="quit">${esc(this.quitCaption)}</button>
          </div>
        </div>
      </div>`;
  }

  private renderSound(): void {
    const on = !sfx.isMuted;
    const btn = this.ui.find<HTMLButtonElement>('[data-act="sound"]');
    btn.textContent = on ? 'SOUND: ON' : 'SOUND: OFF';
    btn.setAttribute('aria-pressed', String(on));
  }

  private resume_(): void {
    this.scene.stop();
    this.scene.resume(this.from);
  }
}
