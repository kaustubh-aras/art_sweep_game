import Phaser from 'phaser';
import {
  Scenes,
  TILE,
  COLS,
  ROWS,
  GAME_W,
  GAME_H,
  Colors,
  SAW_RADIUS,
  BUDGET_TOTAL,
} from '@/game/constants';
import { PALETTE_ORDER, PIECE_REGISTRY, type EditorPieceType } from '@/game/pieceRegistry';
import {
  type LevelStruct,
  type StructPiece,
  cloneStruct,
  computeBudget,
  countType,
  pieceAt,
  inBounds,
  validate,
  toLevelData,
} from '@/game/levelStruct';
import { createPiece, type Dir4, type Dir8 } from '@/game/pieces';

type ToolType = EditorPieceType | 'spawn' | 'exit';
type Cell = { x: number; y: number };

const TOP_H = 34;
const PALETTE_H = 68;
const DIR4: Dir4[] = ['up', 'right', 'down', 'left'];
// Spring cycles through all 8 — flats and 45° inclines interleaved.
const DIR8: Dir8[] = ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left'];

interface EditorInit {
  struct?: LevelStruct;
  result?: { verified?: number | null; published?: boolean };
}

/**
 * Mario-Maker-style level editor. A single LevelStruct is the source of truth;
 * the canvas is a pure re-render of it. Every mutation goes through mutate()
 * so undo/redo, budget, and verify-invalidation stay consistent.
 */
export class EditorScene extends Phaser.Scene {
  private struct!: LevelStruct;
  private pending?: EditorInit;

  private selectedTool: ToolType = 'block';
  private trashMode = false;
  private gridLines = true;

  private undoStack: LevelStruct[] = [];
  private redoStack: LevelStruct[] = [];

  // Canvas transform (grid scaled to fit between the top bar and palette).
  private gridScale = 1;
  private offX = 0;
  private offY = TOP_H;

  private gridLayer!: Phaser.GameObjects.Container;
  private staticGfx!: Phaser.GameObjects.Graphics;

  // UI refs updated by refreshUI().
  private titleText!: Phaser.GameObjects.Text;
  private budgetText!: Phaser.GameObjects.Text;
  private budgetGfx!: Phaser.GameObjects.Graphics;
  private publishBtn!: Phaser.GameObjects.Text;
  private trashBtn!: Phaser.GameObjects.Text;
  private gridBtn!: Phaser.GameObjects.Text;
  private toastText!: Phaser.GameObjects.Text;
  private paletteItems: { tool: ToolType; bg: Phaser.GameObjects.Rectangle }[] = [];
  private selRing!: Phaser.GameObjects.Graphics;

  // Input transient state.
  private pressActive = false; // true only while a press started inside the grid
  private pressCell: Cell = { x: 0, y: 0 };
  private pressMoved = false;
  private longPressFired = false;
  private longPress?: Phaser.Time.TimerEvent;
  private painting = false;
  private paintPlaced = 0;
  private paintSnapshot?: LevelStruct;
  private lastPaintCell: Cell = { x: 0, y: 0 };

  // Saw path-edit sub-mode: drag the two endpoints to reshape the patrol line.
  private sawEdit: StructPiece | null = null;
  private sawDrag: 0 | 1 | null = null;
  private sawSnapshot?: LevelStruct;

  constructor() {
    super(Scenes.Editor);
  }

  init(data: EditorInit): void {
    this.pending = data;
  }

