// Hex tab state — one instance per `<Hex>` mount, so nothing here is a module
// singleton any more.
//
// The rendering that used to be hand-written (`renderGrid`, `renderBlocks`,
// `renderInfoSection`, `updateInfoPanel`, `showMatchBanner`) is gone: the fields
// below are the single source of truth and the templates derive from them.
//
// What stays imperative is deliberate and marked [imperative] — the auto loop,
// the hover cycles and the confetti canvas are all loops over time, not values.

import {
  deriveFull,
  deriveGroup,
  getPuzzles,
  randomAndDerive,
  randomAndHash160,
} from "./api";
import {
  hexByteLen,
  isValidHex,
  lowBytes,
  puzzleKeyHex,
  randomBytes,
  randomTopByte,
  setKeyByte,
  splitRange,
  topByteBounds,
} from "./range";
import type { KeyInfo, PuzzleGroup, PuzzleInfo, RangeSpec } from "./types";

const HOVER_INTERVAL_MS = 60;
const RATE_WINDOW_MS = 10_000;
const RATE_IDLE_RESET_MS = 30_000;
const EDIT_DEBOUNCE_MS = 300;
const TOAST_MS = 1200;

/** Which byte is currently counting through its range, if any. */
interface Hover {
  kind: "grid" | "block" | null;
  /** grid: cell index */
  cellIdx: number;
  /** block: puzzle number */
  puzzleNum: number;
  startVal: number;
  /** Inclusive lower bound for a bounded byte, or null for a free cell. */
  minVal: number | null;
  /** Inclusive upper bound for a bounded byte, or null for a free cell. */
  maxVal: number | null;
}

const NO_HOVER: Hover = {
  kind: null,
  cellIdx: -1,
  puzzleNum: -1,
  startVal: -1,
  minVal: null,
  maxVal: null,
};

/** One rendered bottom panel: a group puzzle, or the custom-range result. */
export interface Panel {
  puzzleNum: number | null;
  info: KeyInfo;
}

export class HexState {
  // ── Loaded data ──────────────────────────────────────────────────────────
  puzzles = $state<PuzzleInfo[]>([]);
  groups = $state<PuzzleGroup[]>([]);

  // ── Mode ─────────────────────────────────────────────────────────────────
  /** Which flow is active: a byte-group, or a custom range. */
  mode = $state<"group" | "custom">("custom");
  activeGroup = $state<PuzzleGroup | null>(null);
  /** `<select>` value: a byte count as a string, or "" for the placeholder. */
  groupSelectBytes = $state("");

  // ── Group-mode state ─────────────────────────────────────────────────────
  /** The `bytes - 1` shared random bytes, as 2-char hex. */
  baseBytes = $state<string[]>([]);
  /** puzzle_number -> current high byte */
  topByteVals = $state<Record<number, number>>({});
  /** puzzle_number -> last derived info */
  lastInfos = $state<Record<number, KeyInfo>>({});

  // ── Custom-mode state ────────────────────────────────────────────────────
  hexBytesLen = $state(0);
  rangeText = $state("");
  lastKeyHex = $state("");
  /** Last full KeyInfo derived in custom mode (shown in the bottom panel). */
  customInfo = $state<KeyInfo | null>(null);
  /** Not rendered — read inside async actions. */
  rangeSpec: RangeSpec = { type: "custom", start_hex: "", end_hex: "" };

  // ── UI state ─────────────────────────────────────────────────────────────
  error = $state("");
  toast = $state<string | null>(null);
  keysRate = $state("0 keys/s");
  /** Locks the Random/Auto buttons once a match is found, to prevent accidents. */
  matched = $state(false);
  /** Grid cell frozen green by a hover-produced match, if any. */
  matchCell = $state<number | null>(null);
  /** Save path shown in the banner, or null when there is no banner. */
  matchBanner = $state<string | null>(null);
  /** Bumped per match so the banner remounts (and re-fires the confetti). */
  matchSeq = $state(0);
  autoRunning = $state(false);
  hover = $state<Hover>({ ...NO_HOVER });

  // ── Not reactive: timers and counters ────────────────────────────────────
  /** Bumped on every new round so stale async derive results are dropped. */
  private groupGen = 0;
  private autoTimer: number | null = null;
  private hoverTimer: number | null = null;
  private toastTimer: number | null = null;
  private editTimer: number | null = null;
  private scannedKeys = 0;
  private rateWindowStart = performance.now();

