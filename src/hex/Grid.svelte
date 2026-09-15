<script lang="ts">
  import type { HexState } from "./state.svelte";

  let { state }: { state: HexState } = $props();
</script>

<section class="grid-wrap">
  <div
    id="grid"
    class="grid"
    style="grid-template-columns: repeat({state.gridBytes.length}, 1fr)"
  >
    {#each state.gridBytes as byte, i (i)}
      <!-- No ARIA role fits: a cell displays a byte and cycles it while hovered.
           It is not activatable, so `button` would be a lie. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="cell"
        class:cycling={state.hover.kind === "grid" && state.hover.cellIdx === i}
        class:matched={state.matchCell === i}
        onmouseenter={() => state.startGridHover(i)}
        onmouseleave={() => state.endGridHover(i)}
      >{byte}</div>
    {/each}
  </div>
</section>
