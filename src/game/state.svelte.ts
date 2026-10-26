// Game tab state — one instance per `<Game>` mount, mirroring `HexState`.
//
// There is one clock here now, and it belongs to the scene: the **simulation**
// clock. `scene.setPaused()` stops the sim step, and with it the survival timer
// and every respawn timer.
//
// The key has no clock of its own. It is a pure function of the live world
// (design §3.4): the scene calls `onFrame` at the end of each `update()`, this
// samples the sim it just stepped, and a world identical to the last one
// submitted produces nothing. No timer, no rate constant — a busy world streams
// keys at the frame rate and a still one produces none.
//
// "暂停 = 停止搜索" (design §8) therefore needs no second switch. `syncStatus()`
// is still the single place that decides a pause, but it only has to stop the
// *simulation*: a frozen sim is a frozen key stream, structurally.
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
import { gameBaseBytes, keyHexFromBase, type GameKeyBytes } from "./keymap";
import type { RobotIntent } from "./robot";
import { GameScene } from "./scenes/GameScene";
import type { ItemKind } from "./types";

/**
 * How often the key readout and the byte strip are repainted, in ms.
 *
 * Sampling runs as fast as the IPC allows; *display* does not. The two are
 * different jobs: `keysScanned` is a cost counter and wants every key, while
 * the byte strip is 20-odd DOM nodes and the address card above it — at 60 Hz
 * that is an unreadable blur, and it competes with the canvas for the main
 * thread the synchronous `derive_group` call is already using.
 */
