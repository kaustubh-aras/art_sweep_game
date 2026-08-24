import Phaser from 'phaser';
import { C, FONT } from '@/clockshot/theme';
import { addBackdrop } from '@/clockshot/glass';
import { SCORE, START_TIME_MS, TIME_GAIN, TIME_LOSS } from '@/shared/config';
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
    // Glass needs something behind it, or it is just a grey box.
    addBackdrop(this);
    bakeTextures(this);

    this.pages = [
      {
        title: 'SWING, DO NOT WALK',
        body: [
          'Hold GRAPPLE to hook the nearest anchor above you.',
          'The rope pulls in as you swing, so you gain height.',
          'Let go to launch — your speed carries with you.',
          '',
          'Desktop: A/D steer · E, SPACE or click to grapple',
        ].join('\n'),
        icons: [{ key: TEX.anchor, caption: 'anchor' }],
      },
      {
        title: 'TIME IS FUEL',
        body: [
          `You start with ${START_TIME_MS / 1000} seconds.`,
          'The clock starts the moment you move, and never stops.',
          '',
          `Clock  +${TIME_GAIN.clock}s        Golden clock  +${TIME_GAIN.golden}s`,
          `Spikes and enemies  -${TIME_LOSS.hazard}s`,
          '',
          'Run out and the run is over.',
        ].join('\n'),
        icons: [
          { key: TEX.clock, caption: `+${TIME_GAIN.clock}s` },
          { key: TEX.golden, caption: `+${TIME_GAIN.golden}s` },
        ],
      },
      {
        title: 'REACH THE GOAL',
        body: [
          'The green ring is the end of the run.',
          'Green flags along the way are checkpoints —',
          'touch one and that is where you restart.',
          '',
          'Getting to the goal is the only way to score.',
          '',
          `Finish  ${SCORE.goal}`,
          `Each anchor you used  ${SCORE.anchor}`,
          `Each second still on your clock  ${SCORE.secondLeft}`,
          '',
          'So fly through more of the arena, and arrive early.',
        ].join('\n'),
        icons: [{ key: TEX.goal, caption: 'goal' }],
      },
    ];

    this.titleText = text(this, 0, 0, '', 22, C.gold);
    this.titleText.setStyle({ fontFamily: FONT, fontStyle: 'bold' });
    this.bodyText = text(this, 0, 0, '', 13, C.ink);
    this.bodyText.setAlign('center').setLineSpacing(7);
    this.dots = this.add.graphics();

    this.nextBtn = new Button(this, 0, 0, 'NEXT', { width: 240, variant: 'primary' }, () =>
      this.advance(),
    );
    this.backBtn = new Button(this, 0, 0, 'SKIP', { width: 240, variant: 'ghost' }, () =>
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
