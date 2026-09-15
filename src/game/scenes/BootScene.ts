// The Game tab's only scene. It exists to prove the loop runs and the lifecycle
// is wired correctly — no game logic lives here yet. Monsters, respawn timers,
// collision and the survival clock all land in the game-design phase.
//
// [imperative] `update()` is a callback over time, not a value, so the frame
// counter stays a plain field. Publishing it to Svelte state every frame would
// mean 60 reactivity passes a second for a number nobody can read that fast;
// the timer below throttles it to the rate the HUD is actually legible at.

import Phaser from "phaser";
import { GAME_STATS, type GameStats } from "../config";

/** How often the scene hands fresh numbers to the HUD. */
const STATS_INTERVAL_MS = 250;

export class BootScene extends Phaser.Scene {
  /** Plain field on purpose — see the note at the top of this file. */
  private frames = 0;

  constructor() {
    super("Boot");
  }

  create(): void {
    this.time.addEvent({
      delay: STATS_INTERVAL_MS,
      loop: true,
      callback: () => {
        const stats: GameStats = {
          frames: this.frames,
          fps: this.game.loop.actualFps,
        };
        this.game.events.emit(GAME_STATS, stats);
      },
    });
  }

  // Both unused; `_`-prefixed because tsconfig sets `noUnusedParameters`.
  update(_time: number, _delta: number): void {
    this.frames++;
  }
}
