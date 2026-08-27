import Phaser from 'phaser';
import {
  arenaAt,
  buildLayout,
  centreOf,
  killYOf,
  type Arena,
  type Pickup,
  type PickupKind,
  type Rect,
} from '@/clockshot/arena';
import { C, FONT, T, hex } from '@/clockshot/theme';
import { COMBAT, GRAVITY, WARNING_MS } from '@/clockshot/tuning';
import { TEX, bakeTextures } from '@/clockshot/textures';
import { ART, ENEMY_ANIM, fitArt, hasArt } from '@/clockshot/art';
import { Controls } from '@/clockshot/controls';
import { TimerHud } from '@/clockshot/timerHud';
import { Player } from '@/clockshot/player';
import type { Anchor } from '@/clockshot/arena';
import { sfx } from '@/clockshot/sfx';
import { store } from '@/clockshot/store';
import { layoutOf, type Layout } from '@/clockshot/ui';
import {
  CHECKPOINT_MIN_MS,
  MAX_RUN_MS,
  START_TIME_MS,
  TIME_GAIN,
  TIME_LOSS,
} from '@/shared/config';
import { EMPTY_TALLY, type RunStartResponse, type RunTally } from '@/shared/api';
import type { Practice, PracticeResult } from '@/clockshot/practice';

interface EnemyData {
  from: number;
  to: number;
  speed: number;
  dir: 1 | -1;
  /** The line it patrols along, so the buzz can be measured from somewhere. */
  baseY: number;
  /** Its own place in the buzz, so a row of them never shudders in unison. */
  phase: number;
}

type EnemySprite = Phaser.Physics.Arcade.Sprite & {
  cs: EnemyData;
  /** The red heat behind the blade, kept in step with it. */
  glow?: Phaser.GameObjects.Image;
};
type CheckpointSprite = Phaser.Physics.Arcade.Sprite & { index: number };

/**
 * What survives an out-of-time restart.
 *
 * A restart is not a new run — it is the same attempt resumed from the last
 * checkpoint — so the things the score is made of have to carry across, or a
 * player would be quietly robbed of every anchor they had already swung from.
 */
interface Resume {
  /** Indices of every checkpoint already armed, and where to come back to. */
  armed: number[];
  at: { x: number; y: number } | null;
  /** The clock recorded when that checkpoint was first touched. */
  timeMs: number;
  anchors: string[];
  tally: RunTally;
}
type PickupSprite = Phaser.Physics.Arcade.Sprite & { kind: PickupKind; taken: boolean };

/**
 * The 30-second run.
 *
 * The clock here is the server's, not the device's: elapsed time is measured
 * against the run's server start stamp via `store.serverNow()`. Backgrounding
 * the tab therefore neither pauses nor extends a run — when the player comes
 * back, the run is exactly as far along as it really is, and may already be
 * over.
 */
/**
 * How far a hazard's heat reaches, as a multiple of the thing throwing it.
 *
 * How far a hazard's heat reaches past the thing throwing it, as a multiple of
 * that thing's size. A halo that stops at the edge of a spike tells a player
 * nothing they could not already see from the spike.
 */
const GLOW_SPREAD = 1.9;

/**
 * How far the animated backdrop is held down behind live gameplay.
 *
 * How far the animated backdrop is held down behind live gameplay.
 *
 * Zero: the arena sits on the loop at full brightness. Raise it if pickups and
 * hazards start losing their fight with the picture behind them — that is the
 * whole reason the dial exists.
 */
const PLAY_SCRIM = 0;

/**
 * How fast the enemy turns, in degrees per second.
 *
 * Nearly ten rotations a second — well past the point where the 34fps frames
 * underneath can be read individually, which is the intent: at this speed it
 * stops being a creature you watch and becomes a hazard you keep away from.
 */
const ENEMY_SPIN = 3500;

/**
 * How big a spike is drawn, and how often one appears along a strip.
 *
 * Size and spacing are separate numbers on purpose: raise `size` and the spikes
 * get bigger where they stand, raise `spacing` and there are fewer of them.
 * Tiling could not tell those two apart.
 */
const SPIKE = {
  size: 86,
  spacing: 62,
} as const;

/**
 * Whether each hazard throws its own red heat.
 *
 * Separate switches because the two are separate judgements: the enemy already
 * reads as dangerous from its animation alone, where a spike is a static thing
 * on a dark floor and the heat is most of what makes it noticeable.
 */
const ENEMY_GLOW = false;
const SPIKE_GLOW = false;

/** The buzz: how far it strays off its line, how quickly, and how much it shakes. */
const ENEMY_BUZZ = {
  /** World units, peak to centre. Small on purpose — this is a tremor. */
  travel: 2.6,
  /** Radians a second. Fast enough to be a vibration rather than a bob. */
  rate: 17,
  /** Degrees of shudder added on top of the steady turn. */
  wobble: 2.2,
} as const;

/**
 * How wide one tile of stone is, in world units.
 *
 * One number for the whole arena, so a block is the same size whether it is
 * under the spawn or holding up a ledge on the far side. It matches the
 * editor's grid cell, which is what a built level is measured in anyway.
 */
const TILE_WORLD = 60;

export class PlayScene extends Phaser.Scene {
  private run!: RunStartResponse;
  /** The place this window is played in. Chosen by the server, drawn here. */
  private arena!: Arena;
  /**
   * Set when this is somebody testing a level they built.
   *
   * A test run is the same game in every respect a player can feel — the same
   * clock, the same rope, the same checkpoints — and different in exactly two:
   * the server never hears about it, and it ends back in the editor instead of
   * on a results screen.
   */
  private practice: Practice | null = null;
  private killY = 0;

