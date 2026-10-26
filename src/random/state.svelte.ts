// Random tab state: a self-chaining scan loop over the shared address book.
//
// [imperative] The loop awaits one IPC batch before scheduling the next tick.
// That await is the backpressure — the Rust side owns the time budget, so the
// browser never queues unbounded work.  Same pattern as `HexState.onAuto`.

import { addresses } from "../addresses.svelte";
import { randomScan, type BitcoinAddress, type RandomMatch } from "./api";

/** How long one Rust batch scans before returning a fresh key for the cards. */
const BATCH_BUDGET_MS = 40;
/** Rolling rate window, matching the Hex tab's cadence. */
const RATE_WINDOW_MS = 1_000;
const TOAST_MS = 1_200;

export class RandomState {
  // ── Scan state ───────────────────────────────────────────────────────────
  running = $state(false);
  /** The last key scanned; drives the 32 byte cards. */
  keyHex = $state("");
  bitcoin = $state<BitcoinAddress[]>([]);
  ethereum = $state("");
  solana = $state("");
  checked = $state(0);
  keysRate = $state("0 keys/s");
  matches = $state<RandomMatch[]>([]);
  /** Where the hit was written; null until a hit lands. */
  savePath = $state<string | null>(null);
  /** Why saving failed, if it did — the match itself is still valid. */
  saveError = $state<string | null>(null);
  error = $state("");

  // ── UI ──────────────────────────────────────────────────────────────────
  toast = $state<string | null>(null);

  // ── Not reactive ────────────────────────────────────────────────────────
  private timer: number | null = null;
  /** Bumped by every start/stop so stale batches and loads are discarded. */
  private gen = 0;
  private windowStart = performance.now();
  private windowKeys = 0;
  private toastTimer: number | null = null;

  /** Always 32 cards, with placeholders before the first key arrives. */
  get bytes(): string[] {
    const out: string[] = [];
    for (let i = 0; i < 32; i++) {
      out.push(this.keyHex.slice(i * 2, i * 2 + 2) || "··");
    }
    return out;
  }

  get hasKey(): boolean {
    return this.keyHex.length === 64;
  }

  get hasTargets(): boolean {
    return addresses.total > 0;
  }

  /** Called from the tab's `$effect`; hiding the tab stops the CPU loop. */
  setActive(active: boolean): void {
    if (!active) this.stop();
  }

  toggle(): void {
    if (this.running) this.stop();
    else void this.start();
  }

  async start(): Promise<void> {
    if (this.running) return;
    const gen = ++this.gen;
    this.error = "";
    this.matches = [];
    this.savePath = null;
    this.saveError = null;
    this.checked = 0;
    this.keysRate = "0 keys/s";
    this.windowStart = performance.now();
    this.windowKeys = 0;

    // Read the book first.  `ensureLoaded` is a no-op once App has loaded it.
    await addresses.ensureLoaded();
    if (gen !== this.gen) return; // stopped or restarted while loading
    if (!this.hasTargets) {
      this.error =
        "No target addresses yet — add Bitcoin / Ethereum / Solana addresses in the Settings tab, then Save.";
      return;
    }

    this.running = true;
    void this.tick(gen);
  }

  stop(): void {
    this.running = false;
    this.gen++;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async tick(gen: number): Promise<void> {
    if (gen !== this.gen || !this.running) return;
    try {
      const res = await randomScan(addresses.snapshot(), BATCH_BUDGET_MS);
      if (gen !== this.gen || !this.running) return;

      this.keyHex = res.private_key_hex;
      this.bitcoin = res.bitcoin;
      this.ethereum = res.ethereum;
      this.solana = res.solana;
      this.checked += res.checked;
      this.record(res.checked);

      if (res.matches.length > 0) {
        this.matches = res.matches;
        this.savePath = res.save_path;
        this.saveError = res.save_error;
        if (res.save_path) this.showToast("match saved to disk");
        this.stop();
        return;
      }
      this.timer = window.setTimeout(() => void this.tick(gen), 0);
    } catch (e) {
      if (gen !== this.gen) return;
      this.error = String(e);
      this.stop();
    }
  }

  private record(n: number): void {
    this.windowKeys += n;
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed < RATE_WINDOW_MS) return;
    const rate = Math.round(this.windowKeys / (elapsed / 1000));
    this.keysRate = `${rate.toLocaleString()} keys/s`;
    this.windowKeys = 0;
    this.windowStart = now;
  }

  async copy(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast(`copied ${label}`);
    } catch {
      this.showToast("copy failed");
    }
  }

  private showToast(text: string): void {
    this.toast = text;
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast = null;
    }, TOAST_MS);
  }
}
