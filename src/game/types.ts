// Shared shapes for the Game tab. Pure data — no Phaser, no DOM, no Tauri.
//
// See `docs/game-design.md` for the design these types implement. The section
// numbers in the comments below refer to that document.

/** 8-way facing. Index into `DIR_VECTORS`: 0 = east, increasing clockwise. */
export type Dir = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const DIR_COUNT = 8;

/**
 * Unit vector per `Dir`. Screen space, so +y is down: `Dir` 2 is south, 6 is
 * north. Generated rather than hand-listed so the table cannot drift out of
 * sync with `dirFromVector` below.
 */
export const DIR_VECTORS: readonly (readonly [number, number])[] = Array.from(
  { length: DIR_COUNT },
  (_, i) => {
    const a = (i * Math.PI) / 4;
    return [Math.cos(a), Math.sin(a)] as const;
  },
);

/** Nearest of the 8 compass directions to `(dx, dy)`. Pass a non-zero vector. */
export function dirFromVector(dx: number, dy: number): Dir {
  const idx = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return (((idx % DIR_COUNT) + DIR_COUNT) % DIR_COUNT) as Dir;
}

/** Mirror a `Dir` horizontally / vertically — used to bounce wanderers off walls. */
export const mirrorDirX = (d: Dir): Dir => (((4 - d) % DIR_COUNT + DIR_COUNT) % DIR_COUNT) as Dir;
export const mirrorDirY = (d: Dir): Dir => ((DIR_COUNT - d) % DIR_COUNT) as Dir;

// ── Player (design §5, requirement 3) ───────────────────────────────────────

export interface PlayerStats {
  /** Facing, one of the 8 directions. */
  dir: Dir;
  moveSpeed: number;
  /** Attacks per second. */
  attackSpeed: number;
  attackPower: number;
  /** Radius of the auto-attack's target search, in px. */
  attackRange: number;
  hp: number;
  maxHp: number;
  /** HP restored per second, once out of combat. */
  hpSpeed: number;
  posX: number;
  posY: number;
}

// ── Monster (design §6, requirement 5) ──────────────────────────────────────

export type MonsterKind = "wanderer" | "hunter" | "brute";

export interface MonsterStats {
  /** Stable for the lifetime of the monster; used to break distance ties. */
  id: number;
  kind: MonsterKind;
  /** Facing, one of the 8 directions. */
  dir: Dir;
  moveSpeed: number;
  attackSpeed: number;
  attackPower: number;
  attackRange: number;
  /**
   * Perception radius (`m_range`). The monster only chases a player inside it —
   * this is the field that makes "walk around the vision circle" a real tactic.
   */
  senseRange: number;
  hp: number;
  maxHp: number;
  posX: number;
  posY: number;
  /** Seconds until this monster may attack again. */
  attackCooldown: number;
  /**
   * Home region index (0..8). A monster is leashed to it: it wanders, chases
   * and dies there, and its respawn is scheduled there. Per-region counts are
   * therefore meaningful, and each tier's difficulty is its own.
   */
  region: number;
  /**
   * True while the player is inside this monster's `senseRange` **and** inside
   * its home region — see design §6. Aggro, damage and `V`'s aggro byte all
   * follow this one flag.
   */
  attacking: boolean;
  /** Seconds until this monster picks a new wander heading. */
  wanderTimer: number;
}

// ── Scene (design §4, requirement 4) ────────────────────────────────────────

/** Where a region sits in the 3x3 grid; drives its difficulty tier. */
export type RegionTier = "corner" | "edge" | "center";

export interface RegionConfig {
  /** 0..8, row-major: `row * 3 + col`. */
  index: number;
  tier: RegionTier;
  /** Bounds within the arena, in px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Steady-state monster count for this region. Escalates over time. */
  targetCount: number;
  /** Seconds between a kill here and that monster reappearing. Escalates. */
  respawnSeconds: number;
  /** Which archetypes spawn here, picked uniformly. */
  kinds: readonly MonsterKind[];
}

/** A `RegionConfig` plus the respawns currently counting down in it. */
export interface RegionRuntime {
  config: RegionConfig;
  pending: { seconds: number; kind: MonsterKind }[];
}

// ── Snapshot (design §3.4) ──────────────────────────────────────────────────

/**
 * The read-only view the key map consumes. Deliberately a snapshot rather than
 * a live handle on the sim: the key tick fires on its own schedule and must not
 * observe the sim mid-step.
 */
export interface GameSnapshot {
  /** Simulation steps so far — `V[0]`, so a static scene still moves the key. */
  tick: number;
  width: number;
  height: number;
  player: PlayerStats;
  monsters: readonly MonsterStats[];
  /** The region the player is currently standing in. */
  region: RegionConfig;
  kills: number;
  level: number;
  hashpower: number;
}

/** Player movement intent for one step, each component in {-1, 0, 1}. */
export interface MoveInput {
  dx: number;
  dy: number;
}

export const NO_INPUT: MoveInput = { dx: 0, dy: 0 };