  // ── Derived ──────────────────────────────────────────────────────────────

  /**
   * The bytes shown in the grid.  Group mode shows the shared base bytes;
   * custom mode shows the low bytes of the last key.  One definition replaces
   * the four `renderGrid()` call sites the imperative version needed.
   */
  gridBytes = $derived.by(() =>
    this.mode === "group" ? this.baseBytes : lowBytes(this.lastKeyHex, this.hexBytesLen),
  );

  /** The bottom AddrInfo panels, in display order. */
  panels = $derived.by<Panel[]>(() => {
    const out: Panel[] = [];
    if (this.mode === "group" && this.activeGroup) {
      for (const p of this.activeGroup.puzzles) {
        const info = this.lastInfos[p.puzzle_number];
        if (info) out.push({ puzzleNum: p.puzzle_number, info });
      }
    } else if (this.customInfo) {
      out.push({ puzzleNum: null, info: this.customInfo });
    }
    return out;
  });

  /** The puzzle's target hash160, or null for a custom-range panel. */
  targetHash160(puzzleNum: number | null): string | null {
    if (puzzleNum === null) return null;
    return this.puzzles.find((p) => p.puzzle_number === puzzleNum)?.hash160 ?? null;
  }

  // ── Small UI actions ─────────────────────────────────────────────────────

  showError(msg: string) {
    this.error = msg;
  }

