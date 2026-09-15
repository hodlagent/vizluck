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
  type MonsterKind,
  type MonsterStats,
  type MoveInput,
  type PlayerStats,
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

  hashpowerMax: 100,
  /** Per second. Idling in a corner bleeds the scan rate back down. */
  hashpowerDecay: 3,
  keyRateMin: 2,
  keyRateMax: 20,

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

  /** Wander behaviour for monsters that have not sensed the player. */
  wanderSpeedScale: 0.45,
  wanderMinSeconds: 1,
  wanderMaxSeconds: 3.5,
  /** Keeps wanderers off their region's edge. */
  regionPad: 14,
  /**
   * How close to its region's edge a *chasing* monster may get. Much smaller
   * than `regionPad`: a monster that stopped short of the border could not
   * reach a player standing just across it, which reads as a broken hitbox.
   */
  chasePad: 2,
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
  /** Hashpower granted on kill (design §8.1). */
  drop: number;
  xp: number;
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
    drop: 1,
    xp: 10,
  },
  hunter: {
    hp: 35,
    moveSpeed: 120,
    attackPower: 8,
    attackSpeed: 1.2,
    attackRange: 26,
    senseRange: 260,
    drop: 2,
    xp: 20,
  },
  brute: {
    hp: 90,
    moveSpeed: 40,
    attackPower: 18,
    attackSpeed: 0.6,
    attackRange: 34,
    // Short sight, huge damage: walking around this circle is the core tactic.
    senseRange: 110,
    drop: 4,
    xp: 40,
  },
};

/** XP needed to advance *from* `level`. */
export const xpForNext = (level: number): number => 100 * level;

/** Key sampling rate for a hashpower value, in keys/s (design §8.1). */
export function keyRateFor(hashpower: number): number {
  const frac = Math.max(0, Math.min(1, hashpower / TUNING.hashpowerMax));
  return TUNING.keyRateMin + (TUNING.keyRateMax - TUNING.keyRateMin) * frac;
}

// ── State ───────────────────────────────────────────────────────────────────

export interface SimState {
  width: number;
  height: number;
  player: PlayerStats;
  monsters: MonsterStats[];
  configs: RegionConfig[];
  regions: RegionRuntime[];

  /** Seconds survived this run — the score (design §1, requirement 6). */
  time: number;
  kills: number;
  level: number;
  xp: number;
  hashpower: number;
  /** False once `hp` hits 0; the run is over and `step` becomes a no-op. */
  alive: boolean;

