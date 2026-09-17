// The game simulation. Implements design §4–§8 of `docs/game-design.md`.
//
// Pure and framework-free: no Phaser, no DOM, no Tauri, and every random draw
// goes through `state.rng`, so a test can drive a whole run deterministically.
// The Phaser scene is a renderer over this, never the other way round.

import {
  DIR_COUNT,
  DIR_VECTORS,
  dirFromVector,
  mirrorDirX,
  mirrorDirY,
  type Dir,
  type GameSnapshot,
  type ItemKind,
  type ItemStats,
  type MonsterKind,
  type MonsterStats,
  type MoveInput,
  type PlayerStats,
  type ProjectileKind,
  type ProjectileStats,
  type RegionConfig,
  type RegionRuntime,
} from "./types";

// ── Tuning (design §11) ─────────────────────────────────────────────────────

export const TUNING = {
  /** Arena size in px; matches the logical canvas in `src/game/config.ts`. */
  width: 960,
  height: 540,

  hp: 100,
  hpSpeed: 1,
  moveSpeed: 160,
  attackPower: 8,
  attackSpeed: 1.5,
  attackRange: 55,

  /** Seconds after the last hit before `hpSpeed` kicks in (design §5.2). */
  regenDelay: 3,

  /**
   * Longest step the sim will take. A paused tab, a dragged window or a slow
   * frame must not teleport monsters through the player on resume.
   */
  maxDt: 0.05,

  /** Difficulty escalation (design §4.3). */
  escalateEvery: 30,
  escalateRespawn: 0.9,
  maxTargetCount: 14,
  minRespawn: 0.8,

  /**
   * Monster HP escalation (design §4.4, requirement 1). Every `monsterHpEvery`
   * seconds survived, a monster spawned from then on carries `monsterHpGrowth`
   * times the HP of one spawned a minute earlier — compounding.
   */
  monsterHpEvery: 60,
  monsterHpGrowth: 1.05,

  /** What a level is worth (design §8.2, requirement 2). */
  levelHpGrowth: 1.05,

  /** Potions (design §8.3, requirement 3). */
  potionGrowth: 1.05,
  /** Fraction of max HP a heal potion pours back in. */
  healPotion: 0.3,
  /**
   * A potion's radius in px — its body, and the radius it is *drawn* at.
   *
   * Not the pickup threshold on its own: collecting is two bodies touching, so
   * the trigger distance is this plus `playerRadius`. See `pickedUp()`.
   */
  pickupRadius: 5,
  /**
   * The player's body radius in px. `GameScene` draws the player at exactly
   * this radius, which is the point: "looks like I stepped on it" and "counts
   * as stepped on it" are the same line, and there is one constant behind both.
   */
  playerRadius: 9,
  /** Seconds a potion lies on the floor before it fades. */
  itemLifetime: 30,
  /** Seconds of blinking before `itemLifetime` runs out. */
  itemFlicker: 10,

  /**
   * Projectiles (design §15). Every attack carries its damage to the impact
   * instead of applying it at the muzzle, so these constants are what make
   * "dodge the shot" a real move rather than decoration — §7's claim that
   * dodging is spatial rests on them being beatable by `moveSpeed`.
   */
  /**
   * The player's shot, and a monster's — deliberately **not** the same speed.
   *
   * The player's attack is automatic (§5.1): they cannot aim, so they cannot
   * compensate for a miss, and a shot that drifts wide is pure loss. A monster's
   * shot missing is the opposite — it is the player's own dodge paying off. So
   * the asymmetry is the point rather than an oversight: 520 crosses the whole
   * 55px `attackRange` in 0.106s, and 280 gives a wanderer's 22px shot 0.079s of
   * flight, in which a player sprinting *perpendicular* at `moveSpeed` covers
   * 12.6px against the 11.5px two-body threshold. Dodgeable — but only by
   * committing to it: at a random angle the lateral component is only ~8px, so
   * moving is not by itself enough.
   */
  bulletSpeed: 520,
  monsterBulletSpeed: 280,
  /**
   * Px a bullet may travel before it fizzles — 2× the player's `attackRange`,
   * and 3.2× the brute's, so a target fleeing directly away is still caught
   * while a stray shot dies close to where it was aimed instead of crossing the
   * arena to hit a stranger.
   *
   * That second half used to be argued from the region: a shot died "inside the
   * region it was fired in". Regions stopped bounding anything when the leash
   * came out (§6.2), and the range does not depend on them — it is simply short
   * against the 960px arena.
   */
  bulletRange: 110,
  /**
   * A bullet's radius in px — its body, **and the radius it is drawn at**, on
   * the same terms as `pickupRadius`. Hitting is two bodies touching (§8.4's
   * rule), so the threshold against a target is this plus the target's radius:
   * 11.5px against the player.
   */
  bulletRadius: 2.5,
  /**
   * Seconds a bomb is in the air. The bomb lands on the spot the player stood on
   * when it was thrown, exactly this long later, so its speed is derived from
   * the distance rather than fixed: what stays constant is the *warning*.
   *
   * **The escape rule, stated once so these constants can be checked against
   * it.** A player standing in the landing circle has to cover
   * `bombBlast + playerRadius` to be clear of it, and one who breaks into a run
   * the moment the bomb leaves the brute's hand covers `moveSpeed × bombFuse`.
   * Those two numbers are the whole balance of the mechanic, and the margin
   * between them has to be worth more than a single step: `dt` is clamped to
   * `maxDt`, so at 20fps a step is `moveSpeed × maxDt` = 8px of travel. A margin
   * under 8px means hesitating for one frame is fatal and the "dodge window" is
   * only open to someone who was already running — which is not a dodge.
   *
   * `160 × 0.4` = 64px against `32 + 9` = 41px leaves 23px, ~3 steps of grace at
   * the slowest timestep and ~0.14s at 60fps. 0.3s left only 7px, and was
   * measured to be undodgeable at `maxDt` for anyone who reacted a step late.
   * Why the brute's shot is the *slow* one is in §15: a constant fuse is a
   * constant warning, and only a slow attacker needs one.
   */
  bombFuse: 0.4,
  /**
   * Blast radius in px, measured from the landing point — and the radius of the
   * reticle drawn on the ground there, since a warning circle that lied about
   * its own size would be worse than no warning at all.
   */
  bombBlast: 32,
  /**
   * Hard cap on shots in flight. Purely defensive — every archetype's flight is
   * shorter than its own attack interval, so each monster has at most one shot
   * in the air, and nothing in the current balance comes near this — it just
   * stops a future change from growing the array without bound.
   */
  maxProjectiles: 128,

  /** Wander behaviour for monsters that have not sensed the player. */
  wanderSpeedScale: 0.45,
  wanderMinSeconds: 1,
  wanderMaxSeconds: 3.5,
  /**
   * Keeps wanderers off the arena's edge, so a drifting monster stays a body on
   * screen rather than a sliver clipped by the wall.
   *
   * The one pad that is *not* applied is the chasing monster's — see the chase
   * clamp in `stepSim`, which uses the same bounds as the player.
   */
  arenaPad: 14,
  spawnPad: 18,
} as const;

