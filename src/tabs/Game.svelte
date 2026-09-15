<script lang="ts">
  import { onMount } from "svelte";
  import { GameState } from "../game/state.svelte";

  /** Whether this tab is the visible one — driven by `App.svelte`. */
  let { active = false }: { active?: boolean } = $props();

  // Created per mount rather than at module scope, so a second Game tab would
  // get its own independent state. Same reasoning as `HexState`.
  const state = new GameState();

  let host: HTMLDivElement | undefined;

  onMount(() => {
    if (!host) return;
    state.mount(host);
    return () => state.unmount();
  });

  // The tab's pause protocol. Phaser's own visibility handling watches
  // `document.visibilitychange` — which never fires when `App.svelte` merely
  // flips the panel's `hidden` attribute. Without this the game would keep
  // rendering behind the Hex tab, competing with the GPU scanner for nothing.
  $effect(() => {
    state.setActive(active);
  });
</script>

<!-- The HUD is Svelte's, not Phaser's: the engine owns the canvas and nothing
     else, and the numbers below are exactly the throttled subset that is
     allowed to reach `$state`. See `src/game/scenes/BootScene.ts`. -->
<div class="game-stage">
  <div class="game-host" bind:this={host}></div>
</div>

<div class="game-hud">
  <span>status <b>{state.status}</b></span>
  <span>fps <b>{state.fps}</b></span>
  <span>frames <b>{state.frames}</b></span>
</div>

{#if state.error}
  <div id="game-error" class="error">{state.error}</div>
{/if}
