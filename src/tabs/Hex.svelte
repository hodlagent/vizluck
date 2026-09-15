<script lang="ts">
  import { onMount } from "svelte";
  import AddrInfoPanel from "../hex/AddrInfoPanel.svelte";
  import Grid from "../hex/Grid.svelte";
  import MatchBanner from "../hex/MatchBanner.svelte";
  import PuzzleBlocks from "../hex/PuzzleBlocks.svelte";
  import { HexState } from "../hex/state.svelte";

  // Created per mount rather than at module scope, so a second Hex tab would
  // get its own independent state.
  const state = new HexState();

  onMount(() => {
    void state.init();
  });

  // `body.auto-running` sits outside this component's markup, so it is the one
  // bit of state a template binding cannot carry.  The flag is what makes hover
  // visual feedback go inert while auto runs.
  $effect(() => {
    document.body.classList.toggle("auto-running", state.autoRunning);
    return () => document.body.classList.remove("auto-running");
  });
</script>

<!-- ── Top bar ─────────────────────────────────────────────── -->
<header class="topbar">
  <div class="brand-row">
    <div class="brand">vizluck</div>
    <div id="keys-rate" class="keys-rate" title="Keys scanned per second">
      {state.keysRate}
    </div>
  </div>

  <div class="controls">
    <select
      id="group-select"
      class="select"
      title="Choose a byte group"
      bind:value={state.groupSelectBytes}
      onchange={(e) => state.onGroupChange(e.currentTarget.value)}
    >
      <option value="">— custom range —</option>
      {#each state.groups as g (g.bytes)}
        <option value={String(g.bytes)}>
          group_{g.bytes} · {g.puzzles.length} puzzles
        </option>
      {/each}
    </select>

    <input
      id="range-input"
      class="input"
      type="text"
      placeholder="start_hex:end_hex  (e.g. 800000000000000000:ffffffffffffffffff)"
      autocomplete="off"
      spellcheck="false"
      bind:value={state.rangeText}
      oninput={(e) => state.onRangeInput(e.currentTarget.value)}
    />

    <button
      id="btn-random"
      class="btn"
      title="Generate one random key"
      disabled={state.matched}
      onclick={() => state.onRandom()}
    >
      🎲 Random
    </button>
    <button
      id="btn-auto"
      class="btn"
      title="Auto-randomize (click again to stop)"
      disabled={state.matched}
      onclick={() => state.onAuto()}
    >
      {state.autoRunning ? "⏸ Stop" : "▶ Auto"}
    </button>
  </div>

  {#if state.error}
    <div id="error" class="error">{state.error}</div>
  {/if}
</header>

<!-- ── Grid ────────────────────────────────────────────────── -->
<main class="main">
  <!-- A sibling of `.grid-wrap`, not a child: `.grid-wrap` is a `display: flex`
       row, so a banner inside it rendered as a narrow column beside the grid and
       shoved the grid off-centre.  `.main` is a column, so here it spans the
       content width and sits above the grid, which is what it was always for. -->
  {#if state.matchBanner !== null}
    {#key state.matchSeq}
      {@const savePath = state.matchBanner}
      <MatchBanner {savePath} oncopy={() => void state.copyText(savePath, "file path")} />
    {/key}
  {/if}

  <Grid {state} />

  <!-- Group mode: divider + one puzzle block per puzzle in the group.  Both are
       absent — not merely hidden — in custom-range mode. -->
  {#if state.mode === "group" && state.activeGroup}
    {@const group = state.activeGroup}
    <div id="divider" class="divider"></div>
    <PuzzleBlocks {state} {group} />
  {/if}

  <!-- AddrInfo: persistent bottom panel.  One panel per group puzzle, or a
       single panel for a custom-range result. -->
  <section id="info" class="info">
    {#each state.panels as panel (panel.puzzleNum ?? "custom")}
      <AddrInfoPanel
        puzzleNum={panel.puzzleNum}
        info={panel.info}
        targetHash160={state.targetHash160(panel.puzzleNum)}
        active={panel.puzzleNum !== null &&
          state.hover.kind === "block" &&
          state.hover.puzzleNum === panel.puzzleNum}
        oncopy={(value, label) => void state.copyText(value, label)}
      />
    {/each}
  </section>
</main>

<!-- ── Toast ───────────────────────────────────────────────── -->
{#if state.toast !== null}
  <div id="toast" class="toast">{state.toast}</div>
{/if}