export interface MonsterArchetype {
  hp: number;
  moveSpeed: number;
  attackPower: number;
  attackSpeed: number;
  attackRange: number;
  /** `m_range` — the perception radius. */
  senseRange: number;
  xp: number;
  /**
   * Body radius in px — and the radius `GameScene` draws this kind at.
   *
   * Owned here rather than in the renderer because the projectile hit test needs
   * it, and §10.3's rule is that the drawn radius *is* the judged radius. A
   * radius the sim cannot see is a radius the two are free to disagree about,
   * which is exactly the drift §8.4 records being bitten by.
   */
  radius: number;
  /** Which shot this kind fires (design §15). See `MONSTER_ARCHETYPES`. */
  projectile: ProjectileKind;
}

/** Per-kind stats (design §6). */
export const MONSTER_ARCHETYPES: Record<MonsterKind, MonsterArchetype> = {
  wanderer: {
    hp: 20,
    moveSpeed: 50,
    attackPower: 5,
    attackSpeed: 0.8,
    attackRange: 22,
    senseRange: 140,
    xp: 10,
    radius: 6,
    projectile: "bullet",
  },
  hunter: {
    hp: 35,
    moveSpeed: 120,
    attackPower: 8,
    attackSpeed: 1.2,
    attackRange: 26,
    senseRange: 260,
    xp: 20,
    radius: 7,
    projectile: "bullet",
  },
  brute: {
    hp: 90,
    moveSpeed: 40,
    attackPower: 18,
    attackSpeed: 0.6,
    attackRange: 34,
    // Short sight, huge damage: walking around this circle is the core tactic.
    senseRange: 110,
    xp: 40,
    radius: 11,
    // Slow and heavy, so its shot is the arcing one: a bomb that lands where the
    // player *was* is the slow attacker's answer to a target who keeps moving,
    // and the reticle it paints is what makes that answer fair (design §15).
    projectile: "bomb",
  },
};

/** XP needed to advance *from* `level`. */
export const xpForNext = (level: number): number => 100 * level;

/**
 * Monster HP escalation factor at `time` seconds into a run (design §4.4).
 *
 * Derived from the survival clock rather than carried in a field: it is a pure
 * function of `time`, so there is no second piece of state to keep in sync with
 * the clock, and a test can state the expected factor without stepping the sim.
 */
export function monsterHpMul(time: number): number {
  return TUNING.monsterHpGrowth ** Math.floor(time / TUNING.monsterHpEvery);
}

/** The four potions, in a fixed order — the drop roll and the HUD both walk it. */
export const ITEM_KINDS: readonly ItemKind[] = ["heal", "power", "agility", "vitality"];

/**
 * Per-kill drop chance, one **independent** roll per kind (design §8.3).
 *
 * Independent rather than a weighted pick from a 100% table, which is the
 * user's call and changes what the numbers mean: a kill can now drop nothing
 * at all (~52%, the product of the four complements) or, rarely, two things at
 * once. `heal` is the common one because it is the only potion that does
 * nothing permanent; `vitality` is the rarest because its +5% compounds for the
 * rest of the run.
 */
