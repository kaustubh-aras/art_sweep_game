import Phaser from 'phaser';
import {
  Scenes,
  TILE,
  ROWS,
  GAME_W,
  GAME_H,
  Colors,
  SIM_DT,
  RUN_SPEED,
  JUMP_APEX_TILES,
  JUMP_RANGE_TILES,
  COYOTE_TIME,
  JUMP_BUFFER,
  JUMP_CUT_MULT,
  MAX_FALL_SPEED,
  SPRING_APEX_TILES,
  SPRING_LAUNCH_SPEED,
  SPRING_LAUNCH_DECAY,
  CRUMBLE_TIME,
  SAW_RADIUS,
} from '@/game/constants';
import { Level, type LevelData } from '@/game/level';
import { Exit, Key, CrumbleBlock, Spring, Defuser, Saw, Ghost, CRUMBLE_STAGES } from '@/game/pieces';
import type { LevelStruct } from '@/game/levelStruct';

const SAW_SPIN = 7; // radians/sec, cosmetic blade spin

/** Scene-start payload. Empty = normal file-loaded play. `editor` = launched
 *  from the editor for Test (verify:false) or the publish gate (verify:true). */
export interface RaidInit {
  levelData?: LevelData; // in-memory level; skips the file load
  editor?: { struct: LevelStruct; verify: boolean };
}

interface SawEntity {
  saw: Saw;
  gfx: Phaser.GameObjects.Graphics;
}

interface GhostEntity {
  ghost: Ghost;
  gfx: Phaser.GameObjects.Graphics;
}

interface KeyEntity {
  key: Key;
  gfx: Phaser.GameObjects.Graphics;
  collected: boolean;
}

interface CrumbleEntity {
  block: CrumbleBlock;
  gfx: Phaser.GameObjects.Graphics;
  timer: number; // -1 = untriggered; else seconds remaining until collapse
  crumbled: boolean;
}

interface SpringEntity {
  spring: Spring;
  gfx: Phaser.GameObjects.Graphics;
}

interface DefuserEntity {
  defuser: Defuser;
  gfx: Phaser.GameObjects.Graphics;
  collected: boolean;
}

/**
 * RaidScene — the moment-to-moment raid loop.
 *
 * This is the determinism foundation (GDD §4.3, §9.1):
 *   - fixed 60 Hz accumulator; sim never sees a variable delta
 *   - hand-rolled AABB collision (no Arcade Physics)
 *   - coyote time, jump buffering, variable jump height
 *
 * The level is a Level of Piece objects (see game/pieces.ts). Right now it's
 * built by hand in buildTestLevel(); Level.fromJSON() loads real §5.5 data.
 */

// Derived movement physics (see constants for the tuning inputs).
// Half the horizontal range is covered on the way up at run speed.
const T_APEX = JUMP_RANGE_TILES / 2 / RUN_SPEED; // s to reach apex
const GRAVITY = (2 * JUMP_APEX_TILES) / (T_APEX * T_APEX); // tiles/s^2
const JUMP_V = (2 * JUMP_APEX_TILES) / T_APEX; // tiles/s (upward)
// Launch velocity for a fixed-height spring bounce: v = sqrt(2 g h).
const SPRING_V = Math.sqrt(2 * GRAVITY * SPRING_APEX_TILES); // tiles/s (upward)

const PLAYER_W = 0.72; // tiles
const PLAYER_H = 0.9; // tiles

// Which level to load. Later this becomes a level id fetched from the server.
const LEVEL_KEY = 'level:classic-demo';
const LEVEL_URL = 'levels/classic-demo.json';

export class RaidScene extends Phaser.Scene {
  private level!: Level;

  // Player sim state (tile units).
  private px = 0;
  private py = 0;
  private vx = 0;
  private vy = 0;
  private onGround = false;
  private coyote = 0;
  private buffer = 0;
  // True during a fixed-height spring bounce: suppresses jump-cut so the launch
  // height is the same whether or not the player holds jump.
  private noCut = false;
  // Sideways spring impulse; added on top of input velocity and decays to 0.
  private launchVx = 0;

