// Game state → private key. Implements design §3 of `docs/game-design.md`.
//
// Pure and synchronous: no Tauri, no Phaser, no DOM. Everything here is
// directly unit-testable, which matters because this is the one part of the
// game where a subtle mistake silently degrades the search (a biased byte
// stream means a worse-than-theoretical hit rate, and nothing would ever
// surface that).

import { puzzleKeyHex, randomTopByte } from "../hex/range";
import type { PuzzleInfo } from "../hex/types";
import type { GameSnapshot, MonsterStats } from "./types";

/** How many of the nearest monsters feed the key. See design §3.4. */
export const MONSTER_WINDOW = 8;

/** 16 header bytes + the monster window. See design §3.4 for the layout. */
export const VECTOR_LEN = 16 + MONSTER_WINDOW * 6;

/**
 * Divisors that map an unbounded-ish stat onto 0..255. Chosen so a normal
 * run's values spread across most of the byte instead of pinning to one end.
 */
const SCALE = {
  attackPower: 64,
  moveSpeed: 320,
  attackSpeed: 4,
  attackRange: 200,
  hpSpeed: 8,
  level: 32,
  hashpower: 100,
  kills: 512,
  targetCount: 16,
  respawn: 8,
  /** Distances are squared-up to this before quantising. */
  dist: 1200,
} as const;

/** Labels for `V[0..15]`, in order. */
const HEADER_LABELS = [
  "tick",
  "player.dir",
  "player.posX",
  "player.posY",
  "player.hp",
  "player.attackPower",
  "player.moveSpeed",
  "player.attackSpeed",
  "player.attackRange",
  "player.hpSpeed",
  "level",
  "hashpower",
  "region.index",
  "region.count",
  "region.respawn",
  "kills",
] as const;

/** Labels for the 6 bytes each monster contributes. */
const MONSTER_FIELDS = ["dir", "x", "y", "hp", "dist", "aggro"] as const;

/** Which state field owns free byte `j`. Shown in the HUD (design §10.2). */
export function ownerLabel(j: number): string {
  if (j < HEADER_LABELS.length) return HEADER_LABELS[j];
  const i = Math.floor((j - HEADER_LABELS.length) / MONSTER_FIELDS.length);
  return `m[${i}].${MONSTER_FIELDS[(j - HEADER_LABELS.length) % MONSTER_FIELDS.length]}`;
}

