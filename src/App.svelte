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
     `hidden`, which is what lets a hidden Hex tab keep running its auto loop.
     Unmounting it would destroy its `HexState` and stop the loop, so switching
     back would come up empty — exactly the "tab reset" Auto mode must survive. -->
<div class="panel" hidden={active !== "hex"}>
  <Hex />
</div>
<!-- `active` is the Game tab's pause protocol. It cannot be left to Phaser's
     built-in visibility handling: that watches `document.visibilitychange`,
     which never fires for a `hidden` attribute. Without it a backgrounded game
     would keep rendering next to the GPU scanner. -->
<div class="panel" hidden={active !== "game"}>
  <Game active={active === "game"} />
</div>