export const DROP_CHANCE: Record<ItemKind, number> = {
  heal: 0.22,
  power: 0.14,
  agility: 0.14,
  vitality: 0.09,
};

/**
 * What one kill leaves behind: anywhere from nothing to all four.
 *
 * Consumes exactly `ITEM_KINDS.length` draws **whatever the outcome**. That is
 * deliberate and load-bearing for the tests: the rng stream advances by a fixed
 * amount per kill, so a seeded run stays reproducible no matter what dropped.
 */
export function rollDrops(rng: () => number): ItemKind[] {
  const out: ItemKind[] = [];
  for (const kind of ITEM_KINDS) {
    if (rng() < DROP_CHANCE[kind]) out.push(kind);
  }
  return out;
}

// ── State ───────────────────────────────────────────────────────────────────

export interface SimState {
  width: number;
  height: number;
  player: PlayerStats;
  monsters: MonsterStats[];
  /** Potions on the floor, waiting to be walked over (design §8.3). */
  items: ItemStats[];
  /**
   * Shots in flight — bullets and bombs alike, told apart by `kind` (design §15).
   *
   * Not key material and so not in `GameSnapshot`: a shot moves the world only
   * by landing on it, through stats `V` already carries.
   */
  projectiles: ProjectileStats[];
  /** How many of each potion has been picked up this run — HUD only. */
  pickups: Record<ItemKind, number>;
  configs: RegionConfig[];
  regions: RegionRuntime[];

  /** Seconds survived this run — the score (design §1, requirement 6). */
  time: number;
  kills: number;
  level: number;
  xp: number;
  /** False once `hp` hits 0; the run is over and `step` becomes a no-op. */
  alive: boolean;

  /**
   * Simulation steps so far — a plain step counter, and a probe for "did the
   * sim actually advance?".
   *
   * It used to feed `V[0]`, forcing the key to move even in an empty corner.
   * That byte is gone: the key is now a pure function of the world, so a world
   * standing still is *supposed* to stop producing keys.
   */
  tick: number;
  /** Seconds until the player may swing again. */
  attackCooldown: number;
  /** Seconds since the player last took damage. */
  sinceDamage: number;

  escalationTimer: number;
  nextId: number;
  rng: () => number;
}

export interface SimOptions {
  width?: number;
  height?: number;
  /** Injectable for deterministic tests. */
  rng?: () => number;
}

// ── Construction ────────────────────────────────────────────────────────────

/**
 * The 3x3 region grid (design §4.1). It is a **spawn partition**: each region
 * owns a target population, a respawn interval and an archetype mix, so the
 * map's density and rhythm are spatially graded and "where do I stand" is a real
 * decision rather than a decoration.
 *
 * It is *not* a set of walls. Monsters are free to leave — the leash was removed
 * deliberately (§6.2) — so a tier's numbers describe where its monsters are
 * **born**, which over a long run is only loosely where they will be found.
 */
export function buildRegions(width: number, height: number): RegionConfig[] {
  const cw = width / 3;
  const ch = height / 3;
  const out: RegionConfig[] = [];

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const centre = row === 1 && col === 1;
      const corner = row !== 1 && col !== 1;
      const tier = centre ? "center" : corner ? "corner" : "edge";

      out.push({
        index: row * 3 + col,
        tier,
        x: col * cw,
        y: row * ch,
        w: cw,
        h: ch,
        targetCount: centre ? 6 : corner ? 2 : 4,
        respawnSeconds: centre ? 2.5 : corner ? 6 : 4,
        kinds: centre
          ? (["brute", "hunter"] as const)
          : corner
            ? (["wanderer"] as const)
            : (["wanderer", "hunter"] as const),
      });
    }
  }
  return out;
}

function spawnMonster(s: SimState, cfg: RegionConfig, kind: MonsterKind): MonsterStats {
  const arch = MONSTER_ARCHETYPES[kind];
  const pad = TUNING.spawnPad;
  // Requirement 1: the arena gets tougher on a clock. Applied here, at the
  // moment of spawning, rather than retro-fitted onto monsters already on the
  // floor — a monster whose bar grew while the player was hitting it reads as a
  // bug, not as difficulty. Nothing is lost by it: a region turns its whole
  // population over in 2.5-6s, so within a minute essentially every monster on
  // screen was spawned under the new factor anyway.
  const hp = arch.hp * monsterHpMul(s.time);
  const m: MonsterStats = {
    id: s.nextId++,
    kind,
    dir: Math.floor(s.rng() * DIR_COUNT) as Dir,
    moveSpeed: arch.moveSpeed,
    attackSpeed: arch.attackSpeed,
    attackPower: arch.attackPower,
    attackRange: arch.attackRange,
    senseRange: arch.senseRange,
    hp,
    maxHp: hp,
    posX: cfg.x + pad + s.rng() * Math.max(1, cfg.w - pad * 2),
    posY: cfg.y + pad + s.rng() * Math.max(1, cfg.h - pad * 2),
    // Stagger the first swing so a freshly populated region doesn't volley.
    attackCooldown: s.rng() / arch.attackSpeed,
    region: cfg.index,
    attacking: false,
    wanderTimer: s.rng() * TUNING.wanderMaxSeconds,
  };
  s.monsters.push(m);
  return m;
}

