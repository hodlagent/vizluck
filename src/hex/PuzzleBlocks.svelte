<script lang="ts">
  import { topByteBounds } from "./range";
  import type { HexState } from "./state.svelte";
  import type { PuzzleGroup } from "./types";

  // Only ever mounted in group mode with a group selected, so the caller does
  // the `{#if}` and hands us a non-null group.  That `{#if}` is also what hides
  // these blocks in custom-range mode — the old `hidden` attribute never
  // worked, because `.puzzle-blocks { display: flex }` outranks it.
  let { state, group }: { state: HexState; group: PuzzleGroup } = $props();
</script>

<section id="puzzle-blocks" class="puzzle-blocks">
  {#each group.puzzles as p (p.puzzle_number)}
    {@const bounds = topByteBounds(p)}
    {@const val = state.topByteVals[p.puzzle_number] ?? 0}
    <!-- No ARIA role fits: a block displays a puzzle's high byte and cycles it
         while hovered.  It is not activatable, so `button` would be a lie. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="pblock"
      class:cycling={state.hover.kind === "block" && state.hover.puzzleNum === p.puzzle_number}
      class:matched={state.lastInfos[p.puzzle_number]?.address_match === true}
      data-puzzle={p.puzzle_number}
      onmouseenter={() => state.startBlockHover(p.puzzle_number)}
      onmouseleave={() => state.endBlockHover(p.puzzle_number)}
    >
      <div class="pblock-num">#{p.puzzle_number}</div>
      <div class="pblock-val">{val.toString(16).padStart(2, "0")}</div>
      <div class="pblock-range">
        {bounds.min.toString(16).padStart(2, "0")}–{bounds.max
          .toString(16)
          .padStart(2, "0")}
      </div>
    </div>
  {/each}
</section>
