<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HexState } from "./state.svelte";

  let {
    state,
    banner,
  }: {
    state: HexState;
    /**
     * Rendered inside `.grid-wrap`, immediately before `#grid` — the slot the
     * match banner has always occupied.  Kept here (rather than as a sibling of
     * `.grid-wrap`) so the banner's box stays exactly where it was.
     */
    banner?: Snippet;
  } = $props();
</script>

<section class="grid-wrap">
  {@render banner?.()}
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