/** A fresh run. Regions start at their target count so the map is never empty. */
export function createSim(opts: SimOptions = {}): SimState {
  const width = opts.width ?? TUNING.width;
  const height = opts.height ?? TUNING.height;
  const configs = buildRegions(width, height);

  const s: SimState = {
    width,
    height,
    player: {
      dir: 0,
      moveSpeed: TUNING.moveSpeed,
      attackSpeed: TUNING.attackSpeed,
      attackPower: TUNING.attackPower,
      attackRange: TUNING.attackRange,
      hp: TUNING.hp,
      maxHp: TUNING.hp,
      hpSpeed: TUNING.hpSpeed,
      // Spawn in the middle of a corner region — the thinnest, slowest-refilling
      // tier, which is where a run should start (design §4.1). It is no longer a
      // *safe* corner, only a quiet one: see §6.2.
      posX: configs[0].x + configs[0].w / 2,
      posY: configs[0].y + configs[0].h / 2,
    },
    monsters: [],
    items: [],
    projectiles: [],
    pickups: { heal: 0, power: 0, agility: 0, vitality: 0 },
    configs,
    regions: configs.map((config): RegionRuntime => ({ config, pending: [] })),
    time: 0,
    kills: 0,
    level: 1,
    xp: 0,
    alive: true,
    tick: 0,
    attackCooldown: 0,
    sinceDamage: TUNING.regenDelay,
    escalationTimer: 0,
    nextId: 1,
    rng: opts.rng ?? Math.random,
  };

  for (const cfg of configs) {
    for (let i = 0; i < cfg.targetCount; i++) {
      spawnMonster(s, cfg, cfg.kinds[Math.floor(s.rng() * cfg.kinds.length)]);
    }
  }
  return s;
}

// ── Queries ─────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Region index containing `(x, y)`, given the arena size.
 *
 * Exported on its own because `robot.ts` asks the same question about positions
 * the player is *not* standing on — every candidate step it weighs — and a
 * second copy of this arithmetic is exactly the kind of thing that drifts out of
 * sync with the walls it is supposed to describe.
 */
export function regionIndexAtPoint(width: number, height: number, x: number, y: number): number {
  const col = clamp(Math.floor(x / (width / 3)), 0, 2);
  const row = clamp(Math.floor(y / (height / 3)), 0, 2);
  return row * 3 + col;
}

/** Region index containing `(x, y)`. */
export function regionIndexAt(s: SimState, x: number, y: number): number {
  return regionIndexAtPoint(s.width, s.height, x, y);
}

/**
 * Live monsters whose *home* is `region`.
 *
 * It counts by **home**, not by where a monster is standing, and since the leash
 * was removed (§6.2) those are no longer the same number: a region at its target
 * count can have few or no monsters physically inside it. That is correct here,
 * because the question this answers is the spawn budget's — "does this region
 * still own its quota of living monsters?" — and not "how crowded does this
 * region look?". A monster that wandered off and died elsewhere still respawns
 * in its home region, so the ledger stays balanced either way.
 */
function countInRegion(s: SimState, region: number): number {
  let n = 0;
  for (const m of s.monsters) if (m.region === region) n++;
  return n;
}

/**
 * Distance from `(px, py)` to the segment `(ax, ay)`–`(bx, by)`.
 *
 * A body that did not move this step degenerates its segment to the point it is
 * standing on, which this handles rather than dividing by zero.
 *
 * Shared by collection and by projectile hits, because both are the same
 * question — "did this path reach that body?" — and both would be wrong the same
 * way without it. See `pickedUp` for the bug that put it here.
 */
