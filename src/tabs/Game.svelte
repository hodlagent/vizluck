<script lang="ts">
  import { onMount } from "svelte";
  import AddrInfoPanel from "../hex/AddrInfoPanel.svelte";
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
</script>

<!-- ── Top bar: exactly the two controls requirement 1 asks for ─────── -->
<header class="topbar">
  <div class="brand-row">
    <div class="game-brand">survive</div>
    <div id="game-status" class="game-status" title="Run state">
      {state.status}
    </div>
  </div>

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

  {#if state.info}
    <section id="game-info" class="info">
      <AddrInfoPanel
        puzzleNum={state.puzzle?.puzzle_number ?? null}
        info={state.info}
        targetHash160={state.puzzle?.hash160 ?? null}
        active={false}
        oncopy={(value, label) => void state.copyText(value, label)}
      />
    </section>
  {/if}
</main>
