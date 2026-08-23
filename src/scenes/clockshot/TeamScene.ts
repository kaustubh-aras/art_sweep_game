import Phaser from 'phaser';
import { C, FONT, hex, teamName } from '@/clockshot/theme';
import { store } from '@/clockshot/store';
import { api, NetError } from '@/clockshot/net';
import { Button, fadeTo, layoutOf, text } from '@/clockshot/ui';
import type { Team } from '@/shared/config';

/**
 * Team selection.
 *
 * The choice is deliberately heavy: it persists across rounds, and the server
 * refuses to change it once the player has banked anything this round. Saying
 * so up front is kinder than letting someone pick, play, and then discover
 * they are locked in.
 */
export class TeamScene extends Phaser.Scene {
  private bg!: Phaser.GameObjects.Graphics;
  private title!: Phaser.GameObjects.Text;
  private blurb!: Phaser.GameObjects.Text;
  private note!: Phaser.GameObjects.Text;
  private redBtn!: Button;
  private blueBtn!: Button;
  private backBtn!: Button;
  private busy = false;

  constructor() {
    super('cs-team');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    this.bg = this.add.graphics();

    this.title = text(this, 0, 0, 'CHOOSE A SIDE', 26, C.ink);
    this.title.setStyle({ fontFamily: FONT, fontStyle: 'bold' });

    this.blurb = text(
      this,
      0,
      0,
      'Every second you bank goes into your\nteam’s shared clock. The team ahead when\nthe round ends wins it for everyone.',
      13,
      C.dim,
    );
    this.blurb.setAlign('center').setLineSpacing(6);

    this.note = text(this, 0, 0, '', 11.5, C.faint);
    this.note.setAlign('center').setLineSpacing(4);

    this.redBtn = new Button(this, 0, 0, 'RED TEAM', { width: 240, filled: true, color: C.red }, () =>
      this.choose('red'),
    );
    this.blueBtn = new Button(this, 0, 0, 'BLUE TEAM', { width: 240, filled: true, color: C.blue }, () =>
      this.choose('blue'),
    );
    this.backBtn = new Button(this, 0, 0, 'BACK', { width: 240, color: C.panelEdge }, () =>
      fadeTo(this, () => this.scene.start('cs-menu')),
    );

    this.render();
    this.relayout();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
    });
    this.cameras.main.fadeIn(200, 7, 11, 22);
  }

  private render(): void {
    if (!store.username) {
      this.note.setText('You need to be logged in to Reddit to join a team.').setColor(hex(C.gold));
      this.redBtn.setEnabled(false);
      this.blueBtn.setEnabled(false);
      return;
    }

    if (store.team) {
      const locked = store.contribution > 0;
      this.note
        .setText(
          locked
            ? `You are on ${teamName(store.team)} and have already banked ${store.contribution}s this round.\nYou can switch when the next round begins.`
            : `You are on ${teamName(store.team)}. You can still change your mind.`,
        )
        .setColor(hex(locked ? C.faint : C.dim));
      this.redBtn.setEnabled(!locked);
      this.blueBtn.setEnabled(!locked);
    } else {
      this.note.setText('Your choice sticks between rounds.').setColor(hex(C.faint));
    }
  }

  private async choose(team: Team): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.redBtn.setEnabled(false);
    this.blueBtn.setEnabled(false);

    try {
      const res = await api.chooseTeam(team);
      store.setTeam(res.team);
      if (!res.changed && res.message) {
        // The server refused the switch; show its reason rather than pretending.
        this.note.setText(res.message).setColor(hex(C.gold));
        this.busy = false;
        this.render();
        return;
      }
      await store.refreshQuietly();
      fadeTo(this, () => this.scene.start('cs-menu'));
    } catch (err) {
      this.busy = false;
      this.render();
      this.note
        .setText(err instanceof NetError ? err.message : 'Could not save your team.')
        .setColor(hex(C.danger));
    }
  }

  private relayout(): void {
    const L = layoutOf(this);
    const g = this.bg;
    g.clear();

    // Two colour fields, so the choice is visible before it is read.
    const half = L.iw / 2;
    g.fillStyle(C.red, 0.09);
    g.fillRoundedRect(L.x, L.y, half - 4 * L.ui, L.ih * 0.42, 16 * L.ui);
    g.fillStyle(C.blue, 0.09);
    g.fillRoundedRect(L.x + half + 4 * L.ui, L.y, half - 4 * L.ui, L.ih * 0.42, 16 * L.ui);

    this.title.setPosition(L.cx, L.y + 46 * L.ui).setFontSize(Math.round(25 * L.ui));
    this.blurb.setPosition(L.cx, L.y + 108 * L.ui).setFontSize(Math.round(12.5 * L.ui));
    this.note.setPosition(L.cx, L.y + 180 * L.ui).setFontSize(Math.round(11 * L.ui));

    const bw = Math.min(300 * L.ui, L.iw - 40 * L.ui);
    const bh = 58 * L.ui;
    const gap = 12 * L.ui;
    let by = L.y + L.ih - bh / 2 - 6 * L.ui;

    this.backBtn.setPosition(L.cx, by).setSize(bw, 50 * L.ui);
    by -= bh + gap + 6 * L.ui;
    this.blueBtn.setPosition(L.cx, by).setSize(bw, bh).setFontSize(18 * L.ui);
    by -= bh + gap;
    this.redBtn.setPosition(L.cx, by).setSize(bw, bh).setFontSize(18 * L.ui);
  }
}