function segDistToPoint(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/**
 * Did the player's path this step pass close enough to `it` to collect it?
 *
 * Two bodies **touching**, not the player's centre landing inside the potion:
 * the threshold is `playerRadius + pickupRadius` (design §8.4). Testing only
 * the centre against the potion's own 5px left a dead band — from 5px out to
 * the 14px where the two discs actually meet — in which the player was drawn
 * standing square on top of a potion that the rule insisted they had not
 * reached. Worse, that band is where a player *moving* almost always is: they
 * steer with the eight directions, so they sweep past rather than thread the
 * needle, and the potion only ever popped once they stopped and jiggled the
 * centre into the last 5px. §8.3 makes "walk over there" the cost of a drop;
 * it must not also cost pixel-perfect alignment.
 *
 * Point-to-**segment**, not point-to-endpoint. `dt` is clamped to `maxDt`, but
 * that is still ~8px of travel on a slow frame and agility potions compound,
 * so a fast player covers more ground in a single step than the trigger
 * distance. Testing only where they ended up would let them walk clean over a
 * potion and leave it lying there.
 */
function pickedUp(it: ItemStats, fromX: number, fromY: number, toX: number, toY: number): boolean {
  const reach = TUNING.playerRadius + TUNING.pickupRadius;
  return segDistToPoint(it.posX, it.posY, fromX, fromY, toX, toY) <= reach;
}

function nearestMonster(s: SimState, x: number, y: number, maxDist: number): MonsterStats | null {
  const limit = maxDist * maxDist;
  let best: MonsterStats | null = null;
  let bestD2 = Infinity;
  for (const m of s.monsters) {
    const d2 = (m.posX - x) ** 2 + (m.posY - y) ** 2;
    if (d2 > limit) continue;
    // `id` breaks ties so the choice is stable frame to frame.
    if (best === null || d2 < bestD2 || (d2 === bestD2 && m.id < best.id)) {
      best = m;
      bestD2 = d2;
    }
  }
  return best;
}

/**
 * The monster a shot's path passed through this step, if any.
 *
 * Swept rather than sampled, for the reason `pickedUp` is: a bullet covers
 * `bulletSpeed × maxDt` = 26px in a single step, which is wider than every
 * monster's body, so testing only where the shot *ended up* would let it pass
 * clean through a monster between two frames. The margin is real rather than
 * theoretical — a target 12px away is missed by an endpoint test and hit by
 * this one, and that is a distance a monster chasing into the player's face
 * reaches routinely.
 *
 * A monster's own shot cannot tunnel the same way: `monsterBulletSpeed × maxDt`
 * is 14px against the player's 11.5px two-body threshold, so no step is wide
 * enough for the player's body to fit between its endpoints. The sweep on that
 * side is symmetry, not a fix.
 *
 * The first body along the path wins, not the nearest to where the shot
 * stopped — a shot stops where it hits, so the earliest crossing is the one it
 * would have reached first. `id` breaks ties so the choice is stable.
 */
function monsterOnSegment(
  s: SimState,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): MonsterStats | null {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const len2 = dx * dx + dy * dy;
  let best: MonsterStats | null = null;
  let bestT = Infinity;

  for (const m of s.monsters) {
    const reach = MONSTER_ARCHETYPES[m.kind].radius + TUNING.bulletRadius;
    const t = len2 > 0 ? clamp(((m.posX - fromX) * dx + (m.posY - fromY) * dy) / len2, 0, 1) : 0;
    if (Math.hypot(m.posX - (fromX + dx * t), m.posY - (fromY + dy * t)) > reach) continue;
    if (best === null || t < bestT || (t === bestT && m.id < best.id)) {
      best = m;
      bestT = t;
    }
  }
  return best;
}

// ── Mutations ───────────────────────────────────────────────────────────────

function damagePlayer(s: SimState, amount: number): void {
  s.player.hp -= amount;
  s.sinceDamage = 0;
  if (s.player.hp <= 0) {
    s.player.hp = 0;
    s.alive = false;
  }
}

/**
 * Launch a shot from `(fromX, fromY)` at where `(atX, atY)` is *right now*
 * (design §15).
 *
 * No lead and no homing, deliberately. The rule the design settled on is that a
 * target who moves out of the way is missed, so aiming has to be a fixed guess
 * made at the muzzle rather than a promise the shot keeps — a homing shot would
 * quietly restore the guaranteed hit that hit-scan used to give, and there would
 * be nothing left to dodge. Aiming *is* continuous (a float vector, not one of
 * the 8 `Dir`s): the line to the nearest monster is almost never a compass
 * direction, and rounding it would turn a 55px shot into a miss by up to 21px.
 *
 * Consumes **no** rng. That is load-bearing: the seeded runs in `tests/` depend
 * on the stream advancing by exactly as much as it did before shots existed, so
 * a shot may not draw for spread, jitter or anything else. Any randomness a
 * reader wants here belongs in the renderer, which is where all the existing
 * particle jitter already lives.
 */
function fire(
  s: SimState,
  fromPlayer: boolean,
  kind: ProjectileKind,
  fromX: number,
  fromY: number,
  atX: number,
  atY: number,
  damage: number,
): void {
  if (s.projectiles.length >= TUNING.maxProjectiles) return;

  const dx = atX - fromX;
  const dy = atY - fromY;
  const len = Math.hypot(dx, dy);
  // A target standing exactly on the muzzle gives no direction to aim along.
  // Fire due east rather than dividing by zero: the shot still exists, still
  // travels and still expires, so nothing downstream has to special-case it.
  const ux = len > 0 ? dx / len : 1;
  const uy = len > 0 ? dy / len : 0;

  const bomb = kind === "bomb";
  // A bomb owes the player a *constant warning*: it lands on the spot they stood
  // on when it was thrown, exactly `bombFuse` later, so its speed has to follow
  // the distance. A bullet flies at a fixed speed instead and simply expires if
  // it never catches anything — at the shooter's own speed, which is not the
  // same for the two sides (see `TUNING.bulletSpeed`).
  const speed = bomb
    ? len > 0
      ? len / TUNING.bombFuse
      : 0
    : fromPlayer
      ? TUNING.bulletSpeed
      : TUNING.monsterBulletSpeed;

  s.projectiles.push({
    id: s.nextId++,
    kind,
    fromPlayer,
    posX: fromX,
    posY: fromY,
    vx: ux * speed,
    vy: uy * speed,
    damage,
    // A bullet expires on distance; a bomb expires on its fuse, and its `range`
    // is only a record of how far it was thrown.
    range: bomb ? len : TUNING.bulletRange,
    fuse: bomb ? TUNING.bombFuse : 0,
    blast: bomb ? TUNING.bombBlast : 0,
  });
}

/**
 * Where a bomb is going to land: the point the reticle is drawn on, the point
 * the robot treats as dangerous, and the point the blast is finally tested from
 * (design §15). One function because those three have to be the same point.
 *
 * A pure identity rather than a stored field. `fire` derives a bomb's speed as
 * `distance / bombFuse`, so `pos + v × fuse` is the aim point at *any* moment of
 * the flight, whatever the fuse was set to — the bomb converges on it, which is
 * also why a bomb thrown at a running player still lands where they *were*.
 */
export function bombLanding(b: ProjectileStats): { x: number; y: number } {
  return { x: b.posX + b.vx * b.fuse, y: b.posY + b.vy * b.fuse };
}

/**
 * What a level is worth (design §8.2, requirement 2): a bigger life bar, and
 * nothing else.
 *
 * Attack power, attack speed and move speed deliberately do **not** grow here.
 * A level used to raise all of them, which would have made every potion a
 * slower-acting level-up — the drop table only means something if the floor is
 * where combat strength comes from. Note also that the *current* hp is left
 * alone: a level raises the ceiling, and filling the bar back up is what the
 * heal potion is for.
 */
function applyLevelUp(p: PlayerStats): void {
  p.maxHp *= TUNING.levelHpGrowth;
}

/**
 * Pour a potion into the player (design §8.3, requirement 3).
 *
 * The four effects are the whole reward economy, so each one is stated once,
 * here, and nothing else in the sim touches these stats mid-run.
 */
function applyItem(s: SimState, kind: ItemKind): void {
  const p = s.player;
  s.pickups[kind]++;

  switch (kind) {
    case "heal":
      // 30% of the max, capped: a surplus is spilled, not banked.
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * TUNING.healPotion);
      break;
    case "power":
      p.attackPower *= TUNING.potionGrowth;
      p.attackSpeed *= TUNING.potionGrowth;
      break;
    case "agility":
      p.moveSpeed *= TUNING.potionGrowth;
      break;
    case "vitality":
      // The ceiling moves, the current hp does not — that is exactly what
      // separates this from the heal potion, and why both exist.
      p.maxHp *= TUNING.potionGrowth;
      break;
    default: {
      // Exhaustiveness: a fifth potion must be given an effect, not silently
      // dropped by the switch.
      const never: never = kind;
      throw new Error(`unhandled item kind: ${String(never)}`);
    }
  }
}

