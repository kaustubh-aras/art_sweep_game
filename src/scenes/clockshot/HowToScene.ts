import Phaser from 'phaser';
import { C, FONT } from '@/clockshot/theme';
import { SCORE } from '@/shared/config';
import { Button, fadeTo, layoutOf, text } from '@/clockshot/ui';
import { TEX, bakeTextures } from '@/clockshot/textures';

interface Page {
  title: string;
  body: string;
  /** Textures shown as a row of examples under the text. */
  icons?: { key: string; caption: string }[];
}

/**
 * How to play.
 *
 * Three pages, because the game asks three things of a player: move by
 * swinging, turn the arena into seconds, and understand that those seconds
 * leave the run and go somewhere shared.
 */
export class HowToScene extends Phaser.Scene {
  private pages: Page[] = [];
  private index = 0;

  private titleText!: Phaser.GameObjects.Text;
  private bodyText!: Phaser.GameObjects.Text;
  private dots!: Phaser.GameObjects.Graphics;
  private icons: Phaser.GameObjects.Image[] = [];
  private captions: Phaser.GameObjects.Text[] = [];
  private nextBtn!: Button;
  private backBtn!: Button;

  constructor() {
    super('cs-howto');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    bakeTextures(this);

    this.pages = [
      {
        title: 'SWING, DO NOT WALK',
        body: [
          'Hold GRAPPLE to hook the nearest anchor above you.',
          'The rope pulls in as you swing, so you gain height.',
          'Let go to launch — your speed carries with you.',
          '',
          'Desktop: A/D move · SPACE jump · E grapple · F shoot',
        ].join('\n'),
        icons: [{ key: TEX.anchor, caption: 'anchor' }],
      },
      {
        title: 'TIME IS THE SCORE',
        body: [
          `Clock fragment  +${SCORE.fragment}s`,
          `Large fragment  +${SCORE.largeFragment}s`,
          `Golden clock  +${SCORE.goldenClock}s`,
          `Destroy an enemy  +${SCORE.enemyKill}s`,
          '',
          `Red fragments steal ${SCORE.enemyFragment}s from the other team.`,
          `Spikes cost ${SCORE.hazardPenalty}s. Falling out costs ${SCORE.fallPenalty}s.`,
        ].join('\n'),
        icons: [
          { key: TEX.fragment, caption: `+${SCORE.fragment}` },
          { key: TEX.large, caption: `+${SCORE.largeFragment}` },
          { key: TEX.golden, caption: `+${SCORE.goldenClock}` },
          { key: TEX.enemyFrag, caption: 'steal' },
        ],
      },
      {
        title: 'IT IS ONE SHARED FIGHT',
        body: [
          'Your run lasts 30 seconds.',
          'Every second you bank is added to your',
          "team's shared clock for the whole community.",
          '',
          'Nobody has to be online at the same time.',
          'The team ahead when the round ends wins it.',
        ].join('\n'),
      },
    ];

    this.titleText = text(this, 0, 0, '', 22, C.gold);
    this.titleText.setStyle({ fontFamily: FONT, fontStyle: 'bold' });
    this.bodyText = text(this, 0, 0, '', 13, C.ink);
    this.bodyText.setAlign('center').setLineSpacing(7);
    this.dots = this.add.graphics();

    this.nextBtn = new Button(this, 0, 0, 'NEXT', { width: 240, filled: true, color: C.cyan }, () =>
      this.advance(),
    );
    this.backBtn = new Button(this, 0, 0, 'SKIP', { width: 240, color: C.panelEdge }, () =>
      fadeTo(this, () => this.scene.start('cs-menu')),
    );

    // Tapping anywhere that is not a button also advances.
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      const L = layoutOf(this);
      if (p.y < L.y + L.ih - 130 * L.ui) this.advance();
    });

    this.show();
    this.relayout();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
      this.input.removeAllListeners();
    });
    this.cameras.main.fadeIn(200, 7, 11, 22);
  }

  private advance(): void {
    if (this.index >= this.pages.length - 1) {
      fadeTo(this, () => this.scene.start('cs-menu'));
      return;
    }
    this.index++;
    this.show();
    this.relayout();
  }

  private show(): void {
    const page = this.pages[this.index]!;
    this.titleText.setText(page.title);
    this.bodyText.setText(page.body);
    this.nextBtn.setCaption(this.index >= this.pages.length - 1 ? 'GOT IT' : 'NEXT');
    this.backBtn.setCaption(this.index >= this.pages.length - 1 ? 'BACK' : 'SKIP');

    for (const i of this.icons) i.destroy();
    for (const c of this.captions) c.destroy();
    this.icons = [];
    this.captions = [];

    for (const spec of page.icons ?? []) {
      this.icons.push(this.add.image(0, 0, spec.key));
      this.captions.push(text(this, 0, 0, spec.caption, 11, C.dim));
    }
  }

  private relayout(): void {
    const L = layoutOf(this);
    this.titleText.setPosition(L.cx, L.y + 54 * L.ui).setFontSize(Math.round(21 * L.ui));
    this.bodyText
      .setPosition(L.cx, L.y + L.ih * 0.36)
      .setFontSize(Math.round(12.5 * L.ui))
      .setWordWrapWidth(L.iw - 24 * L.ui);

    // Icon strip, centred under the body copy.
    const iconY = L.y + L.ih * 0.6;
    const n = this.icons.length;
    const spacing = Math.min(84 * L.ui, (L.iw - 40 * L.ui) / Math.max(1, n));
    this.icons.forEach((img, i) => {
      const x = L.cx + (i - (n - 1) / 2) * spacing;
      img.setPosition(x, iconY).setScale(L.ui);
      this.captions[i]?.setPosition(x, iconY + 34 * L.ui).setFontSize(Math.round(10.5 * L.ui));
    });

    // Page dots.
    const g = this.dots;
    g.clear();
    const dy = L.y + L.ih - 136 * L.ui;
    this.pages.forEach((_, i) => {
      const x = L.cx + (i - (this.pages.length - 1) / 2) * 20 * L.ui;
      g.fillStyle(i === this.index ? C.gold : C.faint, i === this.index ? 1 : 0.5);
      g.fillCircle(x, dy, (i === this.index ? 5 : 3.5) * L.ui);
    });

    const bw = Math.min(300 * L.ui, L.iw - 40 * L.ui);
    const bh = 52 * L.ui;
    this.backBtn.setPosition(L.cx, L.y + L.ih - bh / 2 - 6 * L.ui).setSize(bw, bh);
    this.nextBtn.setPosition(L.cx, L.y + L.ih - bh * 1.5 - 16 * L.ui).setSize(bw, bh);
  }
}