  /**
   * The clock, in milliseconds. This *is* the run.
   *
   * It is frozen until the player first moves, then drains in real time. Clock
   * pickups add to it and hits take from it, so a good run lasts longer than a
   * bad one — the opposite of the fixed timer this replaced.
   */
  private timeMs = START_TIME_MS;
  private started = false;
  /** Whether the lit grapple-point art arrived; without it the scale carries it. */
  private anchorLit = false;
  /** Holds the loop back so the arena stays readable over it. */
  private playScrim?: Phaser.GameObjects.Rectangle;
  /** The scale the anchor art is drawn at, so the highlight can build on it. */
  private anchorScale = 1;
  /** Last anchor count painted, so the HUD only redraws when it changes. */
  private shownAnchors = -1;
  private goal!: Phaser.Physics.Arcade.Sprite;

  private checkpoints!: Phaser.Physics.Arcade.Group;
  /** Checkpoints armed so far this run, and the one to restart from. */
  private armed = new Set<number>();
  private resumeAt: { x: number; y: number } | null = null;
  private resumeTimeMs = START_TIME_MS;
  private carriedAnchors: string[] = [];

  private player!: Player;
  private controls!: Controls;
  private platforms!: Phaser.Physics.Arcade.StaticGroup;
  private hazards!: Phaser.Physics.Arcade.StaticGroup;
  private pickups!: Phaser.Physics.Arcade.Group;
  private enemies!: Phaser.Physics.Arcade.Group;

  private rope!: Phaser.GameObjects.Graphics;
  private anchorSprites: Phaser.GameObjects.Image[] = [];
  private particles!: Phaser.GameObjects.Particles.ParticleEmitter;

  private tally: RunTally = { ...EMPTY_TALLY };
  private streak = 0;
  private finished = false;
  private lastTickSecond = -1;

  // HUD
  private timer!: TimerHud;
  private hudScore!: Phaser.GameObjects.Text;
  private hudTeam!: Phaser.GameObjects.Text;
  /** The pause affordance. Static, so it is painted on layout and left alone. */
  private hudChrome!: Phaser.GameObjects.Graphics;
  private pauseZone!: Phaser.GameObjects.Zone;

  /**
   * A second camera that renders only the HUD and the controls.
   *
   * The world camera zooms so the arena reads at the same physical size on
   * every device. The interface must not zoom with it — a thumb is the same
   * size whatever the screen — so it gets its own unzoomed camera, and each
   * camera is told to ignore the other's objects.
   */
  private uiCam!: Phaser.Cameras.Scene2D.Camera;

  constructor() {
    super('cs-play');
  }

  init(data: { run: RunStartResponse; resume?: Resume; arena?: Arena; practice?: Practice }): void {
    this.run = data.run;
    // A built level arrives already converted; a real run looks its arena up by
    // the index the server chose.
    this.arena = data.arena ?? arenaAt(data.run.arenaIndex);
    this.practice = data.practice ?? null;
    this.killY = killYOf(this.arena);

    const r = data.resume;
    this.tally = r ? { ...r.tally } : { ...EMPTY_TALLY };
    this.armed = new Set(r?.armed ?? []);
    this.resumeAt = r?.at ?? null;
    this.carriedAnchors = r?.anchors ?? [];
    this.resumeTimeMs = r ? Math.max(r.timeMs, CHECKPOINT_MIN_MS) : data.run.startTimeMs || START_TIME_MS;

    this.timeMs = this.resumeTimeMs;
    this.started = false;
    this.shownAnchors = -1;
    this.streak = 0;
    this.finished = false;
    this.lastTickSecond = -1;
  }

  /* ---------------------------------------------------------------------- */
  /* Build                                                                   */
  /* ---------------------------------------------------------------------- */

  create(): void {
    bakeTextures(this);

    const { width, height } = this.arena.world;
    this.physics.world.setBounds(0, 0, width, height);
    this.physics.world.gravity.y = GRAVITY;
    this.cameras.main.setBounds(0, 0, width, height);

    this.drawBackdrop();
    this.buildPlatforms();
    this.buildHazards();
    this.buildAnchors();

    const layout = buildLayout(this.arena, this.run.seed);
    this.buildPickups(layout.pickups);

    this.rope = this.add.graphics().setDepth(18);

    const from = this.resumeAt ?? this.arena.spawn;
    this.player = new Player(this, from.x, from.y);
    // Anchors already swung from stay credited: this is the same run.
    for (const key of this.carriedAnchors) this.player.anchorsUsed.add(key);
    this.physics.add.collider(this.player.sprite, this.platforms);

    this.buildEnemies(layout.patrols);
    this.buildGoal();
    this.buildCheckpoints();
    this.buildParticles();

    this.physics.add.overlap(this.player.sprite, this.pickups, (_p, obj) =>
      this.onPickup(obj as PickupSprite),
    );
    this.physics.add.overlap(this.player.sprite, this.hazards, () => this.onHazard());
    this.physics.add.overlap(this.player.sprite, this.enemies, () => this.onHazard());
    this.physics.add.overlap(this.player.sprite, this.goal, () => this.onGoal());
    this.physics.add.overlap(this.player.sprite, this.checkpoints, (_p, c) =>
      this.onCheckpoint(c as CheckpointSprite),
    );

    // A loose camera reads as input lag even when the input is instant: you
    // move, and the world takes a beat to agree. 0.11 was well behind a swing.
    this.cameras.main.startFollow(this.player.sprite, true, 0.2, 0.2);

    this.controls = new Controls(this, () => this.pause());
    this.buildHud();
    this.updateHudText();
    this.splitCameras();
    this.relayout();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.teardown, this);

