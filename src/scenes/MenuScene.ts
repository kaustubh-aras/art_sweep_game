import Phaser from 'phaser';
import { Scenes } from '@/game/constants';
import { T, TX, FONT } from '@/ui/theme';
import type { Frame } from '@/ui/layout';
import { Button } from '@/ui/Button';
import { SweepClock } from '@/sweep/clock';
import { ClockFace } from '@/sweep/clockFace';
import { InkLayer } from '@/sweep/inkLayer';
import { Replayer } from '@/sweep/replay';
import { chain, resetChain, run } from '@/sweep/session';
import type { ChainLink } from '@/sweep/chain';
import { formatAge } from '@/sweep/scoring';
import { sfx } from '@/audio/AudioManager';
import { SweepScene } from './SweepScene';

/**
 * The feed card (GDD §7 screen 1).
 *
 * A live sweep of the newest link plays behind the card, so the menu is already
 * the game: the chain number, the drawer's handle and the bounty are all
 * visible before you tap anything, which is the "someone was just here" pillar.
 */
export class MenuScene extends SweepScene {
  private clock = new SweepClock();
  private face!: ClockFace;
  private ink!: InkLayer;
  private replay!: Replayer;
  private link!: ChainLink;

  private title!: Phaser.GameObjects.Text;
  private chainLine!: Phaser.GameObjects.Text;
  private cardPlate!: Phaser.GameObjects.Graphics;
  private cardTitle!: Phaser.GameObjects.Text;
  private cardMeta!: Phaser.GameObjects.Text;
  private statsLine!: Phaser.GameObjects.Text;
  private playBtn!: Button;
  private howBtn!: Button;
  private muteBtn!: Button;
  private resetBtn!: Button;

  constructor() {
    super(Scenes.Menu);
  }

