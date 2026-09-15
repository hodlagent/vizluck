<script lang="ts">
  // One click-to-copy row of an AddrInfo panel.
  let {
    label,
    value,
    cls,
    oncopy,
  }: {
    label: string;
    value: string;
    /** Extra classes: `pk` / `xprv` / `addr`, plus `match` or `nomatch`. */
    cls: string;
    oncopy: () => void;
  } = $props();
</script>

<div
  class="card {cls}"
  title="click to copy"
  role="button"
  tabindex="0"
  onclick={oncopy}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      oncopy();
    }
  }}
>
  <div class="card-label">{label}</div>
  <div class="card-value">{value}</div>
</div>
