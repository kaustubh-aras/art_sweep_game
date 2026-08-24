import Phaser from 'phaser';
import { C, FONT, hex } from '@/clockshot/theme';
import { addBackdrop } from '@/clockshot/glass';
import { sfx } from '@/clockshot/sfx';
import { Button, fadeTo, fitText, layoutOf, text, type Layout } from '@/clockshot/ui';
import { countKind, seedOf, starterLevel, toArena, validate, type BuildLevel } from '@/clockshot/build';
import { canPersist, deleteLevel, loadDraft, loadLibrary } from '@/clockshot/buildStore';
import { practiceRun } from '@/clockshot/practice';
import { attachTapProxy, type TapProxy } from '@/clockshot/immersive';

interface Row {
  level: BuildLevel;
  title: Phaser.GameObjects.Text;
  sub: Phaser.GameObjects.Text;
  zone: Phaser.GameObjects.Zone;
  y: number;
  h: number;
}

/**
 * The shelf: every level this player has built and cleared.
 *
 * A level reaches this list only by being finished by its own author, so
 * nothing here is unplayable. The draft in progress is deliberately not on the
 * shelf — it lives in the editor until it earns a place.
 */
export class LevelsScene extends Phaser.Scene {
  private levels: BuildLevel[] = [];
  private selected = 0;

  private bg!: Phaser.GameObjects.Graphics;
  private listGfx!: Phaser.GameObjects.Graphics;
  private listLayer!: Phaser.GameObjects.Container;
  private listMask!: Phaser.GameObjects.Graphics;

  private title!: Phaser.GameObjects.Text;
  private blurb!: Phaser.GameObjects.Text;
  private empty!: Phaser.GameObjects.Text;

  private playBtn!: Button;
  private editBtn!: Button;
  private deleteBtn!: Button;
  private newBtn!: Button;
  private backBtn!: Button;

  private rows: Row[] = [];
  private listRect = { x: 0, y: 0, w: 0, h: 0 };
  private scroll = 0;
  private contentH = 0;
  /** Delete asks once. The second tap on an armed button is the confirmation. */
  private deleteArmed = false;
  /**
   * Set the moment a press turns into a scroll.
   *
   * The rows own the tap and the scene owns the drag, so without this every
   * flick down the list would also select whatever row the finger started on.
   */
  private dragMoved = false;

  /**
   * The three taps that lead somewhere worth the whole screen.
   *
   * A player can reach this shelf without the game having asked for the screen
   * yet — Reddit can restore a collapsed post, a desktop player can press
   * Escape — so every door out of it carries the request rather than assuming
   * the one on the menu already did.
   */
  private proxies: TapProxy[] = [];