  create(): void {
    this.struct = this.pending?.struct ?? starterStruct();
    this.struct.meta.budgetUsed = computeBudget(this.struct);
    this.undoStack = [];
    this.redoStack = [];
    this.selectedTool = 'block';
    this.trashMode = false;

    // Fit the 20x12 grid into the space between top bar and palette.
    const availH = GAME_H - TOP_H - PALETTE_H;
    this.gridScale = availH / (ROWS * TILE);
    this.offX = (GAME_W - COLS * TILE * this.gridScale) / 2;
    this.offY = TOP_H;

    this.gridLayer = this.add.container(this.offX, this.offY).setScale(this.gridScale);
    this.staticGfx = this.add.graphics();
    this.gridLayer.add(this.staticGfx);

    this.buildTopBar();
    this.buildPalette();

    this.selRing = this.add.graphics().setDepth(20);
    this.toastText = this.add
      .text(GAME_W / 2, GAME_H - PALETTE_H - 16, '', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#fff',
        backgroundColor: '#000000aa',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5)
      .setDepth(300)
      .setAlpha(0);

    this.bindInput();
    this.renderAll();
    this.refreshUI();
    this.refreshPalette();

    // Returned from a publish playtest with the user hitting PUBLISH?
    if (this.pending?.result?.published) {
      this.struct.meta.verifiedTime = this.pending.result.verified ?? null;
      this.publishSuccess(this.pending.result.verified ?? null);
    }
    this.pending = undefined;
  }

  // ---- Top bar -----------------------------------------------------------

  private buildTopBar(): void {
    this.add.rectangle(0, 0, GAME_W, TOP_H, 0x1b2030).setOrigin(0, 0);

    this.titleText = this.add
      .text(6, 3, '', { fontFamily: 'monospace', fontSize: '13px', color: Colors.text })
      .setInteractive({ useHandCursor: true });
    this.titleText.on('pointerup', () => this.editTitle());

    this.budgetGfx = this.add.graphics();
    this.budgetText = this.add.text(150, 3, '', { fontFamily: 'monospace', fontSize: '11px', color: Colors.text });

    this.iconBtn(250, '↶', () => this.undo());
    this.iconBtn(280, '↷', () => this.redo());
    this.trashBtn = this.iconBtn(310, 'DEL', () => this.toggleTrash());
    this.gridBtn = this.iconBtn(348, '#', () => this.toggleGrid());

    this.textBtn(392, 'TEST', 0x2f7d4f, () => this.onTest());
    this.publishBtn = this.textBtn(452, 'PUBLISH', 0xb8891f, () => this.onPublish());
  }

  private iconBtn(x: number, label: string, cb: () => void): Phaser.GameObjects.Text {
    const t = this.add
      .text(x, 6, label, {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: Colors.text,
        backgroundColor: '#2a3350',
        padding: { x: 6, y: 4 },
      })
      .setInteractive({ useHandCursor: true });
    t.on('pointerup', cb);
    return t;
  }

  private textBtn(x: number, label: string, bg: number, cb: () => void): Phaser.GameObjects.Text {
    const hex = '#' + bg.toString(16).padStart(6, '0');
    const t = this.add
      .text(x, 5, label, {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#ffffff',
        backgroundColor: hex,
        padding: { x: 8, y: 5 },
      })
      .setInteractive({ useHandCursor: true });
    t.on('pointerup', cb);
    return t;
  }

  // ---- Palette -----------------------------------------------------------

  private buildPalette(): void {
    const tools: ToolType[] = [...PALETTE_ORDER, 'spawn', 'exit'];
    this.add.rectangle(0, GAME_H - PALETTE_H, GAME_W, PALETTE_H, 0x161a26).setOrigin(0, 0);

    const cw = GAME_W / tools.length;
    const cy = GAME_H - PALETTE_H / 2;
    tools.forEach((tool, i) => {
      const cx = cw * (i + 0.5);
      const locked = tool !== 'spawn' && tool !== 'exit' && PIECE_REGISTRY[tool].locked === true;
      const bg = this.add
        .rectangle(cx, cy, cw - 4, PALETTE_H - 10, 0x222838)
        .setInteractive({ useHandCursor: true });
      const label = this.toolLabel(tool);
      this.add
        .text(cx, cy - 10, label, {
          fontFamily: 'monospace',
          fontSize: '10px',
          color: locked ? '#666c7a' : Colors.text,
        })
        .setOrigin(0.5);
      const sub =
        tool === 'spawn' || tool === 'exit'
          ? tool === 'spawn' ? 'start' : 'goal'
          : locked ? '🔒' : `${PIECE_REGISTRY[tool].cost}`;
      this.add
        .text(cx, cy + 12, sub, {
          fontFamily: 'monospace',
          fontSize: '10px',
          color: locked ? '#666c7a' : '#9aa4bd',
        })
        .setOrigin(0.5);
      bg.on('pointerup', () => this.selectTool(tool, locked));
      this.paletteItems.push({ tool, bg });
    });
  }