  create(): void {
    const c = chain();
    this.link = c.head();

    this.face = new ClockFace(this, 0, 1, 3);
    this.ink = new InkLayer(this, 2);
    this.replay = new Replayer(c.recordingFor(this.link), this.ink);

    this.title = this.add
      .text(0, 0, 'S W E E P', { fontFamily: FONT, fontSize: '24px', color: TX.green })
      .setOrigin(0.5, 0);
    this.chainLine = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '11px', color: TX.dim })
      .setOrigin(0.5, 0);

    this.cardPlate = this.add.graphics().setDepth(8);
    this.cardTitle = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '14px', color: TX.text })
      .setOrigin(0.5, 0.5)
      .setDepth(9);
    this.cardMeta = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '11px', color: TX.dim, align: 'center' })
      .setOrigin(0.5, 0.5)
      .setDepth(9);
    this.statsLine = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '11px', color: TX.faint, align: 'center' })
      .setOrigin(0.5, 0.5)
      .setDepth(9);

    this.playBtn = new Button(this, {
      label: '▶  PLAY THE CHAIN',
      variant: 'primary',
      onClick: () => this.startRun(),
    }).setDepth(9);
    this.howBtn = new Button(this, {
      label: 'HOW TO PLAY',
      variant: 'ghost',
      onClick: () => this.scene.start(Scenes.Tutorial, { from: Scenes.Menu }),
    }).setDepth(9);
    this.muteBtn = new Button(this, {
      label: '',
      variant: 'quiet',
      silent: true,
      onClick: () => this.toggleMute(),
    }).setDepth(9);
    this.resetBtn = new Button(this, {
      label: 'RESET',
      variant: 'quiet',
      onClick: () => this.confirmReset(),
    }).setDepth(9);

    sfx.setMuted(c.muted);
    this.refreshMute();
    this.refreshText();

    this.startLayout();
    this.fadeIn();
    this.enableAudioUnlock();

    // First launch drops straight into the three explainer cards (GDD §7.0).
    if (!c.seenTutorial) {
      this.time.delayedCall(360, () => this.scene.start(Scenes.Tutorial, { from: Scenes.Menu }));
    }
  }

  update(_t: number, delta: number): void {
    this.clock.advance(delta);
    const hand = this.clock.handAngle();
    this.replay.update(this.clock.now());
    this.ink.update(hand);
    this.face.update(hand, 0.85);
  }

  private startRun(): void {
    run.start();
    const link = chain().nextForPlayer();
    if (!link) return;
    run.serve(link);
    this.scene.start(Scenes.Guess, { linkN: link.n });
  }

  private toggleMute(): void {
    const c = chain();
    const next = !c.muted;
    c.setMuted(next);
    sfx.setMuted(next);
    this.refreshMute();
    if (!next) sfx.select();
  }

  private refreshMute(): void {
    this.muteBtn.setLabel(chain().muted ? '🔇  SOUND OFF' : '🔊  SOUND ON');
  }

  private confirmReset(): void {
    if (this.resetBtn.name === 'armed') {
      resetChain();
      this.scene.restart();
      return;
    }
    this.resetBtn.name = 'armed';
    this.resetBtn.setLabel('SURE?').setVariant('danger');
    this.time.delayedCall(2600, () => {
      if (!this.scene.isActive()) return;
      this.resetBtn.name = '';
      this.resetBtn.setLabel('RESET').setVariant('quiet');
    });
  }

  private refreshText(): void {
    const c = chain();
    const p = c.profile;
    const bounty = c.bounty(this.link);
    this.chainLine.setText(
      `CHAIN ALIVE ${formatAge(c.aliveMs())}  ·  ${c.links.length} LINKS  ·  r/sweep`,
    );
    this.cardTitle.setText(`CHAIN #${this.link.n}  ·  by u/${this.link.drawer}`);
    const solved = this.link.solvers.length;
    this.cardMeta.setText(
      `${this.link.category.toUpperCase()}  ·  ${this.link.word.replace(/[a-z]/g, '_')}\n` +
        `BOUNTY ${bounty}  ·  ${solved} SOLVED  ·  ${formatAge(Date.now() - this.link.createdAt)} OLD`,
    );
    this.statsLine.setText(
      p.runs === 0
        ? 'your first run — solve 5 links to complete a chain'
        : `best chain ${p.bestChain}/5   ·   ${p.points} pts   ·   ${p.solves} solves   ·   ${p.draws} drawn`,
    );
  }

  protected layout(f: Frame): void {
    const cardH = Math.round(78 * f.ui);
    const btnH = Math.round(Math.min(54 * f.ui, Math.max(44 * f.ui, f.ih * 0.085)));
    const gap = Math.round(9 * f.ui);

    if (f.portrait) {
      const stackH = cardH + gap + btnH * 2 + gap * 2 + 26 * f.ui;
      const topH = 66 * f.ui;
      const stageTop = f.y + topH;
      const stageH = f.ih - topH - stackH;
      const r = Math.max(56, Math.min(f.iw * 0.44, stageH * 0.48));
      const cx = f.w / 2;
      const cy = stageTop + stageH / 2;

      this.face.setGeometry(cx, cy, r);
      this.ink.setGeometry(cx, cy, r);

      this.title.setFontSize(Math.round(24 * f.ui)).setPosition(cx, f.y + 2 * f.ui);
      this.chainLine.setFontSize(Math.round(10.5 * f.ui)).setPosition(cx, f.y + 34 * f.ui);

      let cy2 = f.y + f.ih - stackH;
      this.drawCard(f, f.x + 4 * f.ui, cy2, f.iw - 8 * f.ui, cardH);
      cy2 += cardH + gap * 2;
      const bw = Math.min(f.iw - 16 * f.ui, 380 * f.ui);
      this.playBtn.layout(cx, cy2 + btnH / 2, bw, btnH).setFontSize(Math.round(16 * f.ui));
      cy2 += btnH + gap;
      this.howBtn
        .layout(cx - bw / 4 - gap / 2, cy2 + btnH / 2, bw / 2 - gap / 2, btnH)
        .setFontSize(Math.round(12 * f.ui));
      this.muteBtn
        .layout(cx + bw / 4 + gap / 2, cy2 + btnH / 2, bw / 2 - gap / 2, btnH)
        .setFontSize(Math.round(12 * f.ui));
      cy2 += btnH + gap;
      this.statsLine.setFontSize(Math.round(10 * f.ui)).setPosition(cx, cy2 + 8 * f.ui);
      this.resetBtn
        .layout(f.x + f.iw - 34 * f.ui, f.y + 18 * f.ui, 56 * f.ui, 26 * f.ui)
        .setFontSize(Math.round(9.5 * f.ui));
    } else {
      const r = Math.max(50, Math.min(f.ih * 0.42, f.iw * 0.27));
      const cx = f.x + r + 12 * f.ui;
      const cy = f.y + f.ih / 2 + 6 * f.ui;
      this.face.setGeometry(cx, cy, r);
      this.ink.setGeometry(cx, cy, r);

      const px = cx + r + 20 * f.ui;
      const pw = Math.max(180 * f.ui, f.x + f.iw - px);
      const pcx = px + pw / 2;

      this.title.setFontSize(Math.round(22 * f.ui)).setPosition(pcx, f.y + 2 * f.ui);
      this.chainLine.setFontSize(Math.round(10 * f.ui)).setPosition(pcx, f.y + 30 * f.ui);

      let cy2 = f.y + 52 * f.ui;
      this.drawCard(f, px, cy2, pw, cardH);
      cy2 += cardH + gap;
      this.playBtn.layout(pcx, cy2 + btnH / 2, pw, btnH).setFontSize(Math.round(15 * f.ui));
      cy2 += btnH + gap;
      this.howBtn
        .layout(pcx - pw / 4 - gap / 2, cy2 + btnH / 2, pw / 2 - gap / 2, btnH)
        .setFontSize(Math.round(12 * f.ui));
      this.muteBtn
        .layout(pcx + pw / 4 + gap / 2, cy2 + btnH / 2, pw / 2 - gap / 2, btnH)
        .setFontSize(Math.round(12 * f.ui));
      cy2 += btnH + gap;
      this.statsLine.setFontSize(Math.round(9.5 * f.ui)).setPosition(pcx, cy2 + 10 * f.ui);
      this.resetBtn
        .layout(f.x + f.iw - 32 * f.ui, f.y + f.ih - 16 * f.ui, 58 * f.ui, 26 * f.ui)
        .setFontSize(Math.round(9.5 * f.ui));
    }
  }

  private drawCard(f: Frame, x: number, y: number, w: number, h: number): void {
    const g = this.cardPlate;
    g.clear();
    g.fillStyle(T.panel, 0.92);
    g.fillRoundedRect(x, y, w, h, 12 * f.ui);
    g.lineStyle(1.4, T.panelEdge, 1);
    g.strokeRoundedRect(x, y, w, h, 12 * f.ui);
    // Bounty ribbon down the left edge.
    g.fillStyle(T.gold, 0.85);
    g.fillRoundedRect(x, y + h * 0.24, 3 * f.ui, h * 0.52, 2);

    this.cardTitle.setFontSize(Math.round(13 * f.ui)).setPosition(x + w / 2, y + h * 0.28);
    this.cardMeta
      .setFontSize(Math.round(10 * f.ui))
      .setLineSpacing(3 * f.ui)
      .setPosition(x + w / 2, y + h * 0.66);
  }
}
