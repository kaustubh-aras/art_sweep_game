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
import { C, FONT, hex } from '@/clockshot/theme';
import { GRAVITY, WARNING_MS } from '@/clockshot/tuning';
import { TEX, bakeTextures } from '@/clockshot/textures';
import { Controls } from '@/clockshot/controls';
import { Player } from '@/clockshot/player';
import { sfx } from '@/clockshot/sfx';
import { store } from '@/clockshot/store';
import { layoutOf } from '@/clockshot/ui';
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
}

type EnemySprite = Phaser.Physics.Arcade.Sprite & { cs: EnemyData };
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
  private hudTimer!: Phaser.GameObjects.Text;
  private hudScore!: Phaser.GameObjects.Text;
  private hudTeam!: Phaser.GameObjects.Text;
  private hudRing!: Phaser.GameObjects.Graphics;
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
    this.cameras.main.setBackgroundColor(C.bg);

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
  private drawBackdrop(): void {
    const { width, height } = this.arena.world;
    const g = this.add.graphics().setDepth(-10);
    g.lineStyle(1, C.grid, 0.55);
    for (let x = 0; x <= width; x += 120) g.lineBetween(x, 0, x, height);
    for (let y = 0; y <= height; y += 120) g.lineBetween(0, y, width, y);
    g.setScrollFactor(0.35);

    // A horizon glow, just to give the void a floor to sit against.
    const glow = this.add.graphics().setDepth(-9).setScrollFactor(0.5);
    glow.fillStyle(C.cyan, 0.05);
    glow.fillRect(0, height - 420, width, 420);
  }

  private buildPlatforms(): void {
    this.platforms = this.physics.add.staticGroup();
    const g = this.add.graphics().setDepth(4);

    for (const r of this.arena.platforms) {
      const c = centreOf(r);
      const body = this.add.rectangle(c.x, c.y, r.w, r.h);
      this.physics.add.existing(body, true);
      this.platforms.add(body);

      g.fillStyle(C.platform, 1);
      g.fillRoundedRect(r.x, r.y, r.w, r.h, 5);
      // A lit top edge tells the player where they can actually stand.
      g.fillStyle(C.platformTop, 1);
      g.fillRect(r.x + 3, r.y, r.w - 6, 4);
    }
  }

  private buildHazards(): void {
    this.hazards = this.physics.add.staticGroup();
    const g = this.add.graphics().setDepth(5);

    for (const r of this.arena.hazards) {
      const c = centreOf(r);
      const body = this.add.rectangle(c.x, c.y, r.w, r.h);
      this.physics.add.existing(body, true);
      this.hazards.add(body);
      this.drawSpikes(g, r);
    }
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
    for (const a of this.arena.anchors) {
      const img = this.add.image(a.x, a.y, TEX.anchor).setDepth(6);
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
    for (const p of patrols) {
      const e = this.enemies.create(p.x, p.y, TEX.enemy) as EnemySprite;
      e.setDepth(12);
      (e.body as Phaser.Physics.Arcade.Body).setAllowGravity(false);
      e.cs = { from: p.from, to: p.to, speed: p.speed, dir: 1 };
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
    this.hudRing = this.add.graphics().setScrollFactor(0).setDepth(880);

    this.hudTimer = this.add
      .text(0, 0, '30.0', { fontFamily: FONT, fontSize: '34px', color: hex(C.gold) })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(882);

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
      this.hudRing,
      this.hudTimer,
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
    this.hudTimer.setPosition(L.cx, L.y + 30 * L.ui).setFontSize(Math.round(30 * L.ui));
    this.hudScore.setPosition(L.cx, L.y + 54 * L.ui).setFontSize(Math.round(17 * L.ui));
    this.hudTeam.setPosition(L.x, L.y + 22 * L.ui).setFontSize(Math.round(12 * L.ui));
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

  private drawHudRing(remainingMs: number): void {
    const L = layoutOf(this);
    const g = this.hudRing;
    g.clear();

    // The pause affordance.
    const pxc = L.x + L.iw - 24 * L.ui;
    const pyc = L.y + 24 * L.ui;
    g.fillStyle(C.panel, 0.85);
    g.fillCircle(pxc, pyc, 20 * L.ui);
    g.lineStyle(1.5, C.panelEdge, 0.8);
    g.strokeCircle(pxc, pyc, 20 * L.ui);
    g.fillStyle(C.ink, 0.85);
    g.fillRect(pxc - 6 * L.ui, pyc - 8 * L.ui, 4 * L.ui, 16 * L.ui);
    g.fillRect(pxc + 2 * L.ui, pyc - 8 * L.ui, 4 * L.ui, 16 * L.ui);

    // The run clock as an arc — colour carries the urgency.
    const frac = Phaser.Math.Clamp(remainingMs / START_TIME_MS, 0, 1);
    const urgent = remainingMs <= WARNING_MS;
    const color = urgent ? C.danger : C.gold;
    const r = 40 * L.ui;
    const cx = L.cx;
    const cy = L.y + 30 * L.ui;

    g.lineStyle(5 * L.ui, C.panelEdge, 0.55);
    g.strokeCircle(cx, cy, r);
    if (frac > 0) {
      g.lineStyle(5 * L.ui, color, 0.95);
      g.beginPath();
      g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2, false);
      g.strokePath();
    }

    this.hudTimer.setColor(hex(color));
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
      scale: 1.7,
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
    this.highlightAnchor();
    this.pulseGoal();

    // The anchor count changes on a grab, which is nowhere near the code that
    // touches the clock — so it gets refreshed here rather than relying on a
    // pickup happening to land at the same moment.
    if (this.player.anchorsUsed.size !== this.shownAnchors) this.updateHudText();

    if (this.player.y > this.killY) this.onFall();

    this.hudTimer.setText((this.timeMs / 1000).toFixed(1));
    this.drawHudRing(this.timeMs);
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
      // A slow wobble so a patrol never looks like a sliding decal.
      e.setAngle(e.angle + (delta / 1000) * 40 * d.dir);
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
  private highlightAnchor(): void {
    const target = this.player.attached
      ? this.player.anchor
      : this.player.findAnchor(this.arena.anchors);
    for (let i = 0; i < this.anchorSprites.length; i++) {
      const img = this.anchorSprites[i]!;
      const a = this.arena.anchors[i]!;
      const isTarget = target !== null && a.x === target.x && a.y === target.y;
      img.setScale(isTarget ? 1.35 : 1);
      img.setAlpha(isTarget ? 1 : 0.55);
    }
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