/** `x / max` mapped onto an integer byte, clamped. */
function quant(x: number, max: number): number {
  if (!(max > 0)) return 0;
  const v = Math.round((x / max) * 255);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** The `MONSTER_WINDOW` monsters nearest the player, nearest first. */
function nearestMonsters(snap: GameSnapshot, n: number): MonsterStats[] {
  const { posX, posY } = snap.player;
  return snap.monsters
    .map((m) => ({ m, d2: (m.posX - posX) ** 2 + (m.posY - posY) ** 2 }))
    // `id` breaks ties so a frame's ordering is fully determined by the state —
    // without it two equidistant monsters could swap and jitter the key.
    .sort((a, b) => a.d2 - b.d2 || a.m.id - b.m.id)
    .slice(0, n)
    .map((e) => e.m);
}

/**
 * Build the fixed-length state vector `V` (design §3.4).
 *
 * Fixed length is load-bearing: monsters die constantly, and a variable-length
 * vector would shift every byte's owner the moment one did, making the HUD's
 * ownership display flicker. Empty monster slots stay 0.
 */
export function buildStateVector(snap: GameSnapshot): Uint8Array {
  const V = new Uint8Array(VECTOR_LEN);
  const p = snap.player;

  V[0] = snap.tick & 0xff;
  V[1] = p.dir;
  V[2] = quant(p.posX, snap.width);
  V[3] = quant(p.posY, snap.height);
  V[4] = quant(p.hp, p.maxHp);
  V[5] = quant(p.attackPower, SCALE.attackPower);
  V[6] = quant(p.moveSpeed, SCALE.moveSpeed);
  V[7] = quant(p.attackSpeed, SCALE.attackSpeed);
  V[8] = quant(p.attackRange, SCALE.attackRange);
  V[9] = quant(p.hpSpeed, SCALE.hpSpeed);
  V[10] = quant(snap.level, SCALE.level);
  V[11] = quant(snap.hashpower, SCALE.hashpower);
  V[12] = snap.region.index;
  V[13] = quant(snap.region.targetCount, SCALE.targetCount);
  V[14] = quant(snap.region.respawnSeconds, SCALE.respawn);
  V[15] = quant(snap.kills, SCALE.kills);

  const near = nearestMonsters(snap, MONSTER_WINDOW);
  for (let i = 0; i < near.length; i++) {
    const m = near[i];
    const o = 16 + i * 6;
    V[o] = m.dir;
    V[o + 1] = quant(m.posX, snap.width);
    V[o + 2] = quant(m.posY, snap.height);
    V[o + 3] = quant(m.hp, m.maxHp);
    V[o + 4] = quant(Math.hypot(m.posX - p.posX, m.posY - p.posY), SCALE.dist);
    V[o + 5] = m.attacking ? 1 : 0;
  }
  return V;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Fold the whole state vector into one 32-bit seed (design §3.3).
 *
 * Seeded with the puzzle number: `V` itself carries no puzzle identity, so
 * without this every puzzle would produce the same key stream.
 */
export function fold(V: Uint8Array, puzzleNumber: number): number {
  let h = (FNV_OFFSET ^ Math.imul(puzzleNumber, FNV_PRIME)) >>> 0;
  for (let i = 0; i < V.length; i++) {
    h = Math.imul(h ^ V[i], FNV_PRIME) >>> 0;
  }
  // Final avalanche, so flipping one byte of `V` moves every output byte.
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** splitmix32 — expands a 32-bit seed into a uniform byte stream. */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export interface GameKeyBytes {
  /** The `b - 1` free low bytes as 2-char lowercase hex, in key order. */
  baseBytes: string[];
  /** Human-readable owner of each byte, parallel to `baseBytes`. */
  owners: string[];
}

/**
 * The game's contribution to the key: the `b - 1` free low bytes (design §3.3).
 *
 * Each byte is `owner + diffuse` mod 256. `owner` gives the byte a stable,
 * legible meaning the player can push around; `diffuse` spreads the entire
 * state across every byte. Since a uniform term plus any term is still
 * uniform, `diffuse` carries the byte distribution — without it, low-cardinality
 * fields like `player.dir` (8 values) would waste 96% of their byte's range.
 */
export function gameBaseBytes(snap: GameSnapshot, puzzle: PuzzleInfo): GameKeyBytes {
  const free = Math.max(0, puzzle.hex_bytes_len - 1);
  const V = buildStateVector(snap);
  const next = splitmix32(fold(V, puzzle.puzzle_number));

  const baseBytes: string[] = [];
  const owners: string[] = [];
  for (let j = 0; j < free; j++) {
    const owner = V[j % V.length];
    const diffuse = next() & 0xff;
    baseBytes.push(((owner + diffuse) & 0xff).toString(16).padStart(2, "0"));
    owners.push(ownerLabel(j % V.length));
  }
  return { baseBytes, owners };
}

/**
 * The full 64-char private key for this instant of gameplay.
 *
 * Byte layout, and the reason this is three lines: the game fills the free low
 * bytes exactly the way the Hex tab's grid does, so key construction stays on
 * `src/hex/range.ts`'s single code path (design §3.2).
 */
export function gameKeyHex(
  snap: GameSnapshot,
  puzzle: PuzzleInfo,
): GameKeyBytes & { keyHex: string } {
  const { baseBytes, owners } = gameBaseBytes(snap, puzzle);
  const topByte = randomTopByte(puzzle);
  return { keyHex: puzzleKeyHex(puzzle, topByte, baseBytes), baseBytes, owners };
}
