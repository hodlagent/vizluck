<script lang="ts">
  import { onMount } from "svelte";
  import { initHex } from "../hex/hex";

  // The markup below is the former `index.html` body, moved across verbatim so
  // the imperative logic in `hex/hex.ts` keeps finding its elements by id.
  // `onMount` runs once the markup is in the DOM, which is what lets `initHex()`
  // resolve those ids (it could not at module scope).
  onMount(() => {
    void initHex();
  });
</script>

<!-- ── Top bar ─────────────────────────────────────────────── -->
<header class="topbar">
  <div class="brand-row">
    <div class="brand">vizluck</div>
    <div id="keys-rate" class="keys-rate" title="Keys scanned per second">
      0 keys/s
    </div>
  </div>
  <div class="controls">
    <select id="group-select" class="select" title="Choose a byte group">
      <option value="">— custom range —</option>
    </select>

    <input
      id="range-input"
      class="input"
      type="text"
      placeholder="start_hex:end_hex  (e.g. 800000000000000000:ffffffffffffffffff)"
      autocomplete="off"
      spellcheck="false"
    />

    <button id="btn-random" class="btn" title="Generate one random key">
      🎲 Random
    </button>
    <button id="btn-auto" class="btn" title="Auto-randomize (click again to stop)">
      ▶ Auto
    </button>
  </div>
  <div id="error" class="error" hidden></div>
</header>

<!-- ── Grid ────────────────────────────────────────────────── -->
<main class="main">
  <section class="grid-wrap">
    <div id="grid" class="grid"></div>
  </section>

  <!-- Group mode: divider + one puzzle block per puzzle in the group.
       Both stay hidden in custom-range mode. -->
  <div id="divider" class="divider" hidden></div>
  <section id="puzzle-blocks" class="puzzle-blocks" hidden></section>

  <!-- AddrInfo: persistent bottom panel.  One panel per group puzzle,
       or a single panel for a custom-range result. -->
  <section id="info" class="info"></section>
</main>

<!-- ── Toast ───────────────────────────────────────────────── -->
<div id="toast" class="toast" hidden>copied</div>
