import { invoke } from "@tauri-apps/api/core";

// ── Types (mirror the Rust response structs) ────────────────────────────────

interface PuzzleInfo {
  puzzle_number: number;
  hex_bytes_len: number;
  start_hex: string;
  end_hex: string;
  hash160: string;
  /** Inclusive lower bound of the top byte (the puzzle's high byte). */
  start_top: number;
  /** Exclusive upper bound of the top byte; 0 encodes overflow (real max 0xFF). */
  end_top: number;
}

/** A byte-group: puzzles sharing the same `hex_bytes_len`. */
interface PuzzleGroup {
  bytes: number;
  puzzles: PuzzleInfo[];
}

type RangeSpec =
  | { type: "puzzle"; puzzle_number: number }
  | { type: "custom"; start_hex: string; end_hex: string };

interface KeyInfo {
  private_key_hex: string;
  xprv: string;
  xpub: string;
  compressed_public_key: string;
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

const groupSelect = $<HTMLSelectElement>("group-select");
const rangeInput = $<HTMLInputElement>("range-input");
const btnRandom = $<HTMLButtonElement>("btn-random");
const btnAuto = $<HTMLButtonElement>("btn-auto");
const gridEl = $("grid");
const dividerEl = $("divider");
const blocksEl = $("puzzle-blocks");
const infoEl = $("info");
const errorEl = $("error");
const toastEl = $("toast");

// ── State ─────────────────────────────────────────────────────────────────────

let puzzles: PuzzleInfo[] = [];
let groups: PuzzleGroup[] = [];
/** Which flow is active: a byte-group, or a custom range. */
let mode: "group" | "custom" = "custom";
let activeGroup: PuzzleGroup | null = null;

// Group-mode state.
let baseBytes: string[] = []; // the `bytes - 1` shared random bytes (2-char hex)
let topByteVals = new Map<number, number>(); // puzzle_number -> current high byte
let lastInfos = new Map<number, KeyInfo>(); // puzzle_number -> last derived info
/** Bumped on every new round so stale async derive results are dropped. */
let groupGen = 0;

// Custom-mode state.
let hexBytesLen = 0;
let rangeSpec: RangeSpec = { type: "custom", start_hex: "", end_hex: "" };
let lastKeyHex = "";

/** Locks the Random/Auto buttons once a match is found, to prevent accidents. */
let matchFound = false;

function setButtonsDisabled(disabled: boolean) {
  btnRandom.disabled = disabled;
  btnAuto.disabled = disabled;
}

let autoTimer: number | null = null;
let toastTimer: number | null = null;

// ── Hover state ──────────────────────────────────────────────────────────
// One cycle at a time. `hoverKind` says whether a grid cell or a puzzle block
// is currently counting through its range; see startHoverCycle / startBlockCycle.
const HOVER_INTERVAL_MS = 60;
let hoverTimer: number | null = null;
let hoverKind: "grid" | "block" | null = null;
let hoverCellIdx = -1; // grid: cell index
let hoverPuzzleNum = -1; // block: puzzle number
let hoverStartVal = -1;
/** Inclusive lower bound for a bounded byte, or null for a free cell. */
let hoverMinVal: number | null = null;
/** Inclusive upper bound for a bounded byte, or null for a free cell. */
let hoverMaxVal: number | null = null;

// ── Bottom AddrInfo panel state ───────────────────────────────────────────────

/** Last full KeyInfo derived in custom mode (shown in the bottom panel). */
let customInfo: KeyInfo | null = null;

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

/** `n` random bytes, each 00–ff, as 2-char hex strings (CSPRNG). */
function randomBytes(n: number): string[] {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0"));
}

/** Inclusive [min, max] the puzzle's high byte may take (from start/end hex). */
function topByteBounds(p: PuzzleInfo): { min: number; max: number } {
  const max = p.end_top === 0 ? 0xff : p.end_top - 1; // overflow → [start_top, 0xFF]
  return { min: p.start_top, max };
}

function randomTopByte(p: PuzzleInfo): number {
  const { min, max } = topByteBounds(p);
  const range = max - min + 1;
  const arr = new Uint8Array(1);
  crypto.getRandomValues(arr);
  return min + (arr[0] % range);
}

/**
 * Build the 64-char key hex for a puzzle from the current base + high byte:
 * `00…00 || highByte || baseBytes`, i.e. high bytes 00-padded above the top byte.
 */
function puzzleKeyHex(p: PuzzleInfo): string {
  const topIdx = 32 - p.hex_bytes_len;
  const pad = "00".repeat(topIdx);
  const top = (topByteVals.get(p.puzzle_number) ?? 0).toString(16).padStart(2, "0");
  const low = baseBytes.join("");
  return pad + top + low;
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

/** Refresh the grid from a list of 2-char hex bytes. */
function renderGrid(bytes: string[]) {
  gridEl.style.gridTemplateColumns = `repeat(${bytes.length}, 1fr)`;
  gridEl.replaceChildren();
  for (const b of bytes) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.textContent = b;
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

/** Render one puzzle block per puzzle in the active group. */
function renderBlocks() {
  blocksEl.replaceChildren();
  if (!activeGroup) return;
  for (const p of activeGroup.puzzles) {
    const block = document.createElement("div");
    block.className = "pblock";
    block.dataset.puzzle = String(p.puzzle_number);

    const num = document.createElement("div");
    num.className = "pblock-num";
    num.textContent = `#${p.puzzle_number}`;

    const val = document.createElement("div");
    val.className = "pblock-val";
    val.textContent = (topByteVals.get(p.puzzle_number) ?? 0)
      .toString(16)
      .padStart(2, "0");

    const range = document.createElement("div");
    range.className = "pblock-range";
    const b = topByteBounds(p);
    range.textContent =
      `${b.min.toString(16).padStart(2, "0")}–${b.max.toString(16).padStart(2, "0")}`;

    block.appendChild(num);
    block.appendChild(val);
    block.appendChild(range);
    blocksEl.appendChild(block);
  }
}

// ── AddrInfo component (bottom panel) ─────────────────────────────────────────
// The derived-key cards (private key, xprv, compressed pubkey, legacy address),
// shown persistently at the bottom of the page — one panel per puzzle in the
// active group, or a single panel for a custom-range result.  Every card is
// click-to-copy and every derivation tick refreshes its panel in place.

/** Build the 4 click-to-copy cards (no head) for a KeyInfo. */
function buildAddrInfoCards(info: KeyInfo): HTMLElement[] {
  const emoji =
    info.address_match === null ? "" : info.address_match ? " ✅" : " ❌";
  const rows: Array<{ label: string; value: string; cls: string }> = [
    { label: "Private Key (32 bytes)", value: info.private_key_hex, cls: "pk" },
    { label: "BIP32 Master Key (xprv)", value: info.xprv, cls: "xprv" },
    { label: "Public Key (compressed)", value: info.compressed_public_key, cls: "pub" },
    {
      label: `Legacy BTC Address${emoji}`,
      value: info.legacy_address,
      cls: "addr" + (emoji ? (info.address_match ? " match" : " nomatch") : ""),
    },
  ];

  const nodes: HTMLElement[] = [];
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
    nodes.push(card);
  }
  return nodes;
}

/**
 * Build a bottom-panel AddrInfo: optional `#N` head + the 4 cards.  A matched
 * panel gets `.matched` (green) so it stands out after the match freeze.
 */
function buildAddrInfoPanel(puzzleNum: number | null, info: KeyInfo): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "addr-info";
  if (puzzleNum !== null) panel.dataset.puzzle = String(puzzleNum);
  if (info.address_match === true) panel.classList.add("matched");

  if (puzzleNum !== null) {
    const head = document.createElement("div");
    head.className = "addr-info-head";
    head.textContent = `Puzzle #${puzzleNum}`;
    panel.appendChild(head);
  }

  for (const card of buildAddrInfoCards(info)) panel.appendChild(card);
  return panel;
}

/** Re-render the whole bottom section from the current state. */
function renderInfoSection() {
  infoEl.replaceChildren();
  if (mode === "group" && activeGroup) {
    for (const p of activeGroup.puzzles) {
      const info = lastInfos.get(p.puzzle_number);
      if (info) infoEl.appendChild(buildAddrInfoPanel(p.puzzle_number, info));
    }
  } else if (customInfo) {
    infoEl.appendChild(buildAddrInfoPanel(null, customInfo));
  }
}

/** Refresh one panel in place (keeps `.active` highlight across block ticks). */
function updateInfoPanel(puzzleNum: number | null, info: KeyInfo) {
  const sel =
    puzzleNum !== null ? `.addr-info[data-puzzle="${puzzleNum}"]` : ".addr-info";
  const existing = infoEl.querySelector<HTMLElement>(sel);
  const fresh = buildAddrInfoPanel(puzzleNum, info);
  if (existing?.classList.contains("active")) fresh.classList.add("active");
  if (existing?.parentElement) existing.replaceWith(fresh);
  else infoEl.appendChild(fresh);
}

// ── Group-mode actions ────────────────────────────────────────────────────────

/** Start a new round for the active group: fresh base + fresh top bytes. */
function newRound() {
  if (!activeGroup) return;
  groupGen++;
  baseBytes = randomBytes(activeGroup.bytes - 1);
  for (const p of activeGroup.puzzles) {
    topByteVals.set(p.puzzle_number, randomTopByte(p));
  }
  renderGrid(baseBytes);
  renderBlocks();
}

/** Derive + match-check every puzzle in the active group in one IPC call. */
async function deriveGroupAll() {
  if (mode !== "group" || !activeGroup || matchFound) return;
  const gen = groupGen;
  const keys = activeGroup.puzzles.map((p) => puzzleKeyHex(p));
  try {
    const results = await invoke<KeyInfo[]>("derive_group", { private_keys: keys });
    if (gen !== groupGen || mode !== "group" || !activeGroup) return;
    for (let i = 0; i < results.length; i++) {
      const info = results[i];
      const p = activeGroup.puzzles[i];
      if (!p) break;
      lastInfos.set(p.puzzle_number, info);
      if (info.address_match === true) {
        handleGroupMatch(p.puzzle_number, info);
        return;
      }
    }
    // Bottom AddrInfo panels always mirror the latest derivation.
    renderInfoSection();
  } catch (e) {
    showError(String(e));
  }
}

/** Derive one puzzle's key (used by block-hover top-byte cycling). */
async function deriveOne(p: PuzzleInfo) {
  if (mode !== "group" || matchFound) return;
  const gen = groupGen;
  const key = puzzleKeyHex(p);
  try {
    const results = await invoke<KeyInfo[]>("derive_group", { private_keys: [key] });
    const info = results[0];
    if (!info || gen !== groupGen || mode !== "group") return;
    lastInfos.set(p.puzzle_number, info);
    if (info.address_match === true) {
      handleGroupMatch(p.puzzle_number, info);
      return;
    }
    updateInfoPanel(p.puzzle_number, info);
  } catch (e) {
    showError(String(e));
  }
}

/** A group-mode match: freeze everything, persist, celebrate. */
function handleGroupMatch(puzzleNum: number, info: KeyInfo) {
  matchFound = true;
  stopAuto();
  stopHoverCycle();
  setButtonsDisabled(true);

  const block = blocksEl.querySelector<HTMLElement>(
    `.pblock[data-puzzle="${puzzleNum}"]`,
  );
  block?.classList.remove("cycling");
  block?.classList.add("matched");

  // The matched panel is rendered green (via address_match) by the re-render.
  renderInfoSection();

  showMatchBanner(info.save_path ?? "");
}

/** A group was picked from the dropdown. */
function selectGroup(g: PuzzleGroup) {
  stopAuto();
  stopHoverCycle();
  if (matchFound) {
    matchFound = false;
    setButtonsDisabled(false);
  }
  mode = "group";
  activeGroup = g;
  rangeInput.value = "";
  dividerEl.hidden = false;
  blocksEl.hidden = false;
  lastInfos.clear();
  renderInfoSection(); // drop the previous group's panels immediately
  newRound();
  void deriveGroupAll();
}

// ── Custom-mode actions ───────────────────────────────────────────────────────

/** Full derivation (Random button, custom mode): grid + bottom panel. */
async function derive() {
  showError("");
  try {
    const key = await invoke<KeyInfo>("random_and_derive", {
      spec: rangeSpec,
      network: "mainnet",
    });
    lastKeyHex = key.private_key_hex;
    renderGrid(lowBytes(key.private_key_hex, hexBytesLen));
    customInfo = key;
    renderInfoSection();

    // Custom ranges never target a puzzle, but keep the guard for safety.
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
 * Lightweight auto-mode tick (custom mode): sample a key and compute only its
 * hash160.  Refreshes the grid and stashes the key hex; the full info is filled
 * in by `completeLastKey` when auto mode pauses.
 */
async function autoTick() {
  showError("");
  try {
    const res = await invoke<AutoKeyInfo>("random_and_hash160", {
      spec: rangeSpec,
      network: "mainnet",
    });
    lastKeyHex = res.private_key_hex;
    renderGrid(lowBytes(res.private_key_hex, hexBytesLen));

    if (res.address_match === true) {
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
 * Run the full derivation for a specific key hex and show it in the bottom panel.
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
    if (lastKeyHex === keyHex) {
      customInfo = key;
      renderInfoSection();
    }
  } catch (e) {
    showError(String(e));
  }
}

// ── Match banner + confetti ───────────────────────────────────────────────────

/**
 * Show a full-width "MATCH FOUND" banner above the grid with the file the
 * result was saved to.  Stays visible until the next generate.
 */
function showMatchBanner(savePath: string) {
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

  launchConfetti();
}

/**
 * Lightweight canvas confetti — spawns a burst of BTC-themed particles that
 * fall, spin, and fade out on their own.  The canvas is removed once every
 * particle has expired, so there is no persistent overlay.
 */
function launchConfetti() {
  const canvas = document.createElement("canvas");
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "9999";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
  };
  resize();

  const colors = ["#f7931a", "#ffd700", "#2ecc71", "#ff6b6b", "#4ecdc4", "#ffffff"];
  const particles: Array<{
    x: number; y: number; vx: number; vy: number;
    size: number; color: string; rot: number; vrot: number; life: number;
  }> = [];

  // Two side cannons + a central burst.
  const spawn = (originX: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI; // upward hemisphere
      const speed = 4 + Math.random() * 8;
      particles.push({
        x: originX,
        y: window.innerHeight * 0.9,
        vx: Math.cos(angle) * speed * (originX < window.innerWidth / 2 ? 1 : -1),
        vy: -Math.sin(angle) * speed - 4,
        size: 6 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 0.3,
        life: 1,
      });
    }
  };
  spawn(window.innerWidth * 0.2, 60);
  spawn(window.innerWidth * 0.8, 60);
  spawn(window.innerWidth * 0.5, 40);

  let lastTime = performance.now();
  let done = false;

  const tick = (now: number) => {
    const dt = Math.min((now - lastTime) / 16.67, 3); // normalize to ~60fps frames
    lastTime = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vy += 0.25 * dt; // gravity
      p.vx *= 0.99; // air drag
      p.x += p.vx * dt * dpr;
      p.y += p.vy * dt * dpr;
      p.rot += p.vrot * dt;
      p.life -= 0.008 * dt; // fade out

      if (p.life <= 0 || p.y > window.innerHeight * dpr + 40) {
        particles.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size * dpr / 2, -p.size * dpr / 2, p.size * dpr, p.size * dpr * 0.6);
      ctx.restore();
    }

    if (particles.length > 0) {
      requestAnimationFrame(tick);
    } else {
      canvas.remove();
      done = true;
    }
  };
  requestAnimationFrame(tick);

  // Safety net: force-remove after 6s even if some particles linger.
  window.setTimeout(() => {
    if (!done) canvas.remove();
  }, 6000);
}

// ── Random / Auto (mode-aware) ────────────────────────────────────────────────

/** Generate a fresh round (group) or a single key (custom). */
function onRandom() {
  if (matchFound) {
    matchFound = false;
    setButtonsDisabled(false);
  }
  stopAuto();
  stopHoverCycle();
  if (mode === "group" && activeGroup) {
    newRound();
    void deriveGroupAll();
  } else {
    void derive();
  }
}

/** Toggle auto-randomize (Auto button): continuous rounds in group mode. */
function onAuto() {
  if (autoTimer !== null) {
    stopAuto();
    if (mode !== "group") void completeLastKey();
    return;
  }
  if (matchFound) {
    matchFound = false;
    setButtonsDisabled(false);
  }
  stopHoverCycle();
  // While auto runs, hover is fully inert: cycling is already blocked by the
  // `autoTimer` guard, and this class also kills the :hover visual feedback.
  document.body.classList.add("auto-running");
  btnAuto.textContent = "⏸ Stop";

  if (mode === "group" && activeGroup) {
    const tick = async () => {
      newRound();
      await deriveGroupAll();
      if (autoTimer !== null) autoTimer = window.setTimeout(tick, HOVER_INTERVAL_MS);
    };
    autoTimer = window.setTimeout(tick, 0);
  } else {
    const tick = async () => {
      await autoTick();
      if (autoTimer !== null) autoTimer = window.setTimeout(tick, HOVER_INTERVAL_MS);
    };
    autoTimer = window.setTimeout(tick, 0);
  }
}

/** Stop the auto loop timer and reset the button.  No other side effects. */
function stopAuto() {
  if (autoTimer !== null) {
    window.clearTimeout(autoTimer);
    autoTimer = null;
  }
  document.body.classList.remove("auto-running");
  btnAuto.textContent = "▶ Auto";
}

// ── Hover interaction ─────────────────────────────────────────────────────
// Group mode: hovering a grid cell cycles that base byte; hovering a puzzle
// block cycles its high byte within [start_top, end_top] and shows AddrInfo.
// Custom mode: hovering a grid cell cycles that key byte (as before).

/** Stop any in-progress hover cycle and clear its visual state. */
function stopHoverCycle() {
  if (hoverTimer !== null) {
    window.clearInterval(hoverTimer);
    hoverTimer = null;
  }
  if (hoverKind === "grid" && hoverCellIdx >= 0) {
    const cell = gridEl.children[hoverCellIdx] as HTMLElement | undefined;
    cell?.classList.remove("cycling");
  } else if (hoverKind === "block" && hoverPuzzleNum >= 0) {
    blocksEl
      .querySelector(`.pblock[data-puzzle="${hoverPuzzleNum}"]`)
      ?.classList.remove("cycling");
    infoEl
      .querySelector(`.addr-info[data-puzzle="${hoverPuzzleNum}"]`)
      ?.classList.remove("active");
  }
  hoverKind = null;
  hoverCellIdx = -1;
  hoverPuzzleNum = -1;
  hoverStartVal = -1;
  hoverMinVal = null;
  hoverMaxVal = null;
}

/** Begin (or switch to) a hover cycle on grid cell `cellIdx`. */
function startHoverCycle(cell: HTMLElement, cellIdx: number) {
  if (autoTimer !== null || matchFound) return;
  if (cell.classList.contains("matched")) return;

  if (hoverTimer !== null && hoverKind === "grid" && hoverCellIdx === cellIdx) return;
  stopHoverCycle();

  hoverKind = "grid";
  hoverCellIdx = cellIdx;
  hoverStartVal = parseInt(cell.textContent ?? "0", 16);
  hoverMinVal = null; // base bytes (group) and custom key bytes are free 00–ff
  hoverMaxVal = null;
  cell.classList.add("cycling");

  hoverTimer = window.setInterval(gridHoverTick, HOVER_INTERVAL_MS);
}

/** One grid hover step: advance the byte, refresh keys, stop at the end. */
function gridHoverTick() {
  const cell = gridEl.children[hoverCellIdx] as HTMLElement | undefined;
  if (!cell) {
    stopHoverCycle();
    return;
  }
  const cur = parseInt(cell.textContent ?? "0", 16);
  const next = (cur + 1) & 0xff;
  if (next === hoverStartVal) {
    stopHoverCycle();
    return;
  }
  const hex = next.toString(16).padStart(2, "0");

  if (mode === "group") {
    baseBytes[hoverCellIdx] = hex;
    cell.textContent = hex;
    void deriveGroupAll();
  } else {
    lastKeyHex = setKeyByte(lastKeyHex, hoverCellIdx, next);
    cell.textContent = hex;
    void refreshHoverInfo(lastKeyHex);
  }
}

/** Begin a hover cycle on a puzzle block (top byte + AddrInfo popover). */
function startBlockCycle(block: HTMLElement, puzzleNum: number) {
  if (autoTimer !== null || matchFound) return;
  const p = activeGroup?.puzzles.find((x) => x.puzzle_number === puzzleNum);
  if (!p) return;
  if (block.classList.contains("matched")) return;

  if (hoverTimer !== null && hoverKind === "block" && hoverPuzzleNum === puzzleNum) return;
  stopHoverCycle();

  hoverKind = "block";
  hoverPuzzleNum = puzzleNum;
  const b = topByteBounds(p);
  hoverStartVal = topByteVals.get(puzzleNum) ?? b.min;
  hoverMinVal = b.min;
  hoverMaxVal = b.max;
  block.classList.add("cycling");

  // Highlight this puzzle's bottom AddrInfo panel while cycling.
  infoEl
    .querySelector(`.addr-info[data-puzzle="${puzzleNum}"]`)
    ?.classList.add("active");

  hoverTimer = window.setInterval(blockHoverTick, HOVER_INTERVAL_MS);
}

/** One block hover step: advance the top byte within its range, derive, stop. */
function blockHoverTick() {
  const p = activeGroup?.puzzles.find((x) => x.puzzle_number === hoverPuzzleNum);
  if (!p || hoverMinVal === null || hoverMaxVal === null) {
    stopHoverCycle();
    return;
  }
  const cur = topByteVals.get(hoverPuzzleNum) ?? hoverMinVal;
  const next = cur >= hoverMaxVal ? hoverMinVal : cur + 1;
  if (next === hoverStartVal) {
    stopHoverCycle();
    return;
  }
  topByteVals.set(hoverPuzzleNum, next);
  const valEl = blocksEl.querySelector<HTMLElement>(
    `.pblock[data-puzzle="${hoverPuzzleNum}"] .pblock-val`,
  );
  if (valEl) valEl.textContent = next.toString(16).padStart(2, "0");
  void deriveOne(p);
}

/** Rewrite the byte backing grid cell `cellIdx` and return the new key hex. */
function setKeyByte(keyHex: string, cellIdx: number, value: number): string {
  const byteIdx = 32 - hexBytesLen + cellIdx; // 0-based index into the 32-byte key
  const charIdx = byteIdx * 2;
  const hex = value.toString(16).padStart(2, "0");
  return keyHex.slice(0, charIdx) + hex + keyHex.slice(charIdx + 2);
}

/** Derive + show the popover for a hover-produced key (custom mode). */
async function refreshHoverInfo(keyHex: string) {
  try {
    const key = await invoke<KeyInfo>("derive_full", {
      private_key_hex: keyHex,
      spec: rangeSpec,
    });
    if (lastKeyHex !== keyHex) return;
    if (key.address_match === true) {
      handleHoverMatch(key);
    } else {
      customInfo = key;
      renderInfoSection();
    }
  } catch (e) {
    showError(String(e));
  }
}

/** A hover cycle produced a match: stop, mark the cell, lock the UI. */
function handleHoverMatch(key: KeyInfo) {
  const cell =
    hoverCellIdx >= 0
      ? (gridEl.children[hoverCellIdx] as HTMLElement | undefined)
      : undefined;
  stopHoverCycle();
  cell?.classList.remove("cycling");
  cell?.classList.add("matched");

  matchFound = true;
  stopAuto();
  setButtonsDisabled(true);
  customInfo = key;
  renderInfoSection();
  showMatchBanner(key.save_path ?? "");
}

// ── Range spec management ─────────────────────────────────────────────────────

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

