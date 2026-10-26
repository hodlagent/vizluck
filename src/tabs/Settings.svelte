<script lang="ts">
  import { onMount } from "svelte";
  import {
    addressWarning,
    addresses,
    CHAINS,
    type Chain,
  } from "../addresses.svelte";

  onMount(() => {
    void addresses.ensureLoaded();
  });

  /** Per-chain "new address" drafts; never written to the book until Add. */
  let drafts = $state<Record<Chain, string>>({
    bitcoin: "",
    ethereum: "",
    solana: "",
  });

  let message = $state("");
  let toast = $state<string | null>(null);
  let toastTimer: number | null = null;

  // Serialized snapshot captured when the book loads / is saved. Comparing it
  // with the live book gives a cheap unsaved-changes marker.
  let savedSnapshot = $state("");
  let captured = false;

  $effect(() => {
    if (addresses.loaded && !captured) {
      savedSnapshot = JSON.stringify(addresses.snapshot());
      captured = true;
    }
  });

  const dirty = $derived(
    addresses.loaded && JSON.stringify(addresses.snapshot()) !== savedSnapshot,
  );

  function add(chain: Chain): void {
    message = "";
    const problem = addresses.add(chain, drafts[chain]);
    if (problem) {
      message = `${chain}: ${problem}`;
      return;
    }
    drafts[chain] = "";
  }

  function remove(chain: Chain, index: number): void {
    addresses.remove(chain, index);
    message = "";
  }

  async function save(): Promise<void> {
    message = "";
    const ok = await addresses.save();
    if (!ok) {
      message = addresses.error;
      return;
    }
    savedSnapshot = JSON.stringify(addresses.snapshot());
    captured = true;
    showToast(`saved · ${addresses.path}`);
  }

  function showToast(text: string): void {
    toast = text;
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast = null;
    }, 2_000);
  }
</script>

<!-- ── Top bar ─────────────────────────────────────────────────────────── -->
<header class="topbar">
  <div class="brand-row settings-brand-row">
    <div class="settings-brand">addresses</div>
    <div class="settings-path" title={addresses.path || "addresses.json"}>
      {addresses.path || "addresses.json"}
    </div>

    <div class="controls">
      {#if dirty}
        <span class="settings-dirty">unsaved</span>
      {/if}
      <button
        id="btn-save-addresses"
        class="btn"
        title="Write all three lists to addresses.json"
        onclick={() => void save()}
      >💾 Save JSON</button>
    </div>
  </div>

  {#if message}
    <div id="settings-error" class="error">{message}</div>
  {/if}
  {#if addresses.error && !message}
    <div id="settings-load-error" class="error">{addresses.error}</div>
  {/if}
</header>

<main class="settings-main">
  {#each CHAINS as chain (chain.id)}
    <section class="chain-card" data-chain={chain.id}>
      <div class="chain-card-head">
        <span class="chain-label">{chain.label}</span>
        <span class="chain-count">
          {addresses.count(chain.id)}
          {addresses.count(chain.id) === 1 ? "address" : "addresses"}
        </span>
      </div>

      <div class="addr-list">
        {#each addresses.book[chain.id] as addr, i (i)}
          {@const warning = addressWarning(chain.id, addr)}
          <div class="addr-row" class:invalid={warning !== null}>
            <input
              class="input addr-input"
              value={addr}
              spellcheck="false"
              autocomplete="off"
              title={warning ?? "address"}
              oninput={(e) => (addresses.book[chain.id][i] = e.currentTarget.value)}
            />
            {#if warning}
              <span class="addr-warning" title={warning}>⚠</span>
            {/if}
            <button
              class="btn addr-del"
              title="Remove this address"
              onclick={() => remove(chain.id, i)}
            >✕</button>
          </div>
        {:else}
          <div class="addr-empty">No {chain.label} addresses yet.</div>
        {/each}
      </div>

      <form
        class="addr-add"
        onsubmit={(e) => {
          e.preventDefault();
          add(chain.id);
        }}
      >
        <input
          class="input addr-input"
          placeholder={chain.placeholder}
          spellcheck="false"
          autocomplete="off"
          bind:value={drafts[chain.id]}
        />
        <button class="btn" type="submit">Add</button>
      </form>
    </section>
  {/each}

  <p class="settings-note">
    Stored as plain JSON at the path above. Each save first copies the previous
    file to <code>addresses.json.bak</code>. Address comparison is
    case-insensitive, and the Random tab checks every address on all three
    chains for every key it generates.
  </p>
</main>

{#if toast !== null}
  <div id="settings-toast" class="toast">{toast}</div>
{/if}
