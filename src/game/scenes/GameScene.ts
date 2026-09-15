// The Game tab's Phaser scene. A renderer over `sim.ts` and nothing more: it
// owns no game rules, only the canvas, the keyboard and the throttled HUD feed.
//
// [imperative] `update()` is a callback over time, not a value, so the frame
// counter and the sim both stay plain fields. Only the numbers the HUD prints
// reach Svelte state, and only on the timer below — publishing per frame would
// mean 60 reactivity passes a second for digits nobody can read that fast.

import Phaser from "phaser";
import { GAME_HEIGHT, GAME_STATS, GAME_WIDTH, SCENE_KEY, themeColor, type GameStats } from "../config";
import { buildRegions, createSim, snapshot as simSnapshot, stepSim, type SimState } from "../sim";
import { DIR_VECTORS, NO_INPUT, type GameSnapshot, type MonsterKind, type MoveInput } from "../types";

/** How often the scene hands fresh numbers to the HUD. */
const STATS_INTERVAL_MS = 250;

const PLAYER_RADIUS = 9;

/**
 * How far outside a monster's `senseRange` its ring is still drawn.
 *
 * The rings are the game's core tactic — walking around a vision circle *is*
 * the skill — but there are ~30 monsters, and drawing every ring at once turns
 * the arena into a web of overlapping arcs where none of them is readable.
 * Showing only the ones the player could actually step into (a little wider
 * than `attackRange`, so you can see a fight coming) keeps the tactic legible
 * and makes the rest of the map quiet.
 */
const SENSE_RING_MARGIN = 60;
const MONSTER_RADIUS: Record<MonsterKind, number> = { wanderer: 6, hunter: 7, brute: 11 };
const HP_BAR_W = 18;
const HP_BAR_H = 3;

/** `#rrggbb` or `rgb(...)` → the 0xRRGGBB integer Phaser draws with. */
function cssToInt(css: string, fallback: number): number {
  const hex = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  if (hex) return parseInt(hex[1], 16);
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(css);
  if (rgb) return (Number(rgb[1]) << 16) | (Number(rgb[2]) << 8) | Number(rgb[3]);
  return fallback;
}

interface Palette {
  grid: number;
  accent: number;
  green: number;
  /** Region tints, by tier — the risk gradient made visible. */
  corner: number;
  edge: number;
  center: number;
  monster: Record<MonsterKind, number>;
}

function readPalette(): Palette {
  return {
    grid: cssToInt(themeColor("--border", "#283046"), 0x283046),
    accent: cssToInt(themeColor("--accent", "#f7931a"), 0xf7931a),
    green: cssToInt(themeColor("--green", "#2ecc71"), 0x2ecc71),
    corner: 0x1f6feb,
    edge: 0xb8860b,
    center: cssToInt(themeColor("--red", "#e74c3c"), 0xe74c3c),
    monster: {
      // Grey = weak, orange = fast, red = dangerous. Deliberately readable at a
      // glance, because dodging depends on telling them apart instantly.
      wanderer: cssToInt(themeColor("--text-dim", "#8b97b3"), 0x8b97b3),
      hunter: cssToInt(themeColor("--accent", "#f7931a"), 0xf7931a),
      brute: cssToInt(themeColor("--red", "#e74c3c"), 0xe74c3c),
    },
  };
}

export class GameScene extends Phaser.Scene {
  /** Plain field on purpose — see the note at the top of this file. */
  private frames = 0;

  /** Null until a puzzle is selected and a run is started. */
  private sim: SimState | null = null;

  private palette!: Palette;
  private backdrop!: Phaser.GameObjects.Graphics;
  private layer!: Phaser.GameObjects.Graphics;

  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd?: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;

  constructor() {
    super(SCENE_KEY);
  }

  create(): void {
    this.palette = readPalette();

    this.backdrop = this.add.graphics();
    this.layer = this.add.graphics();

    this.drawArena();
    this.setupInput();

    this.time.addEvent({
      delay: STATS_INTERVAL_MS,
      loop: true,
      callback: () => this.publishStats(),
    });
  }

  // ── Run lifecycle ─────────────────────────────────────────────────────────

  /** Begin a fresh run. Also used to restart after a death. */
  startRun(): void {
    this.sim = createSim({ width: GAME_WIDTH, height: GAME_HEIGHT });
    // Paint it now rather than waiting for the next `update()`: a run is
    // created while the engine is still paused (the READY state), and the
    // player should be able to see the arena they are about to walk into.
    this.drawFrame();
  }

  /** Drop the current run and go back to the "no puzzle selected" state. */
  clearRun(): void {
    this.sim = null;
    this.layer.clear();
  }

  /**
   * The current state, for the key tick to read. Returns null before a run
   * exists. Read synchronously by the caller — the returned snapshot holds a
   * live reference to the monster list.
   */
  currentSnapshot(): GameSnapshot | null {
    return this.sim ? simSnapshot(this.sim) : null;
  }

  isAlive(): boolean {
    return this.sim?.alive ?? false;
  }

  /** True once a run has been created — distinguishes READY from IDLE. */
  hasRun(): boolean {
    return this.sim !== null;
  }