/** Drop what a kill leaves behind, spread so two potions don't stack. */
function dropLoot(s: SimState, m: MonsterStats): void {
  const kinds = rollDrops(s.rng);
  for (let i = 0; i < kinds.length; i++) {
    // One potion lands exactly where the monster fell; several are spread on a
    // small ring, since two items at identical coordinates are one item as far
    // as the player can see (and only the nearer would ever be picked up first).
    const a = kinds.length > 1 ? (i / kinds.length) * Math.PI * 2 : 0;
    const r = kinds.length > 1 ? 11 : 0;
    s.items.push({
      id: s.nextId++,
      kind: kinds[i],
      posX: clamp(m.posX + Math.cos(a) * r, 0, s.width),
      posY: clamp(m.posY + Math.sin(a) * r, 0, s.height),
      life: TUNING.itemLifetime,
    });
  }
}

function killMonster(s: SimState, m: MonsterStats): void {
  const idx = s.monsters.indexOf(m);
  if (idx < 0) return;
  s.monsters.splice(idx, 1);

  const arch = MONSTER_ARCHETYPES[m.kind];
  s.kills++;
  s.xp += arch.xp;
  while (s.xp >= xpForNext(s.level)) {
    s.xp -= xpForNext(s.level);
    s.level++;
    applyLevelUp(s.player);
  }

  // Requirement 3: a kill leaves potions on the floor, where the monster died
  // rather than where the player is standing. Combat happens at the edge of
  // `attackRange`, so this is what turns "kill" into "and now go and get it".
  dropLoot(s, m);

  // Respawn after this region's delay, in this region (requirement: "杀死后 n
  // 秒后刷新出来", per-region and independent).
  s.regions[m.region].pending.push({
    seconds: s.configs[m.region].respawnSeconds,
    kind: m.kind,
  });
}

/**
 * Drift across the arena, bouncing off its walls.
 *
 * It used to drift inside the monster's home region (§6.2's leash). Regions are
 * a spawn partition and nothing else now, so the only bound left is the arena
 * itself — and a monster that has lost the player wanders from wherever it lost
 * them. There is deliberately no walk home: see §6.2 for what that costs.
 */