    sfx.runStart();
    this.cameras.main.fadeIn(200, 7, 11, 22);
  }

  /** Parallax grid, so speed is legible against an otherwise empty void. */
  /**
   * The arena's floor: the animated loop, dimmed, with the grid over it.
   *
   * The camera paints nothing, so what shows through the transparent canvas is
   * the same `<video>` every other screen sits on. That costs the game its
   * parallax, because a DOM element cannot travel with a camera it knows
   * nothing about — so the wireframe grid comes back on top of it. The grid is
   * what actually carried the sense of speed anyway; the picture behind it was
   * only ever mood.
   *
   * The scrim is the part that matters. A busy 30fps loop directly behind
   * pickups and hazards is motion competing with the things a player has to
   * read while swinging, and the loop is bright in exactly the wrong places.
   * Held down here it stays atmosphere.
   */
  private drawBackdrop(): void {
    const { width, height } = this.arena.world;

    // The camera paints nothing, so what shows through the transparent canvas
    // is the animated loop every other screen sits on. At zero the scrim is not
    // merely invisible — it is never created, so there is no full-screen quad
    // being composited every frame for no reason.
    if (PLAY_SCRIM > 0) {
      const scrim = this.add
        .rectangle(0, 0, this.scale.width, this.scale.height, C.bg, PLAY_SCRIM)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(-20);
      this.world(scrim);
      this.playScrim = scrim;
    }

    // The parallax layer, back over the loop now that there is no painted sky.
    const g = this.add.graphics().setDepth(-10);
    g.lineStyle(1, C.grid, 0.55);
    for (let x = 0; x <= width; x += 120) g.lineBetween(x, 0, x, height);
    for (let y = 0; y <= height; y += 120) g.lineBetween(0, y, width, y);
    g.setScrollFactor(0.35);

    // The horizon glow is gone. It was a flat cyan `fillRect` over the bottom
    // 420 units of the world, and a rectangle has a hard top edge: invisible
    // against the near-black void it was drawn for, but over the loop it became
    // a seam straight across the arena with a lighter half beneath it. The
    // backdrop supplies the depth it was faking.
  }

  private buildPlatforms(): void {
    this.platforms = this.physics.add.staticGroup();
    const g = this.add.graphics().setDepth(5);
    const art = hasArt(this, ART.platform[0]);

    for (const r of this.arena.platforms) {
      const c = centreOf(r);
      const body = this.add.rectangle(c.x, c.y, r.w, r.h);
      this.physics.add.existing(body, true);
      this.platforms.add(body);

      if (art) {
        // Tiled rather than stretched: platforms are any width the arena wants,
        // and one slab scaled to fit would show a different block size on every
        // ledge.
        this.world(this.layTiles(r, ART.platform, 4));
      } else {
        g.fillStyle(C.platform, 1);
        g.fillRoundedRect(r.x, r.y, r.w, r.h, 5);
      }

      // A lit top edge tells the player where they can actually stand. Kept
      // over the artwork too — it is the one part of a platform that has to
      // read instantly, and the illustration has no such affordance of its own.
      g.fillStyle(C.platformTop, 1);
      g.fillRect(r.x + 3, r.y, r.w - 6, 4);
    }
  }

  private buildHazards(): void {
    this.hazards = this.physics.add.staticGroup();
    const g = this.add.graphics().setDepth(5);
    const art = hasArt(this, ART.hazard);

    for (const r of this.arena.hazards) {
      const c = centreOf(r);
      const body = this.add.rectangle(c.x, c.y, r.w, r.h);
      this.physics.add.existing(body, true);
      this.hazards.add(body);
      if (art) this.drawSpikeArt(r);
      else this.drawSpikes(g, r);
    }
  }

  /**
   * The painted hazard, repeated along the strip.
   *
   * The art is a spike on a plinth: a wide base that sits flat on the surface
   * and a point that rises above it. So the tile is drawn taller than the
   * collision box and hung from its bottom edge, which puts the base exactly on
   * the strip and lets the tip overhang.
   *
   * The overhang is deliberate. What punishes a player is the strip; the point
   * standing proud of it reads as "do not go near" without ever being the thing
   * that actually hits them.
   */
  /**
   * The painted hazard: a row of spikes standing on the strip.
   *
   * Placed one by one rather than tiled. A tiled strip can only ever be cut
   * into whole fractions of its own width, so an 110-unit hazard could have
   * spikes at 110, 55 or 37 units and nothing in between — the size was decided
   * by the strip rather than by what looks right. Placing them frees the two
   * apart: the spacing follows the strip, the size does not.
   *
   * Each one stands on the bottom edge of its strip and is allowed to overhang
   * the ends. What punishes a player is the collision box; the art is a warning
   * about it, and a warning that stops exactly at the edge of the danger is a
   * worse warning.
   */
  /**
   * The painted hazard: a row of spikes standing on the strip, under one glow.
   *
   * One glow for the whole strip, not one per spike. Per-spike halos were
   * 224 units across on spikes standing 55 apart, so each overlapped its
   * neighbours by about three quarters — and additive light does not overlap
   * politely. Three of them summed past full brightness, clipped to a flat
   * saturated slab, and the slab showed the edges of the quads it was made of.
   * That is the box that slid around when the arena scrolled.
   *
   * Stretched into an ellipse across the strip it is also the truer shape: heat
   * coming off a row of spikes is one glow the length of the row, not a string
   * of identical circles.
   */
  private drawSpikeArt(r: Rect): void {
    const cols = Math.max(1, Math.round(r.w / SPIKE.spacing));
    const step = r.w / cols;
    const floor = r.y + r.h;

    if (SPIKE_GLOW) {
      const glow = this.add
        .image(r.x + r.w / 2, floor - SPIKE.size * 0.4, TEX.glow)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(C.rage)
        .setDisplaySize(r.w + SPIKE.size * GLOW_SPREAD, SPIKE.size * GLOW_SPREAD)
        .setDepth(5)
        .setAlpha(0.34);
      this.world(glow);

      // Offset by where the strip sits, so a wall of spikes throbs like
      // separate angry things rather than one machine.
      this.tweens.add({
        targets: glow,
        alpha: 0.6,
        duration: 820 + ((r.x * 13) % 260),
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    const spikes = this.add.container(0, 0).setDepth(6);
    for (let i = 0; i < cols; i++) {
      spikes.add(
        this.add
          .image(r.x + (i + 0.5) * step, floor, ART.hazard)
          // Anchored to its foot, so raising `size` grows the spike upwards out
          // of the ground instead of sinking it into the platform.
          .setOrigin(0.5, 1)
          .setDisplaySize(SPIKE.size, SPIKE.size),
      );
    }
    this.world(spikes);
  }

  /**
   * Fills a rectangle with WHOLE tiles.
   *
   * A `tileSprite` repeats its texture until it runs out of room, which means
   * the last column is sliced wherever the rectangle is not an exact multiple
   * of the tile — the "weird cut" at the end of every ledge. Instead the tile
   * count is rounded to whole numbers first and the scale is then derived from
   * it, so the tiles stretch by a percent or two rather than one of them being
   * cut in half.
   *
   * Rounding is per axis and independent, so a rectangle whose aspect is not a
   * clean multiple still gets whole tiles both ways, each as near square as the
   * rectangle allows.
   */
  /**
   * Fills a rectangle with tiles at a fixed size, never stretched.
   *
   * Every tile is square and drawn at the same scale, whatever shape the ledge
   * is. The previous version stretched them to land on a whole count, which on
   * a 220x28 ledge meant drawing a square stone at 55x28 — the same block at a
   * different aspect on every platform in the arena.
   *
   * The tile size is chosen PER PLATFORM so a whole number fits across it
   * exactly. A ledge is whatever width the arena author drew, and 220 is not a
   * multiple of anything convenient — at one fixed size the last tile in every
   * row is a sliver, and at 220 that sliver is two thirds of a block.
   *
   * So each platform picks the nearest count and divides its own width by it.
   * Tiles stay square and every tile on a given ledge is identical; only the
   * size drifts between platforms, and by about ten percent at the extremes
   * rather than the five-fold spread that came of deriving it from aspect.
   *
   * Height is the one place a tile is still cut. A ledge is 28 units tall and a
   * tile is nearer 60, so what is drawn is the top of the block — which is what
   * a thin ledge should look like, and the mossy top edge lands where it wants.
   *
   * The variant is chosen from the cell's own coordinates, so it is stable
   * across a restart and a wall never looks like one block printed repeatedly.
   */
  private layTiles(r: Rect, keys: readonly string[], depth: number): Phaser.GameObjects.Container {
    const first = this.textures.get(keys[0]!).getSourceImage();
    const size = Math.min(first.width, first.height);

    // Whole tiles across, always — the width decides the size, not the reverse.
    const cols = Math.max(1, Math.round(r.w / TILE_WORLD));
    const tile = r.w / cols;
    const scale = tile / size;

    const tiles = this.add.container(0, 0).setDepth(depth);

    for (let c = 0; c < cols; c++) {
      for (let cy = r.y; cy < r.y + r.h - 0.5; cy += tile) {
        const cx = r.x + c * tile;
        const h = Math.min(tile, r.y + r.h - cy);

        const key = keys[this.tileVariant(cx, cy) % keys.length]!;
        const img = this.add.image(cx, cy, key).setOrigin(0, 0).setScale(scale);

        // Cropped in TEXTURE space, so a short row shows the top of a full-size
        // tile rather than a squashed whole one.
        if (h < tile) img.setCrop(0, 0, size, h / scale);
        tiles.add(img);
      }
    }
    return tiles;
  }

  /** A stable pseudo-random pick for a cell, from its own position. */
  private tileVariant(x: number, y: number): number {
    const h = Math.imul(Math.round(x) | 0, 73856093) ^ Math.imul(Math.round(y) | 0, 19349663);
    return Math.abs(h >>> 0);
  }


  private drawSpikes(g: Phaser.GameObjects.Graphics, r: Rect): void {
    const teeth = Math.max(3, Math.floor(r.w / 18));
    const step = r.w / teeth;
    g.fillStyle(C.danger, 0.95);
    for (let i = 0; i < teeth; i++) {
      const x = r.x + i * step;
      g.fillTriangle(x, r.y + r.h, x + step / 2, r.y, x + step, r.y + r.h);
    }
    g.fillStyle(C.danger, 0.16);
    g.fillRect(r.x, r.y - 6, r.w, r.h + 6);
  }

  private buildAnchors(): void {
    this.anchorLit = hasArt(this, ART.anchorLit);
    for (const a of this.arena.anchors) {
      const img = this.add.image(a.x, a.y, TEX.anchor).setDepth(6);
      this.anchorScale = fitArt(img, TEX.anchor);
      this.anchorSprites.push(img);
    }
  }

  private buildPickups(list: readonly Pickup[]): void {
    this.pickups = this.physics.add.group({ allowGravity: false, immovable: true });

    const texFor: Record<PickupKind, string> = {
      clock: TEX.clock,
      golden: TEX.golden,
    };

    for (const p of list) {
      const s = this.pickups.create(p.x, p.y, texFor[p.kind]) as PickupSprite;
      fitArt(s, texFor[p.kind]);
      s.kind = p.kind;
      s.taken = false;
      s.setDepth(10);
      (s.body as Phaser.Physics.Arcade.Body).setAllowGravity(false);

      // A slow bob and spin: motion is what makes a pickup read as collectable.
      this.tweens.add({
        targets: s,
        y: p.y - 9,
        duration: 1200 + ((p.x * 7) % 500),
        yoyo: true,
        repeat: -1,
        ease: 'Sine.inOut',
      });
      if (p.kind === 'golden') {
        this.tweens.add({ targets: s, angle: 360, duration: 6000, repeat: -1 });
      }
    }
  }

  private buildEnemies(patrols: readonly { x: number; y: number; from: number; to: number; speed: number }[]): void {
    this.enemies = this.physics.add.group({ allowGravity: false });

    if (hasArt(this, ENEMY_ANIM.key) && !this.anims.exists(ENEMY_ANIM.key)) {
      this.anims.create({
        key: ENEMY_ANIM.key,
        frames: this.anims.generateFrameNumbers(ENEMY_ANIM.key, {
          start: 0,
          end: ENEMY_ANIM.frames - 1,
        }),
        frameRate: ENEMY_ANIM.frameRate,
        repeat: -1,
      });
    }
    for (const p of patrols) {
      const animated = hasArt(this, ENEMY_ANIM.key);
      const e = this.enemies.create(
        p.x,
        p.y,
        animated ? ENEMY_ANIM.key : TEX.enemy,
      ) as EnemySprite;
      fitArt(e, animated ? ENEMY_ANIM.key : TEX.enemy);
      e.setDepth(12);
      if (animated) {
        // Started from its own frame, so a row of them writhes out of step
        // rather than moving as one organism.
        e.play(ENEMY_ANIM.key);
        e.anims.setProgress(((p.x * 7) % 100) / 100);
      }

      // The heat the enemy throws, behind it and additively blended so it reads
      // as light rather than as a red disc laid over the art. Drawn rather than
      // post-processed on purpose: Phaser's bloom is WebGL-only and vanishes
      // without a word on a Canvas fallback, and a hazard that stops announcing
      // itself on some devices is not a decoration, it is a bug.
      //
      // Off for now — see ENEMY_GLOW. Everything downstream already copes with
      // an enemy that has none, so this is the only place that had to change.
      if (ENEMY_GLOW) {
        const glow = this.add
          .image(p.x, p.y, TEX.glow)
          .setDepth(11)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setTint(C.rage)
          .setDisplaySize(COMBAT.enemyRadius * 7, COMBAT.enemyRadius * 7)
          // Kept well under half, because two enemies passing each other add
          // their light together and anything near the top clips into a slab.
          .setAlpha(0.42);
        e.glow = glow;

        this.tweens.add({
          targets: glow,
          alpha: 0.66,
          scale: glow.scale * 1.12,
          duration: 620,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      }
      (e.body as Phaser.Physics.Arcade.Body).setAllowGravity(false);
      e.cs = { from: p.from, to: p.to, speed: p.speed, dir: 1, baseY: p.y, phase: (p.x % 97) / 97 };
      e.setVelocityX(p.speed);
    }
  }

  /** The goal, and the only thing in the arena that ends a run well. */
  private buildGoal(): void {
    const { x, y } = this.arena.goal;
    this.goal = this.physics.add.sprite(x, y, TEX.goal).setDepth(11);
    const body = this.goal.body as Phaser.Physics.Arcade.Body;
    body.setAllowGravity(false);
    body.setImmovable(true);
  }

  private buildCheckpoints(): void {
    this.checkpoints = this.physics.add.group({ allowGravity: false, immovable: true });
    this.arena.checkpoints.forEach((c, i) => {
      const lit = this.armed.has(i);
      const s = this.checkpoints.create(
        c.x,
        c.y,
        lit ? TEX.checkpointLit : TEX.checkpoint,
      ) as CheckpointSprite;
      s.index = i;
      s.setDepth(9);
      (s.body as Phaser.Physics.Arcade.Body).setAllowGravity(false);
    });
  }

  /**
   * Arms a checkpoint, once and only once.
   *
   * Re-touching is deliberately ignored. If a checkpoint took your *current*
   * clock every time you passed it, the best play would be to collect a fat
   * clock, walk back, re-arm, and die on purpose — which is the exact opposite
   * of what a safety net is for.
   */
  private onCheckpoint(c: CheckpointSprite): void {
    if (this.finished || this.armed.has(c.index)) return;
    this.armed.add(c.index);
    this.resumeAt = { x: c.x, y: c.y - 30 };
    this.resumeTimeMs = Math.max(this.timeMs, CHECKPOINT_MIN_MS);

    c.setTexture(TEX.checkpointLit);
    sfx.collect(1);
    this.burst(c.x, c.y, C.goal, 14);
    this.flashMessage('CHECKPOINT', C.goal);
  }

  /** A slow breath, so the goal reads as alive from across the arena. */
  private pulseGoal(): void {
    const t = this.time.now / 1000;
    this.goal.setScale(1 + Math.sin(t * 2.2) * 0.05);
    this.goal.setAngle(Math.sin(t * 0.8) * 6);
  }

  private buildParticles(): void {
    this.particles = this.add.particles(0, 0, TEX.spark, {
      lifespan: 420,
      speed: { min: 60, max: 220 },
      scale: { start: 1, end: 0 },
      alpha: { start: 1, end: 0 },
      emitting: false,
    });
    this.particles.setDepth(16);
  }

  /* ---------------------------------------------------------------------- */
  /* HUD                                                                     */
  /* ---------------------------------------------------------------------- */

  private buildHud(): void {
    this.hudChrome = this.add.graphics().setScrollFactor(0).setDepth(880);
    this.timer = new TimerHud(this, START_TIME_MS);

    this.hudScore = this.add
      .text(0, 0, '+0s', { fontFamily: FONT, fontSize: '20px', color: hex(C.ink) })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(882);

    // Says which level is being tested, so a builder is never a beat unsure
    // whether they are looking at their own arena or the community's.
    this.hudTeam = this.add
      .text(0, 0, this.practice ? `TEST · ${this.practice.name.toUpperCase()}` : '', {
        fontFamily: FONT,
        fontSize: '13px',
        color: hex(C.cyan),
      })
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(882);

    this.pauseZone = this.add
      .zone(0, 0, 52, 52)
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(883)
      .setInteractive({ useHandCursor: true });
    this.pauseZone.on('pointerup', () => this.pause());
  }

  /** Puts the interface on its own camera and keeps the two from overlapping. */
  private splitCameras(): void {
    this.uiCam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    this.uiCam.setName('ui');

    const ui = this.uiObjects();
    this.cameras.main.ignore(ui);
    // Anything that is not interface belongs to the world camera alone.
    this.uiCam.ignore(this.children.list.filter((o) => !ui.includes(o)));
  }

  private uiObjects(): Phaser.GameObjects.GameObject[] {
    return [
      this.hudChrome,
      ...this.timer.objects(),
      this.hudScore,
      this.hudTeam,
      this.pauseZone,
      ...this.controls.objects(),
    ];
  }

  /** Keeps a world object off the interface camera. */
  private world(obj: Phaser.GameObjects.GameObject): void {
    this.uiCam?.ignore(obj);
  }

  /** Keeps an interface object off the world camera. */
  private overlay(obj: Phaser.GameObjects.GameObject): void {
    this.cameras.main.ignore(obj);
  }

  private relayout(): void {
    const L = layoutOf(this);
    this.playScrim?.setSize(L.w, L.h);
    this.timer.layout(L);
    this.drawChrome(L);
    this.hudScore.setPosition(L.cx, L.y + 100 * L.ui).setFontSize(Math.round(T.label * L.ui));
    this.hudTeam.setPosition(L.x, L.y + 22 * L.ui).setFontSize(Math.round(T.label * L.ui));
    this.pauseZone
      .setPosition(L.x + L.iw - 24 * L.ui, L.y + 24 * L.ui)
      .setSize(52 * L.ui, 52 * L.ui);

    // Zoom so roughly the same slice of arena is visible whatever the device.
    // Without this a 2x phone would render the world at half the apparent size
    // of a desktop, because a game unit is a device pixel.
    const zoom = Phaser.Math.Clamp(Math.min(L.w / 520, L.h / 900), 1, 2.2);
    this.cameras.main.setZoom(zoom);
    // Small deadzone for the same reason: inside it the camera does not move at
    // all, so a big one is a box you can swing around in while nothing tracks.
    this.cameras.main.setDeadzone((34 * L.ui) / zoom, (56 * L.ui) / zoom);
    this.uiCam?.setSize(L.w, L.h);

    this.controls.layout(L);
  }

  /**
   * The static furniture: the pause affordance, and nothing else.
   *
   * The clock used to share this Graphics, which meant repainting the pause
   * button sixty times a second in order to move an arc. It is painted on
   * layout now and then left alone; `TimerHud` owns everything that changes.
   */
  private drawChrome(L: Layout): void {
    const g = this.hudChrome;
    g.clear();

    // A 48-unit target, drawn at 40 — the ring is the visible affordance and
    // the zone around it is the part a thumb actually has to hit.
    const pxc = L.x + L.iw - 24 * L.ui;
    const pyc = L.y + 24 * L.ui;
    g.fillStyle(C.panel, 0.9);
    g.fillCircle(pxc, pyc, 20 * L.ui);
    g.lineStyle(Math.max(1, 1.5 * L.ui), C.panelEdge, 0.9);
    g.strokeCircle(pxc, pyc, 20 * L.ui);
    g.fillStyle(C.ink, 0.9);
    g.fillRect(pxc - 6 * L.ui, pyc - 8 * L.ui, 4 * L.ui, 16 * L.ui);
    g.fillRect(pxc + 2 * L.ui, pyc - 8 * L.ui, 4 * L.ui, 16 * L.ui);
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                  */
  /* ---------------------------------------------------------------------- */

  private onPickup(s: PickupSprite): void {
    if (s.taken || this.finished) return;
    s.taken = true;

    // Every pickup does exactly one thing: it puts seconds back on the clock.
    switch (s.kind) {
      case 'clock':
        this.tally.clocks++;
        this.addTime(TIME_GAIN.clock);
        this.streak++;
        sfx.collect(this.streak);
        break;
      case 'golden':
        this.tally.goldens++;
        this.addTime(TIME_GAIN.golden);
        this.streak++;
        sfx.collectGolden();
        this.cameras.main.shake(180, 0.006);
        this.flashMessage(`+${TIME_GAIN.golden}s`, C.gold);
        break;
    }

    this.burst(s.x, s.y, C.gold, s.kind === 'golden' ? 26 : 10);
    this.popNumber(s.x, s.y, s.kind);

    this.tweens.add({
      targets: s,
      scale: s.scaleX * 1.7,
      alpha: 0,
      duration: 180,
      onComplete: () => s.destroy(),
    });
    this.updateHudText();
  }

  /**
   * Getting hit costs seconds off the clock, which is the only currency there
   * is. The knockback and the ruined line cost more of it again.
   */
  private onHazard(): void {
    if (this.finished) return;
    if (!this.player.takeHit()) return;

    this.tally.hits++;
    this.addTime(-TIME_LOSS.hazard);
    this.flashMessage(`-${TIME_LOSS.hazard}s`, C.danger);
    this.streak = 0;
    sfx.hurt();
    this.cameras.main.shake(220, 0.011);
    this.cameras.main.flash(90, 255, 90, 61, false);

    // Knock the player clear so they cannot sit inside a spike strip.
    this.player.body.velocity.y = -420;
    this.player.body.velocity.x = this.player.facing * -260;
  }

  /** Falling costs the walk back, and nothing else. */
  private onFall(): void {
    if (this.finished) return;
    this.streak = 0;
    sfx.fall();
    this.cameras.main.flash(160, 40, 60, 110);

    // Come back at the safe point nearest to where they went over.
    let best = this.arena.respawns[0]!;
    let bestD = Infinity;
    for (const r of this.arena.respawns) {
      const d = Math.abs(r.x - this.player.x);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    this.player.respawn(best);
  }

  /* ---------------------------------------------------------------------- */
  /* Feedback                                                                */
  /* ---------------------------------------------------------------------- */

  private burst(x: number, y: number, color: number, count: number): void {
    this.particles.setParticleTint(color);
    this.particles.emitParticleAt(x, y, count);
  }

  private popNumber(x: number, y: number, kind: PickupKind): void {
    const value = kind === 'golden' ? `+${TIME_GAIN.golden}s` : `+${TIME_GAIN.clock}s`;
    const color = C.gold;

    const t = this.add
      .text(x, y, value, { fontFamily: FONT, fontSize: '20px', color: hex(color) })
      .setOrigin(0.5)
      .setDepth(30);
    this.world(t);
    this.tweens.add({
      targets: t,
      y: y - 46,
      alpha: 0,
      duration: 620,
      ease: 'Cubic.out',
      onComplete: () => t.destroy(),
    });
  }

  private flashMessage(msg: string, color: number): void {
    const L = layoutOf(this);
    const t = this.add
      .text(L.cx, L.y + L.ih * 0.32, msg, {
        fontFamily: FONT,
        fontSize: `${Math.round(22 * L.ui)}px`,
        color: hex(color),
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(890);
    this.overlay(t);
    this.tweens.add({
      targets: t,
      alpha: 0,
      y: t.y - 30,
      duration: 900,
      ease: 'Cubic.out',
      onComplete: () => t.destroy(),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                   */
  /* ---------------------------------------------------------------------- */

  update(_time: number, delta: number): void {
    if (this.finished) return;

    const intent = this.controls.read();

    // The clock is frozen until the player does something. Nobody should lose
    // a second to reading the screen, and it means the run always begins on the
    // player's terms rather than on a countdown they did not ask for.
    if (!this.started && (intent.moveX !== 0 || intent.grapple)) this.started = true;

    if (this.started) {
      this.timeMs -= delta;

      // The wall clock is still the server's business: a run that has been open
      // absurdly long could not have survived on pickups, and the server would
      // reject it anyway, so end it here rather than let the player keep going.
      // A test run has no server to answer to, so it is never cut short — a
      // builder poking at their own level should be able to take all day.
      const openFor = store.serverNow() - this.run.startedAt;
      if (!this.practice && openFor > MAX_RUN_MS) {
        // The run has been open so long the server will refuse it whatever
        // happens next. Stop here rather than let the player keep trying.
        this.timeMs = 0;
        this.abandon();
        return;
      }
      if (this.timeMs <= 0) {
        this.timeMs = 0;
        this.outOfTime();
        return;
      }
    }

    this.tickWarning(this.timeMs);

    this.player.update(delta, intent, this.arena.anchors);

    this.updateEnemies(delta);
    this.drawRope();
    // The hook icon lights only when the hook could really catch something, so
    // it is told what the arena is offering — the same question the highlight
    // in the world has just answered.
    this.controls.setGrappleState(this.highlightAnchor() !== null, this.player.attached);
    this.pulseGoal();

    // The anchor count changes on a grab, which is nowhere near the code that
    // touches the clock — so it gets refreshed here rather than relying on a
    // pickup happening to land at the same moment.
    if (this.player.anchorsUsed.size !== this.shownAnchors) this.updateHudText();

    if (this.player.y > this.killY) this.onFall();

    this.timer.update(this.timeMs);
    this.controls.tick(this.time.now);
  }

  /**
   * Adds (or removes) seconds.
   *
   * Capped at the starting tank so a lucky pickup run cannot bank an
   * unspendable buffer, and floored at zero because a negative clock is just
   * a finished run.
   */
  private addTime(seconds: number): void {
    this.timeMs = Phaser.Math.Clamp(this.timeMs + seconds * 1000, 0, START_TIME_MS * 2);
    this.updateHudText();
  }

  private tickWarning(remaining: number): void {
    if (remaining > WARNING_MS) return;
    const second = Math.ceil(remaining / 1000);
    if (second !== this.lastTickSecond && second > 0) {
      this.lastTickSecond = second;
      sfx.tick(second <= 3);
      if (second <= 3) this.cameras.main.flash(90, 255, 90, 61, false);
    }
  }

  private updateEnemies(delta: number): void {
    for (const obj of this.enemies.getChildren()) {
      const e = obj as EnemySprite;
      if (!e.active) continue;
      const d = e.cs;
      if (e.x <= d.from && d.dir === -1) {
        d.dir = 1;
        e.setVelocityX(d.speed);
      } else if (e.x >= d.to && d.dir === 1) {
        d.dir = -1;
        e.setVelocityX(-d.speed);
      }
      e.setFlipX(d.dir < 0);

      /**
       * Three motions on top of the frames, none of them large.
       *
       * A steady turn, because a round thing that never rotates reads as a
       * sticker; a buzz across the line it patrols; and a shudder in the angle
       * on top of the turn. Each is small on its own — together they make the
       * thing look like it is straining rather than sliding.
       *
       * The buzz moves it on Y only. Its patrol bounds are tested against X, so
       * jittering that axis would have it turning round early at random.
       */
      const t = this.time.now / 1000 + d.phase * 10;
      e.angle += (delta / 1000) * ENEMY_SPIN;
      e.y = d.baseY + Math.sin(t * ENEMY_BUZZ.rate) * ENEMY_BUZZ.travel;
      e.angle += Math.sin(t * ENEMY_BUZZ.rate * 1.7) * ENEMY_BUZZ.wobble;

      e.glow?.setPosition(e.x, e.y);
    }
  }

  /** The rope, drawn with a slight sag so it reads as a rope and not a laser. */
  private drawRope(): void {
    const g = this.rope;
    g.clear();
    const a = this.player.anchor;
    if (!a) return;

    // Sampled quadratic: the control point hangs below the midpoint, which is
    // what gives the rope its sag. Phaser's Graphics has no curve primitive, so
    // the curve is walked by hand.
    const midX = (a.x + this.player.x) / 2;
    const midY = (a.y + this.player.y) / 2 + 14;

    g.lineStyle(3.5, C.cyan, 0.9);
    g.beginPath();
    g.moveTo(a.x, a.y);
    const STEPS = 12;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const inv = 1 - t;
      const x = inv * inv * a.x + 2 * inv * t * midX + t * t * this.player.x;
      const y = inv * inv * a.y + 2 * inv * t * midY + t * t * this.player.y;
      g.lineTo(x, y);
    }
    g.strokePath();

    g.fillStyle(C.cyan, 1);
    g.fillCircle(a.x, a.y, 6);
  }

  /** Shows which anchor a grapple would take, so the auto-aim is never a guess. */
  private highlightAnchor(): Anchor | null {
    const target = this.player.attached
      ? this.player.anchor
      : this.player.findAnchor(this.arena.anchors);
    for (let i = 0; i < this.anchorSprites.length; i++) {
      const img = this.anchorSprites[i]!;
      const a = this.arena.anchors[i]!;
      const isTarget = target !== null && a.x === target.x && a.y === target.y;
      // Two textures rather than a tint: the lit ring is its own piece of art,
      // and a brightened copy of the dim one would not be the same picture.
      if (this.anchorLit) img.setTexture(isTarget ? ART.anchorLit : TEX.anchor);
      img.setScale(this.anchorScale * (isTarget ? 1.2 : 1));
      img.setAlpha(isTarget ? 1 : 0.55);
    }
    return target;
  }

  /**
   * Under the clock: how much of the arena you have actually flown through.
   *
   * Anchors are what the score pays for besides leftover time, so showing the
   * running count is the only way a player can tell that swinging *more* is
   * worth something.
   */
  private updateHudText(): void {
    const n = this.player?.anchorsUsed.size ?? 0;
    this.shownAnchors = n;
    this.hudScore.setText(n === 1 ? '1 anchor' : `${n} anchors`);
  }

  /* ---------------------------------------------------------------------- */
  /* Flow                                                                    */
  /* ---------------------------------------------------------------------- */

  private pause(): void {
    if (this.finished || this.scene.isPaused()) return;
    this.scene.pause();
    this.scene.launch('cs-pause', {
      from: 'cs-play',
      // Quitting a test drops the builder back where they came from, and calls
      // it what it is: there is no run here to abandon.
      quitTo: this.practice?.returnTo ?? 'cs-menu',
      quitCaption: this.practice ? 'END TEST' : 'ABANDON RUN',
    });
  }

  /** Touched the goal: the run is a success and the clock stops where it is. */
  private onGoal(): void {
    if (this.finished) return;
    this.tally.reachedGoal = true;
    this.tally.msLeft = Math.max(0, Math.round(this.timeMs));
    sfx.victory();
    this.cameras.main.shake(240, 0.009);
    this.cameras.main.flash(200, 61, 255, 160);
    this.flashMessage('GOAL', C.goal);
    this.finish();
  }

  /**
   * The clock hit zero. Straight back in.
   *
   * There is no results screen here on purpose: a failed run scores nothing, so
   * there is nothing to post and nothing to read — a screen would only stand
   * between the player and the retry they already want. The scene restarts from
   * the last armed checkpoint with the clock it recorded, carrying the tally and
   * the anchors, because this is the same attempt resumed rather than a new run.
   */
  private outOfTime(): void {
    if (this.finished) return;
    this.finished = true;

    sfx.fall();
    this.cameras.main.flash(200, 255, 90, 61);
    this.flashMessage(this.resumeAt ? 'BACK TO CHECKPOINT' : 'OUT OF TIME', C.danger);
    this.controls.setVisible(false);

    const resume: Resume = {
      armed: [...this.armed],
      at: this.resumeAt,
      timeMs: this.resumeTimeMs,
      anchors: [...this.player.anchorsUsed],
      tally: { ...this.tally },
    };

    // Just long enough to read the word, and no longer.
    this.cameras.main.fadeOut(220, 7, 11, 22);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      // The arena has to come back round with the restart: a built level is not
      // something `arenaAt` could ever find again.
      this.scene.restart({
        run: this.run,
        resume,
        arena: this.arena,
        practice: this.practice ?? undefined,
      });
    });
  }

  /**
   * The run has outlived what the server will accept, so retrying is pointless.
   * Unlike running out of time, this ends the attempt for good.
   */
  private abandon(): void {
    if (this.finished) return;
    this.tally.reachedGoal = false;
    this.tally.msLeft = 0;
    this.flashMessage('RUN EXPIRED', C.danger);
    this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.tally.anchorsUsed = this.player.anchorsUsed.size;
    this.controls.setVisible(false);
    sfx.runEnd();

    // A test run is never submitted and never scored. It reports one thing —
    // whether the goal was reached and with what clock — to whoever launched it.
    const back = this.practice;
    const result: PracticeResult = {
      clearedMs: this.tally.reachedGoal ? this.tally.msLeft : null,
    };

    this.cameras.main.fadeOut(600, 7, 11, 22);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      if (back) this.scene.start(back.returnTo, { result });
      else this.scene.start('cs-results', { runId: this.run.runId, tally: this.tally });
    });
  }

  private teardown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.controls?.destroy();
    this.anchorSprites = [];
  }
}
