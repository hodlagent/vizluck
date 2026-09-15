<script lang="ts">
  import Hex from "./tabs/Hex.svelte";
  import Game from "./tabs/Game.svelte";

  type Tab = "hex" | "game";

  const TABS: { id: Tab; label: string }[] = [
    { id: "hex", label: "Hex" },
    { id: "game", label: "Game" },
  ];

  let active = $state<Tab>("hex");
</script>

<nav class="tabbar">
  {#each TABS as tab (tab.id)}
    <button
      class="tab"
      class:active={active === tab.id}
      onclick={() => (active = tab.id)}
    >
      {tab.label}
    </button>
  {/each}
</nav>

<!-- Both panels stay mounted at all times; switching tabs only toggles
     `hidden`. Unmounting Hex would orphan the element refs `hex/hex.ts`
     captured and strand its auto loop writing into a detached DOM tree —
     which would look exactly like the tab "resetting" on switch-back. -->
<div class="panel" hidden={active !== "hex"}>
  <Hex />
</div>
<div class="panel" hidden={active !== "game"}>
  <Game />
</div>