function wander(s: SimState, m: MonsterStats, dt: number): void {
  m.wanderTimer -= dt;
  if (m.wanderTimer <= 0) {
    m.wanderTimer =
      TUNING.wanderMinSeconds + s.rng() * (TUNING.wanderMaxSeconds - TUNING.wanderMinSeconds);
    m.dir = Math.floor(s.rng() * DIR_COUNT) as Dir;
  }

  const [vx, vy] = DIR_VECTORS[m.dir];
  const pad = TUNING.arenaPad;
  const minX = pad;
  const maxX = s.width - pad;
  const minY = pad;
  const maxY = s.height - pad;

  let nx = m.posX + vx * m.moveSpeed * TUNING.wanderSpeedScale * dt;
  let ny = m.posY + vy * m.moveSpeed * TUNING.wanderSpeedScale * dt;

  if (nx < minX || nx > maxX) {
    nx = clamp(nx, minX, maxX);
    m.dir = mirrorDirX(m.dir);
  }
  if (ny < minY || ny > maxY) {
    ny = clamp(ny, minY, maxY);
    m.dir = mirrorDirY(m.dir);
  }
  m.posX = nx;
  m.posY = ny;
}

/**
 * Advance the run by `dtRaw` seconds.
 *
 * A no-op once the player is dead — the scene keeps rendering the final frame,
 * but the simulation (and with it the survival clock) is over.
 */
