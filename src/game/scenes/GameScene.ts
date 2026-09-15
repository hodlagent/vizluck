// The Game tab's Phaser scene. A renderer over `sim.ts` and nothing more: it
// owns no game rules, only the canvas, the keyboard and the throttled HUD feed.
//
// [imperative] `update()` is a callback over time, not a value, so the frame
// counter, the effect pools and the sim all stay plain fields. Only the numbers
// the HUD prints reach Svelte state, and only on the timer below — publishing
// per frame would mean 60 reactivity passes a second for digits nobody can read
// that fast.
//
// Everything in the arena is immediate-mode: a static floor painted once, one
// `Graphics` cleared and rebuilt each frame, and a small pool of `Text` objects
// for the numbers that float off a kill. That is deliberate — the alternative,
// a `Sprite` per monster, would mean keeping Phaser's display list in step with
// a simulation that owns its own entity lifecycle, and the scene would become a
// second, subtly-wrong copy of `sim.ts`.
//
// Two constraints shape the effects, and neither is negotiable:
//
//   * `Phaser.AUTO` falls back to the **Canvas** renderer in the headless
//     Chromium the regression net runs in, so nothing here may use a WebGL-only
//     feature. No `fillGradientStyle`, no post-FX pipelines, no reliance on
//     `BlendModes.ADD` actually adding. Glow is built the portable way: nested
//     translucent shapes, which look the same in both renderers.
//   * A pause stops the *simulation*, not the engine — see `setPaused()`. That
//     distinction is the whole reason the arena is visible at all: `Game.pause()`
//     makes `Game.step()` return early, which also skips the render, so a paused
//     game is a canvas that never repaints. Since the engine is paused during
//     boot here, nothing had ever painted and the tab showed an empty black box
//     until the first ▶. Resizing the canvas clears it too, so no draw done
//     while paused survives to be seen.

import Phaser from "phaser";
import {
  GAME_HEIGHT,
  GAME_STATS,
  GAME_WIDTH,
  SCENE_KEY,
  themeColor,
  type GameOverlay,
  type GameStats,
} from "../config";
import {
  buildRegions,
  createSim,
  MONSTER_ARCHETYPES,
  regionIndexAt,
  snapshot as simSnapshot,
  stepSim,
  type SimState,
} from "../sim";
import {
  DIR_VECTORS,
  NO_INPUT,
  type GameSnapshot,
  type MonsterKind,
  type MoveInput,
  type RegionConfig,
} from "../types";

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

/** Roughly one dot per this many px of ring, so a brute's ring reads like one. */
const RING_DOT_SPACING = 15;
const RING_DOT_SIZE = 2;
const PLAYER_RING_SPACING = 13;

/** Trail length, in samples. Twelve at 60fps is about a fifth of a second. */
const TRAIL_MAX = 12;
/** Seconds of white flash on a monster that just took a hit. */
const HIT_FLASH_S = 0.14;
/** Seconds the swing arc stays on screen. */
const SWING_S = 0.18;
/** Seconds the red damage vignette fades over. */
const HURT_S = 0.5;
/** How long a "LEVEL n" announcement hangs in the air. */
const ANNOUNCE_S = 1.6;
/** Pool size for the floating numbers. More than this on screen is noise. */
const FLOATER_POOL = 12;

/** The canvas has no font stack of its own; match the tab's monospace. */
const MONO = '"SF Mono", Menlo, Consolas, monospace';

/** A soft, blue-black floor. Hard-coded: this app is dark-only by design. */
const FLOOR = 0x090c15;
const FLOOR_EDGE = 0x1b2334;

/** `#rrggbb` or `rgb(...)` → the 0xRRGGBB integer Phaser draws with. */
function cssToInt(css: string, fallback: number): number {
  const hex = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  if (hex) return parseInt(hex[1], 16);
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(css);
  if (rgb) return (Number(rgb[1]) << 16) | (Number(rgb[2]) << 8) | Number(rgb[3]);
  return fallback;
}

/** The inverse, for `Text`, which takes CSS strings rather than integers. */
function intToCss(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

/**
 * Lighten (`amount > 0`) or darken (`amount < 0`) toward white or black.
 *
 * Rim/core shades are derived rather than listed so a change to `--accent` in
 * `styles.css` carries through to every highlight on the canvas.
 */
function shade(color: number, amount: number): number {
  const target = amount < 0 ? 0 : 255;
  const t = Math.min(1, Math.abs(amount));
  const mix = (c: number): number => Math.round(c + (target - c) * t);
  return (mix((color >> 16) & 0xff) << 16) | (mix((color >> 8) & 0xff) << 8) | mix(color & 0xff);
}

/** `m:ss.s`, the same shape the HUD prints — the death card has to agree. */
function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const rest = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

interface Palette {
  floor: number;
  grid: number;
  accent: number;
  green: number;
  red: number;
  dim: number;
  /** Region tints, by tier — the risk gradient made visible. */
  corner: number;
  edge: number;
  center: number;
  monster: Record<MonsterKind, number>;
  /** One step lighter than the body, for rims and facing ticks. */
  monsterRim: Record<MonsterKind, number>;
}

function readPalette(): Palette {
  const accent = cssToInt(themeColor("--accent", "#f7931a"), 0xf7931a);
  const green = cssToInt(themeColor("--green", "#2ecc71"), 0x2ecc71);
  const red = cssToInt(themeColor("--red", "#e74c3c"), 0xe74c3c);
  const dim = cssToInt(themeColor("--text-dim", "#8b97b3"), 0x8b97b3);
  const monster: Record<MonsterKind, number> = {
    // Grey = weak, orange = fast, red = dangerous. Deliberately readable at a
    // glance, because dodging depends on telling them apart instantly.
    wanderer: dim,
    hunter: accent,
    brute: red,
  };

  return {
    floor: FLOOR,
    grid: cssToInt(themeColor("--border", "#283046"), 0x283046),
    accent,
    green,
    red,
    dim,
    corner: 0x2f6fd0,
    edge: 0xb8860b,
    center: red,
    monster,
    monsterRim: {
      wanderer: shade(dim, 0.45),
      hunter: shade(accent, 0.4),
      brute: shade(red, 0.4),
    },
  };
}

/** The tier's label, painted into the corner of each region. */
const TIER_LABEL: Record<RegionConfig["tier"], string> = {
  corner: "SAFE",
  edge: "CONTESTED",
  center: "DANGER",
};

/** One flying spark, in px and px/s. */
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: number;
}

