import Phaser from 'phaser';
import { C, FONT, hex } from '@/clockshot/theme';
import { sfx } from '@/clockshot/sfx';
import { fadeTo, fitText, layoutOf, type Layout } from '@/clockshot/ui';
import {
  BUDGET_TOTAL,
  CELL,
  COLS,
  PALETTE_ORDER,
  PIECES,
  ROWS,
  WORLD,
  budgetOf,
  cloneLevel,
  countKind,
  inBounds,
  occupied,
  pieceAt,
  sameCell,
  seedOf,
  starterLevel,
  toArena,
  validate,
  type BuildLevel,
  type Cell,
  type PieceKind,
  type Tool,
} from '@/clockshot/build';
import { canPersist, isSaved, loadDraft, saveDraft, saveLevel } from '@/clockshot/buildStore';
import { practiceRun, type PracticeResult } from '@/clockshot/practice';
import { drawPieceIcon } from '@/clockshot/buildArt';
import { attachTapProxy, type TapProxy, type TapTarget } from '@/clockshot/immersive';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every tappable thing outside the canvas, hit-tested by hand. */
interface Region extends Rect {
  id: string;
}

interface Chip {
  tool: Tool;
  /** Rail-space rectangle; the live one is this offset by the rail scroll. */
  base: Rect;
  name: Phaser.GameObjects.Text;
  sub: Phaser.GameObjects.Text;
}

interface EditorInit {
  /** A level to open. Without one the editor picks the draft back up. */
  level?: BuildLevel;
  /** How the test run that just ended went, when arriving back from one. */
  result?: PracticeResult;
}

const MAX_UNDO = 40;

/**
 * The level editor.
 *
 * One `BuildLevel` is the whole truth; the screen is a pure function of it, and
 * every change goes through `mutate` so undo, the budget, the draft on disk and
 * the level's verified flag can never drift apart from each other.
 *
 * The arrangement is the one a phone can actually be built on: the palette is a
 * rail down the side where a thumb already is, the toolbar sits above the
 * canvas, and TEST and SAVE float over the bottom corner of the grid — so the
 * two things a builder does most often are never more than a thumb's reach from
 * the piece they just placed.
 */
export class EditorScene extends Phaser.Scene {
  private level!: BuildLevel;
  private pending?: EditorInit;

  private tool: Tool = 'block';
  /** With this on, every tap takes something away instead of putting it down. */
  private erase = false;
  /** Whether a drag paints cells or slides the view. Tapping places either way. */
  private paintMode = false;
  private showGrid = true;

  private undoStack: BuildLevel[] = [];
  private redoStack: BuildLevel[] = [];
  /**
   * Whether this level is already on the shelf.
   *
   * Cached rather than asked. The library lives in `localStorage`, and reading
   * it means parsing every level a player owns — not something to do on every
   * frame of a paint stroke just to decide what one button says.
   */
  private onShelf = false;

  /* View onto the grid: world units at the canvas corner, and screen-per-world. */
  private zoom = 1;
  private camX = 0;
  private camY = 0;

  /* Geometry, all recomputed by relayout(). */
  private L!: Layout;
  private canvas: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private rail: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private railScroll = 0;
  private railContentH = 0;
  private regions: Region[] = [];

  private canvasGfx!: Phaser.GameObjects.Graphics;
  private chromeGfx!: Phaser.GameObjects.Graphics;
  private railGfx!: Phaser.GameObjects.Graphics;
  private railText!: Phaser.GameObjects.Container;
  private canvasMask!: Phaser.GameObjects.Graphics;
  private railMask!: Phaser.GameObjects.Graphics;

  private chips: Chip[] = [];
  private barLabels = new Map<string, Phaser.GameObjects.Text>();
  private nameText!: Phaser.GameObjects.Text;
  private budgetText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private toastText!: Phaser.GameObjects.Text;
  private toastTween?: Phaser.Tweens.Tween;

  /**
   * TEST is the tap that asks for the screen.
   *
   * A test run is a run, and a run wants the whole display — but the request
   * only travels on a click the browser itself made, and this canvas never
   * produces one. So TEST gets the same transparent DOM stand-in the menu's
   * PLAY button has. Where the game already has the screen there is nothing to
   * ask for and no proxy is made, and the canvas handles the tap as usual.
   */
  private testProxy: TapProxy | null = null;
  private testDown = false;

  /* Gesture state. */
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: 'none' | 'pan' | 'paint' | 'pinch' | 'rail' = 'none';
  private pressRegion: string | null = null;
  private moved = false;
  private dragStart = { sx: 0, sy: 0, camX: 0, camY: 0, scroll: 0 };
  private pinchStart = { dist: 1, zoom: 1, mx: 0, my: 0, camX: 0, camY: 0 };
  private strokeSnapshot: BuildLevel | null = null;
  private strokeChanged = false;
  private lastPaintCell: Cell | null = null;

  constructor() {
    super('cs-editor');
  }

  init(data: EditorInit): void {
    this.pending = data;
  }

