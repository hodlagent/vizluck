<script lang="ts">
  import { onMount } from "svelte";
  import MatchBanner from "../hex/MatchBanner.svelte";
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
<header class="topbar" data-status={state.status}>
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

      <!-- Requirement 3: who plays. Two buttons rather than a checkbox because
           the active mode has to be legible at a glance — a checkbox says what
           you did, a segmented control says where you are. -->
      <div class="seg" role="group" aria-label="Who plays">
        <button
          id="btn-mode-manual"
          class="seg-btn"
          class:seg-on={!state.robot}
          title="Play it yourself: WASD / arrows"
          disabled={state.matched}
          aria-pressed={!state.robot}
          onclick={() => state.setMode(false)}
        >
          👤 manual
        </button>
        <button
          id="btn-mode-robot"
          class="seg-btn"
          class:seg-on={state.robot}
          title="Let the robot play — it sees only what you see, plus a monster's numbers once you are inside its sense ring"
          disabled={state.matched}
          aria-pressed={state.robot}
          onclick={() => state.setMode(true)}
        >
          🤖 robot
        </button>
      </div>

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

  <!-- The play area and its stat strip are one block: the stats are a caption
       on the arena, so they take this block's tight gap rather than
       `.game-main`'s 28px rhythm, which separates blocks. -->
  <div class="game-arena">
    <div class="game-stage">
      <div class="game-host" bind:this={host}></div>
    </div>

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
      <span>xp <b id="game-xp">{state.xp}/{state.xpNext}</b></span>
      <span>
        <!-- `maxHp` is a product of 1.05s in the sim and carries float dust
             (`1.5 * 1.05` is not `1.575`), so the ceiling is rounded for display
             rather than rounded in the sim, where it would compound. -->
        hp <b id="game-hp">{Math.ceil(state.hp)}/{Math.round(state.maxHp)}</b>
        <span class="hp-bar" aria-hidden="true">
          <span class="hp-fill" style="width: {Math.round(hpFrac * 100)}%"></span>
        </span>
      </span>
      <span>kills <b id="game-kills">{state.kills}</b></span>
      <!-- One number, not a rate: the key advances when the world changes, so
           "keys sampled" is the whole of what the run has cost. There is no
           cadence to report, and printing one would invent a knob. -->
      <span title="Every key this run has handed to the backend">keys <b id="game-keys">{state.keysScanned}</b></span>

      <!-- Requirement 5's reveal, made visible (design §14.4). The canvas
           deliberately does not paint the fog — the user asked for the robot's
           knowledge to stay off the arena — so this is the only place the
           difference between "seen" and "known" is observable. -->
      {#if state.robot}
        <span
          id="game-intent"
          class="hud-robot"
          title="What the robot is doing, and how many monsters it has numbers for"
        >
          auto <b>{state.robotIntent ?? "…"}</b>
          · known <b>{state.robotKnown}/{state.robotSeen}</b>
        </span>
      {/if}
    </div>
  </div>

  {#if !state.puzzle}
    <div id="game-hint" class="game-hint">
      {#if state.robot}
        Pick a puzzle above to open the arena. The robot plays it — no input
        needed; it sees only what is on screen, plus a monster's numbers once
        you are inside its sense ring.
      {:else}
        Pick a puzzle above to open the arena. WASD or the arrow keys to move;
        attacks are automatic.
      {/if}
    </div>
  {/if}

</main>
