import Phaser from 'phaser';
import { C, FONT, hex, teamColor, teamName } from '@/clockshot/theme';
import { api, NetError } from '@/clockshot/net';
import { store } from '@/clockshot/store';
import { Button, drawTeamBar, fadeTo, layoutOf, text } from '@/clockshot/ui';
import type { LeaderRow } from '@/shared/api';

/**
 * Both leaderboards on one screen: the team totals that decide the round, and
 * the individual contributions that build them.
 */
export class LeaderboardScene extends Phaser.Scene {
  private bg!: Phaser.GameObjects.Graphics;
  private bar!: Phaser.GameObjects.Graphics;
  private rowsGfx!: Phaser.GameObjects.Graphics;
  private heading!: Phaser.GameObjects.Text;
  private teamsText!: Phaser.GameObjects.Text;
  private status!: Phaser.GameObjects.Text;
  private rowTexts: Phaser.GameObjects.Text[] = [];
  private backBtn!: Button;
  private refreshBtn!: Button;
  private rows: LeaderRow[] = [];
  private loading = true;

  constructor() {
    super('cs-leaderboard');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    this.bg = this.add.graphics();
    this.bar = this.add.graphics();
    this.rowsGfx = this.add.graphics();

    this.heading = text(this, 0, 0, 'LEADERBOARD', 20, C.ink);
    this.heading.setStyle({ fontFamily: FONT, fontStyle: 'bold' });
    this.teamsText = text(this, 0, 0, '', 13, C.dim);
    this.status = text(this, 0, 0, 'loading…', 12, C.faint);

    this.refreshBtn = new Button(this, 0, 0, 'REFRESH', { width: 240, color: C.cyan }, () =>
      void this.fetchBoard(),
    );
    this.backBtn = new Button(this, 0, 0, 'BACK', { width: 240, color: C.panelEdge }, () =>
      fadeTo(this, () => this.scene.start('cs-menu')),
    );

    this.relayout();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
    });

    void this.fetchBoard();
    this.cameras.main.fadeIn(200, 7, 11, 22);
  }

  private async fetchBoard(): Promise<void> {
    this.loading = true;
    this.status.setText('loading…').setColor(hex(C.faint));
    try {
      const res = await api.leaderboard();
      this.rows = res.players;
      this.teamsText.setText(
        res.teams.map((t) => `${teamName(t.team)} ${t.seconds}s`).join('   ·   '),
      );
      this.status.setText(
        this.rows.length === 0 ? 'Nobody has banked any seconds this round yet.' : '',
      );
      this.drawBarFrom(res.teams);
    } catch (err) {
      this.status
        .setText(err instanceof NetError ? err.message : 'Could not load the leaderboard.')
        .setColor(hex(C.danger));
    } finally {
      this.loading = false;
      this.renderRows();
    }
  }

  private drawBarFrom(teams: { team: string; seconds: number }[]): void {
    const red = teams.find((t) => t.team === 'red')?.seconds ?? 0;
    const blue = teams.find((t) => t.team === 'blue')?.seconds ?? 0;
    const L = layoutOf(this);
    drawTeamBar(this.bar, L.x + 18 * L.ui, L.y + 84 * L.ui, L.iw - 36 * L.ui, 16 * L.ui, red, blue);
  }

  private renderRows(): void {
    for (const t of this.rowTexts) t.destroy();
    this.rowTexts = [];
    this.rowsGfx.clear();
    if (this.loading) return;

    const L = layoutOf(this);
    const top = L.y + 128 * L.ui;
    const rowH = 28 * L.ui;
    // Only draw what fits; the board is capped server-side anyway.
    const room = Math.floor((L.ih - 128 * L.ui - 120 * L.ui) / rowH);
    const shown = this.rows.slice(0, Math.max(0, room));

    shown.forEach((r, i) => {
      const y = top + i * rowH;
      const accent = r.team ? teamColor(r.team) : C.faint;

      if (r.isYou) {
        // The player's own row is lifted out, so they can find themselves.
        this.rowsGfx.fillStyle(accent, 0.16);
        this.rowsGfx.fillRoundedRect(L.x + 10 * L.ui, y - rowH / 2 + 2, L.iw - 20 * L.ui, rowH - 4, 8 * L.ui);
      }
      this.rowsGfx.fillStyle(accent, 0.9);
      this.rowsGfx.fillRect(L.x + 14 * L.ui, y - 6 * L.ui, 3 * L.ui, 12 * L.ui);

      const rank = text(this, L.x + 28 * L.ui, y, `${r.rank}`, 11.5, C.faint, 'left');
      const name = text(this, L.x + 58 * L.ui, y, `u/${r.username}`, 11.5, r.isYou ? C.ink : C.dim, 'left');
      const secs = text(this, L.x + L.iw - 18 * L.ui, y, `${r.seconds}s`, 12, accent, 'right');
      for (const t of [rank, name, secs]) {
        t.setFontSize(Math.round(11 * L.ui));
        this.rowTexts.push(t);
      }
      // Long usernames must not collide with the score column.
      name.setWordWrapWidth(L.iw - 130 * L.ui);
    });

    if (this.rows.length > shown.length) {
      const more = text(
        this,
        L.cx,
        top + shown.length * rowH + 6 * L.ui,
        `+${this.rows.length - shown.length} more`,
        10.5,
        C.faint,
      );
      this.rowTexts.push(more);
    }
  }

  private relayout(): void {
    const L = layoutOf(this);
    const g = this.bg;
    g.clear();
    g.fillStyle(C.panel, 0.9);
    g.fillRoundedRect(L.x, L.y, L.iw, 112 * L.ui, 16 * L.ui);
    g.lineStyle(1.5, C.panelEdge, 0.6);
    g.strokeRoundedRect(L.x, L.y, L.iw, 112 * L.ui, 16 * L.ui);

    this.heading.setPosition(L.cx, L.y + 28 * L.ui).setFontSize(Math.round(18 * L.ui));
    this.teamsText.setPosition(L.cx, L.y + 56 * L.ui).setFontSize(Math.round(12.5 * L.ui));
    this.status.setPosition(L.cx, L.y + 150 * L.ui).setFontSize(Math.round(11 * L.ui));

    const bw = Math.min(300 * L.ui, L.iw - 40 * L.ui);
    const bh = 50 * L.ui;
    this.backBtn.setPosition(L.cx, L.y + L.ih - bh / 2 - 4 * L.ui).setSize(bw, bh);
    this.refreshBtn.setPosition(L.cx, L.y + L.ih - bh * 1.5 - 13 * L.ui).setSize(bw, bh);

    if (store.community) {
      drawTeamBar(
        this.bar,
        L.x + 18 * L.ui,
        L.y + 84 * L.ui,
        L.iw - 36 * L.ui,
        16 * L.ui,
        store.community.banks.red,
        store.community.banks.blue,
      );
    }
    this.renderRows();
  }
}
