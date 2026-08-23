import Phaser from 'phaser';
import {
  ANCHORS,
  HAZARDS,
  KILL_Y,
  PLATFORMS,
  RESPAWNS,
  SPAWN,
  WORLD,
  buildLayout,
  centreOf,
  type Pickup,
  type PickupKind,
  type Rect,
} from '@/clockshot/arena';
import { C, FONT, hex, teamColor } from '@/clockshot/theme';
import { GRAVITY, WARNING_MS } from '@/clockshot/tuning';
import { TEX, bakeTextures } from '@/clockshot/textures';
import { Controls } from '@/clockshot/controls';
import { NO_INTENT, Player } from '@/clockshot/player';
import { sfx } from '@/clockshot/sfx';
import { store } from '@/clockshot/store';
import { layoutOf } from '@/clockshot/ui';
import { RUN_MS, SCORE, type Team } from '@/shared/config';
import { EMPTY_TALLY, type RunStartResponse, type RunTally } from '@/shared/api';

interface EnemyData {
  from: number;
  to: number;
  speed: number;
  dir: 1 | -1;
}

type EnemySprite = Phaser.Physics.Arcade.Sprite & { cs: EnemyData };
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
  /** Null on a first run: the side is chosen on the results screen. */
  private team!: Team | null;

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
  private collected = 0;
  private stolen = 0;
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

  init(data: { run: RunStartResponse }): void {
    this.run = data.run;
    this.team = data.run.team;
    this.tally = { ...EMPTY_TALLY };
    this.collected = 0;
    this.stolen = 0;
    this.streak = 0;
    this.finished = false;
    this.lastTickSecond = -1;
  }

  /* ---------------------------------------------------------------------- */
  /* Build                                                                   */
  /* ---------------------------------------------------------------------- */

  create(): void {
    bakeTextures(this);

    this.physics.world.setBounds(0, 0, WORLD.width, WORLD.height);
    this.physics.world.gravity.y = GRAVITY;
    this.cameras.main.setBounds(0, 0, WORLD.width, WORLD.height);
    this.cameras.main.setBackgroundColor(C.bg);

    this.drawBackdrop();
    this.buildPlatforms();
    this.buildHazards();
    this.buildAnchors();

    const layout = buildLayout(this.run.seed);
    this.buildPickups(layout.pickups);

    this.rope = this.add.graphics().setDepth(18);

    this.player = new Player(this, SPAWN.x, SPAWN.y, this.team);
    this.physics.add.collider(this.player.sprite, this.platforms);

    this.buildEnemies(layout.patrols);
    this.buildParticles();

    this.physics.add.overlap(this.player.sprite, this.pickups, (_p, obj) =>
      this.onPickup(obj as PickupSprite),
    );
    this.physics.add.overlap(this.player.sprite, this.hazards, () => this.onHazard());
    this.physics.add.overlap(this.player.sprite, this.enemies, () => this.onHazard());

    this.cameras.main.startFollow(this.player.sprite, true, 0.11, 0.11);

    this.controls = new Controls(this, () => this.pause());
    this.buildHud();
    this.splitCameras();
    this.relayout();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.teardown, this);

    sfx.runStart();
    this.cameras.main.fadeIn(200, 7, 11, 22);
  }

  /** Parallax grid, so speed is legible against an otherwise empty void. */
  private drawBackdrop(): void {
    const g = this.add.graphics().setDepth(-10);
    g.lineStyle(1, C.grid, 0.55);
    for (let x = 0; x <= WORLD.width; x += 120) g.lineBetween(x, 0, x, WORLD.height);
    for (let y = 0; y <= WORLD.height; y += 120) g.lineBetween(0, y, WORLD.width, y);
    g.setScrollFactor(0.35);

    // A horizon glow in the team's colour keeps whose fight this is on screen.
    // A player who has not chosen yet gets the neutral rope colour instead.
    const glow = this.add.graphics().setDepth(-9).setScrollFactor(0.5);
    glow.fillStyle(this.team ? teamColor(this.team) : C.cyan, 0.05);
    glow.fillRect(0, WORLD.height - 420, WORLD.width, 420);
  }

  private buildPlatforms(): void {
    this.platforms = this.physics.add.staticGroup();
    const g = this.add.graphics().setDepth(4);

    for (const r of PLATFORMS) {
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

    for (const r of HAZARDS) {
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
    for (const a of ANCHORS) {
      const img = this.add.image(a.x, a.y, TEX.anchor).setDepth(6);
      this.anchorSprites.push(img);
    }
  }

  private buildPickups(list: readonly Pickup[]): void {
    this.pickups = this.physics.add.group({ allowGravity: false, immovable: true });

    const texFor: Record<PickupKind, string> = {
      fragment: TEX.fragment,
      golden: TEX.golden,
      enemy: TEX.enemyFrag,
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

    this.hudTeam = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '13px', color: hex(C.dim) })
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
    this.cameras.main.setDeadzone((70 * L.ui) / zoom, (100 * L.ui) / zoom);
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
    const frac = Phaser.Math.Clamp(remainingMs / RUN_MS, 0, 1);
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

    const colorByKind: Record<PickupKind, number> = {
      fragment: C.gold,
      golden: C.gold,
      enemy: C.danger,
    };

    switch (s.kind) {
      case 'fragment':
        this.tally.fragments++;
        this.collected += SCORE.fragment;
        this.streak++;
        sfx.collect(this.streak);
        break;
      case 'golden':
        this.tally.goldenClocks++;
        this.collected += SCORE.goldenClock;
        this.streak++;
        sfx.collectGolden();
        this.cameras.main.shake(180, 0.006);
        this.flashMessage('GOLDEN CLOCK', C.gold);
        break;
      case 'enemy':
        this.tally.enemyFragments++;
        this.stolen += SCORE.enemyFragment;
        sfx.steal();
        this.flashMessage(`-${SCORE.enemyFragment}s STOLEN`, C.danger);
        break;
    }

    this.burst(s.x, s.y, colorByKind[s.kind], s.kind === 'golden' ? 26 : 10);
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
   * Getting hit costs time, not seconds.
   *
   * The knockback, the i-frames and the ruined line are the punishment: they
   * spend the run's scarcest resource, which is the clock. Taking banked
   * seconds away as well is what let a beginner finish a whole run on zero —
   * the single worst thing this game could tell a new player.
   */
  private onHazard(): void {
    if (this.finished) return;
    if (!this.player.takeHit()) return;

    this.streak = 0;
    sfx.hurt();
    this.cameras.main.shake(220, 0.011);
    this.cameras.main.flash(120, 255, 90, 61);

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
    let best = RESPAWNS[0]!;
    let bestD = Infinity;
    for (const r of RESPAWNS) {
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
    const value =
      kind === 'fragment'
        ? `+${SCORE.fragment}`
        : kind === 'golden'
          ? `+${SCORE.goldenClock}`
          : `-${SCORE.enemyFragment}`;
    const color = kind === 'enemy' ? C.danger : C.gold;

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

    // The run clock is the server's. A backgrounded tab does not pause it.
    const elapsed = store.serverNow() - this.run.startedAt;
    const remaining = Math.max(0, RUN_MS - elapsed);

    this.tickWarning(remaining);

    if (remaining <= 0) {
      this.finish();
      return;
    }

    const intent = this.finished ? NO_INTENT : this.controls.read();
    this.player.update(delta, intent, ANCHORS);

    this.updateEnemies(delta);
    this.drawRope();
    this.highlightAnchor();

    if (this.player.y > KILL_Y) this.onFall();

    this.hudTimer.setText((remaining / 1000).toFixed(1));
    this.drawHudRing(remaining);
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
    const target = this.player.attached ? this.player.anchor : this.player.findAnchor(ANCHORS);
    for (let i = 0; i < this.anchorSprites.length; i++) {
      const img = this.anchorSprites[i]!;
      const a = ANCHORS[i]!;
      const isTarget = target !== null && a.x === target.x && a.y === target.y;
      img.setScale(isTarget ? 1.35 : 1);
      img.setAlpha(isTarget ? 1 : 0.55);
    }
  }

  /**
   * One number, not two.
   *
   * Seconds collected and seconds stolen do different things to the two banks,
   * but they do the same thing to the only question a player is asking mid-run
   * — "is my team better off?" — so they are shown as a single total. The split
   * still exists on the wire and on the server; it just is not a thing anyone
   * has to hold in their head while swinging.
   */
  private updateHudText(): void {
    this.hudScore.setText(`+${this.collected + this.stolen}s`);
  }

  /* ---------------------------------------------------------------------- */
  /* Flow                                                                    */
  /* ---------------------------------------------------------------------- */

  private pause(): void {
    if (this.finished || this.scene.isPaused()) return;
    this.scene.pause();
    this.scene.launch('cs-pause', { from: 'cs-play' });
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.controls.setVisible(false);
    sfx.runEnd();
    this.cameras.main.fadeOut(280, 7, 11, 22);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start('cs-results', { runId: this.run.runId, tally: this.tally, team: this.team });
    });
  }

  private teardown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.controls?.destroy();
    this.anchorSprites = [];
  }
}
