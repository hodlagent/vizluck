<script lang="ts">
  import { onMount } from "svelte";
  import MatchBanner from "../hex/MatchBanner.svelte";
  import { keyRateFor, TUNING } from "../game/sim";
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
    void state.init();
    return () => state.unmount();
  });

  // Requirement 1's pause protocol. Phaser's own visibility handling watches
  // `document.visibilitychange` — which never fires when `App.svelte` merely
  // flips the panel's `hidden` attribute. Unlike the Hex tab, this also drops
  // the run intent, so coming back needs a deliberate ▶.
  $effect(() => {
    state.setActive(active);
  });

  /** `m:ss.s` — a survival clock, where the tenths are the whole point. */
  function fmtTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const rest = seconds - m * 60;
    return `${String(m).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
  }

  const rate = $derived(keyRateFor(state.hashpower).toFixed(1));
  const hpFrac = $derived(state.maxHp > 0 ? state.hp / state.maxHp : 0);

  /**
   * Every free byte, in key order — this strip is the Game tab's answer to the
   * Hex tab's grid, so truncating it would hide exactly the thing it exists to
   * show. `b - 1` runs 8..19, so the widest case is 19 small chips.
   */
  const bytePairs = $derived(
    state.baseBytes.map((value, i) => ({ value, owner: state.owners[i] ?? "?" })),
  );

  /** Ownership is the noisy half; naming the first few is enough to teach it. */
  const ownerNote = $derived(
    bytePairs.length > 4
      ? bytePairs.slice(0, 4).map((p) => p.owner).join(" · ") + " · …"
      : bytePairs.map((p) => p.owner).join(" · "),
  );

  /**
   * The key's live part. Everything above the puzzle's range is `00` padding
   * (`puzzleKeyHex`), so the full 64 chars would be a wall of zeroes with the
   * run's actual output hidden at the far end. Stripped, it is the key the
   * player is watching — and it fits on the title row.
   */
  const keyTail = $derived(state.info?.private_key_hex.replace(/^(00)+/, "") ?? "");

  /** Click-to-copy on a chip, plus the keyboard path `AddrInfoCard` offered. */
  function chipKey(e: KeyboardEvent, value: string, label: string): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void state.copyText(value, label);
    }
  }
</script>

<!-- ── Top bar: one row — readout on the left, requirement 1's two controls
     pushed to the right edge ──────────────────────────────────────── -->
<header class="topbar">
  <div class="brand-row game-brand-row">
    <div class="game-brand">survive</div>

    <!-- The key readout rides the title row: which key the run is producing,
         what address it lands on, and whether that address is the target. -->
    {#if state.info}
      {@const info = state.info}
      <div class="game-key">
        <span
          id="game-pk"
          class="gk gk-pk"
          role="button"
          tabindex="0"
          title="Private key, above-range zero padding stripped — click to copy all 64 chars"
          onclick={() => void state.copyText(info.private_key_hex, "private key")}
          onkeydown={(e) => chipKey(e, info.private_key_hex, "private key")}
        >{keyTail}</span>

        <span
          id="game-addr"
          class="gk gk-addr"
          class:match={info.address_match === true}
          class:nomatch={info.address_match === false}
          role="button"
          tabindex="0"
          title="BTC address (compressed) — click to copy"
          onclick={() => void state.copyText(info.compressed_legacy_address, "BTC address")}
          onkeydown={(e) => chipKey(e, info.compressed_legacy_address, "BTC address")}
        >{info.compressed_legacy_address}</span>

        <span
          id="game-flag"
          class="gk-flag"
          title={info.address_match === true ? "target hit" : "not the target"}
        >{info.address_match === true ? "✅" : "❌"}</span>
      </div>
    {/if}

    <div id="game-status" class="game-status" title="Run state">
      {state.status}
    </div>

    <!-- Requirement 1's two controls, on the same row and pushed to the far
         edge — the left half stays a pure readout. -->
    <div class="controls">
      <select
        id="puzzle-select"
        class="select"
        title="Pick a puzzle — the run cannot start without one"
        disabled={state.matched}
        bind:value={state.selected}
        onchange={(e) => state.onSelect(e.currentTarget.value)}
      >
        <option value="">— select a puzzle —</option>
        {#each state.puzzles as p (p.puzzle_number)}
          <option value={String(p.puzzle_number)}>
            #{p.puzzle_number} · {p.hex_bytes_len} bytes
          </option>
        {/each}
      </select>

      <button
        id="btn-run"
        class="btn"
        title={state.alive ? "Pause" : "Start a new run"}
        disabled={!state.canRun}
        onclick={() => state.toggle()}
      >
        {state.running ? "⏸" : "▶"}
      </button>
    </div>
  </div>

  {#if state.error}
    <div id="game-error" class="error">{state.error}</div>
  {/if}

  <!-- ── HUD: read-only, fed by the scene's 4 Hz stats event ─────────── -->
  <div class="game-hud">
    {#if state.puzzle}
      <span>
        puzzle <b>#{state.puzzle.puzzle_number}</b>
        · {state.puzzle.hex_bytes_len} bytes
      </span>
    {/if}
    <span>survived <b id="game-survival">{fmtTime(state.survival)}</b></span>
    <span>best <b id="game-best">{fmtTime(state.bestSurvival)}</b></span>
    <span>level <b id="game-level">{state.level}</b></span>
    <span>
      hp <b id="game-hp">{Math.ceil(state.hp)}/{state.maxHp}</b>
      <span class="hp-bar" aria-hidden="true">
        <span class="hp-fill" style="width: {Math.round(hpFrac * 100)}%"></span>
      </span>
    </span>
    <span>kills <b id="game-kills">{state.kills}</b></span>
    <span>
      hashpower <b id="game-hashpower">{Math.round(state.hashpower)}/{TUNING.hashpowerMax}</b>
    </span>
    <span>sampling <b id="game-rate">{rate}</b> keys/s</span>
    <span>keys <b id="game-keys">{state.keysScanned}</b></span>
  </div>

  <!-- The bytes the gameplay is driving. This is the game's answer to the Hex
       tab's grid: same slot in the layout, different thing pushing it. -->
  {#if bytePairs.length > 0}
    <div id="game-bytes" class="game-bytes" title="Free low bytes — the run's only handle on the key">
      {#each bytePairs as pair, i (i)}
        <span class="gbyte">{pair.value}</span>
      {/each}
      <span class="game-bytes-note">← {ownerNote}</span>
    </div>
  {/if}
</header>

<!-- ── Arena ────────────────────────────────────────────────────────── -->
<!-- Deliberately not `main.main` / `#info`: the Hex tab owns those, and the
     regression net counts them globally. -->
<main class="game-main">
  {#if state.matchBanner !== null}
    {#key state.matchSeq}
      {@const savePath = state.matchBanner}
      <MatchBanner {savePath} oncopy={() => void state.copyText(savePath, "file path")} />
    {/key}
  {/if}

  <div class="game-stage">
    <div class="game-host" bind:this={host}></div>
  </div>

  {#if !state.puzzle}
    <div id="game-hint" class="game-hint">
      Pick a puzzle above to open the arena. WASD or the arrow keys to move;
      attacks are automatic.
    </div>
  {/if}

</main>
