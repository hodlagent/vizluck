// Game tab state — one instance per `<Game>` mount, mirroring `HexState`.
//
// The split that matters: everything Phaser owns is a plain field, and the only
// things that reach `$state` are the handful of numbers the HUD prints, pushed
// at STATS_INTERVAL_MS. Writing them per frame instead would run 60 reactivity
// passes a second for a number nobody can read that fast.

import Phaser from "phaser";
import { GAME_STATS, gameConfig, type GameStats } from "./config";
import { BootScene } from "./scenes/BootScene";

export type GameStatus = "idle" | "booting" | "running" | "paused" | "error";

export class GameState {
  // ── Reactive: HUD numbers only, written on the scene's throttle ──────────
  status = $state<GameStatus>("idle");
  frames = $state(0);
  fps = $state(0);
  error = $state("");

  // ── Not reactive: the engine and everything Phaser touches ───────────────
  private game: Phaser.Game | null = null;
  private host: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Desired running state; can arrive before the engine has finished booting. */
  private active = false;
  /** Set once Phaser has emitted READY — before that `pause()`/`resize()` are meaningless. */
  private ready = false;

  // Arrow-function fields so `off()` can be handed the identical reference.
  private onStats = (stats: GameStats) => {
    this.frames = stats.frames;
    this.fps = Math.round(stats.fps);
  };

  private onReady = () => {
    this.ready = true;
    this.resize();
    // A tab switch can land before READY, so reconcile rather than assume.
    this.syncStatus();
  };

  /**
   * The single place `status` is decided. Setting it at each call site instead
   * is how you end up with a game that is genuinely paused but labelled
   * "running": `$effect` pauses before READY, then READY re-labels it and the
   * second pause is a no-op because the engine is already paused.
   */
  private syncStatus(): void {
    const game = this.game;
    if (!this.ready || !game) return;
    if (this.active) {
      if (game.isPaused) game.resume();
    } else if (!game.isPaused) {
      game.pause();
    }
    this.status = this.active ? "running" : "paused";
  }

  mount(host: HTMLElement): void {
    this.host = host;
    this.status = "booting";

    // `game.destroy(true)` is asynchronous — it tears down on the next frame.
    // Under Vite HMR a remount can race the previous teardown and leave two
    // canvases stacked in the host, so clear the host before booting.
    host.replaceChildren();

    try {
      this.game = new Phaser.Game(gameConfig(host, [BootScene]));
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
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.host = null;
    this.ready = false;

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
   * background), and the document stays visible when we switch tabs. Without
   * this call a hidden Game tab keeps rendering next to the GPU scanner.
   */
  setActive(on: boolean): void {
    this.active = on;
    this.syncStatus();
  }

  private resize(): void {
    const game = this.game;
    const host = this.host;
    if (!this.ready || !game || !host) return;

    // A hidden panel is `display: none`, so both are 0 while the Hex tab is
    // showing. Resizing to 0 would wedge the renderer; the ResizeObserver fires
    // again with real dimensions once the tab becomes visible.
    const { clientWidth: w, clientHeight: h } = host;
    if (w === 0 || h === 0) return;

    game.scale.resize(w, h);
  }
}