  create(): void {
    this.level = this.pending?.level ?? loadDraft() ?? starterLevel();
    this.undoStack = [];
    this.redoStack = [];
    this.tool = 'block';
    this.erase = false;
    this.gesture = 'none';
    this.pointers.clear();
    this.onShelf = isSaved(this.level.id);

    this.cameras.main.setBackgroundColor(C.bg);

    this.canvasMask = this.make.graphics({}, false);
    this.railMask = this.make.graphics({}, false);

    this.canvasGfx = this.add.graphics().setDepth(2);
    this.canvasGfx.setMask(this.canvasMask.createGeometryMask());

    this.railGfx = this.add.graphics().setDepth(6);
    this.railGfx.setMask(this.railMask.createGeometryMask());
    this.railText = this.add.container(0, 0).setDepth(7);
    this.railText.setMask(this.railMask.createGeometryMask());

    this.chromeGfx = this.add.graphics().setDepth(8);

    this.buildChips();
    this.buildBar();

    this.toastText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '12px', color: hex(C.ink) })
      .setOrigin(0.5)
      .setDepth(30)
      .setAlpha(0);

    this.bindInput();
    this.relayout();
    this.fitView();
    this.refresh();

    this.testProxy = attachTapProxy(this, this.testTarget());

    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
      this.testProxy?.destroy();
      this.testProxy = null;
    });

    // Back from a test run: a clear is the one thing that makes a level
    // saveable, so it is worth saying out loud rather than only lighting a
    // button somewhere.
    const result = this.pending?.result;
    if (result?.clearedMs != null) {
      this.level.verifiedMs = result.clearedMs;
      saveDraft(this.level);
      this.refresh();
      this.toast(`CLEARED with ${(result.clearedMs / 1000).toFixed(1)}s — ready to save`, 2600);
    } else if (result) {
      this.toast('Test ended without reaching the goal', 2200);
    }
    this.pending = undefined;

    this.cameras.main.fadeIn(180, 7, 11, 22);
  }

  /* ---------------------------------------------------------------------- */
  /* Furniture                                                               */
  /* ---------------------------------------------------------------------- */

  private tools(): Tool[] {
    return [...PALETTE_ORDER, 'spawn', 'goal'];
  }

  private buildChips(): void {
    for (const tool of this.tools()) {
      const name = this.add
        .text(0, 0, this.toolLabel(tool), { fontFamily: FONT, fontSize: '11px', color: hex(C.ink) })
        .setOrigin(0, 0.5);
      const sub = this.add
        .text(0, 0, '', { fontFamily: FONT, fontSize: '9px', color: hex(C.dim) })
        .setOrigin(0, 0.5);
      this.railText.add([name, sub]);
      this.chips.push({ tool, base: { x: 0, y: 0, w: 0, h: 0 }, name, sub });
    }
  }

  private toolLabel(tool: Tool): string {
    if (tool === 'spawn') return 'SPAWN';
    if (tool === 'goal') return 'GOAL';
    return PIECES[tool].label;
  }

  private buildBar(): void {
    const add = (id: string, caption: string, size = 13): void => {
      const t = this.add
        .text(0, 0, caption, { fontFamily: FONT, fontSize: `${size}px`, color: hex(C.ink) })
        .setOrigin(0.5)
        .setDepth(10);
      this.barLabels.set(id, t);
    };

    add('back', '‹', 17);
    add('levels', '≡', 15);
    add('undo', '↶', 15);
    add('redo', '↷', 15);
    add('grid', '#', 13);
    add('erase', 'ERASE', 10);
    add('mode', 'PAN', 10);
    add('test', 'TEST', 14);
    add('save', 'SAVE', 14);

    this.nameText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '13px', color: hex(C.gold) })
      .setOrigin(0.5)
      .setDepth(10);
    this.budgetText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '9px', color: hex(C.dim) })
      .setOrigin(1, 0.5)
      .setDepth(10);
    this.statusText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '9px', color: hex(C.dim) })
      .setOrigin(0, 0.5)
      .setDepth(10);
  }

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                  */
  /* ---------------------------------------------------------------------- */

  private relayout(): void {
    const L = layoutOf(this);
    this.L = L;
    const u = L.ui;

    const railW = Math.min(84 * u, L.iw * 0.26);
    const barH = 74 * u;
    const gap = 8 * u;

    this.rail = { x: L.x, y: L.y, w: railW, h: L.ih };
    const rightX = L.x + railW + gap;
    const rightW = L.iw - railW - gap;

    this.canvas = {
      x: rightX,
      y: L.y + barH + gap,
      w: rightW,
      h: L.ih - barH - gap,
    };

    this.canvasMask.clear();
    this.canvasMask.fillStyle(0xffffff);
    this.canvasMask.fillRect(this.canvas.x, this.canvas.y, this.canvas.w, this.canvas.h);
    this.railMask.clear();
    this.railMask.fillStyle(0xffffff);
    this.railMask.fillRect(this.rail.x, this.rail.y, this.rail.w, this.rail.h);

    this.regions = [];
    this.layoutRail();
    this.layoutBar(rightX, L.y, rightW, barH);

    this.clampZoom();
    this.clampCam();
    this.refresh();

    // A proxy that did not follow the re-layout would take taps where TEST no
    // longer is — and going full screen is itself a re-layout.
    this.testProxy?.sync();
  }

  private layoutRail(): void {
    const u = this.L.ui;
    const n = this.chips.length;
    const gap = 5 * u;
    const h = Phaser.Math.Clamp((this.rail.h - gap * (n - 1)) / n, 34 * u, 62 * u);

    this.railContentH = h * n + gap * (n - 1);
    this.railScroll = this.clampScroll(this.railScroll);

    this.chips.forEach((chip, i) => {
      chip.base = { x: this.rail.x, y: this.rail.y + i * (h + gap), w: this.rail.w, h };
    });
  }

  private clampScroll(v: number): number {
    const slack = Math.max(0, this.railContentH - this.rail.h);
    return Phaser.Math.Clamp(v, -slack, 0);
  }

  private layoutBar(x: number, y: number, w: number, h: number): void {
    const u = this.L.ui;
    const pad = 8 * u;
    const rowH = (h - pad * 3) / 2;
    const row1 = y + pad + rowH / 2;
    const row2 = y + pad * 2 + rowH + rowH / 2;

    const icon = 30 * u;
    const gap = 5 * u;

    // Row one: leaving, the level's name, and taking a step back.
    let cx = x + pad;
    for (const id of ['back', 'levels']) {
      this.addRegion(id, { x: cx, y: row1 - rowH / 2, w: icon, h: rowH });
      cx += icon + gap;
    }

    let rx = x + w - pad;
    for (const id of ['redo', 'undo']) {
      rx -= icon;
      this.addRegion(id, { x: rx, y: row1 - rowH / 2, w: icon, h: rowH });
      rx -= gap;
    }

    const nameRect = { x: cx, y: row1 - rowH / 2, w: Math.max(40 * u, rx - cx), h: rowH };
    this.addRegion('name', nameRect);
    this.nameText.setPosition(nameRect.x + nameRect.w / 2, row1).setFontSize(Math.round(12 * u));

    // Row two: the switches, then the budget that governs all of them.
    cx = x + pad;
    this.addRegion('grid', { x: cx, y: row2 - rowH / 2, w: icon, h: rowH });
    cx += icon + gap;
    const wide = 46 * u;
    this.addRegion('erase', { x: cx, y: row2 - rowH / 2, w: wide, h: rowH });
    cx += wide + gap;
    this.addRegion('mode', { x: cx, y: row2 - rowH / 2, w: wide, h: rowH });
    cx += wide + gap;

    const meterW = Math.max(40 * u, x + w - pad - cx);
    this.addRegion('budget', { x: cx, y: row2 - rowH / 2, w: meterW, h: rowH });
    this.budgetText
      .setPosition(cx + meterW - 6 * u, row2 - rowH / 2 + rowH * 0.28)
      .setFontSize(Math.round(9 * u));
    this.statusText
      .setPosition(cx + 6 * u, row2 - rowH / 2 + rowH * 0.28)
      .setFontSize(Math.round(9 * u));

    for (const [id, t] of this.barLabels) {
      const r = this.regions.find((q) => q.id === id);
      if (r) t.setPosition(r.x + r.w / 2, r.y + r.h / 2);
    }
    this.barLabels.get('back')?.setFontSize(Math.round(17 * u));
    this.barLabels.get('levels')?.setFontSize(Math.round(15 * u));
    this.barLabels.get('undo')?.setFontSize(Math.round(15 * u));
    this.barLabels.get('redo')?.setFontSize(Math.round(15 * u));
    this.barLabels.get('grid')?.setFontSize(Math.round(13 * u));
    this.barLabels.get('erase')?.setFontSize(Math.round(9.5 * u));
    this.barLabels.get('mode')?.setFontSize(Math.round(9.5 * u));

    // The two verbs, floating over the corner of the grid a thumb rests on.
    const bw = Math.min(96 * u, (this.canvas.w - pad * 3) / 2);
    const bh = 44 * u;
    const by = this.canvas.y + this.canvas.h - bh - pad;
    const bx = this.canvas.x + this.canvas.w - pad - bw;
    this.addRegion('test', { x: bx, y: by, w: bw, h: bh });
    this.addRegion('save', { x: bx - bw - pad, y: by, w: bw, h: bh });
    for (const id of ['test', 'save']) {
      const r = this.regions.find((q) => q.id === id)!;
      this.barLabels.get(id)?.setPosition(r.x + r.w / 2, r.y + r.h / 2).setFontSize(Math.round(14 * u));
    }

    this.toastText
      .setPosition(this.canvas.x + this.canvas.w / 2, this.canvas.y + 20 * u)
      .setFontSize(Math.round(11 * u))
      .setAlign('center')
      .setWordWrapWidth(this.canvas.w - 24 * u);
  }

  private addRegion(id: string, r: Rect): void {
    this.regions.push({ id, ...r });
  }

  /**
   * The TEST button, described the way a tap proxy needs it.
   *
   * The editor's controls are rectangles in a `Graphics`, not `Button`s, so
   * there is no object to hand over — this is one, backed by the same region
   * the canvas draws and hit-tests.
   */
  private testTarget(): TapTarget {
    const scene = this;
    return {
      bounds: () => scene.region('test') ?? { x: 0, y: 0, w: 0, h: 0 },
      get isEnabled(): boolean {
        return true;
      },
      get isVisible(): boolean {
        return true;
      },
      get caption(): string {
        return 'TEST';
      },
      setPressed: (on: boolean) => {
        scene.testDown = on;
        scene.drawChrome();
      },
      click: () => scene.onTest(),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Drawing                                                                 */
  /* ---------------------------------------------------------------------- */

  private refresh(): void {
    this.drawChrome();
    this.drawRail();
    this.drawCanvas();
  }

  private drawChrome(): void {
    const g = this.chromeGfx;
    const u = this.L.ui;
    g.clear();

    const bar = this.barRect();
    this.panel(g, bar, 14 * u, C.panel, 0.95, C.panelEdge);

    for (const id of ['back', 'levels', 'undo', 'redo', 'grid']) {
      const r = this.region(id);
      if (r) this.chipBox(g, r, false, C.panelEdge);
    }

    const undoOn = this.undoStack.length > 0;
    const redoOn = this.redoStack.length > 0;
    this.barLabels.get('undo')?.setAlpha(undoOn ? 1 : 0.3);
    this.barLabels.get('redo')?.setAlpha(redoOn ? 1 : 0.3);

    const gridR = this.region('grid');
    if (gridR && this.showGrid) this.chipBox(g, gridR, true, C.cyan);

    const eraseR = this.region('erase');
    if (eraseR) this.chipBox(g, eraseR, this.erase, this.erase ? C.danger : C.panelEdge);
    this.barLabels.get('erase')?.setColor(hex(this.erase ? C.danger : C.dim));

    const modeR = this.region('mode');
    if (modeR) this.chipBox(g, modeR, this.paintMode, this.paintMode ? C.cyan : C.panelEdge);
    this.barLabels.get('mode')?.setText(this.paintMode ? 'PAINT' : 'PAN');
    this.barLabels.get('mode')?.setColor(hex(this.paintMode ? C.cyan : C.dim));

    // The budget meter. Cyan while there is room, gold when it is tight, red
    // at the ceiling — a builder should feel the wall before they hit it.
    const meter = this.region('budget');
    if (meter) {
      const used = budgetOf(this.level);
      const frac = Phaser.Math.Clamp(used / BUDGET_TOTAL, 0, 1);
      const colour = frac >= 1 ? C.danger : frac > 0.8 ? C.gold : C.cyan;
      const trackY = meter.y + meter.h * 0.62;
      const trackH = 6 * u;
      g.fillStyle(C.grid, 1);
      g.fillRoundedRect(meter.x, trackY, meter.w, trackH, trackH / 2);
      if (frac > 0) {
        g.fillStyle(colour, 0.95);
        g.fillRoundedRect(meter.x, trackY, Math.max(trackH, meter.w * frac), trackH, trackH / 2);
      }
      this.budgetText.setText(`${used}/${BUDGET_TOTAL}`).setColor(hex(colour));
      this.statusText.setText('pieces');
    }

    this.nameText.setText(this.level.name.toUpperCase());
    const nameR = this.region('name');
    if (nameR) fitText(this.nameText, 12 * u, nameR.w - 8 * u);

    // The two verbs. SAVE only lights up once the level has actually been
    // cleared, because an unfinished level is not a level yet.
    const testR = this.region('test');
    if (testR) this.actionBox(g, testR, C.good, true, this.testDown);
    const saveR = this.region('save');
    if (saveR) {
      const ready = this.level.verifiedMs !== null;
      this.actionBox(g, saveR, C.gold, ready);
      this.barLabels
        .get('save')
        ?.setText(this.onShelf && ready ? 'SAVED' : 'SAVE')
        .setAlpha(ready ? 1 : 0.45);
    }
  }

  private drawRail(): void {
    const g = this.railGfx;
    const u = this.L.ui;
    g.clear();

    const used = budgetOf(this.level);

    for (const chip of this.chips) {
      const r = { ...chip.base, y: chip.base.y + this.railScroll };
      const tool = chip.tool;
      const piece = tool === 'spawn' || tool === 'goal' ? null : PIECES[tool as PieceKind];

      const count = piece ? countKind(this.level, tool as PieceKind) : 1;
      const capped = piece?.cap != null && count >= piece.cap;
      const broke = piece != null && used + piece.cost > BUDGET_TOTAL;
      const disabled = !!piece && (capped || broke);
      const selected = this.tool === tool && !this.erase;
      const accent = piece?.color ?? (tool === 'spawn' ? C.cyan : C.goal);

      g.fillStyle(selected ? accent : C.panel, selected ? 0.16 : 0.92);
      g.fillRoundedRect(r.x, r.y, r.w, r.h, 10 * u);
      g.lineStyle(selected ? 2 : 1.2, selected ? accent : C.panelEdge, selected ? 1 : 0.55);
      g.strokeRoundedRect(r.x, r.y, r.w, r.h, 10 * u);

      const iconR = Math.min(r.h * 0.3, 13 * u);
      drawPieceIcon(g, tool, r.x + r.w - iconR - 9 * u, r.y + r.h / 2, iconR);

      chip.name
        .setPosition(r.x + 9 * u, r.y + r.h * 0.36)
        .setFontSize(Math.round(10.5 * u))
        .setColor(hex(disabled ? C.faint : selected ? C.ink : C.dim))
        .setAlpha(disabled ? 0.55 : 1);

      const sub = piece
        ? capped
          ? `max ${piece.cap}`
          : `${count}  ·  ${piece.cost}`
        : tool === 'spawn'
          ? 'start'
          : 'finish';
      chip.sub
        .setPosition(r.x + 9 * u, r.y + r.h * 0.68)
        .setFontSize(Math.round(9 * u))
        .setText(sub)
        .setColor(hex(disabled ? C.faint : selected ? accent : C.faint))
        .setAlpha(disabled ? 0.55 : 1);
    }
  }

  private drawCanvas(): void {
    const g = this.canvasGfx;
    const u = this.L.ui;
    const cv = this.canvas;
    g.clear();

    // The void the arena is cut out of.
    g.fillStyle(C.bg, 1);
    g.fillRect(cv.x, cv.y, cv.w, cv.h);

    const step = CELL * this.zoom;
    const x0 = Math.max(0, Math.floor(this.camX / CELL));
    const y0 = Math.max(0, Math.floor(this.camY / CELL));
    const x1 = Math.min(COLS - 1, Math.ceil((this.camX + cv.w / this.zoom) / CELL));
    const y1 = Math.min(ROWS - 1, Math.ceil((this.camY + cv.h / this.zoom) / CELL));

    // The world's own rectangle, so the edge of the buildable space is a place
    // rather than simply where things stop working.
    const o = this.originOf();
    g.fillStyle(C.panel, 0.5);
    g.fillRect(o.x, o.y, WORLD.width * this.zoom, WORLD.height * this.zoom);

    if (this.showGrid && step > 6) {
      for (let x = x0; x <= x1 + 1; x++) {
        const sx = o.x + x * step;
        g.lineStyle(1, C.grid, x % 5 === 0 ? 0.9 : 0.5);
        g.lineBetween(sx, Math.max(cv.y, o.y), sx, Math.min(cv.y + cv.h, o.y + WORLD.height * this.zoom));
      }
      for (let y = y0; y <= y1 + 1; y++) {
        const sy = o.y + y * step;
        g.lineStyle(1, C.grid, y % 5 === 0 ? 0.9 : 0.5);
        g.lineBetween(Math.max(cv.x, o.x), sy, Math.min(cv.x + cv.w, o.x + WORLD.width * this.zoom), sy);
      }
    }

    g.lineStyle(1.5, C.panelEdge, 0.9);
    g.strokeRect(o.x, o.y, WORLD.width * this.zoom, WORLD.height * this.zoom);

    // Patrol beats first, so an enemy is drawn on top of the line it walks.
    g.lineStyle(2, C.danger, 0.28);
    for (const p of this.level.pieces) {
      if (p.kind !== 'enemy') continue;
      const y = o.y + (p.y + 0.5) * step;
      let a = p.x;
      let b = p.x;
      const solid = (x: number): boolean => {
        const q = pieceAt(this.level, x, p.y + 1);
        return q?.kind === 'block';
      };
      if (solid(p.x)) {
        while (a > 0 && solid(a - 1)) a--;
        while (b < COLS - 1 && solid(b + 1)) b++;
      } else {
        a = Math.max(0, p.x - 2);
        b = Math.min(COLS - 1, p.x + 2);
      }
      g.lineBetween(o.x + (a + 0.5) * step, y, o.x + (b + 0.5) * step, y);
    }

    for (const p of this.level.pieces) {
      if (p.x < x0 - 1 || p.x > x1 + 1 || p.y < y0 - 1 || p.y > y1 + 1) continue;
      this.drawCellPiece(g, p.kind, p.x, p.y, step, o);
    }

    this.drawCellPiece(g, 'spawn', this.level.spawn.x, this.level.spawn.y, step, o);
    this.drawCellPiece(g, 'goal', this.level.goal.x, this.level.goal.y, step, o);

    // A frame around the viewport, so the canvas reads as a window.
    g.lineStyle(1.5, C.panelEdge, 0.7);
    g.strokeRoundedRect(cv.x, cv.y, cv.w, cv.h, 12 * u);
  }

  private drawCellPiece(
    g: Phaser.GameObjects.Graphics,
    tool: Tool,
    cx: number,
    cy: number,
    step: number,
    o: { x: number; y: number },
  ): void {
    const x = o.x + cx * step;
    const y = o.y + cy * step;

    if (tool === 'block') {
      g.fillStyle(C.platform, 1);
      g.fillRect(x, y, step, step);
      g.fillStyle(C.platformTop, 1);
      g.fillRect(x + 1, y, step - 2, Math.max(1.5, step * 0.09));
      return;
    }
    drawPieceIcon(g, tool, x + step / 2, y + step / 2, step * 0.34);
  }

  /** Top-left of the world, in screen units. */
  private originOf(): { x: number; y: number } {
    return { x: this.canvas.x - this.camX * this.zoom, y: this.canvas.y - this.camY * this.zoom };
  }

  private panel(
    g: Phaser.GameObjects.Graphics,
    r: Rect,
    radius: number,
    fill: number,
    alpha: number,
    edge: number,
  ): void {
    g.fillStyle(fill, alpha);
    g.fillRoundedRect(r.x, r.y, r.w, r.h, radius);
    g.lineStyle(1.2, edge, 0.55);
    g.strokeRoundedRect(r.x, r.y, r.w, r.h, radius);
  }

  private chipBox(g: Phaser.GameObjects.Graphics, r: Rect, on: boolean, accent: number): void {
    const rad = 8 * this.L.ui;
    g.fillStyle(on ? accent : C.grid, on ? 0.18 : 0.9);
    g.fillRoundedRect(r.x, r.y, r.w, r.h, rad);
    g.lineStyle(on ? 1.8 : 1.2, accent, on ? 1 : 0.5);
    g.strokeRoundedRect(r.x, r.y, r.w, r.h, rad);
  }

  private actionBox(
    g: Phaser.GameObjects.Graphics,
    r: Rect,
    accent: number,
    on: boolean,
    pressed = false,
  ): void {
    const rad = 12 * this.L.ui;
    g.fillStyle(accent, (on ? 0.24 : 0.08) + (pressed ? 0.2 : 0));
    g.fillRoundedRect(r.x, r.y, r.w, r.h, rad);
    g.lineStyle(2, accent, on ? 0.95 : 0.35);
    g.strokeRoundedRect(r.x, r.y, r.w, r.h, rad);
  }

  private barRect(): Rect {
    const r = this.region('back');
    const budget = this.region('budget');
    if (!r || !budget) return { x: 0, y: 0, w: 0, h: 0 };
    const pad = 8 * this.L.ui;
    return {
      x: r.x - pad,
      y: this.L.y,
      w: budget.x + budget.w + pad - (r.x - pad),
      h: this.canvas.y - this.L.y - 8 * this.L.ui,
    };
  }

  private region(id: string): Region | undefined {
    return this.regions.find((r) => r.id === id);
  }

  /* ---------------------------------------------------------------------- */
  /* View                                                                    */
  /* ---------------------------------------------------------------------- */

  private minZoom(): number {
    return Math.min(this.canvas.w / WORLD.width, this.canvas.h / WORLD.height);
  }

  private maxZoom(): number {
    return (64 * this.L.ui) / CELL;
  }

  private clampZoom(): void {
    this.zoom = Phaser.Math.Clamp(this.zoom, this.minZoom(), this.maxZoom());
  }

  /**
   * Opens on the spawn at a workable size.
   *
   * Not the whole level: fitting thirty columns onto a phone gives cells too
   * small to hit, and a builder who cannot place a block on their first tap has
   * already been told the editor is not for them.
   */
  private fitView(): void {
    const wanted = Phaser.Math.Clamp((this.canvas.w * 0.11) / CELL, this.minZoom(), this.maxZoom());
    this.zoom = wanted;
    this.centreOn(this.level.spawn);
  }

  private centreOn(cell: Cell): void {
    this.camX = (cell.x + 0.5) * CELL - this.canvas.w / this.zoom / 2;
    this.camY = (cell.y + 0.5) * CELL - this.canvas.h / this.zoom / 2;
    this.clampCam();
  }

  /**
   * Keeps the world in view.
   *
   * When the whole world is smaller than the viewport on an axis it is centred
   * on that axis instead of clamped, which is what stops a zoomed-out grid from
   * sticking to one corner.
   */
  private clampCam(): void {
    const viewW = this.canvas.w / this.zoom;
    const viewH = this.canvas.h / this.zoom;
    this.camX =
      WORLD.width <= viewW
        ? (WORLD.width - viewW) / 2
        : Phaser.Math.Clamp(this.camX, 0, WORLD.width - viewW);
    this.camY =
      WORLD.height <= viewH
        ? (WORLD.height - viewH) / 2
        : Phaser.Math.Clamp(this.camY, 0, WORLD.height - viewH);
  }

  private cellAt(sx: number, sy: number): Cell | null {
    const wx = this.camX + (sx - this.canvas.x) / this.zoom;
    const wy = this.camY + (sy - this.canvas.y) / this.zoom;
    const cx = Math.floor(wx / CELL);
    const cy = Math.floor(wy / CELL);
    return inBounds(cx, cy) ? { x: cx, y: cy } : null;
  }

  private inCanvas(x: number, y: number): boolean {
    return (
      x >= this.canvas.x &&
      x <= this.canvas.x + this.canvas.w &&
      y >= this.canvas.y &&
      y <= this.canvas.y + this.canvas.h
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Input                                                                   */
  /* ---------------------------------------------------------------------- */

  private bindInput(): void {
    this.input.on('pointerdown', this.onDown, this);
    this.input.on('pointermove', this.onMove, this);
    this.input.on('pointerup', this.onUp, this);
    this.input.on('pointerupoutside', this.onUp, this);

    this.input.on(
      'wheel',
      (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
        if (!this.inCanvas(p.x, p.y)) return;
        this.zoomAbout(p.x, p.y, this.zoom * (dy > 0 ? 0.88 : 1.12));
      },
      this,
    );

    const kb = this.input.keyboard;
    kb?.on('keydown-Z', () => this.undo());
    kb?.on('keydown-Y', () => this.redo());
    kb?.on('keydown-E', () => this.toggleErase());
    kb?.on('keydown-ESC', () => this.leave('cs-menu'));
  }

  private onDown(p: Phaser.Input.Pointer): void {
    this.pointers.set(p.id, { x: p.x, y: p.y });

    if (this.pointers.size === 2 && this.gesture !== 'none') {
      this.beginPinch();
      return;
    }
    if (this.pointers.size > 1) return;

    const hit = this.regionAt(p.x, p.y);
    if (hit) {
      this.pressRegion = hit;
      this.dragStart = { sx: p.x, sy: p.y, camX: this.camX, camY: this.camY, scroll: this.railScroll };
      this.moved = false;
      return;
    }

    if (!this.inCanvas(p.x, p.y)) return;

    this.moved = false;
    this.dragStart = { sx: p.x, sy: p.y, camX: this.camX, camY: this.camY, scroll: this.railScroll };

    if (this.paintMode) {
      this.gesture = 'paint';
      this.strokeSnapshot = cloneLevel(this.level);
      this.strokeChanged = false;
      this.lastPaintCell = null;
      this.paintAt(p.x, p.y);
    } else {
      this.gesture = 'pan';
    }
  }

  private onMove(p: Phaser.Input.Pointer): void {
    if (!this.pointers.has(p.id)) return;
    this.pointers.set(p.id, { x: p.x, y: p.y });

    if (this.gesture === 'pinch') {
      this.updatePinch();
      return;
    }

    const dx = p.x - this.dragStart.sx;
    const dy = p.y - this.dragStart.sy;
    if (Math.hypot(dx, dy) > 6 * this.L.ui) this.moved = true;

    if (this.pressRegion) {
      // A press that began on a palette chip and then travelled is a scroll of
      // the rail, not a selection: the rail is taller than the space it has.
      if (this.pressRegion.startsWith('chip:') && this.moved) {
        this.gesture = 'rail';
        this.pressRegion = null;
      } else {
        return;
      }
    }

    if (this.gesture === 'rail') {
      this.railScroll = this.clampScroll(this.dragStart.scroll + dy);
      this.drawRail();
      return;
    }

    if (this.gesture === 'pan') {
      this.camX = this.dragStart.camX - dx / this.zoom;
      this.camY = this.dragStart.camY - dy / this.zoom;
      this.clampCam();
      this.drawCanvas();
      return;
    }

    if (this.gesture === 'paint') this.paintAt(p.x, p.y);
  }

  private onUp(p: Phaser.Input.Pointer): void {
    this.pointers.delete(p.id);

    if (this.pressRegion) {
      const hit = this.regionAt(p.x, p.y);
      const id = this.pressRegion;
      this.pressRegion = null;
      if (hit === id) this.onRegion(id);
    } else if (this.gesture === 'paint') {
      this.endStroke();
    } else if (this.gesture === 'pan' && !this.moved) {
      this.onCanvasTap(p.x, p.y);
    }

    if (this.pointers.size === 0) this.gesture = 'none';
    else if (this.gesture === 'pinch') {
      // One finger left of a pinch: start a fresh drag from where it is rather
      // than snapping the view to the difference.
      const rest = [...this.pointers.values()][0]!;
      this.gesture = 'pan';
      this.moved = true;
      this.dragStart = {
        sx: rest.x,
        sy: rest.y,
        camX: this.camX,
        camY: this.camY,
        scroll: this.railScroll,
      };
    }
  }

  private beginPinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    this.gesture = 'pinch';
    this.moved = true;
    // A pinch that started as a paint stroke keeps whatever it already drew.
    if (this.strokeSnapshot) this.endStroke();
    this.pinchStart = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: this.zoom,
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      camX: this.camX,
      camY: this.camY,
    };
  }

  private updatePinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;

    // The world point under the pinch's centre when it began must stay under
    // the pinch's centre now — that is what makes a pinch feel like a pinch.
    const worldX = this.pinchStart.camX + (this.pinchStart.mx - this.canvas.x) / this.pinchStart.zoom;
    const worldY = this.pinchStart.camY + (this.pinchStart.my - this.canvas.y) / this.pinchStart.zoom;

    this.zoom = Phaser.Math.Clamp(
      (this.pinchStart.zoom * dist) / this.pinchStart.dist,
      this.minZoom(),
      this.maxZoom(),
    );
    this.camX = worldX - (mx - this.canvas.x) / this.zoom;
    this.camY = worldY - (my - this.canvas.y) / this.zoom;
    this.clampCam();
    this.drawCanvas();
  }

  private zoomAbout(sx: number, sy: number, next: number): void {
    const worldX = this.camX + (sx - this.canvas.x) / this.zoom;
    const worldY = this.camY + (sy - this.canvas.y) / this.zoom;
    this.zoom = Phaser.Math.Clamp(next, this.minZoom(), this.maxZoom());
    this.camX = worldX - (sx - this.canvas.x) / this.zoom;
    this.camY = worldY - (sy - this.canvas.y) / this.zoom;
    this.clampCam();
    this.drawCanvas();
  }

  private regionAt(x: number, y: number): string | null {
    for (const r of this.regions) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
    }
    // Chips are hit-tested last and by hand, because the rail scrolls under
    // them and their live rectangle is not the one they were laid out at.
    if (x >= this.rail.x && x <= this.rail.x + this.rail.w) {
      for (const chip of this.chips) {
        const top = chip.base.y + this.railScroll;
        if (y >= top && y <= top + chip.base.h && y >= this.rail.y && y <= this.rail.y + this.rail.h) {
          return `chip:${chip.tool}`;
        }
      }
    }
    return null;
  }

  private onRegion(id: string): void {
    if (id.startsWith('chip:')) return this.selectTool(id.slice(5) as Tool);

    switch (id) {
      case 'back':
        return this.leave('cs-menu');
      case 'levels':
        return this.leave('cs-levels');
      case 'undo':
        return this.undo();
      case 'redo':
        return this.redo();
      case 'grid':
        sfx.uiTap();
        this.showGrid = !this.showGrid;
        return this.refresh();
      case 'erase':
        return this.toggleErase();
      case 'mode':
        sfx.uiTap();
        this.paintMode = !this.paintMode;
        this.toast(this.paintMode ? 'Drag to paint' : 'Drag to move the view');
        return this.refresh();
      case 'name':
        return this.rename();
      case 'test':
        return this.onTest();
      case 'save':
        return this.onSave();
      default:
        return;
    }
  }

  private leave(scene: string): void {
    saveDraft(this.level);
    sfx.uiSelect();
    fadeTo(this, () => this.scene.start(scene));
  }

  /* ---------------------------------------------------------------------- */
  /* Editing                                                                 */
  /* ---------------------------------------------------------------------- */

  private selectTool(tool: Tool): void {
    sfx.uiTap();
    this.tool = tool;
    this.erase = false;
    this.refresh();
  }

  private toggleErase(): void {
    sfx.uiTap();
    this.erase = !this.erase;
    this.refresh();
  }

  private onCanvasTap(sx: number, sy: number): void {
    const cell = this.cellAt(sx, sy);
    if (!cell) return;

    if (this.erase) return this.deleteAt(cell);
    if (this.tool === 'spawn') return this.setSpawn(cell);
    if (this.tool === 'goal') return this.setGoal(cell);

    // Tapping something that is already there takes it away. On a phone that is
    // worth more than a separate delete tool: the correction is the same
    // gesture as the mistake.
    if (occupied(this.level, cell)) return this.deleteAt(cell);
    this.place(this.tool, cell);
  }

  /** One cell of a paint stroke, plus every cell the finger skipped over. */
  private paintAt(sx: number, sy: number): void {
    const cell = this.cellAt(sx, sy);
    if (!cell) return;

    const from = this.lastPaintCell;
    this.lastPaintCell = cell;
    if (!from) return this.paintCell(cell);

    const steps = Math.max(Math.abs(cell.x - from.x), Math.abs(cell.y - from.y));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.paintCell({
        x: Math.round(from.x + (cell.x - from.x) * t),
        y: Math.round(from.y + (cell.y - from.y) * t),
      });
    }
  }

  /**
   * Painting never overwrites and never deletes by accident.
   *
   * A stroke that ran over an existing block used to wipe it, which made
   * drawing a floor next to anything a gamble. Now paint only fills empty
   * cells, and only the erase switch removes.
   */
  private paintCell(cell: Cell): void {
    if (!inBounds(cell.x, cell.y)) return;

    if (this.erase) {
      if (this.removeAt(cell)) this.strokeChanged = true;
      return;
    }
    if (this.tool === 'spawn' || this.tool === 'goal') return;
    if (occupied(this.level, cell)) return;
    if (!this.canPlace(this.tool, true)) return;

    this.level.pieces.push({ x: cell.x, y: cell.y, kind: this.tool });
    this.strokeChanged = true;
    this.drawCanvas();
  }

  private endStroke(): void {
    const snapshot = this.strokeSnapshot;
    this.strokeSnapshot = null;
    this.lastPaintCell = null;
    if (!snapshot) return;
    if (!this.strokeChanged) return;
    this.commit(snapshot);
  }

  /** Whether one more of this piece fits, with the reason if it does not. */
  private canPlace(kind: PieceKind, quiet = false): boolean {
    const meta = PIECES[kind];
    if (meta.cap != null && countKind(this.level, kind) >= meta.cap) {
      if (!quiet) this.toast(`Only ${meta.cap} ${meta.label.toLowerCase()} allowed`);
      return false;
    }
    if (budgetOf(this.level) + meta.cost > BUDGET_TOTAL) {
      if (!quiet) this.toast('Out of budget — take something out first');
      return false;
    }
    return true;
  }

  private place(kind: PieceKind, cell: Cell): void {
    if (!this.canPlace(kind)) return;
    this.mutate(() => this.level.pieces.push({ x: cell.x, y: cell.y, kind }));
    sfx.uiTap();
    this.haptic();
  }

  private deleteAt(cell: Cell): void {
    const before = cloneLevel(this.level);
    if (!this.removeAt(cell)) return;
    this.commit(before);
    sfx.uiTap();
    this.haptic();
  }

  /** Takes whatever is in a cell out of the level, without touching history. */
  private removeAt(cell: Cell): boolean {
    const idx = this.level.pieces.findIndex((p) => p.x === cell.x && p.y === cell.y);
    if (idx >= 0) {
      this.level.pieces.splice(idx, 1);
      return true;
    }
    // Spawn and goal are mandatory singletons: they move, they never go away.
    if (sameCell(this.level.spawn, cell) || sameCell(this.level.goal, cell)) {
      this.toast('Spawn and goal can be moved, not removed');
    }
    return false;
  }

  private setSpawn(cell: Cell): void {
    if (sameCell(this.level.goal, cell)) return this.toast('The goal is already there');
    this.mutate(() => {
      this.level.pieces = this.level.pieces.filter((p) => !(p.x === cell.x && p.y === cell.y));
      this.level.spawn = { ...cell };
    });
    this.haptic();
  }

  private setGoal(cell: Cell): void {
    if (sameCell(this.level.spawn, cell)) return this.toast('The spawn is already there');
    this.mutate(() => {
      this.level.pieces = this.level.pieces.filter((p) => !(p.x === cell.x && p.y === cell.y));
      this.level.goal = { ...cell };
    });
    this.haptic();
  }

  /**
   * The one way the level ever changes.
   *
   * Snapshot first, then the edit, then the bookkeeping: history, the verified
   * flag, the draft on disk and the screen. Nothing else writes to `this.level`
   * without coming through here or `commit`.
   */
  private mutate(fn: () => void): void {
    const before = cloneLevel(this.level);
    fn();
    this.commit(before);
  }

  private commit(before: BuildLevel): void {
    this.undoStack.push(before);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    // Any edit invalidates the clearing run: this is no longer that level.
    this.level.verifiedMs = null;
    this.level.updatedAt = Date.now();
    saveDraft(this.level);
    this.refresh();
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return this.toast('Nothing to undo');
    this.redoStack.push(cloneLevel(this.level));
    this.level = prev;
    saveDraft(this.level);
    sfx.uiTap();
    this.refresh();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return this.toast('Nothing to redo');
    this.undoStack.push(cloneLevel(this.level));
    this.level = next;
    saveDraft(this.level);
    sfx.uiTap();
    this.refresh();
  }

  /**
   * Renaming leans on the browser's own prompt.
   *
   * Drawing a keyboard into a Phaser canvas to rename a level would be a
   * fortnight of work for a field nobody edits twice, and a web view that
   * blocks prompts simply says so rather than half-opening something.
   */
  private rename(): void {
    let answer: string | null = null;
    try {
      answer = window.prompt('Name this level', this.level.name);
    } catch {
      answer = null;
    }
    if (answer === null) {
      this.toast('Renaming is not available here');
      return;
    }
    const name = answer.trim().slice(0, 24);
    if (!name) return;
    this.mutate(() => (this.level.name = name));
  }

  /* ---------------------------------------------------------------------- */
  /* Test and save                                                           */
  /* ---------------------------------------------------------------------- */

  private onTest(): void {
    const problem = validate(this.level);
    if (problem) {
      this.toast(problem, 2200);
      return;
    }
    saveDraft(this.level);
    sfx.uiSelect();

    const arena = toArena(this.level);
    fadeTo(this, () =>
      this.scene.start('cs-play', {
        run: practiceRun(seedOf(this.level)),
        arena,
        practice: { levelId: this.level.id, name: this.level.name, returnTo: 'cs-editor' },
      }),
    );
  }

  /**
   * Saving is earned, not offered.
   *
   * A level goes on the shelf only once its builder has finished it themselves,
   * which is the whole reason TEST sits next to SAVE rather than somewhere in a
   * menu. It is also the only check that can catch a level whose goal simply
   * cannot be reached.
   */
  private onSave(): void {
    if (this.level.verifiedMs === null) {
      this.toast('Clear it with TEST first — then it can be saved', 2400);
      return;
    }
    if (!canPersist()) {
      this.toast('This browser will not keep saved levels', 2400);
      return;
    }
    if (saveLevel(this.level)) {
      this.onShelf = true;
      sfx.collectLarge();
      this.toast(`Saved "${this.level.name.toUpperCase()}" to your levels`, 2400);
      this.refresh();
    } else {
      this.toast('Could not save — storage is full', 2400);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Feedback                                                                */
  /* ---------------------------------------------------------------------- */

  private toast(message: string, ms = 1500): void {
    this.toastTween?.remove();
    this.toastText.setText(message).setAlpha(1);
    this.toastTween = this.tweens.add({
      targets: this.toastText,
      alpha: 0,
      delay: ms,
      duration: 320,
    });
  }

  /** A tick a thumb can feel, where the device offers one. */
  private haptic(): void {
    try {
      navigator.vibrate?.(8);
    } catch {
      // Vibration is a courtesy; a device that refuses it changes nothing.
    }
  }
}