  // Input latches sampled each frame, consumed in the fixed step.
  private moveDir = 0; // -1 / 0 / +1
  private jumpHeld = false;
  private jumpQueued = false;

  private accumulator = 0;
  private attempts = 0;
  private ready = false; // true once the level JSON is loaded and placed
  private tick = 0; // fixed-steps since this attempt began; drives saw motion

  // Editor integration (undefined for normal file-loaded play).
  private injectedLevel?: LevelData;
  private editorCtx?: { struct: LevelStruct; verify: boolean };
  private publishClearTime: number | null = null; // first clear time in publish playtest
  private publishOverlayBtn?: Phaser.GameObjects.Text;

  // Optional countdown (from JSON). Starts on first move; hitting zero kills.
  private timerEnabled = false;
  private timerSeconds = 0;
  private timerStarted = false;
  private timeLeft = 0;
  private defused = false; // set once a defusal kit is collected; freezes the timer

  // Defusal-kit runtime state (reset every attempt, like keys).
  private defuserEntities: DefuserEntity[] = [];

  // Key/lock runtime state (reset every attempt).
  private keyEntities: KeyEntity[] = [];
  private exitPiece?: Exit;
  private exitGfx!: Phaser.GameObjects.Graphics;

  // Crumble-block runtime state (reset every attempt).
  private crumbleEntities: CrumbleEntity[] = [];

  // Spring runtime state (for the coil-compress animation on bounce).
  private springEntities: SpringEntity[] = [];
  private springByKey = new Map<string, SpringEntity>();

  // Saw blades — position is derived from `tick`, so no per-saw state to reset.
  private sawEntities: SawEntity[] = [];

  // Ghost blocks — look like blocks; vanish or turn to spikes when touched.
  private ghostEntities: GhostEntity[] = [];

  private playerRect!: Phaser.GameObjects.Rectangle;
  private deathBurst!: Phaser.GameObjects.Particles.ParticleEmitter;
  private hud!: Phaser.GameObjects.Text;
  private keys!: {
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    a: Phaser.Input.Keyboard.Key;
    d: Phaser.Input.Keyboard.Key;
    jump: Phaser.Input.Keyboard.Key;
  };

  constructor() {
    super(Scenes.Raid);
  }

  init(data: RaidInit): void {
    this.injectedLevel = data?.levelData;
    this.editorCtx = data?.editor;
    // Scenes are reused across starts — reset transient counters.
    this.ready = false;
    this.attempts = 0;
    this.tick = 0;
    this.accumulator = 0;
    this.publishClearTime = null;
    this.publishOverlayBtn = undefined;
  }

  preload(): void {
    if (this.injectedLevel) return; // in-memory level from the editor; no file load
    // The level is a real JSON file loaded at runtime. create() won't run until
    // this finishes, so the player never starts before the level is placed.
    // (Later this becomes a fetch from the Devvit server instead of a static file.)
    this.load.json(LEVEL_KEY, LEVEL_URL);
  }

  create(): void {
    const data = this.injectedLevel ?? (this.cache.json.get(LEVEL_KEY) as LevelData | undefined);
    if (!data) {
      this.showLoadError();
      return;
    }
    this.level = Level.fromJSON(data);
    this.timerEnabled = this.level.timer.enabled;
    this.timerSeconds = this.level.timer.seconds;
    this.drawLevel();
    this.createDynamicVisuals();

    this.playerRect = this.add
      .rectangle(0, 0, PLAYER_W * TILE, PLAYER_H * TILE, Colors.player)
      .setOrigin(0.5, 0.5);

    this.createDeathBurst();

    this.hud = this.add.text(6, 4, '', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: Colors.text,
    });

    const kb = this.input.keyboard!;
    this.keys = {
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      a: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      d: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      jump: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
    };
    // Buffer a jump on the exact press edge so fast taps never drop.
    this.keys.jump.on('down', () => (this.jumpQueued = true));

    // On-screen buttons for touch devices (◄ ► on the left, JUMP on the right).
    this.createTouchControls();

    if (this.editorCtx) this.createEditorOverlay();

