import { invoke } from "@tauri-apps/api/core";

// ── Types (mirror the Rust response structs) ────────────────────────────────

interface PuzzleInfo {
  puzzle_number: number;
  hex_bytes_len: number;
  start_hex: string;
  end_hex: string;
  hash160: string;
}

type RangeSpec =
  | { type: "puzzle"; puzzle_number: number }
  | { type: "custom"; start_hex: string; end_hex: string };

interface KeyInfo {
  private_key_hex: string;
  xprv: string;
  xpub: string;
  compressed_public_key: string;
  uncompressed_public_key: string;
  legacy_address: string;
  pubkey_hash160: string;
  address_match: boolean | null;
  /** Absolute path the match was saved to, or null when no match was saved. */
  save_path: string | null;
}

/** Lightweight auto-mode result: key + hash160 only (no address/xprv). */
interface AutoKeyInfo {
  private_key_hex: string;
  pubkey_hash160: string;
  address_match: boolean | null;
  save_path: string | null;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const puzzleSelect = $<HTMLSelectElement>("puzzle-select");
const rangeInput = $<HTMLInputElement>("range-input");
const btnRandom = $<HTMLButtonElement>("btn-random");
const btnAuto = $<HTMLButtonElement>("btn-auto");
const gridEl = $("grid");
const infoEl = $("info");
const errorEl = $("error");
const toastEl = $("toast");

// ── State ─────────────────────────────────────────────────────────────────────

let puzzles: PuzzleInfo[] = [];
/** The spec currently in effect (drives the next derive). */
let rangeSpec: RangeSpec = { type: "custom", start_hex: "", end_hex: "" };
let hexBytesLen = 0;
/** Last key shown on the grid during auto mode, so pause can fill in its info. */
let lastKeyHex = "";
/** Locks the Random/Auto buttons once a match is found, to prevent accidents. */
let matchFound = false;

function setButtonsDisabled(disabled: boolean) {
  btnRandom.disabled = disabled;
  btnAuto.disabled = disabled;
}

let autoTimer: number | null = null;
let toastTimer: number | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function showError(msg: string) {
  if (msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  } else {
    errorEl.textContent = "";
    errorEl.hidden = true;
  }
}

function showToast(text: string) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 1200);
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`copied ${label}`);
  } catch {
    showToast("copy failed");
  }
}

/**
 * Split a range string on either ASCII `:` (U+003A) or fullwidth `：` (U+FF1A).
 * Returns null if there is not exactly one separator.
 */
function splitRange(raw: string): [string, string] | null {
  const ascii = raw.indexOf(":");
  const full = raw.indexOf("：");
  let idx = -1;
  if (ascii >= 0 && full >= 0) idx = Math.min(ascii, full);
  else if (ascii >= 0) idx = ascii;
  else if (full >= 0) idx = full;
  if (idx < 0) return null;
  const start = raw.slice(0, idx).trim();
  const end = raw.slice(idx + 1).trim();
  if (!start || !end) return null;
  return [start, end];
}

/** Byte length of a hex string (low bytes), odd length rounds up. */
function hexByteLen(hex: string): number {
  let h = hex.trim();
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  if (h.length === 0) return 0;
  return Math.ceil(h.length / 2);
}