const DISPLAY_MS = 100;

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
  /** XP banked toward the next level, and that level's price. */
  xp = $state(0);
  xpNext = $state(100);
  hp = $state(0);
  maxHp = $state(0);
  kills = $state(0);
  /** Potions collected this run, per kind (design §8.3). */
  pickups = $state<Record<ItemKind, number>>({ heal: 0, power: 0, agility: 0, vitality: 0 });
  /**
   * Keys actually sampled this run — the real cost of the run, not a rate.
   * Counts every derived key, including the ones the display throttle skips.
   */
  keysScanned = $state(0);

  // ── Auto-play (design §14) ───────────────────────────────────────────────
  /** False = manual (WASD), true = the robot drives. */
  robot = $state(false);
  /** What the robot is doing right now, or null in manual mode (§14.4). */
  robotIntent = $state<RobotIntent | null>(null);
  /** Monsters it currently has stats for, out of how many it can see (§14.1). */
  robotKnown = $state(0);
  robotSeen = $state(0);

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
  /**
   * The free bytes of the last state handed to the backend, joined into one
   * string so a frame can compare them with `===`. Empty means "nothing
   * submitted yet in this run" — reset at every run boundary, never on a pause,
   * because a pause must not manufacture a key on the way back out.
   */
  private lastBase = "";
  /** True while a `derive_group` call is outstanding. */
  private inFlight = false;
  /**
   * `performance.now()` at the last repaint of the key readout. 0 means "nothing
   * painted yet", which is the initial value *and* what every run boundary
   * resets it to, so a run's first key can never be throttled out of the panel.
   */
  private lastPaint = 0;

  // Arrow-function fields so `off()` can be handed the identical reference.
  private onStats = (stats: GameStats) => {
    this.frames = stats.frames;
    this.fps = Math.round(stats.fps);
    this.level = stats.level;
    this.xp = stats.xp;
    this.xpNext = stats.xpNext;
    this.hp = stats.hp;
    this.maxHp = stats.maxHp;
    this.kills = stats.kills;
    this.pickups = stats.pickups;
    this.robotIntent = stats.robotIntent;
    this.robotKnown = stats.robotKnown;
    this.robotSeen = stats.robotSeen;
    // Death lands here first (the feed is 4 Hz). `syncStatus()` reads it back
    // off the live scene and does the bookkeeping.
    this.syncStatus();
  };

  private onReady = () => {
    this.engineReady = true;

    // The key's trigger, installed once. Phaser's `SceneManager` boots the
    // scenes off this same READY event and subscribes first, so the scene
    // exists by the time this runs.
    const scene = this.scene();
    if (scene) {
      scene.onFrame = this.onFrame;
      // The mode control is not gated on READY, so a pick made while the engine
      // was still booting would otherwise be lost — leaving the HUD announcing
      // robot mode while the scene went on reading the keyboard.
      scene.setRobotMode(this.robot);
    }

    this.resize();
    // A tab switch can land before READY, so reconcile rather than assume.
    this.syncStatus();
  };

  /**
   * The key sampler (design §9.4) — the scene calls this once per frame, after
   * it has stepped the sim.
   *
   * There is no timer behind this and no rate constant in front of it. A frame
   * either produced a world that has not been submitted yet or it did not;
   * everything else — the pause, the tab switch, the death, the match — is
   * already resolved by the time this is reached, because all of them freeze
   * the simulation and a frozen simulation repeats itself.
   */
  private onFrame = (): void => {
    const scene = this.scene();
    const puzzle = this.puzzle;
    if (!scene || !puzzle || !this.canSample()) return;

    const snap = scene.currentSnapshot();
    if (!snap) return;

    const base = gameBaseBytes(snap, puzzle);

    // Compared against the *free bytes*, never the finished key: `randomTopByte`
    // is a fresh CSPRNG draw on every call (`src/hex/range.ts`), so two keys
    // over an identical world always differ. Key hex against key hex would call
    // a frozen world new on every frame and submit forever — including while
    // paused, which is exactly what must not happen.
    const sig = base.baseBytes.join("");
    if (sig === this.lastBase) return;

    // Mid-flight: rather than queue this, do nothing and let `submit()` look at
    // the world again when it lands. A queued state is strictly older than
    // whatever is current then, so there is nothing here worth remembering.
    if (this.inFlight) return;

    this.lastBase = sig;
    void this.submit(puzzle, base);
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
    // The scene dies with the game, so there is nothing to detach — but a
    // result can still be in flight, and it must not paint itself into a tab
    // that is gone.
    this.generation++;
    this.lastBase = "";
    this.lastPaint = 0;
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
    this.lastBase = "";
    // Grouped with `lastBase` because it is the same kind of state: both
    // describe one run, and either left stale would act on the next one.
    this.lastPaint = 0;

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

  /**
   * Switch between manual and robot play (design §14.3, requirement 3).
   *
   * A mode switch is a different game, so it resets everything a run owns —
   * arena, player, level, kills, keys — and lands in READY rather than running.
   * Resetting rather than resuming is the point: the two modes are not
   * interchangeable mid-run, and a robot taking over a half-played human run (or
   * the reverse) would be scoring a game neither of them played.
   *
   * It goes through `restart()` rather than repeating the reset, so a mode
   * switch and a post-death ▶ cannot drift apart. `bestSurvival` deliberately
   * survives, exactly as it does across a death and restart.
   */
  setMode(on: boolean): void {
    if (on === this.robot) return;
    this.robot = on;
    const scene = this.scene();
    // Before the restart, so the arena built below is already the new mode's.
    scene?.setRobotMode(on);

    this.running = false;
    if (this.puzzle && scene) this.restart();
    this.robotIntent = null;
    this.robotKnown = 0;
    this.robotSeen = 0;
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
    // A new run is a new world, and its first state has to be submitted even if
    // it happens to hash the same way the last run's did.
    this.lastBase = "";
    this.lastPaint = 0;
    scene.startRun();
    this.hasRun = true;
    this.alive = true;
    this.survival = 0;
    this.keysScanned = 0;
    this.info = null;
    this.baseBytes = [];
    this.owners = [];
    this.error = "";
    // A new run is level 1 with nothing killed, and saying so immediately keeps
    // the HUD honest for the up-to-250ms before the next stats tick arrives —
    // otherwise a fresh run briefly shows the level and kill count of the run
    // that just ended, which is the one moment a user is most likely to look.
    this.level = 1;
    this.xp = 0;
    this.kills = 0;
    this.pickups = { heal: 0, power: 0, agility: 0, vitality: 0 };
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

    // No key switch to flip here any more. `running` and `setPaused()` above
    // are the whole of it: the sampler reads the sim, so a sim that is not
    // running is a sampler with nothing to send.
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

  /**
   * Whether a world state may be handed to the backend right now.
   *
   * This is the old `shouldTick()`, and it is still load-bearing: the scene
   * calls `onFrame` on every frame it renders, including the frames of a run
   * that is armed (READY) but not started. Those frames are frozen, but they
   * are the *first* state of a run, so they differ from `lastBase` and would
   * submit one key before ▶ — which requirement 1 forbids.
   */
  private canSample(): boolean {
    return this.engineReady && this.active && this.running && !this.matched;
  }

  // ── The key sampler, part two: the IPC round-trip ────────────────────────
  //
  // [imperative] An `await`, not an `$effect`: the pause between keys is how
  // long the backend takes, and that await *is* the backpressure. An `$effect`
  // reading reactive state here would fire on every HUD write.

  /** One sample: key → derive_group → match check. Never throws. */
  private async submit(puzzle: PuzzleInfo, base: GameKeyBytes): Promise<void> {
    this.inFlight = true;
    const keyHex = keyHexFromBase(puzzle, base);
    const gen = this.generation;

    try {
      const results = await deriveGroup([keyHex], "game (group)");
      // A restart or a selection change can land during the await, and those
      // are the only two that invalidate this result: both replace the world
      // wholesale, so a key from before them belongs to a run that is gone.
      //
      // A pause, a death or a match deliberately does *not* invalidate it. None
      // of them changes the world — they only stop it — so this key came from
      // exactly the state the arena is now frozen on and is consistent with
      // what is on screen. What a pause must prevent is *starting* the next
      // submission, and `canSample()` does that at `onFrame`'s door.
      if (gen !== this.generation) return;

      const info = results[0];
      if (!info) return;

      this.error = "";
      this.keysScanned++;

      // The cost counter above is exact; the readout is throttled. See
      // `DISPLAY_MS` — the two are answering different questions. A match is
      // exempt: the key that won is the one key that must never be throttled
      // out of the panel it is about to be celebrated in.
      const now = performance.now();
      if (info.address_match === true || now - this.lastPaint >= DISPLAY_MS) {
        this.lastPaint = now;
        this.info = info;
        this.baseBytes = base.baseBytes;
        this.owners = base.owners;
      }

      if (info.address_match === true) this.handleMatch(info);
    } catch (e) {
      // A *failing* call is invalidated by a run boundary exactly as a
      // successful one is, and this guard is the whole of that: without it a
      // rejection from the previous run writes `error` on top of the run that
      // replaced it. That is not a cosmetic mistake — `error` is the first thing
      // `computeStatus()` reads, so the new run would come up frozen on a
      // failure it never had, with the ▶ button inert behind it.
      if (gen !== this.generation) return;
      this.error = String(e);
      this.running = false;
      this.syncStatus();
    } finally {
      this.inFlight = false;
      // Coalescing, and the whole of it: rather than remember what arrived
      // mid-flight, look at the world again. Whatever is there now is newer
      // than anything that could have been queued, and the comparison in
      // `onFrame` drops it if the world has not actually moved since.
      //
      // A match or a pause lands here too, and `onFrame`'s own gate is what
      // stops either being followed by one more submission.
      this.onFrame();
    }
  }

  /**
   * A match: freeze everything, then let the reused banner celebrate.
   *
   * The private key is already on disk — `derive_group` persists every hit
   * through the shared `matches` writer (src-tauri/src/matches.rs), which is
   * exactly why the game routes through it instead of `derive_full` (display
   * only, never persists).
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