  private showToast(text: string) {
    this.toast = text;
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast = null;
    }, TOAST_MS);
  }

  async copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast(`copied ${label}`);
    } catch {
      this.showToast("copy failed");
    }
  }

  /**
   * Count `n` derived keys over a 10s rolling window and show the rate next to
   * the vizluck title.  An idle gap > RATE_IDLE_RESET_MS drops the stale window
   * so a fresh scan isn't diluted by dead time.
   */
  private recordKeys(n: number) {
    const now = performance.now();
    if (now - this.rateWindowStart > RATE_IDLE_RESET_MS) {
      this.scannedKeys = 0;
      this.rateWindowStart = now;
    }
    this.scannedKeys += n;
    if (now - this.rateWindowStart >= RATE_WINDOW_MS) {
      const rate = Math.round(this.scannedKeys / ((now - this.rateWindowStart) / 1000));
      this.keysRate = `${rate} keys/s`;
      this.scannedKeys = 0;
      this.rateWindowStart = now;
    }
  }

  /** Clear the previous match's hold on the UI. */
  private clearMatch() {
    this.matched = false;
  }

  // ── Group-mode actions ───────────────────────────────────────────────────

  /** Start a new round for the active group: fresh base + fresh top bytes. */
  private newRound() {
    if (!this.activeGroup) return;
    this.groupGen++;
    this.baseBytes = randomBytes(this.activeGroup.bytes - 1);
    for (const p of this.activeGroup.puzzles) {
      this.topByteVals[p.puzzle_number] = randomTopByte(p);
    }
    this.matchCell = null; // the grid was regenerated
  }

  /** Derive + match-check every puzzle in the active group in one IPC call. */
  private async deriveGroupAll() {
    if (this.mode !== "group" || !this.activeGroup || this.matched) return;
    const gen = this.groupGen;
    const keys = this.activeGroup.puzzles.map((p) =>
      puzzleKeyHex(p, this.topByteVals[p.puzzle_number] ?? 0, this.baseBytes),
    );
    try {
      const results = await deriveGroup(keys);
      if (gen !== this.groupGen || this.mode !== "group" || !this.activeGroup) return;
      this.recordKeys(results.length);
      for (let i = 0; i < results.length; i++) {
        const info = results[i];
        const p = this.activeGroup.puzzles[i];
        if (!p) break;
        this.lastInfos[p.puzzle_number] = info;
        if (info.address_match === true) {
          this.handleGroupMatch(info);
          return;
        }
      }
    } catch (e) {
      this.showError(String(e));
    }
  }

  /** Derive one puzzle's key (used by block-hover top-byte cycling). */
  private async deriveOne(p: PuzzleInfo) {
    if (this.mode !== "group" || this.matched) return;
    const gen = this.groupGen;
    const key = puzzleKeyHex(p, this.topByteVals[p.puzzle_number] ?? 0, this.baseBytes);
    try {
      const results = await deriveGroup([key]);
      const info = results[0];
      if (!info || gen !== this.groupGen || this.mode !== "group") return;
      this.recordKeys(1);
      this.lastInfos[p.puzzle_number] = info;
      if (info.address_match === true) {
        this.handleGroupMatch(info);
      }
    } catch (e) {
      this.showError(String(e));
    }
  }

  /** A group-mode match: freeze everything, persist, celebrate. */
  private handleGroupMatch(info: KeyInfo) {
    this.matched = true;
    this.stopAuto();
    this.stopHoverCycle();
    // The block's `.matched`, the green panel and the banner all follow from
    // `matched` + `lastInfos` + `matchBanner`; nothing is written to the DOM.
    this.matchBanner = info.save_path ?? "";
    this.matchSeq++;
  }

  /** A group was picked from the dropdown. */
  private selectGroup(g: PuzzleGroup) {
    this.stopAuto();
    this.stopHoverCycle();
    if (this.matched) this.clearMatch();
    this.mode = "group";
    this.activeGroup = g;
    this.rangeText = "";
    this.lastInfos = {}; // drop the previous group's panels immediately
    this.newRound();
    void this.deriveGroupAll();
  }

  onGroupChange(raw: string) {
    this.groupSelectBytes = raw;
    const bytes = Number(raw);
    if (!bytes) return; // "custom range" placeholder selected.
    const g = this.groups.find((x) => x.bytes === bytes);
    if (g) this.selectGroup(g);
  }

  // ── Custom-mode actions ──────────────────────────────────────────────────

  /** Full derivation (Random button, custom mode). */
  private async derive() {
    this.showError("");
    try {
      const key = await randomAndDerive(this.rangeSpec);
      this.recordKeys(1);
      this.lastKeyHex = key.private_key_hex;
      this.matchCell = null; // the grid was regenerated
      this.customInfo = key;

      // Custom ranges never target a puzzle, but keep the guard for safety.
      if (key.address_match === true) {
        this.matched = true;
        this.stopAuto();
        this.matchBanner = key.save_path ?? "";
        this.matchSeq++;
      }
    } catch (e) {
      this.showError(String(e));
    }
  }

  /**
   * Lightweight auto-mode tick (custom mode): sample a key and compute only its
   * hash160.  The full info is filled in by `completeLastKey` when auto pauses.
   */
  private async autoTick() {
    this.showError("");
    try {
      const res = await randomAndHash160(this.rangeSpec);
      this.recordKeys(1);
      this.lastKeyHex = res.private_key_hex;
      this.matchCell = null; // the grid was regenerated

      if (res.address_match === true) {
        this.matched = true;
        this.stopAuto();
        await this.completeLastKey(res.private_key_hex);
        this.matchBanner = res.save_path ?? "";
        this.matchSeq++;
      }
    } catch (e) {
      this.showError(String(e));
      this.stopAuto();
    }
  }

  /**
   * Run the full derivation for a specific key hex and show it in the bottom
   * panel.  Guards against stale renders: if `lastKeyHex` has changed by the
   * time the invoke resolves (e.g. the user hit Random), the result is dropped.
   */
  private async completeLastKey(keyHex: string = this.lastKeyHex) {
    if (!keyHex) return;
    try {
      const key = await deriveFull(keyHex, this.rangeSpec);
      if (this.lastKeyHex === keyHex) this.customInfo = key;
    } catch (e) {
      this.showError(String(e));
    }
  }

  // ── Random / Auto (mode-aware) ───────────────────────────────────────────

  /** Generate a fresh round (group) or a single key (custom). */
  onRandom() {
    if (this.matched) this.clearMatch();
    this.stopAuto();
    this.stopHoverCycle();
    if (this.mode === "group" && this.activeGroup) {
      this.newRound();
      void this.deriveGroupAll();
    } else {
      void this.derive();
    }
  }

  /**
   * Toggle auto-randomize (Auto button): continuous rounds in group mode.
   *
   * [imperative] The loop is a self-chaining `setTimeout` that awaits its IPC
   * round-trip before scheduling the next tick — that await *is* the
   * backpressure.  Rewriting it as `setInterval` or an `$effect` loop would
   * let requests pile up unboundedly.
   */
  onAuto() {
    if (this.autoTimer !== null) {
      this.stopAuto();
      if (this.mode !== "group") void this.completeLastKey();
      return;
    }
    if (this.matched) this.clearMatch();
    this.stopHoverCycle();
    // While auto runs, hover is fully inert: cycling is already blocked by the
    // `autoTimer` guard, and this flag also kills the :hover visual feedback
    // (via `body.auto-running`, synced in Hex.svelte).
    this.autoRunning = true;

    // The branch is picked once, as before.  Mode cannot change mid-run anyway:
    // both `selectGroup` and `onRangeInput` stop auto first.
    const groupTick = this.mode === "group" && this.activeGroup;
    const tick = async () => {
      if (groupTick) {
        this.newRound();
        await this.deriveGroupAll();
      } else {
        await this.autoTick();
      }
      if (this.autoTimer !== null) this.autoTimer = window.setTimeout(tick, HOVER_INTERVAL_MS);
    };
    this.autoTimer = window.setTimeout(tick, 0);
  }

  /** Stop the auto loop timer and reset the button.  No other side effects. */
  private stopAuto() {
    if (this.autoTimer !== null) {
      window.clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
    this.autoRunning = false;
  }

  // ── Hover interaction ────────────────────────────────────────────────────
  // Group mode: hovering a grid cell cycles that base byte; hovering a puzzle
  // block cycles its high byte within [start_top, end_top] and shows AddrInfo.
  // Custom mode: hovering a grid cell cycles that key byte.
  //
  // [imperative] Each cycle is a `setInterval` driving state changes; the
  // `.cycling` / `.active` highlights are derived from `hover`, so stopping the
  // cycle is just clearing it.

  /** Stop any in-progress hover cycle and clear its visual state. */
  private stopHoverCycle() {
    if (this.hoverTimer !== null) {
      window.clearInterval(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.hover = { ...NO_HOVER };
  }

  /** Begin (or switch to) a hover cycle on grid cell `cellIdx`. */
  startGridHover(cellIdx: number) {
    if (this.autoTimer !== null || this.matched) return;
    if (this.matchCell === cellIdx) return;
    if (this.hoverTimer !== null && this.hover.kind === "grid" && this.hover.cellIdx === cellIdx) {
      return;
    }
    this.stopHoverCycle();

    this.hover = {
      kind: "grid",
      cellIdx,
      puzzleNum: -1,
      // Base bytes (group) and custom key bytes are free 00–ff.
      startVal: parseInt(this.gridBytes[cellIdx] ?? "0", 16),
      minVal: null,
      maxVal: null,
    };
    this.hoverTimer = window.setInterval(() => this.gridHoverTick(), HOVER_INTERVAL_MS);
  }

  endGridHover(cellIdx: number) {
    if (this.hover.kind === "grid" && this.hover.cellIdx === cellIdx) this.stopHoverCycle();
  }

  /** One grid hover step: advance the byte, refresh keys, stop at the end. */
  private gridHoverTick() {
    const idx = this.hover.cellIdx;
    const cur = this.gridBytes[idx];
    if (cur === undefined) {
      this.stopHoverCycle(); // the grid was regenerated under us
      return;
    }
    const next = (parseInt(cur, 16) + 1) & 0xff;
    if (next === this.hover.startVal) {
      this.stopHoverCycle();
      return;
    }
    const hex = next.toString(16).padStart(2, "0");

    if (this.mode === "group") {
      this.baseBytes[idx] = hex;
      void this.deriveGroupAll();
    } else {
      this.lastKeyHex = setKeyByte(this.lastKeyHex, this.hexBytesLen, idx, next);
      void this.refreshHoverInfo(this.lastKeyHex);
    }
  }

  /** Begin a hover cycle on a puzzle block (top byte + AddrInfo popover). */
  startBlockHover(puzzleNum: number) {
    if (this.autoTimer !== null || this.matched) return;
    if (this.lastInfos[puzzleNum]?.address_match === true) return;
    const p = this.activeGroup?.puzzles.find((x) => x.puzzle_number === puzzleNum);
    if (!p) return;
    if (this.hoverTimer !== null && this.hover.kind === "block" && this.hover.puzzleNum === puzzleNum) {
      return;
    }
    this.stopHoverCycle();

    const b = topByteBounds(p);
    this.hover = {
      kind: "block",
      cellIdx: -1,
      puzzleNum,
      startVal: this.topByteVals[puzzleNum] ?? b.min,
      minVal: b.min,
      maxVal: b.max,
    };
    this.hoverTimer = window.setInterval(() => this.blockHoverTick(), HOVER_INTERVAL_MS);
  }

  endBlockHover(puzzleNum: number) {
    if (this.hover.kind === "block" && this.hover.puzzleNum === puzzleNum) this.stopHoverCycle();
  }

  /** One block hover step: advance the top byte within its range, derive, stop. */
  private blockHoverTick() {
    const { puzzleNum, minVal, maxVal } = this.hover;
    const p = this.activeGroup?.puzzles.find((x) => x.puzzle_number === puzzleNum);
    if (!p || minVal === null || maxVal === null) {
      this.stopHoverCycle();
      return;
    }
    const cur = this.topByteVals[puzzleNum] ?? minVal;
    const next = cur >= maxVal ? minVal : cur + 1;
    if (next === this.hover.startVal) {
      this.stopHoverCycle();
      return;
    }
    this.topByteVals[puzzleNum] = next;
    void this.deriveOne(p);
  }

  /** Derive + show the panel for a hover-produced key (custom mode). */
  private async refreshHoverInfo(keyHex: string) {
    try {
      const key = await deriveFull(keyHex, this.rangeSpec);
      if (this.lastKeyHex !== keyHex) return;
      this.recordKeys(1);
      if (key.address_match === true) {
        this.handleHoverMatch(key);
      } else {
        this.customInfo = key;
      }
    } catch (e) {
      this.showError(String(e));
    }
  }

  /** A hover cycle produced a match: stop, mark the cell, lock the UI. */
  private handleHoverMatch(key: KeyInfo) {
    const idx = this.hover.cellIdx;
    this.stopHoverCycle();
    if (idx >= 0) this.matchCell = idx;

    this.matched = true;
    this.stopAuto();
    this.customInfo = key;
    this.matchBanner = key.save_path ?? "";
    this.matchSeq++;
  }

  // ── Range spec management ────────────────────────────────────────────────

  /** The user edited the input box → switch to a custom spec (debounced). */
  onRangeInput(raw: string) {
    this.rangeText = raw;
    this.stopAuto();
    if (this.editTimer !== null) window.clearTimeout(this.editTimer);
    this.editTimer = window.setTimeout(() => this.applyRange(this.rangeText), EDIT_DEBOUNCE_MS);
  }

  private applyRange(raw: string) {
    const parts = splitRange(raw);
    if (!parts) {
      this.showError("use the format start_hex:end_hex  (: or ：)");
      return;
    }
    const [start, end] = parts;
    if (!isValidHex(start) || !isValidHex(end)) {
      this.showError("both sides must be valid hex (max 64 chars each)");
      return;
    }
    const hbl = Math.max(hexByteLen(start), hexByteLen(end));
    if (hbl > 32) {
      this.showError("hex_bytes_len must be ≤ 32");
      return;
    }
    if (hbl === 0) {
      this.showError("empty range");
      return;
    }
    this.showError("");

    // Switch out of group mode into custom mode.  The divider and puzzle blocks
    // disappear because they render off `mode`/`activeGroup`, not off `hidden`.
    if (this.matched) this.clearMatch();
    this.mode = "custom";
    this.activeGroup = null;
    this.groupSelectBytes = "";
    this.customInfo = null;
    this.hexBytesLen = hbl;
    this.rangeSpec = { type: "custom", start_hex: start, end_hex: end };
    void this.derive();
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  async init() {
    // Load puzzles and group them by byte length.
    try {
      this.puzzles = await getPuzzles();
    } catch (e) {
      this.showError(`failed to load puzzles: ${e}`);
      return;
    }
    const byBytes = new Map<number, PuzzleInfo[]>();
    for (const p of this.puzzles) {
      const arr = byBytes.get(p.hex_bytes_len) ?? [];
      arr.push(p);
      byBytes.set(p.hex_bytes_len, arr);
    }
    this.groups = [...byBytes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bytes, ps]) => ({
        bytes,
        puzzles: ps.sort((a, b) => a.puzzle_number - b.puzzle_number),
      }));

    // Default: first group so the page isn't empty.
    if (this.groups.length > 0) {
      this.groupSelectBytes = String(this.groups[0].bytes);
      this.selectGroup(this.groups[0]);
    }
  }
}
