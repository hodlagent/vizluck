// Phaser configuration for the Game tab.
//
// A function rather than a module constant: the parent element comes from the
// mount, and the colours are read from the live stylesheet rather than being
// duplicated here.

import Phaser from "phaser";

/** Logical canvas size — matches the 16:9 stage in `styles.css`. */
export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;

/** Key the scene is registered under, so `GameState` can reach it. */
export const SCENE_KEY = "Game";

/** Event the scene publishes throttled HUD numbers on. */
export const GAME_STATS = "game:stats";

/**
 * What `GAME_STATS` carries. Produced by the scene, consumed by `GameState`.
 *
 * Deliberately a throttled summary rather than a live handle on the sim: these
 * are the numbers the HUD prints, and writing them every frame would mean 60
 * reactivity passes a second for digits nobody can read that fast.
 */
export interface GameStats {
  frames: number;
  fps: number;
  /** Seconds survived this run. */
  survival: number;
  /** False once the player has died; the run is over. */
  alive: boolean;
  /** False until a puzzle is selected and a run has been created. */
  ready: boolean;
  level: number;
  hp: number;
  maxHp: number;
  kills: number;
  hashpower: number;
}

/**
 * The full-screen message the arena paints over itself.
 *
 * On the scene rather than in the DOM because these three states have no DOM
 * moment of their own: a run that is armed but not started, a run the user
 * paused, and a run that ended. The HUD can say "paused" in a word, but the
 * arena has to *look* paused or the frozen frame reads as a rendering bug.
 */
export type GameOverlay = "none" | "ready" | "paused" | "dead";

/**
 * Reads a colour out of the global stylesheet, so the canvas tracks whatever
 * `:root` says instead of hard-coding a second copy of the palette.
 *
 * Exported so the scene can tint monsters from the same palette.
 */
export function themeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

export function gameConfig(
  parent: HTMLElement,
  scenes: Phaser.Types.Scenes.SceneType[],
): Phaser.Types.Core.GameConfig {
  return {
    // AUTO rather than WEBGL: WEBGL has no Canvas fallback and throws wherever a
    // WebGL context can't be created — which is exactly the headless Chromium
    // the Playwright regression net runs in.
    type: Phaser.AUTO,
    parent,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: themeColor("--bg", "#0b0e14"),

    // NONE is already the default; stating it explicitly keeps a future
    // FIT/RESIZE from quietly letting Phaser measure the parent behind our back.
    // Sizing is driven from the outside via `game.scale.resize()`.
    scale: { mode: Phaser.Scale.NONE },

    // A BTC scanner has no use for an AudioContext.
    audio: { noAudio: true },

    // Console noise the regression net has no reason to see.
    banner: false,

    scene: scenes,
  };
}
