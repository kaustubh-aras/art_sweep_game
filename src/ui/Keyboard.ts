import Phaser from 'phaser';
import { T, TX, FONT } from './theme';
import { sfx } from '@/audio/AudioManager';
import { dpr } from './viewport';

interface KeyDef {
  id: string;
  glyph: string;
  weight: number;
}

const ROWS: KeyDef[][] = [
  'qwertyuiop'.split('').map((c) => ({ id: c, glyph: c.toUpperCase(), weight: 1 })),
  'asdfghjkl'.split('').map((c) => ({ id: c, glyph: c.toUpperCase(), weight: 1 })),
  [
    { id: '\b', glyph: '⌫', weight: 1.5 },
    ...'zxcvbnm'.split('').map((c) => ({ id: c, glyph: c.toUpperCase(), weight: 1 })),
    { id: ' ', glyph: '␣', weight: 1.5 },
  ],
];

interface KeyCell {
  def: KeyDef;
  bg: Phaser.GameObjects.Graphics;
  text: Phaser.GameObjects.Text;
  hit: Phaser.GameObjects.Rectangle;
  x: number;
  y: number;
  w: number;
  h: number;
  last: number;
}

/**
 * An in-game keyboard.
 *
 * A DOM `<input>` would summon the mobile soft keyboard, which resizes the
 * visual viewport, shoves the page around and would break the fixed-screen
 * rule outright. Drawing the keyboard inside the canvas keeps the whole game on
 * one non-scrolling screen and lets it match the radar styling.
 *
 * Keys fire on *press* rather than release — that is what a keyboard feels
 * like — with a short per-key cooldown so a bounced tap cannot type twice.
 */
export class Keyboard extends Phaser.GameObjects.Container {
  private cells: KeyCell[] = [];
  private enabled = true;

  constructor(scene: Phaser.Scene) {
    super(scene, 0, 0);
    scene.add.existing(this);

    for (const row of ROWS) {
      for (const def of row) {
        const bg = scene.add.graphics();
        const text = scene.add
          .text(0, 0, def.glyph, { fontFamily: FONT, fontSize: '16px', color: TX.text })
          .setOrigin(0.5);
        const hit = scene.add.rectangle(0, 0, 10, 10, 0xffffff, 0).setOrigin(0.5);
        const cell: KeyCell = { def, bg, text, hit, x: 0, y: 0, w: 10, h: 10, last: -1e9 };
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => this.press(cell));
        this.add([bg, text, hit]);
        this.cells.push(cell);
      }
    }
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  /** How tall the keyboard wants to be for a given width. */
  static heightFor(w: number, maxH: number): number {
    const keyW = Math.min(w / 10.2, 58 * dpr());
    const keyH = Math.min(keyW * 1.08, maxH / 3.3);
    return keyH * 3 + Math.max(3, keyW * 0.09) * 2;
  }

  layout(x: number, y: number, w: number, maxH: number): this {
    const keyW = Math.min(w / 10.2, 58 * dpr());
    const gap = Math.max(3, keyW * 0.09);
    const keyH = Math.min(keyW * 1.08, (maxH - gap * 2) / 3);
    const fontPx = Math.max(11 * dpr(), Math.round(keyH * 0.42));

    let i = 0;
    ROWS.forEach((row, r) => {
      const units = row.reduce((a, k) => a + k.weight, 0);
      const rowW = units * keyW + gap * (row.length - 1);
      let cx = x + (w - rowW) / 2;
      const cy = y + r * (keyH + gap);
      for (const def of row) {
        const cw = def.weight * keyW;
        const cell = this.cells[i++];
        cell.x = cx + cw / 2;
        cell.y = cy + keyH / 2;
        cell.w = cw;
        cell.h = keyH;
        cell.text.setPosition(cell.x, cell.y).setFontSize(fontPx);
        cell.hit.setPosition(cell.x, cell.y).setSize(cw + gap, keyH + gap);
        cell.hit.setInteractive({ useHandCursor: true });
        this.drawKey(cell, false);
        cx += cw + gap;
      }
    });
    return this;
  }

  setEnabled(on: boolean): this {
    this.enabled = on;
    this.setAlpha(on ? 1 : 0.32);
    for (const c of this.cells) c.hit.input && (c.hit.input.enabled = on);
    return this;
  }

  /** Route a physical key press through the same path (desktop secondary input). */
  pressPhysical(id: string): void {
    const cell = this.cells.find((c) => c.def.id === id);
    if (cell) this.press(cell);
  }

  private press(cell: KeyCell): void {
    if (!this.enabled) return;
    const now = this.scene.time.now;
    if (now - cell.last < 110) return;
    cell.last = now;

    this.drawKey(cell, true);
    this.scene.time.delayedCall(90, () => this.drawKey(cell, false));
    sfx.tap();

    if (cell.def.id === '\b') this.emit('del');
    else this.emit('key', cell.def.id);
  }

  private drawKey(cell: KeyCell, down: boolean): void {
    const g = cell.bg;
    const r = Math.min(7, cell.h / 3);
    g.clear();
    g.fillStyle(down ? T.keyDown : T.key, down ? 1 : 0.92);
    g.fillRoundedRect(cell.x - cell.w / 2, cell.y - cell.h / 2, cell.w, cell.h, r);
    g.lineStyle(1, down ? T.hand : T.keyEdge, down ? 1 : 0.85);
    g.strokeRoundedRect(cell.x - cell.w / 2, cell.y - cell.h / 2, cell.w, cell.h, r);
    cell.text.setColor(down ? TX.green : TX.text);
  }
}