  private toolLabel(tool: ToolType): string {
    if (tool === 'spawn') return 'SPWN';
    if (tool === 'exit') return 'EXIT';
    return PIECE_REGISTRY[tool].label.slice(0, 4).toUpperCase();
  }

  private selectTool(tool: ToolType, locked: boolean): void {
    if (locked) {
      this.toast('Coming soon');
      return;
    }
    if (this.sawEdit) this.exitSawEdit();
    this.selectedTool = tool;
    this.trashMode = false;
    this.refreshUI();
    this.refreshPalette();
  }

  private refreshPalette(): void {
    this.selRing.clear();
    const item = this.paletteItems.find((p) => p.tool === this.selectedTool);
    if (!item || this.trashMode) return;
    const b = item.bg;
    this.selRing.lineStyle(3, 0x6ee7ff, 1);
    this.selRing.strokeRect(b.x - b.width / 2 - 1, b.y - b.height / 2 - 1, b.width + 2, b.height + 2);
  }

  // ---- Rendering (pure function of the struct) ---------------------------

  private renderAll(): void {
    const g = this.staticGfx;
    g.clear();
    g.fillStyle(0x0e0f14, 1);
    g.fillRect(0, 0, COLS * TILE, ROWS * TILE);

    if (this.gridLines) {
      g.lineStyle(1, 0xffffff, 0.06);
      for (let x = 0; x <= COLS; x++) g.lineBetween(x * TILE, 0, x * TILE, ROWS * TILE);
      for (let y = 0; y <= ROWS; y++) g.lineBetween(0, y * TILE, COLS * TILE, y * TILE);
    }

    for (const sp of this.struct.grid) this.drawStructPiece(sp);
    this.drawSpawn(this.struct.spawn);
    if (this.struct.exit) this.drawExit(this.struct.exit);
    if (this.sawEdit) this.drawSawHandles();
  }

  private drawStructPiece(sp: StructPiece): void {
    const g = this.staticGfx;
    switch (sp.type) {
      case 'block':
      case 'crumble':
      case 'key':
      case 'defuser':
        createPiece(sp.type, sp.x, sp.y).draw(g);
        break;
      case 'spike':
        createPiece('spike', sp.x, sp.y, sp.params?.face).draw(g);
        break;
      case 'spring':
        createPiece('spring', sp.x, sp.y, sp.params?.dir).draw(g);
        break;
      case 'ghost':
        createPiece('ghost', sp.x, sp.y).draw(g);
        // Builder-only shimmer so ghosts are visible in the editor.
        g.lineStyle(1, 0x6ee7ff, 0.8);
        g.strokeRect(sp.x * TILE + 3, sp.y * TILE + 3, TILE - 6, TILE - 6);
        break;
      case 'saw':
        this.drawSawEditor(sp);
        break;
      default:
        g.fillStyle(PIECE_REGISTRY[sp.type].color, 1);
        g.fillRect(sp.x * TILE + 4, sp.y * TILE + 4, TILE - 8, TILE - 8);
    }
  }

