// Game tab state — one instance per `<Game>` mount, mirroring `HexState`.
//
// Two clocks live here, and keeping them apart is most of the design:
//
//   * the **simulation** clock, which the scene owns. `scene.setPaused()` stops
//     the sim step, and with it the survival timer and every respawn timer.
//   * the **key** clock, which is `loop()` below. It samples the live sim,
//     turns it into a private key and asks the backend to match it.
//
// "暂停 = 停止搜索" (design §8) means a pause has to stop *both*, so
// `syncStatus()` is the single place that decides, and nothing else pauses the
// scene or touches the key loop.
//
// The scene keeps *rendering* through all of it. Only the engine's own
// `pause()` — which stops the renderer as well — is still used, and only while
// the tab is off screen.

import Phaser from "phaser";
import { deriveGroup, getPuzzles } from "../hex/api";
import type { KeyInfo, PuzzleInfo } from "../hex/types";
import {
  GAME_STATS,
  SCENE_KEY,
  gameConfig,
  type GameOverlay,
  type GameStats,
} from "./config";
import { gameKeyHex } from "./keymap";
import { GameScene } from "./scenes/GameScene";
import { keyRateFor } from "./sim";

/** Floor on the gap between key ticks, so a huge hashpower can't flood the IPC. */
const MIN_TICK_MS = 20;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * Which full-screen message the arena should be showing.
 *
 * The three states that need one are exactly the three where the picture *is*
 * the feedback: a run armed but not started, a run deliberately halted, and a
 * run that ended. `matched` and `error` are already announced loudly in the DOM
 * and would only be buried by a panel across the arena.
 */
function overlayForStatus(status: GameStatus): GameOverlay {
  switch (status) {
    case "ready":
      return "ready";
    case "paused":
      return "paused";
    case "dead":
      return "dead";
    default:
      return "none";
  }
}

export type GameStatus =
  | "idle"
  | "booting"
  | "ready"
  | "running"
  | "paused"
  | "dead"
  | "matched"
  | "error";

export class GameState {
  // ── Selection ────────────────────────────────────────────────────────────
  puzzles = $state<PuzzleInfo[]>([]);
  /** `<select>` value: a puzzle number as a string, or "" for the placeholder. */
  selected = $state("");

  /** The chosen puzzle, or null while the placeholder is selected. */
  puzzle = $derived(this.puzzles.find((p) => String(p.puzzle_number) === this.selected) ?? null);

  // ── Run intent + status ──────────────────────────────────────────────────
  /** The user's intent, not the engine's state — see `syncStatus()`. */
  running = $state(false);
  status = $state<GameStatus>("idle");
  error = $state("");

  // ── HUD numbers (throttled by the scene) ─────────────────────────────────
  frames = $state(0);
  fps = $state(0);
  survival = $state(0);
  bestSurvival = $state(0);
  alive = $state(false);
  level = $state(1);
  hp = $state(0);
  maxHp = $state(0);
  kills = $state(0);
  hashpower = $state(0);
  /** Keys actually sampled this run — the real cost of the run, not a rate. */
  keysScanned = $state(0);

  // ── Key output ───────────────────────────────────────────────────────────
  /** Latest sampled key's full info, shown in the reused AddrInfoPanel. */
  info = $state<KeyInfo | null>(null);
  /** The `b - 1` free bytes the game is driving, as 2-char hex. */
  baseBytes = $state<string[]>([]);
  /** Who owns each of those bytes (design §10.2). Parallel to `baseBytes`. */
  owners = $state<string[]>([]);

  // ── Match ────────────────────────────────────────────────────────────────
  matched = $state(false);
  matchBanner = $state<string | null>(null);
  /** Bumped per match so the banner remounts (and re-fires the confetti). */
  matchSeq = $state(0);

