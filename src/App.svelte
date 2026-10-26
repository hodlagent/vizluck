<script lang="ts">
  import { onMount } from "svelte";
  import Hex from "./tabs/Hex.svelte";
  import Game from "./tabs/Game.svelte";
  import Random from "./tabs/Random.svelte";
  import Settings from "./tabs/Settings.svelte";
  import { addresses } from "./addresses.svelte";

  type Tab = "hex" | "game" | "random" | "settings";

  const TABS: { id: Tab; label: string }[] = [
    { id: "hex", label: "Hex" },
    { id: "game", label: "Game" },
    { id: "random", label: "Random" },
    { id: "settings", label: "Settings" },
  ];

  let active = $state<Tab>("hex");

  // The address book is shared by Random and Settings. Load it once here so
  // Random has targets even if the user never opened Settings this session.
  onMount(() => {
    void addresses.ensureLoaded();
  });
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
<!-- The Random panel keeps its last key and match when hidden, but its scan
     loop is stopped by `active` — the same deliberate-resume protocol as Game,
     so it never competes with the Hex auto loop / GPU scanner. -->
<div class="panel" hidden={active !== "random"}>
  <Random active={active === "random"} />
</div>
<div class="panel" hidden={active !== "settings"}>
  <Settings />
</div>