  /**
   * Seconds survived this run.
   *
   * `GameState` reads this instead of trusting the throttled stats feed, so a
   * pause landing within one stats interval of a death still reports the real
   * survival time rather than a stale one.
   */
  elapsed(): number {
    return this.sim?.time ?? 0;
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private setupInput(): void {
    // Null in a headless or keyboard-less context; the sim then just gets no
    // input rather than throwing.
    const kb = this.input.keyboard;
    if (!kb) return;
    this.cursors = kb.createCursorKeys();
    this.wasd = {
      W: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
  }

  /** 8-way move intent for this frame, each component in {-1, 0, 1}. */
  private readInput(): MoveInput {
    if (!this.cursors || !this.wasd) return NO_INPUT;
    const { left, right, up, down } = this.cursors;
    const { W, A, S, D } = this.wasd;

    let dx = 0;
    let dy = 0;
    if (left.isDown || A.isDown) dx -= 1;
    if (right.isDown || D.isDown) dx += 1;
    if (up.isDown || W.isDown) dy -= 1;
    if (down.isDown || S.isDown) dy += 1;
    return { dx, dy };
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** Static once per run: the 3x3 risk gradient and its dividers. */
  private drawArena(): void {
    const g = this.backdrop;
    const p = this.palette;
    g.clear();

    const tint: Record<string, number> = { corner: p.corner, edge: p.edge, center: p.center };
    const alpha: Record<string, number> = { corner: 0.05, edge: 0.06, center: 0.1 };

    for (const r of buildRegions(GAME_WIDTH, GAME_HEIGHT)) {
      g.fillStyle(tint[r.tier], alpha[r.tier]);
      g.fillRect(r.x, r.y, r.w, r.h);
    }

    g.lineStyle(1, p.grid, 0.9);
    for (let i = 1; i < 3; i++) {
      const x = (i * GAME_WIDTH) / 3;
      const y = (i * GAME_HEIGHT) / 3;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, GAME_HEIGHT);
      g.strokePath();
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(GAME_WIDTH, y);
      g.strokePath();
    }
  }

  /** Cleared and redrawn every frame; everything here moves. */
  private drawFrame(): void {
    const g = this.layer;
    const p = this.palette;
    g.clear();

    const sim = this.sim;
    if (!sim) return;

    const player = sim.player;

    for (const m of sim.monsters) {
      const reach = Math.hypot(m.posX - player.posX, m.posY - player.posY);
      if (reach > m.senseRange + SENSE_RING_MARGIN) continue;
      g.lineStyle(1, p.monster[m.kind], m.attacking ? 0.5 : 0.22);
      g.strokeCircle(m.posX, m.posY, m.senseRange);
    }

    g.lineStyle(1, p.green, 0.45);
    g.strokeCircle(player.posX, player.posY, player.attackRange);

    for (const m of sim.monsters) {
      const r = MONSTER_RADIUS[m.kind];
      g.fillStyle(p.monster[m.kind], 1);
      g.fillCircle(m.posX, m.posY, r);

      // Health bar, only once it has been hit.
      if (m.hp < m.maxHp) {
        const frac = Math.max(0, m.hp / m.maxHp);
        const bx = m.posX - HP_BAR_W / 2;
        const by = m.posY - r - 8;
        g.fillStyle(0x000000, 0.55);
        g.fillRect(bx, by, HP_BAR_W, HP_BAR_H);
        g.fillStyle(p.monster[m.kind], 1);
        g.fillRect(bx, by, HP_BAR_W * frac, HP_BAR_H);
      }
    }

    // The player, plus a spoke showing which of the 8 directions they face.
    g.fillStyle(p.green, 1);
    g.fillCircle(player.posX, player.posY, PLAYER_RADIUS);
    const [vx, vy] = DIR_VECTORS[player.dir];
    g.lineStyle(3, p.green, 1);
    g.beginPath();
    g.moveTo(player.posX, player.posY);
    g.lineTo(player.posX + vx * PLAYER_RADIUS * 1.9, player.posY + vy * PLAYER_RADIUS * 1.9);
    g.strokePath();

    if (!sim.alive) {
      g.fillStyle(0x000000, 0.5);
      g.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    }
  }

  // ── HUD feed ──────────────────────────────────────────────────────────────

  private publishStats(): void {
    const sim = this.sim;
    const stats: GameStats = {
      frames: this.frames,
      fps: this.game.loop.actualFps,
      survival: sim?.time ?? 0,
      alive: sim?.alive ?? false,
      ready: sim !== null,
      level: sim?.level ?? 1,
      hp: sim?.player.hp ?? 0,
      maxHp: sim?.player.maxHp ?? 0,
      kills: sim?.kills ?? 0,
      hashpower: sim?.hashpower ?? 0,
    };
    this.game.events.emit(GAME_STATS, stats);
  }

  update(_time: number, delta: number): void {
    this.frames++;
    const sim = this.sim;
    // A dead player freezes: the run is over, so the sim (and the survival
    // clock it drives) must stop even though the scene keeps rendering.
    if (sim && sim.alive) {
      stepSim(sim, this.readInput(), delta / 1000);
    }
    this.drawFrame();
  }
}
