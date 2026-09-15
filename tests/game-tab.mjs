#!/usr/bin/env node
/**
 * End-to-end regression net for the Game tab.
 *
 * Same approach as `hex-tab.mjs`: drive the *real* frontend in a browser and
 * stub only the Tauri IPC bridge, so the runes state, the templates, the Phaser
 * scene and the key loop are all exercised for real. Each assertion describes
 * observable behaviour, not implementation.
 *
 * The one thing this file deliberately does not do is kill the player: that
 * takes minutes of wall-clock and belongs in `game-sim.mjs`, where the pure
 * simulation is driven deterministically. Here we cover the wiring around it —
 * requirement 1's gating and pause protocol, the key tick, and the match
 * freeze.
 *
 * Usage:
 *   npm run test:e2e                 # starts a dev server if none is running
 *   VIZLUCK_URL=http://localhost:1420/ npm run test:e2e
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.VIZLUCK_URL ?? "http://localhost:1420/";
const SCREENSHOT = join(tmpdir(), "vizluck-game-tab.png");
const SERVER_TIMEOUT_MS = 60_000;

// `hex_bytes_len` 9 is the real dataset's smallest, and it is what the byte
// layout assertions in `game-sim.mjs` use too — keep the two in step.
const PUZZLES = [
  { puzzle_number: 71, hex_bytes_len: 9, start_hex: "4" + "0".repeat(17), end_hex: "7f" + "f".repeat(17), hash160: "a".repeat(40), start_top: 0x40, end_top: 0x80 },
  { puzzle_number: 72, hex_bytes_len: 9, start_hex: "8" + "0".repeat(17), end_hex: "ff" + "f".repeat(17), hash160: "b".repeat(40), start_top: 0x80, end_top: 0 },
  { puzzle_number: 80, hex_bytes_len: 10, start_hex: "0".repeat(20), end_hex: "f".repeat(20), hash160: "c".repeat(40), start_top: 0x01, end_top: 0 },
];

const errors = [];
const failures = [];
const ok = (l) => console.log(`  PASS  ${l}`);
const bad = (l, d) => {
  failures.push(l);
  console.log(`  FAIL  ${l}${d ? ` — ${d}` : ""}`);
};
const assert = (c, l, d) => (c ? ok(l) : bad(l, d));

// ── Dev server ──────────────────────────────────────────────────────────────

async function reachable() {
  try {
    return (await fetch(BASE_URL, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await reachable()) {
    console.log(`using the dev server already at ${BASE_URL}`);
    return null;
  }
  console.log(`no dev server at ${BASE_URL} — starting one...`);
  const child = spawn("npm", ["run", "dev"], { stdio: "ignore", detached: true });
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await reachable()) return child;
    if (child.exitCode !== null) throw new Error(`dev server exited with code ${child.exitCode}`);
  }
  stopServer(child);
  throw new Error(`dev server did not come up within ${SERVER_TIMEOUT_MS / 1000}s`);
}

function stopServer(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (e) {
    if (!/Executable doesn't exist/.test(e.message)) throw e;
    console.log("bundled Chromium not installed — falling back to system Chrome");
    return await chromium.launch({ channel: "chrome" });
  }
}

// ── The checks ──────────────────────────────────────────────────────────────

async function run() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await page.addInitScript((puzzles) => {
    window.__MATCH_MODE__ = false;
    window.__KEYS_SEEN__ = 0;
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args = {}) => {
        const info = (k) => ({
          private_key_hex: k,
          xprv: "xprv" + "0".repeat(20),
          xpub: "xpub" + "0".repeat(20),
          compressed_public_key: "02" + "f".repeat(64),
          compressed_legacy_address: "1" + "A".repeat(33),
          compressed_hash160: "9".repeat(40),
          address_match: window.__MATCH_MODE__ ? true : false,
          save_path: window.__MATCH_MODE__ ? "/tmp/vizluck-fake-match.txt" : null,
        });
        switch (cmd) {
          case "get_puzzles":
            return puzzles;
          case "derive_group":
            // Counted here rather than in the HUD so the assertions can tell a
            // stopped key loop from a stopped *stats feed* — a paused Phaser
            // freezes the HUD too, which would otherwise mask a running loop.
            window.__KEYS_SEEN__ += args.private_keys.length;
            return args.private_keys.map(info);
          default:
            throw new Error("unstubbed command: " + cmd);
        }
      },
    };
  }, PUZZLES);

  const tab = (name) => page.locator(".tabbar .tab", { hasText: name });
  const keys = () => page.evaluate(() => window.__KEYS_SEEN__);
  const runLabel = () => page.locator("#btn-run").textContent();
  const status = async () => (await page.locator("#game-status").textContent()).trim();

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector("#grid .cell", { timeout: 10000 });
  // The Hex tab runs one `derive_group` of its own on init, and the stub's
  // counter is shared. Wait for that round to land, then zero it, so the
  // counts below measure the Game tab's key loop and nothing else.
  await page.waitForSelector("#info .addr-info", { timeout: 10000 });
  await page.evaluate(() => {
    window.__KEYS_SEEN__ = 0;
  });

  console.log("\n[1] The arena is gated on a puzzle selection (requirement 1)");
  await tab("Game").click();
  await page.waitForSelector(".game-host canvas", { timeout: 10000 });
  assert(await page.locator(".game-host canvas").isVisible(), "Game canvas mounted");
  assert((await page.locator("#puzzle-select option").count()) === PUZZLES.length + 1, "dropdown lists every puzzle plus a placeholder");
  assert((await page.locator("#puzzle-select").inputValue()) === "", "dropdown starts on the placeholder");
  assert(await page.locator("#btn-run").isDisabled(), "run button disabled with no puzzle");
  assert((await runLabel()).trim() === "▶", "run button shows ▶");
  assert((await status()) === "idle", "status is idle", await status());
  assert((await page.locator("#game-hint").count()) === 1, "hint shown with no puzzle");

  console.log("\n[2] Selecting a puzzle arms the run but does not start it");
  await page.locator("#puzzle-select").selectOption("71");
  await page.waitForTimeout(200);
  assert(!(await page.locator("#btn-run").isDisabled()), "run button enabled after selection");
  assert((await status()) === "ready", "status is ready, not running", await status());
  assert((await page.locator("#game-hint").count()) === 0, "hint gone once a puzzle is chosen");
  assert((await keys()) === 0, "no keys sampled before ▶");

  console.log("\n[3] ▶ starts the run and the key tick");
  await page.locator("#btn-run").click();
  await page.waitForTimeout(150);
  assert((await runLabel()).trim() === "⏸", "button flipped to ⏸");
  assert((await status()) === "running", "status is running", await status());
  await page.waitForFunction(() => window.__KEYS_SEEN__ > 0, null, { timeout: 5000 });
  assert((await keys()) > 0, "keys are sampled while running");
  const survived = await page.locator("#game-survival").textContent();
  assert(/^00:0\d\.\d$/.test(survived.trim()), "survival clock is ticking", survived);
  // Requirement 2: the level-up progress is on the HUD, next to the level it
  // feeds. A fresh run is `0/100`, and the pair is what the player watches.
  const xp = ((await page.locator("#game-xp").textContent()) ?? "").trim();
  assert(/^\d+\/\d+$/.test(xp), "xp renders as banked/next", xp);
  // Requirement 3's legend: one dot per potion kind, so the colours on the
  // canvas have somewhere to be explained.
  assert((await page.locator(".game-hud .loot-dot").count()) === 4, "all four potions are in the HUD legend");
  assert((await page.locator("#game-bytes .gbyte").count()) === 8, "the 8 free bytes are on display (b=9)");
  // The key readout lives on the `survive` title row, not in a bottom panel.
  assert((await page.locator("#game-pk").count()) === 1, "the sampled key is on the title row");
  // Puzzle #71 is 9 bytes, so the key is 64 hex chars of which only the low 9
  // bytes are live — the strip leaves exactly 18.
  assert(/^[0-9a-f]{18}$/.test((await page.locator("#game-pk").textContent()).trim()), "private key shown with its zero padding stripped", await page.locator("#game-pk").textContent());
  assert(((await page.locator("#game-addr").textContent()) ?? "").startsWith("1A"), "compressed address is on the title row");
  assert((await page.locator("#game-flag").textContent()).trim() === "❌", "miss icon while no match");
  assert((await page.locator("#game-info").count()) === 0, "no bottom puzzle card");

  console.log("\n[4] ⏸ pauses the search, not just the picture (design §8)");
  await page.locator("#btn-run").click();
  await page.waitForTimeout(150);
  assert((await runLabel()).trim() === "▶", "button flipped back to ▶");
  assert((await status()) === "paused", "status is paused", await status());
  // The key count comes from the IPC stub, so it keeps telling the truth even
  // though the paused scene stops publishing HUD stats.
  const frozen = await keys();
  await page.waitForTimeout(1200);
  assert((await keys()) === frozen, "no keys sampled while paused", `${frozen} -> ${await keys()}`);
  const frozenClock = await page.locator("#game-survival").textContent();
  await page.waitForTimeout(600);
  assert((await page.locator("#game-survival").textContent()) === frozenClock, "survival clock frozen while paused");

  console.log("\n[5] Switching tabs pauses and does NOT auto-resume (requirement 1)");
  await page.locator("#btn-run").click(); // resume
  await page.waitForTimeout(200);
  const before = await keys();
  await tab("Hex").click();
  await page.waitForTimeout(500);
  await tab("Game").click();
  await page.waitForTimeout(300);
  assert((await runLabel()).trim() === "▶", "still showing ▶ after coming back");
  assert((await status()) === "paused", "status is paused after the round-trip", await status());
  assert((await keys()) < before + 8, "no meaningful sampling while away", `${before} -> ${await keys()}`);
  const afterReturn = await keys();
  await page.waitForTimeout(800);
  assert((await keys()) === afterReturn, "key loop stayed stopped after returning");
  await page.locator("#btn-run").click();
  await page.waitForFunction((n) => window.__KEYS_SEEN__ > n, afterReturn, { timeout: 5000 });
  assert((await keys()) > afterReturn, "manual ▶ resumes the search");

  console.log("\n[6] A match freezes the run and celebrates");
  await page.evaluate(() => {
    window.__MATCH_MODE__ = true;
  });
  await page.waitForSelector("#match-banner", { timeout: 8000 });
  assert((await page.locator(".match-title").textContent())?.includes("MATCH FOUND"), "banner title correct");
  assert((await status()) === "matched", "status is matched", await status());
  assert(await page.locator("#btn-run").isDisabled(), "run button locked after a match");
  assert(await page.locator("#puzzle-select").isDisabled(), "puzzle dropdown locked after a match");
  assert((await page.locator("#game-flag").textContent()).trim() === "✅", "hit icon flipped on the title row");
  assert(await page.locator("#game-addr.match").isVisible(), "address is badged as the target");
  const atMatch = await keys();
  await page.waitForTimeout(1200);
  assert((await keys()) === atMatch, "key loop stopped by the match", `${atMatch} -> ${await keys()}`);

  console.log("\n[7] Console errors");
  const bad1 = errors.filter((e) => /missing #|Cannot read|is not a function|TypeError/i.test(e));
  assert(bad1.length === 0, "no missing-#id / TypeError", bad1.join(" | "));
  if (errors.length) console.log("  (console: " + JSON.stringify(errors.slice(0, 4)) + ")");

  await page.screenshot({ path: SCREENSHOT });
  await browser.close();
  return failures;
}

// ── Main ────────────────────────────────────────────────────────────────────

const server = await ensureServer();
try {
  await run();
} finally {
  stopServer(server);
}

console.log(`\nscreenshot: ${SCREENSHOT}`);
console.log(failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILURE(S): ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