/** One expanding ring — a kill burst, a level-up, a hit. */
interface Burst {
  x: number;
  y: number;
  r: number;
  maxR: number;
  life: number;
  max: number;
  color: number;
  width: number;
}

/** A pooled `Text` plus where it currently is. */
interface Floater {
  label: Phaser.GameObjects.Text;
  x: number;
  y: number;
  vy: number;
  life: number;
  max: number;
}

/** Per-monster bookkeeping the sim has no business carrying. */
interface Tracked {
  x: number;
  y: number;
  kind: MonsterKind;
  hp: number;
  flash: number;
  /** Frame marker, so a monster that vanished can be found without a Set. */
  stamp: number;
}

export class GameScene extends Phaser.Scene {
  /** Plain field on purpose — see the note at the top of this file. */
  private frames = 0;
  /** Seconds of *rendered* time. Drives every pulse; freezes with the engine. */
  private clock = 0;

  /** Null until a puzzle is selected and a run is started. */
  private sim: SimState | null = null;

  private palette!: Palette;
  private floor!: Phaser.GameObjects.Graphics;
  private layer!: Phaser.GameObjects.Graphics;
  private overlay!: Phaser.GameObjects.Graphics;
  private overlayKind: GameOverlay = "none";

  private regionLabels: Phaser.GameObjects.Text[] = [];
  private announce!: Phaser.GameObjects.Text;
  private announceLife = 0;
  private overlayTitle!: Phaser.GameObjects.Text;
  private overlaySub!: Phaser.GameObjects.Text;
  private overlayHint!: Phaser.GameObjects.Text;
  private floaters: Floater[] = [];

  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd?: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;

  // ── Transient effects ────────────────────────────────────────────────────
  private sparks: Spark[] = [];
  private bursts: Burst[] = [];
  private trail: { x: number; y: number }[] = [];
  private tracked = new Map<number, Tracked>();
  private stamp = 0;
  /** Seconds left on the player's swing arc, and the direction it went out in. */
  private swing = 0;
  private swingDir = 0;
  /** Seconds left on the red damage vignette. */
  private hurt = 0;
  /** Sim frozen, engine still painting. See `setPaused()`. */
  private paused = false;

  constructor() {
    super(SCENE_KEY);
  }

