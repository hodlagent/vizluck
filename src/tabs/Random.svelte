<script lang="ts">
  import { onMount } from "svelte";
  import { addresses } from "../addresses.svelte";
  import { RandomState } from "../random/state.svelte";

  /** Whether this tab is the visible one — driven by `App.svelte`. */
  let { active = false }: { active?: boolean } = $props();

  // Per mount, like the other tabs: a second Random tab would be independent.
  const state = new RandomState();

  onMount(() => {
    void addresses.ensureLoaded();
    return () => state.stop();
  });

  // Hiding the tab stops the Rust scan loop; it does not auto-resume, so the
  // user's next visit starts with a deliberate ▶ (same protocol as Game).
  $effect(() => {
    state.setActive(active);
  });

</script>

<!-- ── Top bar ─────────────────────────────────────────────────────────── -->
<header class="topbar">
  <div class="brand-row random-brand-row">
    <div class="random-brand">random</div>
    <div id="random-rate" class="keys-rate" title="Keys scanned per second">
      {state.keysRate}
    </div>

    <div class="controls">
      <button
        id="btn-random-scan"
        class="btn"
        title={state.running ? "Stop scanning" : "Start scanning random keys"}
        disabled={!state.running && !state.hasTargets}
        onclick={() => state.toggle()}
      >
        {state.running ? "⏸ Stop" : "▶ Start"}
      </button>
    </div>
  </div>

  <div class="random-status">
    <span>
      checked <b id="random-checked">{state.checked.toLocaleString()}</b>
    </span>
    <span>
      targets
      <b id="random-target-btc">{addresses.count("bitcoin")}</b> BTC ·
      <b id="random-target-eth">{addresses.count("ethereum")}</b> ETH ·
      <b id="random-target-sol">{addresses.count("solana")}</b> SOL
    </span>
    <span class="random-status-note">manage these in Settings</span>
  </div>

  {#if state.error}
    <div id="random-error" class="error">{state.error}</div>
  {/if}

  {#if addresses.total === 0 && !state.error}
    <div id="random-hint" class="random-hint">
      {#if addresses.error}
        Could not read the address book: {addresses.error}
      {:else}
        No target addresses yet. Add Bitcoin / Ethereum / Solana addresses in the
        <b>Settings</b> tab, save them, then press Start.
      {/if}
    </div>
  {/if}
</header>

<!-- Deliberately not `main.main`: the Hex regression net counts that selector
     globally, and `random-main` carries the same flex column layout. -->
<main class="random-main">
  {#if state.matches.length > 0}
    <section id="random-match" class="random-match">
      <div class="random-match-title">✅ ADDRESS MATCH</div>
      {#if state.savePath}
        <div id="random-save-path" class="random-match-saved">
          Saved to {state.savePath}
        </div>
      {:else if state.saveError}
        <div id="random-save-error" class="random-match-save-error">
          Could not save the match: {state.saveError}
        </div>
      {/if}
      {#each state.matches as match, i (i)}
        <div class="random-match-row">
          <span class="chain-label">{match.chain}</span>
          <button
            class="addr-chip match"
            title="click to copy the address"
            onclick={() => void state.copy(match.derived_address, `${match.chain} address`)}
          >{match.derived_address}</button>
          <span class="random-match-configured">matched {match.address}</span>
        </div>
      {/each}
      <button
        class="random-match-key"
        title="click to copy the private key"
        onclick={() =>
          void state.copy(state.matches[0].private_key_hex, "private key")}
      >
        private key · {state.matches[0].private_key_hex}
      </button>
    </section>
  {/if}

  <!-- ── The 32 byte cards ─────────────────────────────────────────────── -->
  <section class="random-key">
    <div class="random-key-head">
      <span>private key · 32 bytes</span>
      {#if state.hasKey}
        <button
          class="random-key-copy"
          title="click to copy the full key"
          onclick={() => void state.copy(state.keyHex, "private key")}
        >copy</button>
      {/if}
    </div>
    <div id="random-grid" class="random-grid">
      {#each state.bytes as byte, i (i)}
        <div class="rand-cell" class:placeholder={!state.hasKey}>{byte}</div>
      {/each}
    </div>
  </section>

  <!-- ── What that key produces on each chain ──────────────────────────── -->
  <section class="random-derived">
    <article class="random-chain">
      <div class="chain-label">Bitcoin</div>
      <div class="chain-note">one key, every standard address form</div>
      {#if state.bitcoin.length > 0}
        {#each state.bitcoin as btc, i (i)}
          <div class="chain-addr-row">
            <span class="chain-type">{btc.kind}</span>
            <button
              class="addr-chip"
              title="click to copy"
              onclick={() => void state.copy(btc.address, "BTC address")}
            >{btc.address}</button>
          </div>
        {/each}
      {:else}
        <span class="chain-empty">—</span>
      {/if}
    </article>

    <article class="random-chain">
      <div class="chain-label">Ethereum</div>
      <div class="chain-note">secp256k1 · keccak256 · EIP-55</div>
      {#if state.ethereum}
        <button
          id="random-eth-addr"
          class="addr-chip"
          title="click to copy"
          onclick={() => void state.copy(state.ethereum, "ETH address")}
        >{state.ethereum}</button>
      {:else}
        <span class="chain-empty">—</span>
      {/if}
    </article>

    <article class="random-chain">
      <div class="chain-label">Solana</div>
      <div class="chain-note">ed25519 · base58</div>
      {#if state.solana}
        <button
          id="random-sol-addr"
          class="addr-chip"
          title="click to copy"
          onclick={() => void state.copy(state.solana, "SOL address")}
        >{state.solana}</button>
      {:else}
        <span class="chain-empty">—</span>
      {/if}
    </article>
  </section>
</main>

{#if state.toast !== null}
  <div id="random-toast" class="toast">{state.toast}</div>
{/if}