  /**
   * Requirement 1: the game cannot start before a puzzle is chosen — without
   * one there is no byte layout, so there is nothing to sample. A match locks
   * it too, so a celebration cannot be overwritten by a stray click.
   *
   * Declared down here, after both of the fields it reads: class field
   * initializers run in source order, so a `$derived` above its inputs is a
   * "used before its initialization" error.
   */
  canRun = $derived(this.puzzle !== null && !this.matched);

  // ── Not reactive: the engine, and everything Phaser or a timer touches ───
  private game: Phaser.Game | null = null;
  private host: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Whether the Game tab is the visible one. */
  private active = false;
  /** Set once Phaser has emitted READY — before that `pause()` is meaningless. */
  private engineReady = false;
  /** True once a run has been created. Distinguishes "ready" from "dead". */
  private hasRun = false;
  /** Bumped on every new run so results in flight are dropped. */
  private generation = 0;
  private ticking = false;
  private tickTimer: number | null = null;

  // Arrow-function fields so `off()` can be handed the identical reference.
  private onStats = (stats: GameStats) => {
    this.frames = stats.frames;
    this.fps = Math.round(stats.fps);
    this.level = stats.level;
    this.hp = stats.hp;
    this.maxHp = stats.maxHp;
    this.kills = stats.kills;
    this.hashpower = stats.hashpower;
    // Death lands here first (the feed is 4 Hz). `syncStatus()` reads it back
    // off the live scene and does the bookkeeping.
    this.syncStatus();
  };

  private onReady = () => {
    this.engineReady = true;
    this.resize();
    // A tab switch can land before READY, so reconcile rather than assume.
    this.syncStatus();
  };

  // ── Lifecycle ────────────────────────────────────────────────────────────

  mount(host: HTMLElement): void {
    this.host = host;
    this.status = "booting";

    // `game.destroy(true)` is asynchronous — it tears down on the next frame.
    // Under Vite HMR a remount can race the previous teardown and leave two
    // canvases stacked in the host, so clear the host before booting.
    host.replaceChildren();

    try {
      this.game = new Phaser.Game(gameConfig(host, [GameScene]));
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      return;
    }

    this.game.events.on(GAME_STATS, this.onStats);
    this.game.events.once(Phaser.Core.Events.READY, this.onReady);

    // Phaser is deliberately left on `Scale.NONE`, so sizing is ours to drive.
    // The observer also catches the `display: none` -> visible transition when
    // the Game tab is opened, which is when the host first has real dimensions.
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
  }

  unmount(): void {
    this.stopTick();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.host = null;
    this.engineReady = false;
    this.hasRun = false;

    const game = this.game;
    this.game = null;
    if (game) {
      game.events.off(GAME_STATS, this.onStats);
      game.events.off(Phaser.Core.Events.READY, this.onReady);
      game.destroy(true);
    }
    this.status = "idle";
  }