function isValidHex(hex: string): boolean {
  let h = hex.trim();
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  return h.length > 0 && h.length <= 64 && /^[0-9a-fA-F]+$/.test(h);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** Refresh the grid from a 64-char key hex (low `hexBytesLen` bytes). */
function renderGrid(keyHex: string) {
  const bytes = lowBytes(keyHex, hexBytesLen);
  gridEl.style.gridTemplateColumns = `repeat(${hexBytesLen}, 1fr)`;
  gridEl.replaceChildren();
  for (let i = 0; i < hexBytesLen; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.textContent = bytes[i];
    gridEl.appendChild(cell);
  }
}

/** Extract the low `n` bytes (as 2-char hex strings) from a 64-char key hex. */
function lowBytes(keyHex: string, n: number): string[] {
  const slice = keyHex.slice(-n * 2); // last n bytes
  const out: string[] = [];
  for (let i = 0; i < slice.length; i += 2) {
    out.push(slice.slice(i, i + 2));
  }
  return out;
}

function renderInfo(key: KeyInfo) {
  const emoji =
    key.address_match === null ? "" : key.address_match ? " ✅" : " ❌";

  const rows: Array<{ label: string; value: string; cls: string }> = [
    { label: "Private Key (32 bytes)", value: key.private_key_hex, cls: "pk" },
    { label: "BIP32 Master Key (xprv)", value: key.xprv, cls: "xprv" },
    { label: "Public Key (compressed)", value: key.compressed_public_key, cls: "pub" },
    { label: "Public Key (uncompressed)", value: key.uncompressed_public_key, cls: "pub" },
    {
      label: `Legacy BTC Address${emoji}`,
      value: key.legacy_address,
      cls: "addr" + (emoji ? (key.address_match ? " match" : " nomatch") : ""),
    },
  ];

  infoEl.replaceChildren();
  for (const row of rows) {
    const card = document.createElement("div");
    card.className = "card " + row.cls;
    card.title = "click to copy";

    const lab = document.createElement("div");
    lab.className = "card-label";
    lab.textContent = row.label;

    const val = document.createElement("div");
    val.className = "card-value";
    val.textContent = row.value;

    card.appendChild(lab);
    card.appendChild(val);
    card.addEventListener("click", () => copyText(row.value, row.label));
    infoEl.appendChild(card);
  }
}

function renderEmptyInfo() {
  infoEl.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = "Pick a puzzle or enter a range, then hit Random.";
  infoEl.appendChild(empty);
}

// ── Core actions ──────────────────────────────────────────────────────────────

/** Full derivation (Random button): grid + bottom info in one shot. */
async function derive() {
  showError("");
  try {
    const key = await invoke<KeyInfo>("random_and_derive", {
      spec: rangeSpec,
      network: "mainnet",
    });
    lastKeyHex = key.private_key_hex;
    renderGrid(key.private_key_hex);
    renderInfo(key);

    // On a puzzle hit: pause auto mode, lock the buttons and celebrate.
    if (key.address_match === true) {
      matchFound = true;
      stopAuto();
      setButtonsDisabled(true);
      showMatchBanner(key.save_path ?? "");
    }
  } catch (e) {
    showError(String(e));
  }
}

/**
 * Lightweight auto-mode tick: sample a key and compute only its hash160.
 * Refreshes the grid and stashes the key hex, but skips address / xprv / etc.
 * Those are filled in later by `completeLastKey` when auto mode pauses.
 */
async function autoTick() {
  showError("");
  try {
    const res = await invoke<AutoKeyInfo>("random_and_hash160", {
      spec: rangeSpec,
      network: "mainnet",
    });
    lastKeyHex = res.private_key_hex;
    renderGrid(res.private_key_hex);

    if (res.address_match === true) {
      // Match! Stop the loop, lock the buttons, then materialize the full info + banner.
      matchFound = true;
      stopAuto();
      setButtonsDisabled(true);
      await completeLastKey(res.private_key_hex);
      showMatchBanner(res.save_path ?? "");
    }
  } catch (e) {
    showError(String(e));
    stopAuto();
  }
}

/**
 * Run the full derivation for a specific key hex and update the bottom info.
 * Guards against stale renders: if `lastKeyHex` has changed by the time the
 * invoke resolves (e.g. the user hit Random), the result is dropped.
 */
async function completeLastKey(keyHex: string = lastKeyHex) {
  if (!keyHex) return;
  try {
    const key = await invoke<KeyInfo>("derive_full", {
      private_key_hex: keyHex,
      spec: rangeSpec,
    });
    if (lastKeyHex === keyHex) renderInfo(key);
  } catch (e) {
    showError(String(e));
  }
}

/**
 * Show a full-width "MATCH FOUND" banner above the grid with the file the
 * result was saved to.  Stays visible until the next generate.
 */
function showMatchBanner(savePath: string) {
  // Remove any previous banner.
  document.getElementById("match-banner")?.remove();

  const banner = document.createElement("div");
  banner.id = "match-banner";
  banner.className = "match-banner";

  const title = document.createElement("div");
  title.className = "match-title";
  title.textContent = "🎉 MATCH FOUND! 🎉";

  const sub = document.createElement("div");
  sub.className = "match-sub";
  if (savePath.startsWith("ERROR:")) {
    sub.textContent = `Could not save file: ${savePath.slice(6).trim()}`;
  } else if (savePath) {
    sub.textContent = `Saved to ${savePath}`;
  } else {
    sub.textContent = "Puzzle hash160 matched!";
  }

  banner.appendChild(title);
  banner.appendChild(sub);
  banner.addEventListener("click", () => copyText(savePath, "file path"));

  gridEl.parentElement?.insertBefore(banner, gridEl);
}

/** Generate one key (Random button): full derivation. */
async function onRandom() {
  if (matchFound) {
    // Starting a new search after a match: unlock the buttons.
    matchFound = false;
    setButtonsDisabled(false);
  }
  stopAuto();
  await derive();
}

/** Toggle auto-randomize (Auto button). */
function onAuto() {
  if (autoTimer !== null) {
    // User clicked Stop: halt the loop, then fill in the last key's info.
    stopAuto();
    void completeLastKey();
    return;
  }
  if (matchFound) {
    // Starting a new search after a match: unlock the buttons.
    matchFound = false;
    setButtonsDisabled(false);
  }
  btnAuto.textContent = "⏸ Stop";
  const tick = async () => {
    await autoTick();
    if (autoTimer !== null) {
      autoTimer = window.setTimeout(tick, 60);
    }
  };
  autoTimer = window.setTimeout(tick, 0);
}

/** Stop the auto loop timer and reset the button.  No other side effects. */
function stopAuto() {
  if (autoTimer !== null) {
    window.clearTimeout(autoTimer);
    autoTimer = null;
  }
  btnAuto.textContent = "▶ Auto";
}

// ── Range spec management ─────────────────────────────────────────────────────

/** A puzzle was selected from the dropdown. */
function selectPuzzle(puzzle: PuzzleInfo) {
  stopAuto();
  // A fresh puzzle selection after a match: unlock the buttons.
  if (matchFound) {
    matchFound = false;
    setButtonsDisabled(false);
  }
  hexBytesLen = puzzle.hex_bytes_len;
  rangeInput.value = `${puzzle.start_hex}:${puzzle.end_hex}`;
  rangeSpec = { type: "puzzle", puzzle_number: puzzle.puzzle_number };
  void derive();
}

/** The user edited the input box → switch to a custom spec (debounced). */
let editTimer: number | null = null;
function onInputEdit() {
  stopAuto();
  if (editTimer !== null) window.clearTimeout(editTimer);
  editTimer = window.setTimeout(() => {
    const raw = rangeInput.value;
    const parts = splitRange(raw);
    if (!parts) {
      showError("use the format start_hex:end_hex  (: or ：)");
      return;
    }
    const [start, end] = parts;
    if (!isValidHex(start) || !isValidHex(end)) {
      showError("both sides must be valid hex (max 64 chars each)");
      return;
    }
    const startLen = hexByteLen(start);
    const endLen = hexByteLen(end);
    const hbl = Math.max(startLen, endLen);
    if (hbl > 32) {
      showError("hex_bytes_len must be ≤ 32");
      return;
    }
    if (hbl === 0) {
      showError("empty range");
      return;
    }
    showError("");
    puzzleSelect.value = "";
    hexBytesLen = hbl;
    rangeSpec = { type: "custom", start_hex: start, end_hex: end };
    void derive();
  }, 300);
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Load puzzles into the dropdown.
  try {
    puzzles = await invoke<PuzzleInfo[]>("get_puzzles");
  } catch (e) {
    showError(`failed to load puzzles: ${e}`);
    return;
  }
  for (const p of puzzles) {
    const opt = document.createElement("option");
    opt.value = String(p.puzzle_number);
    opt.textContent = `#${p.puzzle_number}: ${p.hex_bytes_len}bits`;
    puzzleSelect.appendChild(opt);
  }

  // Wire events.
  puzzleSelect.addEventListener("change", () => {
    const num = Number(puzzleSelect.value);
    if (!num) {
      // "custom range" placeholder selected.
      return;
    }
    const p = puzzles.find((x) => x.puzzle_number === num);
    if (p) selectPuzzle(p);
  });
  rangeInput.addEventListener("input", onInputEdit);
  btnRandom.addEventListener("click", () => void onRandom());
  btnAuto.addEventListener("click", () => onAuto());

  // Default: select the first puzzle so the page isn't empty.
  if (puzzles.length > 0) {
    puzzleSelect.value = String(puzzles[0].puzzle_number);
    selectPuzzle(puzzles[0]);
  } else {
    renderEmptyInfo();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  void init();
});