  private drawSawEditor(sp: StructPiece): void {
    const g = this.staticGfx;
    const path = sp.params?.path;
    if (path) {
      const [a, b] = path;
      g.lineStyle(2, Colors.saw, 0.5);
      g.lineBetween((a[0] + 0.5) * TILE, (a[1] + 0.5) * TILE, (b[0] + 0.5) * TILE, (b[1] + 0.5) * TILE);
    }
    const cx = (sp.x + 0.5) * TILE;
    const cy = (sp.y + 0.5) * TILE;
    const R = SAW_RADIUS * TILE;
    g.fillStyle(Colors.saw, 1);
    g.fillCircle(cx, cy, R * 0.78);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.fillTriangle(
        cx + Math.cos(a) * R, cy + Math.sin(a) * R,
        cx + Math.cos(a - 0.22) * R * 0.78, cy + Math.sin(a - 0.22) * R * 0.78,
        cx + Math.cos(a + 0.22) * R * 0.78, cy + Math.sin(a + 0.22) * R * 0.78,
      );
    }
    g.fillStyle(Colors.sawEdge, 1);
    g.fillCircle(cx, cy, R * 0.3);
  }

  private drawSpawn(c: Cell): void {
    const g = this.staticGfx;
    const cx = (c.x + 0.5) * TILE;
    const cy = (c.y + 0.5) * TILE;
    g.fillStyle(0x6ee7ff, 0.9);
    g.fillCircle(cx, cy, TILE * 0.32);
    g.fillStyle(Colors.bg, 1);
    g.fillTriangle(cx - 5, cy - 6, cx - 5, cy + 6, cx + 6, cy);
  }

  private drawExit(c: Cell): void {
    createPiece('exit', c.x, c.y).draw(this.staticGfx);
  }

  // ---- Input -------------------------------------------------------------

  private bindInput(): void {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p));
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p));
    this.input.on('pointerup', () => this.onUp());
  }

  private cellFromPointer(p: Phaser.Input.Pointer): Cell | null {
    const lx = (p.x - this.offX) / this.gridScale;
    const ly = (p.y - this.offY) / this.gridScale;
    if (lx < 0 || ly < 0 || lx >= COLS * TILE || ly >= ROWS * TILE) return null;
    return { x: Math.floor(lx / TILE), y: Math.floor(ly / TILE) };
  }

  private onDown(p: Phaser.Input.Pointer): void {
    if (this.sawEdit) {
      this.sawEditDown(p);
      this.pressActive = false; // saw session consumes the gesture
      return;
    }
    const cell = this.cellFromPointer(p);
    if (!cell) {
      this.pressActive = false; // press began on the UI, not the canvas
      return;
    }
    this.pressActive = true;
    this.pressCell = cell;
    this.pressMoved = false;
    this.longPressFired = false;

    const existing = pieceAt(this.struct, cell.x, cell.y);

    // Paint only over empty ground — tapping an occupied cell is edit/delete.
    if (
      !this.trashMode &&
      this.selectedTool === 'block' &&
      !existing &&
      !this.isSpawn(cell) &&
      !this.isExit(cell)
    ) {
      this.painting = true;
      this.paintSnapshot = cloneStruct(this.struct);
      this.paintPlaced = 0;
      this.lastPaintCell = cell;
      this.placeBlockPaint(cell);
    }

    if (!this.trashMode && existing) {
      // Long-press an existing piece to delete it.
      this.longPress = this.time.delayedCall(350, () => {
        if (this.pressMoved) return;
        this.longPressFired = true;
        this.painting = false;
        this.deleteAt(cell);
      });
    }
  }

  private onMove(p: Phaser.Input.Pointer): void {
    if (this.sawEdit) {
      this.sawEditMove(p);
      return;
    }
    if (!p.isDown) return;
    const cell = this.cellFromPointer(p);
    if (!cell) return;
    if (cell.x !== this.pressCell.x || cell.y !== this.pressCell.y) {
      this.pressMoved = true;
      this.cancelLongPress();
    }
    if (this.painting && (cell.x !== this.lastPaintCell.x || cell.y !== this.lastPaintCell.y)) {
      for (const c of lineCells(this.lastPaintCell, cell)) this.placeBlockPaint(c);
      this.lastPaintCell = cell;
    }
  }

  private onUp(): void {
    this.cancelLongPress();
    if (this.sawDrag != null) {
      this.sawEditUp();
      return;
    }
    if (this.painting) {
      this.painting = false;
      this.finishPaint();
      this.pressActive = false;
      return;
    }
    const active = this.pressActive;
    this.pressActive = false;
    if (!active || this.longPressFired || this.pressMoved) return;
    this.onTap(this.pressCell);
  }

  private cancelLongPress(): void {
    this.longPress?.remove(false);
    this.longPress = undefined;
  }

  // ---- Tap / place / delete ---------------------------------------------

  private onTap(cell: Cell): void {
    if (this.trashMode) {
      this.deleteAt(cell);
      return;
    }
    if (this.selectedTool === 'spawn') return this.setSpawn(cell);
    if (this.selectedTool === 'exit') return this.setExit(cell);

    const existing = pieceAt(this.struct, cell.x, cell.y);
    if (existing) {
      if (existing.type === 'saw') return this.enterSawEdit(existing);
      return this.editParam(existing);
    }
    this.placePiece(this.selectedTool, cell);
  }

  private isSpawn(c: Cell): boolean {
    return this.struct.spawn.x === c.x && this.struct.spawn.y === c.y;
  }
  private isExit(c: Cell): boolean {
    return !!this.struct.exit && this.struct.exit.x === c.x && this.struct.exit.y === c.y;
  }

  private setSpawn(cell: Cell): void {
    if (pieceAt(this.struct, cell.x, cell.y) || this.isExit(cell)) return this.toast('Occupied');
    this.mutate(() => (this.struct.spawn = { ...cell }));
    this.haptic();
  }

  private setExit(cell: Cell): void {
    if (pieceAt(this.struct, cell.x, cell.y) || this.isSpawn(cell)) return this.toast('Occupied');
    this.mutate(() => (this.struct.exit = { ...cell }));
    this.haptic();
  }

  private placePiece(type: EditorPieceType, cell: Cell): void {
    const meta = PIECE_REGISTRY[type];
    if (meta.locked) return this.toast('Coming soon');
    if (!inBounds(cell.x, cell.y)) return;
    if (pieceAt(this.struct, cell.x, cell.y) || this.isSpawn(cell) || this.isExit(cell))
      return this.toast('Occupied');
    if (meta.cap != null && countType(this.struct, type) >= meta.cap)
      return this.toast(`Max ${meta.cap} ${meta.label}`);
    if (computeBudget(this.struct) + meta.cost > BUDGET_TOTAL) {
      this.shakeBudget();
      return this.toast('Over budget');
    }
    this.mutate(() => this.struct.grid.push({ x: cell.x, y: cell.y, type, params: defaultParams(type, cell) }));
    this.popAt(cell);
    this.haptic();
  }

  private deleteAt(cell: Cell): void {
    const idx = this.struct.grid.findIndex((p) => p.x === cell.x && p.y === cell.y);
    if (idx >= 0) {
      this.mutate(() => this.struct.grid.splice(idx, 1));
      this.poof(cell);
      this.haptic();
      return;
    }
    if (this.isExit(cell)) {
      this.mutate(() => (this.struct.exit = null));
      this.poof(cell);
    }
    // Spawn is a mandatory singleton — never deletable.
  }

  private editParam(sp: StructPiece): void {
    if (sp.type === 'spike') {
      this.mutate(() => (sp.params = { face: nextDir4(sp.params?.face) }));
      this.toast(`Spike ${sp.params?.face}`);
    } else if (sp.type === 'spring') {
      this.mutate(() => (sp.params = { ...sp.params, dir: nextDir8(sp.params?.dir) }));
      this.toast(`Spring ${sp.params?.dir}`);
    } else {
      this.toast('No settings');
    }
  }

  // ---- Saw path editing --------------------------------------------------

  private enterSawEdit(sp: StructPiece): void {
    this.sawEdit = sp;
    this.renderAll();
    this.toast('Drag the ends · tap saw = speed · tap away = done', 2400);
  }

  private exitSawEdit(): void {
    this.sawEdit = null;
    this.sawDrag = null;
    this.renderAll();
    this.refreshUI();
  }

  private handleHit(p: Phaser.Input.Pointer): 0 | 1 | null {
    const path = this.sawEdit?.params?.path;
    if (!path) return null;
    for (let i = 0; i < 2; i++) {
      const sx = this.offX + (path[i][0] + 0.5) * TILE * this.gridScale;
      const sy = this.offY + (path[i][1] + 0.5) * TILE * this.gridScale;
      if (Phaser.Math.Distance.Between(p.x, p.y, sx, sy) <= TILE * this.gridScale * 0.6) return i as 0 | 1;
    }
    return null;
  }

  private clampCell(p: Phaser.Input.Pointer): Cell {
    const lx = (p.x - this.offX) / this.gridScale;
    const ly = (p.y - this.offY) / this.gridScale;
    return {
      x: Phaser.Math.Clamp(Math.floor(lx / TILE), 0, COLS - 1),
      y: Phaser.Math.Clamp(Math.floor(ly / TILE), 0, ROWS - 1),
    };
  }

  private sawEditDown(p: Phaser.Input.Pointer): void {
    const hit = this.handleHit(p);
    if (hit != null) {
      this.sawDrag = hit;
      this.sawSnapshot = cloneStruct(this.struct);
      return;
    }
    const sp = this.sawEdit!;
    const cell = this.cellFromPointer(p);
    if (cell && cell.x === sp.x && cell.y === sp.y) {
      // Tap the saw body to cycle its speed 1→4.
      this.mutate(() => (sp.params = { ...sp.params, speed: (Math.round(sp.params?.speed ?? 3) % 4) + 1 }));
      this.toast(`Saw speed ${sp.params?.speed}`);
      return;
    }
    this.exitSawEdit(); // tapped away — done
  }

  private sawEditMove(p: Phaser.Input.Pointer): void {
    if (this.sawDrag == null) return;
    const path = this.sawEdit!.params!.path!;
    const other = path[this.sawDrag === 0 ? 1 : 0];
    const c = this.clampCell(p);

    // Snap to the nearest of 8 directions from the fixed end: horizontal,
    // vertical, or 45° diagonal (equal step on both axes).
    const rdx = c.x - other[0];
    const rdy = c.y - other[1];
    const adx = Math.abs(rdx);
    const ady = Math.abs(rdy);
    let dxDir = 0;
    let dyDir = 0;
    if (ady <= adx / 2) dxDir = Math.sign(rdx); // horizontal
    else if (adx <= ady / 2) dyDir = Math.sign(rdy); // vertical
    else {
      dxDir = Math.sign(rdx) || 1; // diagonal
      dyDir = Math.sign(rdy) || 1;
    }
    let k = Math.max(adx, ady);
    let nx = other[0] + dxDir * k;
    let ny = other[1] + dyDir * k;
    // Shorten until the endpoint sits back in bounds (keeps the line shape).
    while (k > 0 && (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS)) {
      k--;
      nx = other[0] + dxDir * k;
      ny = other[1] + dyDir * k;
    }

    path[this.sawDrag] = [nx, ny];
    if (this.sawDrag === 0) {
      this.sawEdit!.x = nx;
      this.sawEdit!.y = ny;
    }
    this.renderAll();
  }

  private sawEditUp(): void {
    if (this.sawDrag == null) return;
    if (this.sawSnapshot) {
      this.pushUndo(this.sawSnapshot);
      this.afterMutate();
    }
    this.sawSnapshot = undefined;
    this.sawDrag = null;
  }

  private drawSawHandles(): void {
    const path = this.sawEdit?.params?.path;
    if (!path) return;
    const g = this.staticGfx;
    const [a, b] = path;
    g.lineStyle(2, 0x6ee7ff, 0.95);
    g.lineBetween((a[0] + 0.5) * TILE, (a[1] + 0.5) * TILE, (b[0] + 0.5) * TILE, (b[1] + 0.5) * TILE);
    for (const e of path) {
      g.fillStyle(0x6ee7ff, 1);
      g.fillCircle((e[0] + 0.5) * TILE, (e[1] + 0.5) * TILE, TILE * 0.3);
      g.fillStyle(Colors.bg, 1);
      g.fillCircle((e[0] + 0.5) * TILE, (e[1] + 0.5) * TILE, TILE * 0.13);
    }
  }

  // ---- Block paint (batched into one undo step) --------------------------

  private placeBlockPaint(cell: Cell): void {
    if (!inBounds(cell.x, cell.y)) return;
    if (this.isSpawn(cell) || this.isExit(cell)) return;
    if (pieceAt(this.struct, cell.x, cell.y)) return;
    if (computeBudget(this.struct) + 1 > BUDGET_TOTAL) return; // silently stop at cap
    this.struct.grid.push({ x: cell.x, y: cell.y, type: 'block' });
    this.paintPlaced++;
    this.renderAll();
  }

  private finishPaint(): void {
    if (this.paintPlaced > 0 && this.paintSnapshot) {
      this.pushUndo(this.paintSnapshot);
      this.afterMutate();
      this.haptic();
    }
    this.paintSnapshot = undefined;
  }

  // ---- Mutation / undo-redo ---------------------------------------------

  private mutate(fn: () => void): void {
    const snap = cloneStruct(this.struct);
    fn();
    this.pushUndo(snap);
    this.afterMutate();
  }

  private pushUndo(snap: LevelStruct): void {
    this.undoStack.push(snap);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  private afterMutate(): void {
    this.struct.meta.budgetUsed = computeBudget(this.struct);
    this.struct.meta.verifiedTime = null; // any edit invalidates the publish gate
    this.renderAll();
    this.refreshUI();
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(cloneStruct(this.struct));
    this.struct = prev;
    this.struct.meta.budgetUsed = computeBudget(this.struct);
    this.renderAll();
    this.refreshUI();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(cloneStruct(this.struct));
    this.struct = next;
    this.struct.meta.budgetUsed = computeBudget(this.struct);
    this.renderAll();
    this.refreshUI();
  }

  // ---- Toggles / title ---------------------------------------------------

  private toggleTrash(): void {
    if (this.sawEdit) this.exitSawEdit();
    this.trashMode = !this.trashMode;
    this.refreshUI();
    this.refreshPalette();
  }
  private toggleGrid(): void {
    this.gridLines = !this.gridLines;
    this.renderAll();
    this.refreshUI();
  }

  private editTitle(): void {
    const t = window.prompt('Level title (1–32 chars)', this.struct.meta.title);
    if (t == null) return;
    const title = t.trim().slice(0, 32) || 'Untitled';
    this.mutate(() => (this.struct.meta.title = title));
  }

  // ---- Test / Publish ----------------------------------------------------

  private onTest(): void {
    this.scene.start(Scenes.Raid, {
      levelData: toLevelData(this.struct),
      editor: { struct: cloneStruct(this.struct), verify: false },
    });
  }

  private onPublish(): void {
    const v = validate(this.struct);
    if (!v.ok) return this.toast(v.errors[0]);
    this.scene.start(Scenes.Raid, {
      levelData: toLevelData(this.struct),
      editor: { struct: cloneStruct(this.struct), verify: true },
    });
  }

  private publishSuccess(time: number | null): void {
    // Server POST would go here; for now we log the frozen struct.
    console.log('PUBLISH', this.serialize());
    const stamp = time != null ? `verified ${time.toFixed(2)}s` : 'unverified';
    this.toast(`Published "${this.struct.meta.title}" · ${this.struct.meta.budgetUsed}/100 · ${stamp}`, 2800);
    this.refreshUI();
  }

  /** The editor's sole output: a deep-cloned, budget-recomputed struct. */
  serialize(): LevelStruct {
    const s = cloneStruct(this.struct);
    s.meta.budgetUsed = computeBudget(s);
    return s;
  }

  // ---- UI refresh --------------------------------------------------------

  private refreshUI(): void {
    this.titleText.setText(`✎ ${this.struct.meta.title}`);

    const used = this.struct.meta.budgetUsed;
    this.budgetText.setText(`${used}/${BUDGET_TOTAL}`);
    const color = used >= BUDGET_TOTAL ? 0xff5964 : used > 85 ? 0xffb020 : 0x5ce68a;
    this.budgetGfx.clear();
    this.budgetGfx.fillStyle(0x000000, 0.4).fillRect(150, 18, 90, 8);
    this.budgetGfx.fillStyle(color, 1).fillRect(150, 18, 90 * Math.min(1, used / BUDGET_TOTAL), 8);

    this.trashBtn.setBackgroundColor(this.trashMode ? '#c0392b' : '#2a3350');
    this.gridBtn.setBackgroundColor(this.gridLines ? '#3a6ea5' : '#2a3350');

    const ok = validate(this.struct).ok;
    this.publishBtn.setAlpha(ok ? 1 : 0.45);
    const verified = this.struct.meta.verifiedTime != null;
    this.publishBtn.setText(verified ? 'PUBLISHED ✓' : 'PUBLISH');
  }

  // ---- Feedback ----------------------------------------------------------

  private toast(msg: string, ms = 1400): void {
    this.toastText.setText(msg).setAlpha(1);
    this.tweens.killTweensOf(this.toastText);
    this.tweens.add({ targets: this.toastText, alpha: 0, delay: ms, duration: 300 });
  }

  private shakeBudget(): void {
    this.tweens.add({ targets: this.budgetText, x: 158, duration: 40, yoyo: true, repeat: 3 });
  }

  private popAt(cell: Cell): void {
    const r = this.add
      .rectangle(this.offX + (cell.x + 0.5) * TILE * this.gridScale, this.offY + (cell.y + 0.5) * TILE * this.gridScale, TILE * this.gridScale, TILE * this.gridScale, 0xffffff, 0.5)
      .setDepth(15);
    this.tweens.add({ targets: r, scale: 1.4, alpha: 0, duration: 160, onComplete: () => r.destroy() });
  }

  private poof(cell: Cell): void {
    const c = this.add
      .circle(this.offX + (cell.x + 0.5) * TILE * this.gridScale, this.offY + (cell.y + 0.5) * TILE * this.gridScale, 6, 0xffb020, 0.8)
      .setDepth(15);
    this.tweens.add({ targets: c, scale: 2.2, alpha: 0, duration: 220, onComplete: () => c.destroy() });
  }

  private haptic(): void {
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(8);
  }
}