  /**
   * The tab's pause protocol. `App.svelte` keeps both panels mounted and only
   * toggles `hidden`, which Phaser cannot see: its built-in visibility handling
   * watches `document.visibilitychange` (the whole window going to the
   * background), and the document stays visible when we switch tabs.
   *
   * Requirement 1 makes this stricter than the Hex tab: switching away clears
   * the *run intent* too, so coming back shows ▶ and needs a deliberate click.
   * The Hex tab, by contrast, deliberately keeps scanning in the background.
   */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (!on) this.running = false;
    this.syncStatus();
  }

  // ── Controls ─────────────────────────────────────────────────────────────

  /** The dropdown changed. Selection is what gates the run button. */
  onSelect(raw: string): void {
    if (this.matched) return; // locked once a match is on screen
    this.selected = raw;
    this.running = false;
    this.generation++;
    this.stopTick();

    // Changing the puzzle invalidates the run: a new byte layout means the
    // arena's history no longer maps to anything.
    const scene = this.scene();
    scene?.clearRun();
    this.hasRun = false;
    this.alive = false;
    this.survival = 0;
    this.keysScanned = 0;
    this.info = null;
    this.baseBytes = [];
    this.owners = [];
    this.error = "";

    // Pre-build the arena so the player can see what they are about to walk
    // into. It stays frozen at the first frame until ▶ — that is the READY
    // state in design §8, not an accident.
    if (this.puzzle && scene) {
      scene.startRun();
      this.hasRun = true;
      this.alive = true;
    }
    this.syncStatus();
  }

  /** ▶ / ⏸. Also the restart button after a death. */
  toggle(): void {
    if (!this.canRun) return;
    if (this.running) {
      this.running = false;
    } else {
      if (!this.alive) this.restart();
      this.running = true;
    }
    this.syncStatus();
  }

  private restart(): void {
    const scene = this.scene();
    if (!scene) return;
    this.generation++;
    this.stopTick();
    scene.startRun();
    this.hasRun = true;
    this.alive = true;
    this.survival = 0;
    this.keysScanned = 0;
    this.info = null;
    this.baseBytes = [];
    this.owners = [];
    this.error = "";
  }

  async copyText(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      this.error = `failed to copy ${label}`;
    }
  }

  // ── The single decision point ────────────────────────────────────────────

  /**
   * Reconcile `running`, the engine's pause state, the key loop and `status`.
   *
   * Everything that can change any of them funnels through here — tab switch,
   * button, selection, match, the 4 Hz stats feed. Setting status at each call
   * site instead is how you end up with a game that is genuinely paused but
   * labelled "running".
   */
  private syncStatus(): void {
    this.syncLive();

    // Death ends the run: freeze the intent and bank the score. Both halves
    // matter — without `running = false` the ▶ button would keep claiming a
    // dead run is running, and the key loop would sample a frozen sim forever.
    if (this.hasRun && !this.alive && this.running) {
      this.running = false;
      this.bestSurvival = Math.max(this.bestSurvival, this.survival);
    }

    // Resolve the status first, because the arena's full-screen message is
    // derived from it.
    const status = this.computeStatus();
    const scene = this.scene();
    scene?.setOverlay(overlayForStatus(status));

    // Two pauses, and they are not the same pause.
    //
    //   * the *simulation* stops whenever the run is not actually running —
    //     that is requirement 1 and design §8, and it is `setPaused()`.
    //   * the *engine* stops only when the tab is off screen. A hidden panel is
    //     `display: none`, so its frames are invisible and painting them would
    //     burn the GPU right next to the scanner (see `App.svelte`).
    //
    // `game.pause()` used to cover both, which also stopped the renderer while
    // the tab *was* visible. The engine is paused from boot until the first tab
    // switch, so the very first frame was never painted and the arena showed up
    // black — and because resizing a canvas clears it, no later draw while
    // paused survived either.
    const simRunning = this.active && this.running && !this.matched;
    scene?.setPaused(!simRunning);

    const game = this.game;
    if (game && this.engineReady) {
      if (this.active) {
        if (game.isPaused) game.resume();
      } else if (!game.isPaused) {
        game.pause();
      }
    }

    if (this.shouldTick()) this.ensureTick();
    else this.stopTick();

    this.status = status;
  }

  /**
   * Pull survival/alive off the live sim rather than off the throttled stats.
   *
   * The stats feed is 4 Hz, and a user who pauses within one interval of dying
   * would otherwise leave a dead run labelled "paused" and re-startable in
   * place. The scene is the truth; this is the read.
   */
  private syncLive(): void {
    const scene = this.scene();
    if (!scene) return;
    if (scene.hasRun()) {
      this.hasRun = true;
      this.survival = scene.elapsed();
    }
    this.alive = scene.isAlive();
    if (this.survival > this.bestSurvival) this.bestSurvival = this.survival;
  }

  private computeStatus(): GameStatus {
    if (this.error) return "error";
    if (this.matched) return "matched";
    if (!this.puzzle) return "idle";
    if (!this.engineReady) return "booting";
    if (this.running) return "running";
    if (this.hasRun && !this.alive) return "dead";
    return this.survival > 0 ? "paused" : "ready";
  }

  private shouldTick(): boolean {
    return this.engineReady && this.active && this.running && !this.matched;
  }

  // ── The key clock ────────────────────────────────────────────────────────
  //
  // [imperative] A `while` loop over an await, not an `$effect`: the interval
  // depends on the run's hashpower, which only exists inside the simulation,
  // and the await of the IPC round-trip *is* the backpressure. An `$effect`
  // reading reactive state here would fire on every HUD write.

  private ensureTick(): void {
    if (this.ticking) return;
    this.ticking = true;
    void this.loop();
  }

  private stopTick(): void {
    this.ticking = false;
    if (this.tickTimer !== null) {
      window.clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private async loop(): Promise<void> {
    while (this.ticking) {
      const started = performance.now();
      await this.tickOnce();
      if (!this.ticking) return;

      // Target the rate the run has earned, minus what the IPC just cost, so a
      // slow round-trip throttles the rate rather than stacking requests.
      const interval = 1000 / keyRateFor(this.hashpower);
      const wait = Math.max(MIN_TICK_MS, interval - (performance.now() - started));
      await sleep(wait);
    }
  }

  /** One sample: sim → key → match check. Never throws. */
  private async tickOnce(): Promise<void> {
    const scene = this.scene();
    const puzzle = this.puzzle;
    if (!scene || !puzzle) return;

    // Requirement 6, the whole point: read the scene *now*, map it to bytes,
    // and hand the result to the same command the Hex tab's group mode uses.
    const snap = scene.currentSnapshot();
    if (!snap) return;

    const { keyHex, baseBytes, owners } = gameKeyHex(snap, puzzle);
    const gen = this.generation;

    try {
      const results = await deriveGroup([keyHex]);
      // A restart, a selection change or a pause can all land during the await.
      if (gen !== this.generation || !this.ticking) return;

      const info = results[0];
      if (!info) return;

      this.error = "";
      this.keysScanned++;
      this.info = info;
      this.baseBytes = baseBytes;
      this.owners = owners;

      if (info.address_match === true) this.handleMatch(info);
    } catch (e) {
      this.error = String(e);
      this.running = false;
      this.syncStatus();
    }
  }

  /**
   * A match: freeze everything, then let the reused banner celebrate.
   *
   * The private key is already on disk — `derive_group` is the one command
   * that calls `save_match` (src-tauri/src/homepage.rs), which is exactly why
   * the game routes through it instead of `derive_full`.
   */
  private handleMatch(info: KeyInfo): void {
    this.matched = true;
    this.running = false;
    this.info = info;
    this.matchBanner = info.save_path ?? "";
    this.matchSeq++;
    this.bestSurvival = Math.max(this.bestSurvival, this.survival);
    this.syncStatus();
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    try {
      const puzzles = await getPuzzles();
      this.puzzles = puzzles.sort((a, b) => a.puzzle_number - b.puzzle_number);
    } catch (e) {
      this.error = `failed to load puzzles: ${e}`;
      this.status = "error";
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private scene(): GameScene | null {
    const game = this.game;
    if (!game || !this.engineReady) return null;
    // Returns undefined rather than null when the scene has not been created
    // yet, despite what the type says.
    return game.scene.getScene<GameScene>(SCENE_KEY) ?? null;
  }

  private resize(): void {
    const game = this.game;
    const host = this.host;
    if (!this.engineReady || !game || !host) return;

    // A hidden panel is `display: none`, so both are 0 while the Hex tab is
    // showing. Resizing to 0 would wedge the renderer; the ResizeObserver fires
    // again with real dimensions once the tab becomes visible.
    const { clientWidth: w, clientHeight: h } = host;
    if (w === 0 || h === 0) return;

    game.scale.resize(w, h);
  }
}
