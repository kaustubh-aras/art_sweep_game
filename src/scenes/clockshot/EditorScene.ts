import Phaser from 'phaser';
import { C, hex } from '@/clockshot/theme';
import { sfx } from '@/clockshot/sfx';
import { fadeTo, layoutOf, type Layout } from '@/clockshot/ui';
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
import { mountEditorChrome, type ChromeTool, type EditorChrome } from './editorChrome';
import { api, NetError } from '@/clockshot/net';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every tappable thing outside the canvas, hit-tested by hand. */


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

  private canvasGfx!: Phaser.GameObjects.Graphics;
  private canvasMask!: Phaser.GameObjects.Graphics;

  /**
   * The toolbar, the tool rail and the dialogs, as DOM over the canvas.
   *
   * TEST is a real button here, so the click that asks for the screen is the
   * genuine one Reddit requires — the transparent stand-in this used to need is
   * gone, and with it the re-sync on every relayout.
   */
  private chrome!: EditorChrome;

  /** True while a publish is in flight, so POST cannot be pressed twice. */
  private publishing = false;

  /* Gesture state. */
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: 'none' | 'pan' | 'paint' | 'pinch' = 'none';
  private moved = false;
  private dragStart = { sx: 0, sy: 0, camX: 0, camY: 0 };
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
    this.canvasGfx = this.add.graphics().setDepth(2);
    this.canvasGfx.setMask(this.canvasMask.createGeometryMask());

    this.chrome = mountEditorChrome(this, {
      onAction: (id) => this.onAction(id),
      onTool: (tool) => this.selectTool(tool as Tool),
      onRename: (name) => this.applyName(name),
    });

    this.bindInput();
    this.relayout();
    this.fitView();
    this.refresh();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
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

  private toolLabel(tool: Tool): string {
    if (tool === 'spawn') return 'SPAWN';
    if (tool === 'goal') return 'GOAL';
    return PIECES[tool].label;
  }

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                  */
  /* ---------------------------------------------------------------------- */

  private relayout(): void {
    const L = layoutOf(this);
    this.L = L;

    // The toolbar and the rail are DOM, and they know their own size — the grid
    // takes whatever is left rather than both sides agreeing a number and then
    // drifting apart the first time one of them wraps to a second line.
    const inset = this.chrome.insets();
    const gap = 8 * L.ui;

    this.canvas = {
      x: L.x + inset.left,
      y: L.y + inset.top + gap,
      w: Math.max(80, L.w - L.x - inset.left - 8 * L.ui),
      h: Math.max(80, L.h - L.y - inset.top - gap - 8 * L.ui),
    };

    this.canvasMask.clear();
    this.canvasMask.fillStyle(0xffffff);
    this.canvasMask.fillRect(this.canvas.x, this.canvas.y, this.canvas.w, this.canvas.h);

    this.clampZoom();
    this.clampCam();
    this.refresh();
  }

  /* ---------------------------------------------------------------------- */
  /* Drawing                                                                 */
  /* ---------------------------------------------------------------------- */

  private refresh(): void {
    this.chrome.update({
      name: this.level.name,
      tools: this.chromeTools(),
      tool: this.erase ? null : this.tool,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      showGrid: this.showGrid,
      erase: this.erase,
      paintMode: this.paintMode,
      used: budgetOf(this.level),
      total: BUDGET_TOTAL,
      verified: this.level.verifiedMs !== null,
      onShelf: this.onShelf,
      publishing: this.publishing,
    });
    this.drawCanvas();
  }

  /**
   * The palette, described for the chrome.
   *
   * A chip is disabled for one of two different reasons — the piece is at its
   * own cap, or one more would break the budget — and the line under the label
   * says which. A dead control with no reason given is the most annoying kind.
   */
  private chromeTools(): ChromeTool[] {
    const used = budgetOf(this.level);

    return this.tools().map((tool) => {
      if (tool === 'spawn' || tool === 'goal') {
        return {
          id: tool,
          label: this.toolLabel(tool),
          sub: tool === 'spawn' ? 'start' : 'finish',
          colour: hex(tool === 'spawn' ? C.cyan : C.goal),
          disabled: false,
        };
      }

      const piece = PIECES[tool as PieceKind];
      const count = countKind(this.level, tool as PieceKind);
      const capped = piece.cap != null && count >= piece.cap;
      const broke = used + piece.cost > BUDGET_TOTAL;

      return {
        id: tool,
        label: piece.label,
        sub: capped ? `max ${piece.cap}` : broke ? 'no budget' : `${count}  ·  ${piece.cost}`,
        colour: hex(piece.color),
        disabled: capped || broke,
      };
    });
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

    if (!this.inCanvas(p.x, p.y)) return;

    this.moved = false;
    this.dragStart = { sx: p.x, sy: p.y, camX: this.camX, camY: this.camY };

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

    if (this.gesture === 'paint') {
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

  /**
   * One control on the toolbar, pressed.
   *
   * The chrome owns what the buttons look like and when they are disabled; this
   * only says what each one means. Keeping the verbs here rather than in the
   * DOM module is what lets the toolbar be replaced again without touching a
   * line of editing logic.
   */
  private onAction(id: string): void {
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
      case 'test':
        return this.onTest();
      case 'save':
        return this.onSave();
      case 'publish':
        return void this.onPublish();
      default:
        return;
    }
  }

  /**
   * Publishes the level as its own Reddit post.
   *
   * The level goes up as a claim, not as a fact — the server parses it from
   * scratch, checks it against the same rules the palette enforced here, and
   * refuses it if the author never cleared it. So the only thing this has to
   * get right is telling the builder what happened.
   */
  private async onPublish(): Promise<void> {
    if (this.publishing) return;

    const problem = validate(this.level);
    if (problem) {
      this.toast(problem, 2400);
      return;
    }

    this.publishing = true;
    this.refresh();
    saveDraft(this.level);

    try {
      const res = await api.publishLevel(this.level);
      this.toast(
        res.remaining > 0
          ? `Posted. ${res.remaining} more level${res.remaining === 1 ? '' : 's'} today.`
          : 'Posted. That is your last level today.',
        3200,
      );
    } catch (err) {
      this.toast(
        err instanceof NetError ? err.message : 'Could not publish that level.',
        3200,
      );
    } finally {
      this.publishing = false;
      this.refresh();
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
  /**
   * Renames the level.
   *
   * This used to call `window.prompt`, which a Reddit web view blocks outright
   * — so inside the post, where nearly everyone builds, renaming a level was
   * simply impossible and the editor said so in a toast. The chrome asks with a
   * real `<dialog>` and hands the answer here.
   */
  private applyName(name: string): void {
    if (!name || name === this.level.name) return;
    this.level.name = name;
    saveDraft(this.level);
    sfx.uiSelect();
    this.refresh();
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
    this.chrome.toast(message, ms);
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
