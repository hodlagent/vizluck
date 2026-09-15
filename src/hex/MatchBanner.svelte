<script lang="ts">
  import { onMount } from "svelte";
  import { launchConfetti } from "./confetti";

  // Remounted per match (the parent keys it on `matchSeq`), so mounting *is*
  // "a new match happened" — that is what fires the confetti.
  let { savePath, oncopy }: { savePath: string; oncopy: () => void } = $props();

  const sub = $derived(
    savePath.startsWith("ERROR:")
      ? `Could not save file: ${savePath.slice(6).trim()}`
      : savePath
        ? `Saved to ${savePath}`
        : "Puzzle hash160 matched!",
  );

  onMount(launchConfetti);
</script>

<div
  id="match-banner"
  class="match-banner"
  role="button"
  tabindex="0"
  onclick={oncopy}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      oncopy();
    }
  }}
>
  <div class="match-title">🎉 MATCH FOUND! 🎉</div>
  <div class="match-sub">{sub}</div>
</div>