  constructor() {
    super('cs-levels');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    // Glass needs something behind it, or it is just a grey box.
    addBackdrop(this);
    this.levels = loadLibrary();
    this.selected = 0;
    this.scroll = 0;
    this.deleteArmed = false;

    this.bg = this.add.graphics();
    this.listGfx = this.add.graphics().setDepth(1);
    this.listLayer = this.add.container(0, 0).setDepth(2);
    this.listMask = this.make.graphics({}, false);
    const mask = this.listMask.createGeometryMask();
    this.listGfx.setMask(mask);
    this.listLayer.setMask(mask);

    this.title = text(this, 0, 0, 'MY LEVELS', 24, C.gold);
    this.title.setStyle({ fontFamily: FONT, fontStyle: 'bold' });
    this.blurb = text(this, 0, 0, '', 11, C.dim);
    this.empty = text(this, 0, 0, '', 12, C.dim);
    this.empty.setAlign('center').setLineSpacing(6);

    this.playBtn = new Button(this, 0, 0, 'PLAY', { width: 100, variant: 'primary' }, () =>
      this.onPlay(),
    );
    this.editBtn = new Button(this, 0, 0, 'EDIT', { width: 100, variant: 'secondary', color: C.gold }, () => this.onEdit());
    this.deleteBtn = new Button(this, 0, 0, 'DELETE', { width: 100, variant: 'danger' }, () =>
      this.onDelete(),
    );
    this.newBtn = new Button(this, 0, 0, 'NEW LEVEL', { width: 240, variant: 'secondary', color: C.good }, () =>
      this.onNew(),
    );
    this.backBtn = new Button(this, 0, 0, 'BACK', { width: 240, variant: 'ghost' }, () =>
      fadeTo(this, () => this.scene.start('cs-menu')),
    );

    this.buildRows();
    this.bindScroll();
    this.relayout();
    this.render();

    for (const b of [this.playBtn, this.editBtn, this.newBtn]) {
      const proxy = attachTapProxy(this, b);
      if (proxy) this.proxies.push(proxy);
    }

    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
      for (const proxy of this.proxies) proxy.destroy();
      this.proxies = [];
    });

    this.cameras.main.fadeIn(180, 7, 11, 22);
  }

  /* ---------------------------------------------------------------------- */
  /* Rows                                                                    */
  /* ---------------------------------------------------------------------- */

  private buildRows(): void {
    for (const row of this.rows) {
      row.title.destroy();
      row.sub.destroy();
      row.zone.destroy();
    }
    this.rows = [];

    this.levels.forEach((level, i) => {
      const title = this.add
        .text(0, 0, level.name.toUpperCase(), { fontFamily: FONT, fontSize: '13px', color: hex(C.ink) })
        .setOrigin(0, 0.5);
      const sub = this.add
        .text(0, 0, this.subLine(level), { fontFamily: FONT, fontSize: '10px', color: hex(C.dim) })
        .setOrigin(0, 0.5);
      const zone = this.add.zone(0, 0, 10, 10).setOrigin(0, 0).setInteractive({ useHandCursor: true });
      zone.on('pointerup', () => this.select(i));
      this.listLayer.add([title, sub, zone]);
      this.rows.push({ level, title, sub, zone, y: 0, h: 0 });
    });
  }

  private subLine(level: BuildLevel): string {
    const cleared = level.verifiedMs !== null ? `cleared with ${(level.verifiedMs / 1000).toFixed(1)}s` : 'not cleared';
    const bits = [
      `${level.pieces.length} pieces`,
      `${countKind(level, 'anchor')} anchors`,
      cleared,
    ];
    return bits.join('  ·  ');
  }

  private select(i: number): void {
    if (this.dragMoved) return;
    if (this.selected === i) return;
    sfx.uiTap();
    this.selected = i;
    this.deleteArmed = false;
    this.render();
  }

  /**
   * The list scrolls by dragging anywhere on it.
   *
   * The row zones handle the tap; this handles the drag, and a drag that has
   * travelled far enough stops being a tap — otherwise every scroll would also
   * select whatever the finger happened to land on.
   */
  private bindScroll(): void {
    let dragging = false;
    let startY = 0;
    let startScroll = 0;

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!this.inList(p.x, p.y)) return;
      dragging = true;
      this.dragMoved = false;
      startY = p.y;
      startScroll = this.scroll;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!dragging || !p.isDown) return;
      const dy = p.y - startY;
      if (Math.abs(dy) < 4) return;
      this.dragMoved = true;
      this.scroll = this.clampScroll(startScroll + dy);
      this.layoutRows();
      this.drawList();
    });
    this.input.on('pointerup', () => {
      dragging = false;
    });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      if (!this.inList(p.x, p.y)) return;
      this.scroll = this.clampScroll(this.scroll - dy);
      this.layoutRows();
      this.drawList();
    });
  }

  private inList(x: number, y: number): boolean {
    const r = this.listRect;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  private clampScroll(v: number): number {
    const slack = Math.max(0, this.contentH - this.listRect.h);
    return Phaser.Math.Clamp(v, -slack, 0);
  }

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */

  private current(): BuildLevel | null {
    return this.levels[this.selected] ?? null;
  }

  private onPlay(): void {
    const level = this.current();
    if (!level) return;
    const problem = validate(level);
    if (problem) {
      this.blurb.setText(problem).setColor(hex(C.danger));
      return;
    }
    fadeTo(this, () =>
      this.scene.start('cs-play', {
        run: practiceRun(seedOf(level)),
        arena: toArena(level),
        practice: { levelId: level.id, name: level.name, returnTo: 'cs-levels' },
      }),
    );
  }

  private onEdit(): void {
    const level = this.current();
    if (!level) return;
    fadeTo(this, () => this.scene.start('cs-editor', { level }));
  }

  /** The first tap arms; the second deletes. Nothing here is recoverable. */
  private onDelete(): void {
    const level = this.current();
    if (!level) return;
    if (!this.deleteArmed) {
      this.deleteArmed = true;
      this.render();
      return;
    }
    deleteLevel(level.id);
    this.levels = loadLibrary();
    this.selected = Math.max(0, Math.min(this.selected, this.levels.length - 1));
    this.deleteArmed = false;
    this.buildRows();
    this.relayout();
    this.render();
  }

  /**
   * A new level, without throwing away the one in progress.
   *
   * The draft is a single slot, so starting a new build over an uncleared one
   * would lose it silently. When that is what is about to happen, the button
   * says so and the second tap goes ahead.
   */
  private onNew(): void {
    const draft = loadDraft();
    const risky = draft !== null && draft.verifiedMs === null && draft.pieces.length > 0;
    if (risky && this.newBtn.caption === 'NEW LEVEL') {
      this.newBtn.setCaption('DISCARD DRAFT?');
      return;
    }
    const n = this.levels.length + 1;
    fadeTo(this, () => this.scene.start('cs-editor', { level: starterLevel(`ARENA ${n}`) }));
  }

  /* ---------------------------------------------------------------------- */
  /* Layout and paint                                                        */
  /* ---------------------------------------------------------------------- */

  private relayout(): void {
    const L = layoutOf(this);
    const u = L.ui;

    this.title.setPosition(L.cx, L.y + 22 * u).setFontSize(Math.round(22 * u));
    this.blurb.setPosition(L.cx, L.y + 48 * u).setFontSize(Math.round(11 * u));

    const btnH = 48 * u;
    const gap = 9 * u;
    // Three rows of buttons at the bottom; the list takes everything above.
    const bottom = L.y + L.ih;
    const backY = bottom - btnH / 2;
    const newY = backY - btnH - gap;
    const actionY = newY - btnH - gap;

    const wide = Math.min(300 * u, L.iw - 20 * u);
    this.backBtn.setPosition(L.cx, backY).setSize(wide, btnH).setFontSize(15 * u);
    this.newBtn.setPosition(L.cx, newY).setSize(wide, btnH).setFontSize(15 * u);

    const third = (wide - gap * 2) / 3;
    this.playBtn.setPosition(L.cx - third - gap, actionY).setSize(third, btnH).setFontSize(13 * u);
    this.editBtn.setPosition(L.cx, actionY).setSize(third, btnH).setFontSize(13 * u);
    this.deleteBtn.setPosition(L.cx + third + gap, actionY).setSize(third, btnH).setFontSize(13 * u);

    const listTop = L.y + 66 * u;
    this.listRect = {
      x: L.x,
      y: listTop,
      w: L.iw,
      h: Math.max(60 * u, actionY - btnH / 2 - gap - listTop),
    };
    this.listMask.clear();
    this.listMask.fillStyle(0xffffff);
    this.listMask.fillRect(this.listRect.x, this.listRect.y, this.listRect.w, this.listRect.h);

    this.empty.setPosition(L.cx, this.listRect.y + this.listRect.h / 2).setFontSize(Math.round(12 * u));

    this.layoutRows();
    this.paintBackground(L);
    this.drawList();

    // A proxy that did not follow the re-layout would take taps where the
    // button no longer is.
    for (const proxy of this.proxies) proxy.sync();
  }

  private layoutRows(): void {
    const L = layoutOf(this);
    const u = L.ui;
    const rowH = 54 * u;
    const gap = 8 * u;

    this.contentH = this.rows.length * rowH + Math.max(0, this.rows.length - 1) * gap;
    this.scroll = this.clampScroll(this.scroll);

    this.rows.forEach((row, i) => {
      const y = this.listRect.y + this.scroll + i * (rowH + gap);
      row.y = y;
      row.h = rowH;
      row.title.setPosition(this.listRect.x + 14 * u, y + rowH * 0.36).setFontSize(Math.round(12.5 * u));
      row.sub.setPosition(this.listRect.x + 14 * u, y + rowH * 0.68).setFontSize(Math.round(9.5 * u));
      fitText(row.title, 12.5 * u, this.listRect.w - 60 * u);
      fitText(row.sub, 9.5 * u, this.listRect.w - 30 * u);
      row.zone.setPosition(this.listRect.x, y).setSize(this.listRect.w, rowH);
      if (row.zone.input) row.zone.input.hitArea.setTo(0, 0, this.listRect.w, rowH);
    });
  }

  private paintBackground(L: Layout): void {
    const g = this.bg;
    g.clear();
    g.fillStyle(C.panel, 0.4);
    g.fillRoundedRect(this.listRect.x, this.listRect.y, this.listRect.w, this.listRect.h, 14 * L.ui);
  }

  private drawList(): void {
    const L = layoutOf(this);
    const u = L.ui;
    const g = this.listGfx;
    g.clear();

    this.rows.forEach((row, i) => {
      const on = i === this.selected;
      g.fillStyle(on ? C.cyan : C.panel, on ? 0.14 : 0.9);
      g.fillRoundedRect(this.listRect.x, row.y, this.listRect.w, row.h, 12 * u);
      g.lineStyle(on ? 2 : 1.2, on ? C.cyan : C.panelEdge, on ? 1 : 0.5);
      g.strokeRoundedRect(this.listRect.x, row.y, this.listRect.w, row.h, 12 * u);

      // Difficulty as pips, because a number nobody set by hand reads as data.
      const pips = toArenaDifficulty(row.level);
      for (let p = 0; p < 5; p++) {
        const cx = this.listRect.x + this.listRect.w - 18 * u - (4 - p) * 9 * u;
        g.fillStyle(p < pips ? C.gold : C.panelEdge, p < pips ? 0.9 : 0.6);
        g.fillCircle(cx, row.y + row.h / 2, 2.6 * u);
      }
    });
  }

  private render(): void {
    const has = this.levels.length > 0;

    this.empty.setVisible(!has);
    if (!has) {
      this.empty.setText(
        canPersist()
          ? 'Nothing built yet.\n\nNEW LEVEL opens the editor.\nClear your level once and it lands here.'
          : 'This browser will not keep saved levels,\nso the shelf stays empty.\nThe editor still works for a single session.',
      );
    }

    this.blurb
      .setText(has ? `${this.levels.length} level${this.levels.length === 1 ? '' : 's'} on this device` : '')
      .setColor(hex(C.dim));

    for (const b of [this.playBtn, this.editBtn, this.deleteBtn]) b.setEnabled(has);
    this.deleteBtn.setCaption(this.deleteArmed ? 'SURE?' : 'DELETE');
    this.newBtn.setCaption('NEW LEVEL');

    this.drawList();
  }
}

/**
 * The same difficulty the arena itself would report.
 *
 * Converting the whole level to get one number is wasteful and honest: there is
 * exactly one definition of how hard a built level is, and it lives with the
 * conversion rather than being approximated a second time here.
 */
function toArenaDifficulty(level: BuildLevel): number {
  return toArena(level).difficulty;
}