  create(): void {
    this.palette = readPalette();

    this.floor = this.add.graphics().setDepth(0);
    this.layer = this.add.graphics().setDepth(1);
    this.overlay = this.add.graphics().setDepth(2);

    this.drawFloor();
    this.buildLabels();
    this.setupInput();
    this.fitCamera();

    // The engine is resized from the outside (`GameState.resize()`), and an
    // overlay drawn *before* a pause would otherwise keep the old geometry
    // forever — a paused game does not re-render, so nothing would repaint it.
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize);

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
    this.resetEffects();
    // Paint it now rather than waiting for the next `update()`: a run is
    // created while the engine is still paused (the READY state), and the
    // player should be able to see the arena they are about to walk into.
    this.drawFrame();
  }

  /** Drop the current run and go back to the "no puzzle selected" state. */
  clearRun(): void {
    this.sim = null;
    this.resetEffects();
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

  // ── Pause ─────────────────────────────────────────────────────────────────

  /**
   * Freeze the run without stopping the renderer.
   *
   * "暂停 = 停止搜索" (design §8) is about the *simulation* — the survival
   * clock, the respawn timers and the key loop — and every one of those is
   * gated on this flag or on `GameState.running`. What it must not do is stop
   * the engine: `Game.pause()` skips the render along with the update, so the
   * arena would go stale the moment the canvas was resized and the pause
   * message could never be painted at all.
   *
   * The render clock keeps ticking, which is deliberate. A paused arena still
   * breathes, and the frame the player paused on is the frame they come back to.
   */
  setPaused(on: boolean): void {
    if (on === this.paused) return;
    this.paused = on;
  }

  // ── Overlay ───────────────────────────────────────────────────────────────

  /**
   * Paint (or clear) the full-screen message. Called by `GameState` as it
   * reconciles the run's status.
   *
   * Redrawing on every call would be wasted work at the 4 Hz stats rate, hence
   * the early return; `onResize` redraws unconditionally for the cases this
   * guard would otherwise skip.
   */
  setOverlay(kind: GameOverlay): void {
    if (kind === this.overlayKind) return;
    this.overlayKind = kind;

    // The death card is the one overlay whose numbers cannot be known here:
    // they come off the sim that just ended.
    if (kind === "dead") {
      const sim = this.sim;
      const survival = sim?.time ?? 0;
      this.overlayTitle.setText("GAME OVER");
      this.overlaySub.setText(
        `SURVIVED ${fmtTime(survival)}   ·   KILLS ${sim?.kills ?? 0}   ·   LEVEL ${sim?.level ?? 1}`,
      );
      this.overlayHint.setText("PRESS  ▶  TO RUN AGAIN");
    } else if (kind === "ready") {
      this.overlayTitle.setText("READY");
      this.overlaySub.setText("PRESS  ▶  TO OPEN THE ARENA");
      this.overlayHint.setText("WASD / ARROWS TO MOVE   ·   ATTACKS ARE AUTOMATIC");
    } else if (kind === "paused") {
      this.overlayTitle.setText("PAUSED");
      this.overlaySub.setText("THE SEARCH IS STOPPED");
      this.overlayHint.setText("PRESS  ▶  TO RESUME");
    }

    this.drawOverlay();
  }

  /** Redraw the overlay at the current size. Cheap; called on resize too. */
  private drawOverlay(): void {
    const g = this.overlay;
    const kind = this.overlayKind;
    g.clear();

    const showText = kind !== "none";
    this.overlayTitle.setVisible(showText);
    this.overlaySub.setVisible(showText);
    this.overlayHint.setVisible(showText);
    if (!showText) return;

    const view = this.visibleWorld();
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT / 2;

    // Death is the only state that hides the arena completely: the run is over
    // and the card is the whole point. Ready and paused stay see-through, so
    // the player keeps looking at the board they are about to walk back into.
    const veil = kind === "dead" ? 0.78 : 0.42;
    g.fillStyle(FLOOR, veil);
    g.fillRect(view.x, view.y, view.w, view.h);

    const tint = kind === "dead" ? this.palette.red : this.palette.accent;
    const panelW = 420;
    // Tall enough to clear the middle row's caption, which sits at y≈190-203.
    // At 150 the card's top edge landed at 195 and sliced "DANGER" in half, and
    // a half-word in the card's own colour reads as a rendering fault rather
    // than as a label the card is covering. The card is drawn *over* the arena;
    // it has to occlude things cleanly or not at all.
    const panelH = 176;
    const px = cx - panelW / 2;
    const py = cy - panelH / 2;

    // Opaque, not translucent. The panel is the one surface in the arena whose
    // job is to be *read*, and read/paused stay see-through by design — so a
    // monster wandering behind the card would otherwise drift straight through
    // the words. The veil above already dims the arena; the card sits on top of
    // that, not inside it.
    g.fillStyle(FLOOR, 1);
    g.fillRoundedRect(px, py, panelW, panelH, 12);
    g.lineStyle(1, tint, 0.65);
    g.strokeRoundedRect(px, py, panelW, panelH, 12);

    // Corner brackets, the same HUD motif the regions use.
    const arm = 16;
    g.lineStyle(2, tint, 0.9);
    for (const [sx, sy] of [
      [px, py],
      [px + panelW, py],
      [px, py + panelH],
      [px + panelW, py + panelH],
    ] as const) {
      const dx = sx === px ? arm : -arm;
      const dy = sy === py ? arm : -arm;
      g.beginPath();
      g.moveTo(sx + dx, sy);
      g.lineTo(sx, sy);
      g.lineTo(sx, sy + dy);
      g.strokePath();
    }

    this.overlayTitle.setPosition(cx, cy - 42).setColor(intToCss(tint));
    this.overlaySub.setPosition(cx, cy + 4);
    this.overlayHint.setPosition(cx, cy + 44);
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

  // ── Camera ────────────────────────────────────────────────────────────────

  /**
   * Fit the 960x540 arena inside whatever the host element currently is.
   *
   * Phaser is on `Scale.NONE` (see `config.ts`), so `game.scale.resize()` grows
   * the canvas but leaves the world at its logical size — without this the
   * arena would sit in the top-left corner of the stage with dead space down
   * the right and bottom edges. `centerOn` is zoom-independent, so the two
   * calls together letterbox correctly at any aspect ratio.
   */
  private fitCamera(): void {
    const cam = this.cameras.main;
    const vw = this.scale.width;
    const vh = this.scale.height;
    if (!(vw > 0 && vh > 0)) return;
    cam.setZoom(Math.min(vw / GAME_WIDTH, vh / GAME_HEIGHT));
    cam.centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);
  }

  /**
   * The world-space rectangle the canvas currently shows.
   *
   * The letterbox bars are part of it on purpose: overlays have to cover the
   * whole canvas, not just the arena. Derived from the camera rather than
   * hard-coded to the arena so it stays right if the fit ever changes.
   */
  private visibleWorld(): { x: number; y: number; w: number; h: number } {
    const cam = this.cameras.main;
    const zoom = cam.zoomX || 1;
    const w = this.scale.width / zoom;
    const h = this.scale.height / zoom;
    return {
      x: cam.scrollX + (this.scale.width / 2) * (1 - 1 / zoom),
      y: cam.scrollY + (this.scale.height / 2) * (1 - 1 / zoom),
      w,
      h,
    };
  }

  private onResize = (): void => {
    this.fitCamera();
    // A paused game is not re-rendering, so the frozen frame has to be replaced
    // by hand or the arena would keep the geometry it had before the resize.
    this.drawFrame();
    this.drawOverlay();
  };

  // ── Static arena ──────────────────────────────────────────────────────────

  /**
   * The floor: painted once, never touched again.
   *
   * It is one `Graphics` rather than a generated texture because Phaser's
   * Canvas renderer has to re-run every stored command each frame — so the
   * budget here is "how many primitives", not "how many pixels". Hence a sparse
   * line grid with dots only at the intersections, rather than a dot per cell.
   */
  private drawFloor(): void {
    const g = this.floor;
    const p = this.palette;
    g.clear();

    g.fillStyle(p.floor, 1);
    g.fillRoundedRect(-4, -4, GAME_WIDTH + 8, GAME_HEIGHT + 8, 10);

    const regions = buildRegions(GAME_WIDTH, GAME_HEIGHT);
    const tint: Record<RegionConfig["tier"], number> = {
      corner: p.corner,
      edge: p.edge,
      center: p.center,
    };
    const wash: Record<RegionConfig["tier"], number> = { corner: 0.07, edge: 0.08, center: 0.12 };
    const rim: Record<RegionConfig["tier"], number> = { corner: 0.3, edge: 0.32, center: 0.5 };

    // 1. A fine grid over the whole arena — the "tactical map" substrate.
    g.lineStyle(1, p.grid, 0.5);
    for (let x = 60; x < GAME_WIDTH; x += 60) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, GAME_HEIGHT);
      g.strokePath();
    }
    for (let y = 60; y < GAME_HEIGHT; y += 60) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(GAME_WIDTH, y);
      g.strokePath();
    }
    g.fillStyle(p.grid, 0.85);
    for (let x = 60; x < GAME_WIDTH; x += 60) {
      for (let y = 60; y < GAME_HEIGHT; y += 60) g.fillPoint(x, y, 2);
    }

    // 2. Per-region wash + rim. The centre is the lethal, rich tier, so it gets
    //    the strongest wash and a double border — the risk gradient is the one
    //    thing the floor has to communicate.
    for (const r of regions) {
      g.fillStyle(tint[r.tier], wash[r.tier]);
      g.fillRect(r.x, r.y, r.w, r.h);
      g.lineStyle(1, tint[r.tier], rim[r.tier]);
      g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      if (r.tier === "center") {
        g.lineStyle(1, tint[r.tier], 0.28);
        g.strokeRect(r.x + 7.5, r.y + 7.5, r.w - 15, r.h - 15);
      }
    }

    // 3. Corner brackets on every region — the HUD motif that stops nine plain
    //    rectangles from reading as a spreadsheet.
    const arm = 14;
    for (const r of regions) {
      g.lineStyle(2, tint[r.tier], 0.75);
      const corners: readonly (readonly [number, number, number, number])[] = [
        [r.x, r.y, 1, 1],
        [r.x + r.w, r.y, -1, 1],
        [r.x, r.y + r.h, 1, -1],
        [r.x + r.w, r.y + r.h, -1, -1],
      ];
      for (const [cx, cy, sx, sy] of corners) {
        g.beginPath();
        g.moveTo(cx + arm * sx, cy);
        g.lineTo(cx, cy);
        g.lineTo(cx, cy + arm * sy);
        g.strokePath();
      }
    }

    // 4. A vignette, drawn *under* the edge so the border stays crisp. Nested
    //    hairline rings darkening toward the rim: `fillGradientStyle` is
    //    WebGL-only and this scene has to survive the Canvas renderer, so the
    //    ramp is stacked strokes a pixel apart, which the eye reads as a smooth
    //    falloff. It also does real work — it pulls the corners (the safe tier)
    //    down and pushes the lit centre forward.
    const band = 34;
    for (let i = 0; i < band; i++) {
      const a = 0.26 * Math.pow(1 - i / band, 2.2);
      if (a < 0.004) break;
      g.lineStyle(1, 0x000000, a);
      g.strokeRoundedRect(
        -4 + i,
        -4 + i,
        GAME_WIDTH + 8 - i * 2,
        GAME_HEIGHT + 8 - i * 2,
        Math.max(0, 10 - i),
      );
    }

    // 5. The arena's own edge, plus a hairline highlight just inside it.
    g.lineStyle(2, FLOOR_EDGE, 1);
    g.strokeRoundedRect(-4, -4, GAME_WIDTH + 8, GAME_HEIGHT + 8, 10);
    g.lineStyle(1, p.grid, 0.9);
    g.strokeRoundedRect(0.5, 0.5, GAME_WIDTH - 1, GAME_HEIGHT - 1, 8);
  }

  /** The nine tier captions, plus the pooled texts. Built once. */
  private buildLabels(): void {
    const p = this.palette;
    const tierColor: Record<RegionConfig["tier"], number> = {
      corner: p.corner,
      edge: p.edge,
      center: p.center,
    };

    for (const r of buildRegions(GAME_WIDTH, GAME_HEIGHT)) {
      const label = this.add
        .text(r.x + 22, r.y + 10, TIER_LABEL[r.tier], {
          fontFamily: MONO,
          fontSize: "11px",
          color: intToCss(shade(tierColor[r.tier], 0.55)),
        })
        // 0.68, not 0.5: the caption colour is a *lighter tint of its own tier*,
        // so all of its contrast comes from the lightness delta against the
        // wash of that same hue — halving it again with alpha left "DANGER"
        // barely above the red it sits on. Colour-coded but legible beats
        // tastefully muted and unreadable.
        .setAlpha(0.68)
        .setDepth(1);
      this.regionLabels.push(label);
    }

    this.announce = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 70, "", {
        fontFamily: MONO,
        fontSize: "26px",
        fontStyle: "bold",
        color: intToCss(p.green),
      })
      .setOrigin(0.5)
      .setDepth(4)
      .setVisible(false);

    for (let i = 0; i < FLOATER_POOL; i++) {
      const label = this.add
        .text(0, 0, "", { fontFamily: MONO, fontSize: "13px", fontStyle: "bold" })
        .setOrigin(0.5)
        .setDepth(3)
        .setVisible(false);
      this.floaters.push({ label, x: 0, y: 0, vy: 0, life: 0, max: 1 });
    }

    this.overlayTitle = this.add
      .text(0, 0, "", { fontFamily: MONO, fontSize: "34px", fontStyle: "bold" })
      .setOrigin(0.5)
      .setDepth(4)
      .setVisible(false);
    this.overlaySub = this.add
      .text(0, 0, "", { fontFamily: MONO, fontSize: "13px", color: intToCss(p.dim) })
      .setOrigin(0.5)
      .setDepth(4)
      .setVisible(false);
    this.overlayHint = this.add
      .text(0, 0, "", { fontFamily: MONO, fontSize: "12px", color: intToCss(shade(p.dim, -0.15)) })
      .setOrigin(0.5)
      .setDepth(4)
      .setVisible(false);
  }

  // ── Per-frame drawing ─────────────────────────────────────────────────────

  /** Cleared and redrawn every frame; everything here moves. */
  private drawFrame(): void {
    const g = this.layer;
    const p = this.palette;
    g.clear();

    const sim = this.sim;
    if (!sim) return;

    const player = sim.player;
    const t = this.clock;

    // 1. The region the player is standing in. This is the whole risk gradient
    //    made personal: step into the centre and the floor lights up under you.
    const here = sim.configs[regionIndexAt(sim, player.posX, player.posY)];
    const hereTint = here.tier === "center" ? p.center : here.tier === "edge" ? p.edge : p.corner;
    const herePulse = 0.5 + 0.5 * Math.sin(t * 2);
    g.fillStyle(hereTint, 0.08 + 0.035 * herePulse);
    g.fillRect(here.x, here.y, here.w, here.h);
    // A rim on the *current* region only. The floor already rims all nine, so
    // without this the highlight is a wash the eye has to hunt for; a lit border
    // turns "which tier am I in" into a glance.
    g.lineStyle(1, hereTint, 0.35 + 0.25 * herePulse);
    g.strokeRect(here.x + 0.5, here.y + 0.5, here.w - 1, here.h - 1);

    // 2. The centre breathes. Slow, low-amplitude, and only in the lethal tier,
    //    so "somewhere dangerous" is legible from the corner of the eye.
    const centre = sim.configs[4];
    g.fillStyle(p.center, 0.04 + 0.035 * (0.5 + 0.5 * Math.sin(t * 1.7)));
    g.fillRect(centre.x, centre.y, centre.w, centre.h);

    // 3. Threat lines: a monster that has the player inside its sense circle is
    //    the only thing in this game that can hurt them, and a link back to it
    //    answers "what is hitting me" without hunting for the ring.
    g.lineStyle(1, p.red, 0.16);
    for (const m of sim.monsters) {
      if (!m.attacking) continue;
      g.beginPath();
      g.moveTo(m.posX, m.posY);
      g.lineTo(player.posX, player.posY);
      g.strokePath();
    }

    // 4. Sense rings, as dotted radar arcs. Dots rather than strokes because the
    //    overlap is the problem: dashes still merge into a web when three rings
    //    cross, while dots stay countable.
    for (const m of sim.monsters) {
      const reach = Math.hypot(m.posX - player.posX, m.posY - player.posY);
      if (reach > m.senseRange + SENSE_RING_MARGIN) continue;

      const near = Math.max(0, 1 - reach / (m.senseRange + SENSE_RING_MARGIN));
      const alpha = m.attacking ? 0.55 : 0.1 + near * 0.24;
      this.dottedRing(g, m.posX, m.posY, m.senseRange, p.monster[m.kind], alpha, m.attacking ? 2.6 : 2);
      if (m.attacking) {
        // A second, wider ring reads as "locked on" without needing an icon.
        g.lineStyle(1, p.monster[m.kind], 0.14);
        g.strokeCircle(m.posX, m.posY, m.senseRange + 4);
      }
    }

    // 5. The player's reach. Breathing, so it reads as a live stat; stretched by
    //    a swing so the auto-attack has something to show for itself. Gone
    //    entirely once dead — reach is meaningless without a unit to spend it.
    //
    //    Held clearly *below* the sense rings in the hierarchy — they are the
    //    tactic, this is your own stat — but it still has to be visible, and at
    //    the original 0.08-0.20 it simply was not: a green dotted ring at 8%
    //    over a dark floor is nothing, and "how far can I hit" is not a stat the
    //    player should have to infer from a kill.
    if (sim.alive) {
      const swell = this.swing / SWING_S;
      const range = player.attackRange + swell * 7;
      this.dottedRing(
        g,
        player.posX,
        player.posY,
        range,
        p.green,
        0.28 + 0.1 * Math.sin(t * 2.4) + swell * 0.45,
        2.5,
        PLAYER_RING_SPACING,
      );
    }

    // 6. Monsters.
    for (const m of sim.monsters) {
      const color = p.monster[m.kind];
      const rim = p.monsterRim[m.kind];
      const r = MONSTER_RADIUS[m.kind];
      const [vx, vy] = DIR_VECTORS[m.dir];
      const track = this.tracked.get(m.id);
      const flash = track ? track.flash : 0;

      // Halo: two translucent discs instead of a real glow, which is all the
      // Canvas renderer can promise.
      g.fillStyle(color, m.attacking ? 0.2 : 0.11);
      g.fillCircle(m.posX, m.posY, r + 6);

      // A hunter drags a short speed line; it is the only fast monster and the
      // only one whose threat is "it will catch you".
      if (m.kind === "hunter") {
        g.lineStyle(2, color, 0.3);
        g.beginPath();
        g.moveTo(m.posX - vx * (r + 2), m.posY - vy * (r + 2));
        g.lineTo(m.posX - vx * (r + 11), m.posY - vy * (r + 11));
        g.strokePath();
      }

      // Body: a different silhouette per kind, because colour alone stops
      // working the moment two of them overlap.
      this.polygon(g, m.posX, m.posY, r, m.kind === "brute" ? 6 : m.kind === "hunter" ? 4 : 0, m.dir * 0.2);
      g.fillStyle(color, 1);
      g.fillPath();
      g.lineStyle(1.5, rim, 0.9);
      g.strokePath();

      // Inner core, so a body never reads as a flat sticker.
      g.fillStyle(shade(color, -0.4), 1);
      g.fillCircle(m.posX, m.posY, r * 0.42);

      // Facing tick.
      g.lineStyle(2, rim, 0.95);
      g.beginPath();
      g.moveTo(m.posX + vx * r * 0.45, m.posY + vy * r * 0.45);
      g.lineTo(m.posX + vx * (r + 3), m.posY + vy * (r + 3));
      g.strokePath();

      if (m.attacking) {
        // Aggro ring: the one place a pulse earns its keep, since it has to be
        // visible in a crowd.
        g.lineStyle(1.5, rim, 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 11)));
        g.strokeCircle(m.posX, m.posY, r + 4);
      }

      if (flash > 0) {
        g.fillStyle(0xffffff, 0.8 * (flash / HIT_FLASH_S));
        g.fillCircle(m.posX, m.posY, r + 1);
      }

      this.drawHpBar(g, m.posX, m.posY - r - 9, m.hp / m.maxHp, color);
    }

    // 7. Player — or its husk. Death has to change the *body*, not just dim the
    //    frame: a corpse still glowing green under a GAME OVER card reads as a
    //    rendering bug, and it is the last thing the run leaves on screen.
    if (!sim.alive) {
      this.drawHusk(g, player.posX, player.posY, t);
    } else {
      const [pvx, pvy] = DIR_VECTORS[player.dir];

      for (let i = 0; i < this.trail.length; i++) {
        const pt = this.trail[i];
        const f = (i + 1) / this.trail.length;
        g.fillStyle(p.green, 0.16 * f);
        g.fillCircle(pt.x, pt.y, 1.5 + 3.5 * f);
      }

      g.fillStyle(p.green, 0.09);
      g.fillCircle(player.posX, player.posY, PLAYER_RADIUS + 9);
      g.fillStyle(p.green, 0.14);
      g.fillCircle(player.posX, player.posY, PLAYER_RADIUS + 4);

      // Regeneration shimmer: a ring that only exists while hp is actually
      // coming back, so the 3s regen delay is observable rather than a hidden
      // rule. It fades in over the delay instead of snapping on, which is what
      // makes "you are safe now" feel like something rather than nothing.
      if (player.hp < player.maxHp) {
        const regen = Math.min(1, Math.max(0, (sim.sinceDamage - 3) / 0.7));
        if (regen > 0) {
          g.lineStyle(2, p.green, regen * (0.25 + 0.2 * (0.5 + 0.5 * Math.sin(t * 6))));
          g.strokeCircle(player.posX, player.posY, PLAYER_RADIUS + 6);
        }
      }

      if (this.hurt > 0) {
        g.fillStyle(p.red, 0.25 * (this.hurt / HURT_S));
        g.fillCircle(player.posX, player.posY, PLAYER_RADIUS + 10);
      }

      g.fillStyle(0x081108, 1);
      g.fillCircle(player.posX, player.posY, PLAYER_RADIUS + 1.5);
      g.fillStyle(p.green, 1);
      g.fillCircle(player.posX, player.posY, PLAYER_RADIUS);
      g.fillStyle(shade(p.green, 0.55), 1);
      g.fillCircle(player.posX, player.posY, PLAYER_RADIUS * 0.5);
      g.lineStyle(1.5, shade(p.green, 0.7), 0.95);
      g.strokeCircle(player.posX, player.posY, PLAYER_RADIUS);

      g.fillStyle(shade(p.green, 0.6), 1);
      g.fillTriangle(
        player.posX + pvx * (PLAYER_RADIUS + 11),
        player.posY + pvy * (PLAYER_RADIUS + 11),
        player.posX - pvy * 5 + pvx * (PLAYER_RADIUS + 1),
        player.posY + pvx * 5 + pvy * (PLAYER_RADIUS + 1),
        player.posX + pvy * 5 + pvx * (PLAYER_RADIUS + 1),
        player.posY - pvx * 5 + pvy * (PLAYER_RADIUS + 1),
      );
    }

    // 8. The swing, when there is one: a fan of dots out along the facing.
    if (this.swing > 0) {
      const f = this.swing / SWING_S;
      const base = (this.swingDir * Math.PI) / 4;
      g.fillStyle(shade(p.green, 0.5), 0.75 * f);
      for (let i = -4; i <= 4; i++) {
        const a = base + i * 0.16;
        const rr = player.attackRange * (0.55 + 0.45 * (1 - f)) * (1 - Math.abs(i) * 0.05);
        g.fillPoint(player.posX + Math.cos(a) * rr, player.posY + Math.sin(a) * rr, 4);
      }
    }

    // 9. Sparks and shock rings, above everything they came from.
    for (const s of this.sparks) {
      g.fillStyle(s.color, Math.max(0, s.life / s.max));
      g.fillPoint(s.x, s.y, s.size);
    }
    for (const b of this.bursts) {
      const f = b.life / b.max;
      g.lineStyle(b.width * f, b.color, 0.7 * f);
      g.strokeCircle(b.x, b.y, b.r);
    }
  }

  /**
   * Lay down a polygon path and leave it open for fill/stroke.
   *
   * `sides` of 0 means a circle, which is how the wanderer is drawn — the point
   * of the helper is that every body goes through one call site, so the three
   * silhouettes stay a single decision rather than three near-copies.
   */
  private polygon(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    r: number,
    sides: number,
    rotation: number,
  ): void {
    if (sides < 3) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.closePath();
      return;
    }
    g.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = rotation + (i * Math.PI * 2) / sides - Math.PI / 2;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
  }

  /** A circle of dots — a radar sweep, not a wall. */
  private dottedRing(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    radius: number,
    color: number,
    alpha: number,
    size = RING_DOT_SIZE,
    spacing = RING_DOT_SPACING,
  ): void {
    if (alpha <= 0.01 || radius <= 0) return;
    const dots = Math.max(8, Math.round((Math.PI * 2 * radius) / spacing));
    g.fillStyle(color, Math.min(1, alpha));
    for (let i = 0; i < dots; i++) {
      const a = (i / dots) * Math.PI * 2;
      g.fillPoint(x + Math.cos(a) * radius, y + Math.sin(a) * radius, size);
    }
  }

  /**
   * What is left where the player was: a cold disc and a cross.
   *
   * Grey rather than a dimmed green — the read has to be "this unit is gone",
   * not "this unit is in shadow". And tuned *for the death veil* rather than
   * for the bare floor: the husk is only ever drawn while dead, and dead always
   * paints a 0.78 veil over the arena, so a grey picked to look right on its own
   * washes out to nothing underneath it. This one is deliberately several steps
   * lighter than a corpse reads in isolation.
   */
  private drawHusk(g: Phaser.GameObjects.Graphics, x: number, y: number, t: number): void {
    const ash = 0x6b7794;
    // A slow, wide halo so the spot is findable under the death card.
    g.fillStyle(this.palette.red, 0.08 + 0.04 * (0.5 + 0.5 * Math.sin(t * 1.5)));
    g.fillCircle(x, y, PLAYER_RADIUS + 14);

    g.fillStyle(0x11141c, 1);
    g.fillCircle(x, y, PLAYER_RADIUS + 1.5);
    g.fillStyle(ash, 1);
    g.fillCircle(x, y, PLAYER_RADIUS);
    g.lineStyle(1, 0xffffff, 0.16);
    g.strokeCircle(x, y, PLAYER_RADIUS - 0.5);
    // The X is the darkest thing on the disc, matching the collar around it.
    // Contrast is what survives a 0.78 veil: every colour in the arena is
    // scaled to 22% and offset, so a *tonal* difference of this size is the
    // only kind that still reads at the bottom of it.
    g.lineStyle(2.5, 0x11141c, 1);
    const arm = PLAYER_RADIUS * 0.55;
    for (const s of [1, -1]) {
      g.beginPath();
      g.moveTo(x - arm, y - arm * s);
      g.lineTo(x + arm, y + arm * s);
      g.strokePath();
    }
  }

  /** Above a damaged monster only; a full bar is visual noise. */
  private drawHpBar(
    g: Phaser.GameObjects.Graphics,
    cx: number,
    y: number,
    frac: number,
    color: number,
  ): void {
    if (frac >= 1) return;
    const clamped = Math.max(0, frac);
    const x = cx - HP_BAR_W / 2;
    g.fillStyle(0x000000, 0.6);
    g.fillRect(x - 1, y - 1, HP_BAR_W + 2, HP_BAR_H + 2);
    // The fill doubles as the health read: green, amber, red, left to right.
    const fill = clamped > 0.6 ? color : clamped > 0.3 ? 0xd9a441 : 0xe74c3c;
    g.fillStyle(fill, 1);
    g.fillRect(x, y, HP_BAR_W * clamped, HP_BAR_H);
    g.fillStyle(0xffffff, 0.25);
    g.fillRect(x, y, HP_BAR_W * clamped, 1);
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  private resetEffects(): void {
    this.sparks.length = 0;
    this.bursts.length = 0;
    this.trail.length = 0;
    this.tracked.clear();
    this.swing = 0;
    this.hurt = 0;
    this.announceLife = 0;
    this.announce.setVisible(false);
    for (const f of this.floaters) {
      f.life = 0;
      f.label.setVisible(false);
    }
  }

  /**
   * Turn this frame's *differences* into effects.
   *
   * The sim sends no events — it is pure and stays pure — so the scene diffs
   * the state it already holds. Every effect here therefore has exactly one
   * possible cause, and `sim.ts` never learns that it is being watched.
   */
  private observe(before: { hp: number; cooldown: number; level: number }): void {
    const sim = this.sim;
    if (!sim) return;
    const p = this.palette;
    const player = sim.player;

    // Damage to the player: vignette + a shock ring, so a hit registers even
    // when the eye is on the other side of the arena.
    if (player.hp < before.hp) {
      this.hurt = HURT_S;
      this.bursts.push({
        x: player.posX,
        y: player.posY,
        r: PLAYER_RADIUS,
        maxR: PLAYER_RADIUS + 26,
        life: 0.32,
        max: 0.32,
        color: p.red,
        width: 2.5,
      });
    }

    // A swing: `attackCooldown` only ever jumps *up*, when the auto-attack
    // fires. Cheap, exact, and needs nothing from the sim.
    if (sim.attackCooldown > before.cooldown) {
      this.swing = SWING_S;
      this.swingDir = player.dir;
    }

    if (sim.level > before.level) {
      this.announce.setText(`LEVEL ${sim.level}`).setAlpha(0).setVisible(true);
      this.announceLife = ANNOUNCE_S;
      this.bursts.push({
        x: player.posX,
        y: player.posY,
        r: PLAYER_RADIUS,
        maxR: 90,
        life: 0.6,
        max: 0.6,
        color: p.green,
        width: 3,
      });
    }

    // Monsters: mark everything still alive, then sweep. A `stamp` beats a Set
    // here because the sweep is the only allocation-free way to notice that an
    // id the map still holds has stopped appearing in the list.
    this.stamp++;
    for (const m of sim.monsters) {
      let track = this.tracked.get(m.id);
      if (!track) {
        track = { x: m.posX, y: m.posY, kind: m.kind, hp: m.hp, flash: 0, stamp: this.stamp };
        this.tracked.set(m.id, track);
        continue;
      }
      if (m.hp < track.hp) {
        track.flash = HIT_FLASH_S;
        this.spray(m.posX, m.posY, p.monsterRim[m.kind], 3, 60);
      }
      track.x = m.posX;
      track.y = m.posY;
      track.kind = m.kind;
      track.hp = m.hp;
      track.stamp = this.stamp;
    }

    for (const [id, track] of this.tracked) {
      if (track.stamp === this.stamp) continue;
      this.tracked.delete(id);
      const color = p.monster[track.kind];
      this.spray(track.x, track.y, color, track.kind === "brute" ? 16 : 9, 140);
      this.bursts.push({
        x: track.x,
        y: track.y,
        r: MONSTER_RADIUS[track.kind],
        maxR: MONSTER_RADIUS[track.kind] + 22,
        life: 0.3,
        max: 0.3,
        color,
        width: 2,
      });
      this.spawnFloater(
        `+${MONSTER_ARCHETYPES[track.kind].drop}`,
        track.x,
        track.y - MONSTER_RADIUS[track.kind] - 4,
        p.accent,
      );
    }
  }

  /** A puff of dots radiating from a point. */
  private spray(x: number, y: number, color: number, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.sparks.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: 0.4,
        max: 0.4,
        size: 1 + Math.random() * 2.5,
        color,
      });
    }
  }

  /** Take a free `Text` from the pool and send it floating up. */
  private spawnFloater(text: string, x: number, y: number, color: number): void {
    // The oldest floater yields rather than the newest being dropped: a burst
    // of kills should never swallow the number the player is reading.
    let slot = this.floaters.find((f) => f.life <= 0);
    if (!slot) {
      slot = this.floaters.reduce((a, b) => (a.life <= b.life ? a : b));
    }
    slot.x = x;
    slot.y = y;
    slot.vy = -34;
    slot.life = 0.9;
    slot.max = 0.9;
    slot.label.setText(text).setColor(intToCss(color)).setPosition(x, y).setAlpha(1).setVisible(true);
  }

  /** Advance everything transient. `dt` is already clamped by the caller. */
  private stepEffects(dt: number): void {
    this.clock += dt;
    if (this.swing > 0) this.swing = Math.max(0, this.swing - dt);
    if (this.hurt > 0) this.hurt = Math.max(0, this.hurt - dt);

    for (const s of this.sparks) {
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      // Drag, so a burst decelerates instead of sliding off the arena.
      s.vx *= 1 - Math.min(1, dt * 6);
      s.vy *= 1 - Math.min(1, dt * 6);
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      if (this.sparks[i].life <= 0) this.sparks.splice(i, 1);
    }

    for (const b of this.bursts) {
      b.life -= dt;
      const f = Math.max(0, b.life / b.max);
      b.r = b.maxR - (b.maxR - b.r) * f;
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      if (this.bursts[i].life <= 0) this.bursts.splice(i, 1);
    }

    for (const track of this.tracked.values()) {
      if (track.flash > 0) track.flash = Math.max(0, track.flash - dt);
    }

    for (const f of this.floaters) {
      if (f.life <= 0) continue;
      f.life -= dt;
      f.y += f.vy * dt;
      f.label.setPosition(f.x, f.y).setAlpha(Math.min(1, f.life / (f.max * 0.5)));
      if (f.life <= 0) f.label.setVisible(false);
    }

    if (this.announceLife > 0) {
      this.announceLife -= dt;
      const f = Math.max(0, this.announceLife / ANNOUNCE_S);
      this.announce.setAlpha(Math.min(1, f * 2.5));
      if (this.announceLife <= 0) this.announce.setVisible(false);
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
    // The sim clamps its own step; clamping here too keeps the *effect* clocks
    // on the same timeline as the simulation they are illustrating.
    const dt = Math.min(Math.max(delta / 1000, 0), 0.05);

    const sim = this.sim;
    if (sim && !this.paused) {
      if (sim.alive) {
        const before = {
          hp: sim.player.hp,
          cooldown: sim.attackCooldown,
          level: sim.level,
        };
        stepSim(sim, this.readInput(), dt);
        this.observe(before);

        const last = this.trail[this.trail.length - 1];
        if (!last || Math.hypot(last.x - sim.player.posX, last.y - sim.player.posY) > 3) {
          this.trail.push({ x: sim.player.posX, y: sim.player.posY });
          if (this.trail.length > TRAIL_MAX) this.trail.shift();
        }
      } else if (this.overlayKind !== "dead") {
        // Death is drawn the moment it happens rather than waiting for the 4 Hz
        // stats tick to route it back through `GameState` — that round trip is
        // up to 250ms of a live-looking arena after the run has already ended.
        this.setOverlay("dead");
      }
    }

    this.stepEffects(dt);
    this.fitCamera();
    this.drawFrame();
  }
}