    // Switch out of group mode into custom mode.
    if (matchFound) {
      matchFound = false;
      setButtonsDisabled(false);
    }
    mode = "custom";
    activeGroup = null;
    groupSelect.value = "";
    dividerEl.hidden = true;
    blocksEl.hidden = true;
    customInfo = null;
    renderInfoSection();
    hexBytesLen = hbl;
    rangeSpec = { type: "custom", start_hex: start, end_hex: end };
    void derive();
  }, 300);
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Load puzzles and group them by byte length.
  try {
    puzzles = await invoke<PuzzleInfo[]>("get_puzzles");
  } catch (e) {
    showError(`failed to load puzzles: ${e}`);
    return;
  }
  const byBytes = new Map<number, PuzzleInfo[]>();
  for (const p of puzzles) {
    const arr = byBytes.get(p.hex_bytes_len) ?? [];
    arr.push(p);
    byBytes.set(p.hex_bytes_len, arr);
  }
  groups = [...byBytes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bytes, ps]) => ({
      bytes,
      puzzles: ps.sort((a, b) => a.puzzle_number - b.puzzle_number),
    }));

  for (const g of groups) {
    const opt = document.createElement("option");
    opt.value = String(g.bytes);
    opt.textContent = `group_${g.bytes} · ${g.puzzles.length} puzzles`;
    groupSelect.appendChild(opt);
  }

  // Wire events.
  groupSelect.addEventListener("change", () => {
    const bytes = Number(groupSelect.value);
    if (!bytes) return; // "custom range" placeholder selected.
    const g = groups.find((x) => x.bytes === bytes);
    if (g) selectGroup(g);
  });
  rangeInput.addEventListener("input", onInputEdit);
  btnRandom.addEventListener("click", () => void onRandom());
  btnAuto.addEventListener("click", () => onAuto());

  // Hover cycling on the grid (cells are recreated by renderGrid, so delegate).
  gridEl.addEventListener("mouseover", (e) => {
    const target = (e.target as HTMLElement).closest(".cell");
    if (!target || !gridEl.contains(target)) return;
    const idx = Array.from(gridEl.children).indexOf(target as Element);
    if (idx >= 0) startHoverCycle(target as HTMLElement, idx);
  });
  gridEl.addEventListener("mouseout", (e) => {
    const target = (e.target as HTMLElement).closest(".cell");
    if (!target) return;
    const idx = Array.from(gridEl.children).indexOf(target as Element);
    if (idx < 0 || hoverKind !== "grid" || idx !== hoverCellIdx) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && target.contains(related)) return;
    stopHoverCycle();
  });

  // Hover cycling on the puzzle blocks (delegated the same way).
  blocksEl.addEventListener("mouseover", (e) => {
    const target = (e.target as HTMLElement).closest(".pblock");
    if (!target || !blocksEl.contains(target)) return;
    const puzzleNum = Number((target as HTMLElement).dataset.puzzle);
    if (Number.isNaN(puzzleNum)) return;
    startBlockCycle(target as HTMLElement, puzzleNum);
  });
  blocksEl.addEventListener("mouseout", (e) => {
    const target = (e.target as HTMLElement).closest(".pblock");
    if (!target) return;
    const puzzleNum = Number((target as HTMLElement).dataset.puzzle);
    if (hoverKind === "block" && hoverPuzzleNum === puzzleNum) {
      stopHoverCycle();
    }
  });

  // Default: first group so the page isn't empty.
  if (groups.length > 0) {
    groupSelect.value = String(groups[0].bytes);
    selectGroup(groups[0]);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  void init();
});