export function stepSim(s: SimState, input: MoveInput, dtRaw: number): void {
  if (!s.alive) return;
  const dt = Math.min(Math.max(dtRaw, 0), TUNING.maxDt);

  s.time += dt;
  s.tick++;
  const p = s.player;

  // ── Difficulty escalation (design §4.3) ──────────────────────────────────
  s.escalationTimer += dt;
  while (s.escalationTimer >= TUNING.escalateEvery) {
    s.escalationTimer -= TUNING.escalateEvery;
    for (const cfg of s.configs) {
      cfg.targetCount = Math.min(cfg.targetCount + 1, TUNING.maxTargetCount);
      cfg.respawnSeconds = Math.max(cfg.respawnSeconds * TUNING.escalateRespawn, TUNING.minRespawn);
    }
  }

  // ── Player ───────────────────────────────────────────────────────────────
  // Where the player stood before moving, kept for the pickup test below.
  const fromX = p.posX;
  const fromY = p.posY;
  if (input.dx !== 0 || input.dy !== 0) {
    p.dir = dirFromVector(input.dx, input.dy);
    // Normalised, so `moveSpeed` is a *speed* in every direction rather than
    // only along the axes. Without this a diagonal moved `√2 × moveSpeed` —
    // measured at 226.3 px/s against a stated 160 — because the two components
    // were scaled independently. Monsters already move along unit `DIR_VECTORS`,
    // so this also puts the player on the same footing as everything else in the
    // arena, and the displacement now matches `p.dir` exactly.
    const len = Math.hypot(input.dx, input.dy);
    p.posX = clamp(p.posX + (input.dx / len) * p.moveSpeed * dt, 0, s.width);
    p.posY = clamp(p.posY + (input.dy / len) * p.moveSpeed * dt, 0, s.height);
  }

  // ── Potions on the floor (design §8.3) ───────────────────────────────────
  // The order inside this loop — age first, then collect — is load-bearing for
  // the renderer. It means an item can only ever expire on the step where its
  // *previously observed* `life` was already ≤ dt, which is how the scene tells
  // a pickup from a fade without guessing from distance (see `GameScene.observe`).
  // Reverse index, because the loop splices.
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    it.life -= dt;
    if (it.life <= 0) {
      s.items.splice(i, 1);
      continue;
    }
    if (pickedUp(it, fromX, fromY, p.posX, p.posY)) {
      s.items.splice(i, 1);
      applyItem(s, it.kind);
    }
  }

  s.sinceDamage += dt;
  if (s.sinceDamage >= TUNING.regenDelay && p.hp < p.maxHp) {
    p.hp = Math.min(p.maxHp, p.hp + p.hpSpeed * dt);
  }

  // Player → monster auto-attack (design §5.1). The cooldown only resets on a
  // swing, so an idle player is always ready for the next thing that walks in.
  s.attackCooldown -= dt;
  if (s.attackCooldown <= 0) {
    const target = nearestMonster(s, p.posX, p.posY, p.attackRange);
    if (target) {
      // Aimed at where the target stands *now*, so the shot can be walked out of
      // — that is §7's second dodge window made real (design §15). The cooldown
      // still paces the swing; what the swing *lands* is no longer guaranteed
      // the instant it is thrown.
      fire(s, true, "bullet", p.posX, p.posY, target.posX, target.posY, p.attackPower);
      s.attackCooldown = 1 / p.attackSpeed;
    }
  }

  // ── Monsters ─────────────────────────────────────────────────────────────
  // Nothing in this loop removes a monster — the only thing that does now is a
  // player's bullet, and that runs in the projectile phase below — so iterating
  // `s.monsters` directly is safe.
  for (const m of s.monsters) {
    const dx = p.posX - m.posX;
    const dy = p.posY - m.posY;
    const dist = Math.hypot(dx, dy);

    m.attackCooldown -= dt;
    // One condition, and the region is deliberately not part of it. A monster
    // fights whatever it can see, wherever it can see it — a hunter's 260px
    // sense reaches from the edge region into the corner next door, so a corner
    // is no longer a place a chaser cannot follow you into (§6.2).
    m.attacking = dist <= m.senseRange;

    if (!m.attacking) {
      wander(s, m, dt);
      continue;
    }

    m.dir = dirFromVector(dx, dy);
    const [vx, vy] = DIR_VECTORS[m.dir];
    // Close in, but stop short of standing inside the player. The clamp is the
    // **arena**, on exactly the player's own bounds — not a padded box, and not
    // a region. A pad here would stop a chaser short of a player standing on the
    // wall, which reads as a broken hitbox; the region version of this clamp is
    // what used to make a border a way to break aggro (§6.2). Aggro now breaks
    // only by outrunning `senseRange`.
    if (dist > m.attackRange * 0.7) {
      m.posX = clamp(m.posX + vx * m.moveSpeed * dt, 0, s.width);
      m.posY = clamp(m.posY + vy * m.moveSpeed * dt, 0, s.height);
    }
    if (dist <= m.attackRange && m.attackCooldown <= 0) {
      // Which shot this is, is an archetype property (design §15): the wanderer
      // and the hunter fire, the brute lobs. The cooldown now paces the *throw*
      // rather than the wound — the damage arrives with the projectile, in the
      // phase below, which is also why this loop can no longer end the run and
      // no longer has to guard for it.
      fire(
        s,
        false,
        MONSTER_ARCHETYPES[m.kind].projectile,
        m.posX,
        m.posY,
        p.posX,
        p.posY,
        m.attackPower,
      );
      m.attackCooldown = 1 / m.attackSpeed;
    }
  }

  // ── Projectiles (design §15) ─────────────────────────────────────────────
  // After the shooters have had their turn, so a shot thrown this step also
  // travels this step; before the respawns, which stay last as they always have.
  //
  // Reverse index, because the loop splices. Killing a monster splices
  // `s.monsters` from inside a loop over `s.projectiles`, which is safe — the
  // monster loop above has already finished, so nothing else is walking it.
  for (let i = s.projectiles.length - 1; i >= 0; i--) {
    const b = s.projectiles[i];
    const fromX = b.posX;
    const fromY = b.posY;
    b.posX += b.vx * dt;
    b.posY += b.vy * dt;

    if (b.kind === "bomb") {
      // A bomb is on a fuse, not a distance: it detonates on its landing point,
      // and `range` is only a record of how far that was.
      b.fuse -= dt;
      if (b.fuse > 0) continue;
      s.projectiles.splice(i, 1);
      // Where the player is when it goes off is what counts — the reticle on the
      // ground says exactly this circle, and the step is 8px against a 32px
      // blast, so there is no room for the swept test the bullet needs.
      if (Math.hypot(p.posX - b.posX, p.posY - b.posY) <= b.blast + TUNING.playerRadius) {
        damagePlayer(s, b.damage);
        if (!s.alive) return; // dead mid-loop: stop simulating this step
      }
      continue;
    }

    b.range -= Math.hypot(b.vx, b.vy) * dt;

    if (b.fromPlayer) {
      const hit = monsterOnSegment(s, fromX, fromY, b.posX, b.posY);
      if (hit) {
        s.projectiles.splice(i, 1);
        hit.hp -= b.damage;
        if (hit.hp <= 0) killMonster(s, hit);
        continue;
      }
    } else if (
      segDistToPoint(p.posX, p.posY, fromX, fromY, b.posX, b.posY) <=
      TUNING.playerRadius + TUNING.bulletRadius
    ) {
      // The shot reached the player's body — two discs touching, the same rule
      // collection uses (§8.4), which is what keeps "drawn radius" and "judged
      // radius" the same line on both sides of the arena.
      s.projectiles.splice(i, 1);
      damagePlayer(s, b.damage);
      if (!s.alive) return;
    }

    if (b.range <= 0) s.projectiles.splice(i, 1);
  }

  // ── Respawns ─────────────────────────────────────────────────────────────
  for (const region of s.regions) {
    const cfg = region.config;
    for (let i = region.pending.length - 1; i >= 0; i--) {
      const entry = region.pending[i];
      entry.seconds -= dt;
      if (entry.seconds > 0) continue;
      region.pending.splice(i, 1);
      // Refill only up to the target. A region already at capacity drops the
      // entry rather than over-spawning.
      if (countInRegion(s, cfg.index) < cfg.targetCount) {
        spawnMonster(s, cfg, entry.kind);
      }
    }
  }
}

// ── Snapshot ────────────────────────────────────────────────────────────────

/** A frozen-enough view for the key map. See `GameSnapshot`'s doc comment. */
export function snapshot(s: SimState): GameSnapshot {
  return {
    width: s.width,
    height: s.height,
    player: { ...s.player },
    monsters: s.monsters,
    region: s.configs[regionIndexAt(s, s.player.posX, s.player.posY)],
    kills: s.kills,
    level: s.level,
    xp: s.xp,
  };
}
