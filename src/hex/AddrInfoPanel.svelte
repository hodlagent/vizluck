<script lang="ts">
  import AddrInfoCard from "./AddrInfoCard.svelte";
  import type { KeyInfo } from "./types";

  let {
    puzzleNum,
    info,
    targetHash160,
    active,
    oncopy,
  }: {
    /** The puzzle this panel belongs to, or null for a custom-range result. */
    puzzleNum: number | null;
    info: KeyInfo;
    /**
     * The puzzle's target when comparing (group mode), or null for custom
     * ranges — each address card then shows ✅/❌ against it, or no badge.
     */
    targetHash160: string | null;
    /** Lit while this puzzle's block cycles its high byte. */
    active: boolean;
    oncopy: (value: string, label: string) => void;
  } = $props();

  const comp = $derived.by(() => {
    if (targetHash160 === null) return { emoji: "", cls: "addr" };
    const matched = info.compressed_hash160 === targetHash160;
    return { emoji: matched ? " ✅" : " ❌", cls: "addr " + (matched ? "match" : "nomatch") };
  });

  const rows = $derived([
    { label: "Private Key (32 bytes)", value: info.private_key_hex, cls: "pk" },
    { label: "BIP32 Master Key (xprv)", value: info.xprv, cls: "xprv" },
    {
      label: `BTC Address (compressed)${comp.emoji}`,
      value: info.compressed_legacy_address,
      cls: comp.cls,
    },
  ]);
</script>

<div
  class="addr-info"
  class:active
  class:matched={info.address_match === true}
  data-puzzle={puzzleNum ?? undefined}
>
  {#if puzzleNum !== null}
    <div class="addr-info-head">Puzzle #{puzzleNum}</div>
  {/if}
  {#each rows as row (row.cls + row.label)}
    <AddrInfoCard
      label={row.label}
      value={row.value}
      cls={row.cls}
      oncopy={() => oncopy(row.value, row.label)}
    />
  {/each}
</div>