    this.respawn();
    this.accumulator = 0;
    // Everything is placed and drawn — the player takes control now.
    this.ready = true;
  }

  /** Test mode: a single EDIT button. Publish mode: infinite tries plus two
   *  buttons — EDIT (back, no publish) and PUBLISH (commit regardless). */
  private createEditorOverlay(): void {
    if (!this.editorCtx) return;

    const editBtn = this.add
      .text(8, 6, '◀ EDIT', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: Colors.text,
        backgroundColor: '#2a3350',
        padding: { x: 8, y: 5 },
      })
      .setOrigin(0, 0)
      .setDepth(150)
      .setInteractive({ useHandCursor: true });
    editBtn.on('pointerup', () => this.returnToEditor({}));

    if (this.editorCtx.verify) {
      this.add
        .text(GAME_W / 2, 8, 'PLAYTEST · infinite tries', {
          fontFamily: 'monospace',
          fontSize: '11px',
          color: '#ffd24a',
        })
        .setOrigin(0.5, 0)
        .setDepth(150);

      const pub = this.add
        .text(GAME_W - 8, 6, 'PUBLISH ▶', {
          fontFamily: 'monospace',
          fontSize: '13px',
          color: '#ffffff',
          backgroundColor: '#b8891f',
          padding: { x: 8, y: 5 },
        })
        .setOrigin(1, 0)
        .setDepth(150)
        .setInteractive({ useHandCursor: true });
      pub.on('pointerup', () =>
        this.returnToEditor({ published: true, verified: this.publishClearTime }),
      );
      this.publishOverlayBtn = pub;
    }
  }

  private returnToEditor(result: { verified?: number | null; published?: boolean }): void {
    if (!this.editorCtx) return;
    this.ready = false; // stop the sim immediately
    this.scene.start(Scenes.Editor, { struct: this.editorCtx.struct, result });
  }

  /** Publish playtest: flash a clear confirmation and green the Publish button. */
  private showCleared(): void {
    this.add
      .text(GAME_W / 2, GAME_H / 2, 'CLEARED ✓', {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: '#9dff6e',
      })
      .setOrigin(0.5)
      .setDepth(160)
      .setAlpha(1)
      .setName('clearedFlash');
    const flash = this.children.getByName('clearedFlash');
    if (flash) this.tweens.add({ targets: flash, alpha: 0, delay: 700, duration: 400, onComplete: () => flash.destroy() });
    this.publishOverlayBtn?.setBackgroundColor('#2f7d4f').setText('PUBLISH ✓ ▶');
  }

  update(_time: number, delta: number): void {
    if (!this.ready) return; // wait until the level is fully loaded
    this.sampleInput();

    // Fixed-timestep accumulator: clamp to avoid spiral-of-death on stalls.
    this.accumulator += Math.min(delta / 1000, 0.25);
    while (this.accumulator >= SIM_DT) {
      this.step();
      this.accumulator -= SIM_DT;
    }

    this.render();
  }

  // ---- Simulation --------------------------------------------------------

  private step(): void {
    if (!this.ready) return; // bail if we just handed off to another scene
    this.tick++; // advance the deterministic clock (drives saw positions)

    // Timer: begins on the first movement input, kills the player at zero.
    // A collected defusal kit freezes it for the rest of the run.
    if (this.timerEnabled && !this.defused) {
      if (!this.timerStarted && (this.moveDir !== 0 || this.jumpHeld)) {
        this.timerStarted = true;
      }
      if (this.timerStarted) {
        this.timeLeft -= SIM_DT;
        if (this.timeLeft <= 0) {
          this.timeLeft = 0;
          this.die();
          return;
        }
      }
    }

    // Horizontal: instant target velocity (tight platformer feel), plus any
    // sideways spring impulse riding on top. The impulse fades so control returns.
    this.vx = this.moveDir * RUN_SPEED + this.launchVx;
    if (this.launchVx !== 0) {
      const d = SPRING_LAUNCH_DECAY * SIM_DT;
      this.launchVx =
        Math.abs(this.launchVx) <= d ? 0 : this.launchVx - Math.sign(this.launchVx) * d;
    }

    // Timers.
    this.coyote = this.onGround ? COYOTE_TIME : Math.max(0, this.coyote - SIM_DT);
    if (this.jumpQueued) {
      this.buffer = JUMP_BUFFER;
      this.jumpQueued = false;
    } else {
      this.buffer = Math.max(0, this.buffer - SIM_DT);
    }

    // Jump start: buffered press + within coyote window.
    if (this.buffer > 0 && this.coyote > 0) {
      this.vy = -JUMP_V;
      this.buffer = 0;
      this.coyote = 0;
      this.onGround = false;
      this.noCut = false; // a player-initiated jump IS variable-height
    }
    // Variable height: releasing early cuts upward velocity — but never during a
    // spring bounce, which is a fixed height by design.
    if (!this.noCut && !this.jumpHeld && this.vy < 0) {
      this.vy *= JUMP_CUT_MULT;
    }

    // Gravity + fall cap.
    this.vy = Math.min(this.vy + GRAVITY * SIM_DT, MAX_FALL_SPEED);

    // Integrate + resolve axis-separately for clean AABB.
    this.moveX(this.vx * SIM_DT);
    this.onGround = false;
    this.moveY(this.vy * SIM_DT);

    // Key pickups + defuser pickup + crumble ticking + spring coil-release.
    this.collectKeys();
    this.collectDefusers();
    this.updateCrumbles();
    this.updateSprings();
    // Ghost blocks: vanish (harmless) or reveal a spike (deadly) on contact.
    const killedByGhost = this.updateGhosts();

    // Hazards / bounds (spikes + out-of-bounds + saw blades + ghost-spikes).
    if (
      this.overlaps((x, y) => this.level.isLethal(x, y)) ||
      this.py > ROWS + 1 ||
      this.hitBySaw() ||
      killedByGhost
    ) {
      this.die();
      return;
    }
    // Exit only clears the level once every key is collected (door unlocked).
    if (this.keysRemaining() === 0 && this.overlaps((x, y) => this.level.isGoal(x, y))) {
      if (this.editorCtx?.verify) {
        // Publish playtest: record the first clear time, flash it, keep playing.
        if (this.publishClearTime == null) {
          this.publishClearTime = this.tick * SIM_DT;
          this.showCleared();
        }
        this.respawn();
        return;
      }
      if (this.editorCtx) {
        this.returnToEditor({}); // Test clear -> back to editor
        return;
      }
      this.scene.start(Scenes.Results, { attempts: this.attempts });
    }
  }

  private collectKeys(): void {
    if (this.keyEntities.length === 0) return;
    let changed = false;
    for (const e of this.keyEntities) {
      if (!e.collected && this.overlapsTile(e.key.x, e.key.y)) {
        e.collected = true;
        e.gfx.setVisible(false);
        changed = true;
      }
    }
    if (changed) this.refreshDoor(); // may flip locked -> unlocked
  }

  private collectDefusers(): void {
    if (this.defused || this.defuserEntities.length === 0) return;
    for (const e of this.defuserEntities) {
      if (!e.collected && this.overlapsTile(e.defuser.x, e.defuser.y)) {
        e.collected = true;
        e.gfx.setVisible(false);
        this.defused = true; // timer is frozen from here on
      }
    }
  }

  private keysRemaining(): number {
    let n = 0;
    for (const e of this.keyEntities) if (!e.collected) n++;
    return n;
  }

  /** Recolor the door based on how many keys are left. */
  private refreshDoor(): void {
    if (!this.exitPiece) return;
    this.exitPiece.locked = this.keysRemaining() > 0;
    this.exitGfx.clear();
    this.exitPiece.draw(this.exitGfx);
  }

  /** Continuous AABB-vs-tile test (better than floor() for pickups). */
  private overlapsTile(tx: number, ty: number): boolean {
    const hw = PLAYER_W / 2;
    const hh = PLAYER_H / 2;
    return (
      this.px + hw > tx &&
      this.px - hw < tx + 1 &&
      this.py + hh > ty &&
      this.py - hh < ty + 1
    );
  }

  /** True if any saw's circular hitbox overlaps the player's AABB this tick.
   *  Circle-vs-box via the closest point on the box to the blade center. */
  private hitBySaw(): boolean {
    if (this.sawEntities.length === 0) return false;
    const hw = PLAYER_W / 2;
    const hh = PLAYER_H / 2;
    for (const e of this.sawEntities) {
      const c = e.saw.centerAt(this.tick);
      const nearX = Math.max(this.px - hw, Math.min(c.x, this.px + hw));
      const nearY = Math.max(this.py - hh, Math.min(c.y, this.py + hh));
      const dx = c.x - nearX;
      const dy = c.y - nearY;
      if (dx * dx + dy * dy < SAW_RADIUS * SAW_RADIUS) return true;
    }
    return false;
  }

  /** Trigger any ghost block the player overlaps. Harmless ones vanish;
   *  spike ones reveal a spike. Returns true if a spike-ghost was triggered
   *  (so the caller kills the player this step). */
  private updateGhosts(): boolean {
    if (this.ghostEntities.length === 0) return false;
    let deadly = false;
    for (const e of this.ghostEntities) {
      if (e.ghost.triggered) continue;
      if (!this.overlapsTile(e.ghost.x, e.ghost.y)) continue;
      e.ghost.triggered = true;
      e.gfx.clear();
      e.ghost.draw(e.gfx); // redraw as spike, or nothing if it vanished
      if (e.ghost.becomesSpike) deadly = true;
    }
    return deadly;
  }

  /** True if the player is currently resting on top of tile (tx, ty). */
  private standingOn(tx: number, ty: number): boolean {
    if (!this.onGround) return false;
    const hw = PLAYER_W / 2;
    const hh = PLAYER_H / 2;
    // Feet sit just above the tile below; that tile's row is where we stand.
    if (Math.floor(this.py + hh + 0.02) !== ty) return false;
    return tx >= Math.floor(this.px - hw) && tx <= Math.floor(this.px + hw);
  }

  private updateCrumbles(): void {
    if (this.crumbleEntities.length === 0) return;
    for (const c of this.crumbleEntities) {
      if (c.crumbled) continue;

      // Trigger once stood on; after that it collapses regardless (§5.4).
      if (c.timer < 0) {
        if (!this.standingOn(c.block.x, c.block.y)) continue;
        c.timer = CRUMBLE_TIME;
      }

      c.timer -= SIM_DT;
      const elapsed = CRUMBLE_TIME - c.timer;
      const stage = Math.min(CRUMBLE_STAGES - 1, Math.floor(elapsed / (CRUMBLE_TIME / CRUMBLE_STAGES)));
      if (stage !== c.block.stage) {
        c.block.stage = stage;
        c.gfx.clear();
        c.block.draw(c.gfx);
      }

      if (c.timer <= 0) {
        c.crumbled = true;
        c.gfx.setVisible(false);
        this.level.setSolid(c.block.x, c.block.y, false); // player now falls through
      }
    }
  }

  /** Compress the coil the moment the player bounces off it. */
  private triggerSpring(tx: number, ty: number): void {
    const e = this.springByKey.get(`${tx},${ty}`);
    if (!e) return;
    e.spring.squash = 1;
    e.gfx.clear();
    e.spring.draw(e.gfx);
  }

  /** Ease each compressed coil back to rest and redraw it. */
  private updateSprings(): void {
    if (this.springEntities.length === 0) return;
    for (const e of this.springEntities) {
      if (e.spring.squash <= 0) continue;
      e.spring.squash = Math.max(0, e.spring.squash - SIM_DT / 0.12); // release over ~120ms
      e.gfx.clear();
      e.spring.draw(e.gfx);
    }
  }

  /** The spring occupying tile (tx,ty), if any. */
  private springAt(tx: number, ty: number): Spring | undefined {
    return this.springByKey.get(`${tx},${ty}`)?.spring;
  }

  private moveX(dx: number): void {
    this.px += dx;
    const hw = PLAYER_W / 2;
    let launched: [number, number, Spring] | null = null;
    for (const [cx, cy] of this.overlappedSolids()) {
      const spr = this.springAt(cx, cy);
      // A sideways spring launches you back the way you came into its face.
      if (spr && ((dx > 0 && spr.dir === 'left') || (dx < 0 && spr.dir === 'right'))) {
        launched = [cx, cy, spr];
      } else if (!spr) {
        this.launchVx = 0; // ran into a plain wall — kill any sideways carry
      }
      // Push out along X toward the side we came from (springs are solid too).
      if (dx > 0) this.px = cx - hw - 0.0001;
      else if (dx < 0) this.px = cx + 1 + hw + 0.0001;
      this.vx = 0;
    }
    if (launched) {
      this.launchVx = launched[2].dir === 'left' ? -SPRING_LAUNCH_SPEED : SPRING_LAUNCH_SPEED;
      this.triggerSpring(launched[0], launched[1]);
    }
  }

  private moveY(dy: number): void {
    this.py += dy;
    const hh = PLAYER_H / 2;
    let launched: [number, number, Spring] | null = null;
    for (const [cx, cy] of this.overlappedSolids()) {
      const spr = this.springAt(cx, cy);
      if (dy > 0) {
        this.py = cy - hh - 0.0001;
        // Landing on an up- or up-diagonal spring launches instead of resting.
        if (spr && (spr.dir === 'up' || spr.dir === 'up-left' || spr.dir === 'up-right')) {
          launched = [cx, cy, spr];
        } else {
          this.onGround = true;
        }
      } else if (dy < 0) {
        this.py = cy + 1 + hh + 0.0001;
        // Bonking a down- or down-diagonal spring from below slams you down.
        if (spr && (spr.dir === 'down' || spr.dir === 'down-left' || spr.dir === 'down-right')) {
          launched = [cx, cy, spr];
        }
      }
      this.vy = 0;
    }
    if (launched) {
      const dir = launched[2].dir;
      const up = dir === 'up' || dir === 'up-left' || dir === 'up-right';
      this.vy = up ? -SPRING_V : SPRING_V;
      this.noCut = up; // fixed-height up-bounce is immune to jump-cut
      // Diagonals add the sideways fling on top (reuses your side-launch feel).
      if (dir === 'up-left' || dir === 'down-left') this.launchVx = -SPRING_LAUNCH_SPEED;
      else if (dir === 'up-right' || dir === 'down-right') this.launchVx = SPRING_LAUNCH_SPEED;
      this.triggerSpring(launched[0], launched[1]);
    }
  }

  /** Solid tiles the player's AABB currently overlaps. */
  private *overlappedSolids(): Generator<[number, number]> {
    const hw = PLAYER_W / 2;
    const hh = PLAYER_H / 2;
    const minX = Math.floor(this.px - hw);
    const maxX = Math.floor(this.px + hw);
    const minY = Math.floor(this.py - hh);
    const maxY = Math.floor(this.py + hh);
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        if (this.level.isSolid(tx, ty)) yield [tx, ty];
      }
    }
  }

  /** True if any tile the player's AABB covers satisfies `pred`. */
  private overlaps(pred: (x: number, y: number) => boolean): boolean {
    const hw = PLAYER_W / 2;
    const hh = PLAYER_H / 2;
    const minX = Math.floor(this.px - hw);
    const maxX = Math.floor(this.px + hw);
    const minY = Math.floor(this.py - hh);
    const maxY = Math.floor(this.py + hh);
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        if (pred(tx, ty)) return true;
      }
    }
    return false;
  }

  private respawn(): void {
    this.attempts++;
    this.px = this.level.spawn.x + 0.5;
    this.py = this.level.spawn.y + 0.5;
    this.vx = 0;
    this.vy = 0;
    this.onGround = false;
    this.coyote = 0;
    this.buffer = 0;
    this.noCut = false;
    this.launchVx = 0;
    this.jumpQueued = false;
    this.tick = 0; // restart the deterministic clock -> saws return to their start
    // Timer resets every attempt and waits for the next first-move.
    this.timerStarted = false;
    this.timeLeft = this.timerSeconds;
    // Defusal kit resets — recollect it each run to freeze the timer again.
    this.defused = false;
    for (const e of this.defuserEntities) {
      e.collected = false;
      e.gfx.setVisible(true);
    }
    // Keys reset every attempt — you must recollect them each run.
    for (const e of this.keyEntities) {
      e.collected = false;
      e.gfx.setVisible(true);
    }
    this.refreshDoor();
    // Crumble blocks rebuild on death (§5.4).
    for (const c of this.crumbleEntities) {
      c.crumbled = false;
      c.timer = -1;
      c.block.stage = 0;
      c.gfx.setVisible(true);
      c.gfx.clear();
      c.block.draw(c.gfx);
      this.level.setSolid(c.block.x, c.block.y, true);
    }
    // Springs reset their coil to rest.
    for (const e of this.springEntities) {
      e.spring.squash = 0;
      e.gfx.clear();
      e.spring.draw(e.gfx);
    }
    // Ghost blocks reset to looking like solid blocks again.
    for (const e of this.ghostEntities) {
      e.ghost.triggered = false;
      e.gfx.clear();
      e.ghost.draw(e.gfx);
    }
  }

  /** Death: burst of debris at the death spot + shake, then instant restart.
   *  Infinite tries everywhere now (including the publish playtest). */
  private die(): void {
    this.deathBurst.explode(28, this.px * TILE, this.py * TILE);
    this.cameras.main.shake(140, 0.012);
    this.respawn(); // teleport to spawn immediately — gibs fly while you retry (§4.4)
  }

  /** One reusable emitter; explode() fires a burst on demand. */
  private createDeathBurst(): void {
    this.deathBurst = this.add
      .particles(0, 0, 'spark', {
        speed: { min: 90, max: 340 },
        angle: { min: 0, max: 360 },
        gravityY: 620,
        lifespan: { min: 250, max: 520 },
        scale: { start: 1.3, end: 0 },
        alpha: { start: 1, end: 0 },
        rotate: { min: 0, max: 360 },
        // Fun multi-color pop — player cyan + white sparks + hot debris.
        tint: [Colors.player, 0xffffff, Colors.coin, Colors.spike],
        emitting: false, // burst-only, never a steady stream
      })
      .setDepth(200);
  }

  // ---- Input -------------------------------------------------------------

  private sampleInput(): void {
    this.scanTouchButtons();
    const left = this.keys.left.isDown || this.keys.a.isDown || this.touchLeft;
    const right = this.keys.right.isDown || this.keys.d.isDown || this.touchRight;
    this.moveDir = (right ? 1 : 0) - (left ? 1 : 0);
    this.jumpHeld = this.keys.jump.isDown || this.touchJump;
  }

  private touchLeft = false;
  private touchRight = false;
  private touchJump = false;
  private prevJumpBtn = false;
  private touchButtons: { kind: 'left' | 'right' | 'jump'; x: number; y: number; r: number }[] = [];

  /** Builds the on-screen d-pad + jump button (touch devices only, §4.2). */
  private createTouchControls(): void {
    if (!this.sys.game.device.input.touch) return;
    // Allow several simultaneous touches (e.g. hold ► while tapping JUMP).
    this.input.addPointer(2);

    const y = GAME_H - 52;
    const defs = [
      { kind: 'left' as const, x: 52, y, r: 34, glyph: '◄', size: '22px' },
      { kind: 'right' as const, x: 134, y, r: 34, glyph: '►', size: '22px' },
      { kind: 'jump' as const, x: GAME_W - 62, y, r: 44, glyph: 'JUMP', size: '14px' },
    ];
    for (const d of defs) {
      this.add
        .circle(d.x, d.y, d.r, 0xffffff, 0.12)
        .setStrokeStyle(2, 0xffffff, 0.3)
        .setDepth(100);
      this.add
        .text(d.x, d.y, d.glyph, { fontFamily: 'monospace', fontSize: d.size, color: Colors.text })
        .setOrigin(0.5)
        .setAlpha(0.75)
        .setDepth(101);
      this.touchButtons.push({ kind: d.kind, x: d.x, y: d.y, r: d.r });
    }
  }

  /** Hit-test every active pointer against the buttons each frame.
   *  Frame-based (not event-based) so slides and multi-touch never get stuck. */
  private scanTouchButtons(): void {
    if (this.touchButtons.length === 0) return;
    let l = false;
    let r = false;
    let j = false;
    for (const p of this.input.manager.pointers) {
      if (!p.isDown) continue;
      for (const b of this.touchButtons) {
        const dx = p.x - b.x;
        const dy = p.y - b.y;
        if (dx * dx + dy * dy > b.r * b.r) continue;
        if (b.kind === 'left') l = true;
        else if (b.kind === 'right') r = true;
        else j = true;
      }
    }
    this.touchLeft = l;
    this.touchRight = r;
    this.touchJump = j;
    // Rising edge -> buffer a jump (so the buffer/coyote logic still applies).
    if (j && !this.prevJumpBtn) this.jumpQueued = true;
    this.prevJumpBtn = j;
  }

  // ---- Rendering ---------------------------------------------------------

  private render(): void {
    this.playerRect.setPosition(this.px * TILE, this.py * TILE);

    // Move + spin each saw to its position for the current tick.
    if (this.sawEntities.length > 0) {
      const angle = this.tick * SIM_DT * SAW_SPIN;
      for (const e of this.sawEntities) {
        const c = e.saw.centerAt(this.tick);
        e.gfx.setPosition(c.x * TILE, c.y * TILE);
        e.gfx.setRotation(angle);
      }
    }

    const total = this.keyEntities.length;
    const keyStr = total > 0 ? `keys ${total - this.keysRemaining()}/${total}   ` : '';
    const timeStr = this.timerEnabled
      ? this.defused
        ? 'time DEFUSED   '
        : `time ${this.timeLeft.toFixed(1)}   `
      : '';
    this.hud.setText(`${timeStr}${keyStr}attempts ${this.attempts}   [←/→ or A/D · space]`);
  }

  private drawLevel(): void {
    // Each Piece draws itself — RaidScene no longer knows how a spike looks.
    this.level.draw(this.add.graphics());
  }

  /** Build runtime visuals for dynamic pieces (keys + the exit door). */
  private createDynamicVisuals(): void {
    this.keyEntities = this.level.keyPieces().map((key) => {
      const gfx = this.add.graphics();
      key.draw(gfx);
      return { key, gfx, collected: false };
    });

    this.crumbleEntities = this.level.crumblePieces().map((block) => {
      const gfx = this.add.graphics();
      block.draw(gfx);
      return { block, gfx, timer: -1, crumbled: false };
    });

    this.springByKey.clear();
    this.springEntities = this.level.springPieces().map((spring) => {
      const gfx = this.add.graphics();
      spring.draw(gfx);
      const e: SpringEntity = { spring, gfx };
      this.springByKey.set(`${spring.x},${spring.y}`, e);
      return e;
    });

    this.defuserEntities = this.level.defuserPieces().map((defuser) => {
      const gfx = this.add.graphics();
      defuser.draw(gfx);
      return { defuser, gfx, collected: false };
    });

    // Saws: draw the blade art once (centered at local origin); render() moves
    // and spins each one every frame by transforming its Graphics object.
    this.sawEntities = this.level.sawPieces().map((saw) => {
      const gfx = this.add.graphics().setDepth(60);
      saw.draw(gfx);
      return { saw, gfx };
    });

    // Ghost blocks — drawn looking exactly like a normal block until triggered.
    this.ghostEntities = this.level.ghostPieces().map((ghost) => {
      const gfx = this.add.graphics();
      ghost.draw(gfx);
      return { ghost, gfx };
    });

    this.exitPiece = this.level.exitPiece();
    this.exitGfx = this.add.graphics();
    this.refreshDoor(); // sets initial locked/unlocked color
  }

  // ---- Load failure ------------------------------------------------------

  private showLoadError(): void {
    this.add
      .text(GAME_W / 2, GAME_H / 2, 'Failed to load level', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#ff5964',
      })
      .setOrigin(0.5);
  }
}