// ---- Helpers -------------------------------------------------------------

function starterStruct(): LevelStruct {
  const grid: StructPiece[] = [];
  for (let x = 0; x < COLS; x++) grid.push({ x, y: ROWS - 1, type: 'block' });
  return {
    meta: { author: 'u/you', title: 'Untitled', canvas: 'classic', budgetUsed: 0, verifiedTime: null },
    grid,
    spawn: { x: 1, y: ROWS - 2 },
    exit: { x: COLS - 2, y: ROWS - 2 },
  };
}

function defaultParams(type: EditorPieceType, c: Cell): StructPiece['params'] {
  if (type === 'spike') return { face: 'up' };
  if (type === 'spring') return { dir: 'up' };
  if (type === 'saw') {
    return { path: [[c.x, c.y], [Math.min(c.x + 3, COLS - 1), c.y]], speed: 3 };
  }
  return undefined;
}

function nextDir4(d?: Dir4): Dir4 {
  return DIR4[(DIR4.indexOf(d ?? 'up') + 1) % 4];
}

function nextDir8(d?: Dir8): Dir8 {
  return DIR8[(DIR8.indexOf(d ?? 'up') + 1) % 8];
}

/** Cells crossed from a to b (inclusive of b), for gap-free drag-paint. */
function lineCells(a: Cell, b: Cell): Cell[] {
  const cells: Cell[] = [];
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  for (let i = 1; i <= steps; i++) {
    cells.push({ x: Math.round(a.x + ((b.x - a.x) * i) / steps), y: Math.round(a.y + ((b.y - a.y) * i) / steps) });
  }
  return cells;
}