  /**
   * Simulation steps so far. Feeds `V[0]`, which is what guarantees the key
   * still moves when the player stands still in an empty corner.
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
 * The 3x3 region grid (design §4.1). The tiers are the whole point: corners are
 * safe and poor, the centre is rich and lethal, so "where do I stand" is a real
 * decision rather than a decoration.
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
  const m: MonsterStats = {
    id: s.nextId++,
    kind,
    dir: Math.floor(s.rng() * DIR_COUNT) as Dir,
    moveSpeed: arch.moveSpeed,
    attackSpeed: arch.attackSpeed,
    attackPower: arch.attackPower,
    attackRange: arch.attackRange,
    senseRange: arch.senseRange,
    hp: arch.hp,
    maxHp: arch.hp,
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
      // Spawn in the middle of a corner region — the safe, poor tier, which is
      // where a run should start (design §4.1).
      posX: configs[0].x + configs[0].w / 2,
      posY: configs[0].y + configs[0].h / 2,
    },
    monsters: [],
    configs,
    regions: configs.map((config): RegionRuntime => ({ config, pending: [] })),
    time: 0,
    kills: 0,
    level: 1,
    xp: 0,
    hashpower: 0,
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

/** Region index containing `(x, y)`. */
export function regionIndexAt(s: SimState, x: number, y: number): number {
  const col = clamp(Math.floor(x / (s.width / 3)), 0, 2);
  const row = clamp(Math.floor(y / (s.height / 3)), 0, 2);
  return row * 3 + col;
}

/** Is `(x, y)` inside `cfg`? Half-open, to match `regionIndexAt`'s flooring. */
function pointInRegion(cfg: RegionConfig, x: number, y: number): boolean {
  return x >= cfg.x && x < cfg.x + cfg.w && y >= cfg.y && y < cfg.y + cfg.h;
}

/** Live monsters whose *home* is `region` — chasers elsewhere still count. */
function countInRegion(s: SimState, region: number): number {
  let n = 0;
  for (const m of s.monsters) if (m.region === region) n++;
  return n;
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

// ── Mutations ───────────────────────────────────────────────────────────────

function damagePlayer(s: SimState, amount: number): void {
  s.player.hp -= amount;
  s.sinceDamage = 0;
  if (s.player.hp <= 0) {
    s.player.hp = 0;
    s.alive = false;
  }
}

function applyLevelUp(p: PlayerStats): void {
  p.maxHp += 10;
  p.hp = Math.min(p.maxHp, p.hp + 10);
  p.attackPower += 1;
  p.moveSpeed += 2;
  p.attackSpeed += 0.05;
  p.attackRange += 1;
  p.hpSpeed += 0.1;
}

function killMonster(s: SimState, m: MonsterStats): void {
  const idx = s.monsters.indexOf(m);
  if (idx < 0) return;
  s.monsters.splice(idx, 1);

  const arch = MONSTER_ARCHETYPES[m.kind];
  s.kills++;
  s.hashpower = Math.min(TUNING.hashpowerMax, s.hashpower + arch.drop);
  s.xp += arch.xp;
  while (s.xp >= xpForNext(s.level)) {
    s.xp -= xpForNext(s.level);
    s.level++;
    applyLevelUp(s.player);
  }

  // Respawn after this region's delay, in this region (requirement: "杀死后 n
  // 秒后刷新出来", per-region and independent).
  s.regions[m.region].pending.push({
    seconds: s.configs[m.region].respawnSeconds,
    kind: m.kind,
  });
}

/** Drift inside the home region, bouncing off its edges. */
function wander(s: SimState, m: MonsterStats, dt: number): void {
  const home = s.configs[m.region];
  m.wanderTimer -= dt;
  if (m.wanderTimer <= 0) {
    m.wanderTimer =
      TUNING.wanderMinSeconds + s.rng() * (TUNING.wanderMaxSeconds - TUNING.wanderMinSeconds);
    m.dir = Math.floor(s.rng() * DIR_COUNT) as Dir;
  }

  const [vx, vy] = DIR_VECTORS[m.dir];
  const pad = TUNING.regionPad;
  const minX = home.x + pad;
  const maxX = home.x + home.w - pad;
  const minY = home.y + pad;
  const maxY = home.y + home.h - pad;

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
  if (input.dx !== 0 || input.dy !== 0) {
    p.dir = dirFromVector(input.dx, input.dy);
    p.posX = clamp(p.posX + input.dx * p.moveSpeed * dt, 0, s.width);
    p.posY = clamp(p.posY + input.dy * p.moveSpeed * dt, 0, s.height);
  }

  s.sinceDamage += dt;
  if (s.sinceDamage >= TUNING.regenDelay && p.hp < p.maxHp) {
    p.hp = Math.min(p.maxHp, p.hp + p.hpSpeed * dt);
  }

  s.hashpower = Math.max(0, s.hashpower - TUNING.hashpowerDecay * dt);

  // Player → monster auto-attack (design §5.1). The cooldown only resets on a
  // swing, so an idle player is always ready for the next thing that walks in.
  s.attackCooldown -= dt;
  if (s.attackCooldown <= 0) {
    const target = nearestMonster(s, p.posX, p.posY, p.attackRange);
    if (target) {
      target.hp -= p.attackPower;
      s.attackCooldown = 1 / p.attackSpeed;
      if (target.hp <= 0) killMonster(s, target);
    }
  }

  // ── Monsters ─────────────────────────────────────────────────────────────
  // Nothing in this loop removes a monster (only the player's attack above
  // does, and it runs first), so iterating `s.monsters` directly is safe.
  for (const m of s.monsters) {
    const home = s.configs[m.region];
    const dx = p.posX - m.posX;
    const dy = p.posY - m.posY;
    const dist = Math.hypot(dx, dy);

    m.attackCooldown -= dt;
    // Two conditions, and the second is the load-bearing one: a monster fights
    // only inside its *own* region. Without it the tiers are a lie — a hunter's
    // 260px sense reaches from the adjacent edge region right into a corner, so
    // the "safe" tier would be exactly as lethal as the centre, just later.
    // Leashing also makes requirement 4's per-region independence real: the
    // corner's population is decided by the corner.
    m.attacking = dist <= m.senseRange && pointInRegion(home, p.posX, p.posY);

    if (!m.attacking) {
      wander(s, m, dt);
      continue;
    }

    m.dir = dirFromVector(dx, dy);
    const [vx, vy] = DIR_VECTORS[m.dir];
    // Close in, but stop short of standing inside the player — and stay in the
    // home region, so crossing a border is a real way to break aggro.
    if (dist > m.attackRange * 0.7) {
      const pad = TUNING.chasePad;
      m.posX = clamp(m.posX + vx * m.moveSpeed * dt, home.x + pad, home.x + home.w - pad);
      m.posY = clamp(m.posY + vy * m.moveSpeed * dt, home.y + pad, home.y + home.h - pad);
    }
    if (dist <= m.attackRange && m.attackCooldown <= 0) {
      damagePlayer(s, m.attackPower);
      m.attackCooldown = 1 / m.attackSpeed;
      if (!s.alive) return; // dead mid-loop: stop simulating this step
    }
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
    tick: s.tick,
    width: s.width,
    height: s.height,
    player: { ...s.player },
    monsters: s.monsters,
    region: s.configs[regionIndexAt(s, s.player.posX, s.player.posY)],
    kills: s.kills,
    level: s.level,
    hashpower: s.hashpower,
  };
}
