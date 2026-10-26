#!/usr/bin/env node
/**
 * End-to-end regression net for the two new tabs: Settings (address CRUD +
 * JSON save) and Random (32 byte cards + collision scan).
 *
 * Same approach as `hex-tab.mjs`: the real frontend runs in a real browser and
 * only the Tauri IPC bridge is stubbed.  The crypto itself is covered by Rust
 * unit tests (`cargo test --lib collision:: addresses::`); this file covers the
 * wiring the Rust tests cannot see — binding, save, start/stop, match freeze.
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
const SCREENSHOT = join(tmpdir(), "vizluck-random-tab.png");
const SETTINGS_SCREENSHOT = join(tmpdir(), "vizluck-settings-tab.png");
const SERVER_TIMEOUT_MS = 60_000;

const h160 = (c) => c.repeat(40);
const PUZZLES = [
  { puzzle_number: 71, hex_bytes_len: 4, start_hex: "00000000", end_hex: "ffffffff", hash160: h160("a"), start_top: 0x01, end_top: 0 },
  { puzzle_number: 72, hex_bytes_len: 4, start_hex: "00000000", end_hex: "ffffffff", hash160: h160("b"), start_top: 0x02, end_top: 0 },
  { puzzle_number: 73, hex_bytes_len: 4, start_hex: "00000000", end_hex: "ffffffff", hash160: h160("c"), start_top: 0x03, end_top: 0 },
];

const BTC = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ETH = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const SOL = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";
const KEY = "ab".repeat(32);
const SAVE_PATH = "/tmp/vizluck-test/matches/20260728_123456.txt";

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
    console.log("(run `npx playwright install chromium` to use the bundled one)");
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

  await page.addInitScript(({ puzzles, btc, eth, sol, key, savePath }) => {
    window.__BOOK__ = { bitcoin: [btc], ethereum: [eth], solana: [sol] };
    window.__SAVED__ = null;
    window.__SAVE_PATH__ = "/tmp/vizluck-test/addresses.json";
    window.__SCAN_CALLS__ = 0;
    // 0 = never match; otherwise the call number that returns a hit.
    window.__MATCH_AFTER__ = 0;

    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args = {}) => {
        const info = (k) => ({
          private_key_hex: k,
          xprv: "xprv" + "0".repeat(20),
          xpub: "xpub" + "0".repeat(20),
          compressed_public_key: "02" + "f".repeat(64),
          compressed_legacy_address: "1" + "A".repeat(33),
          compressed_hash160: "9".repeat(40),
          address_match: false,
          save_path: null,
        });
        switch (cmd) {
          case "get_puzzles":
            return puzzles;
          case "derive_group":
            return args.private_keys.map(info);
          case "load_addresses":
            return {
              path: "/tmp/vizluck-test/addresses.json",
              book: structuredClone(window.__BOOK__),
            };
          case "save_addresses":
            window.__SAVED__ = structuredClone(args.book);
            return window.__SAVE_PATH__;
          case "random_scan": {
            window.__SCAN_CALLS__++;
            const call = window.__SCAN_CALLS__;
            // Mimic the Rust time budget so the loop yields to the browser
            // instead of spinning as fast as the stub can resolve.
            await new Promise((r) => setTimeout(r, 10));
            const hit = window.__MATCH_AFTER__ > 0 && call >= window.__MATCH_AFTER__;
            return {
              private_key_hex: key,
              bitcoin: [
                { kind: "P2PKH (compressed)", address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH" },
                { kind: "P2PKH (uncompressed)", address: "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm" },
                { kind: "P2SH-P2WPKH", address: "3JvL6Ymt8MVWiCNHC7oWU6nLeHNJKLZGLN" },
                { kind: "P2WPKH", address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" },
              ],
              ethereum: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
              solana: "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z",
              checked: 7,
              matches: hit
                ? [{
                    chain: "ethereum",
                    address: window.__BOOK__.ethereum[0],
                    derived_address: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
                    private_key_hex: key,
                  }]
                : [],
              save_path: hit ? savePath : null,
              save_error: null,
            };
          }
          default:
            throw new Error("unstubbed command: " + cmd);
        }
      },
    };
  }, { puzzles: PUZZLES, btc: BTC, eth: ETH, sol: SOL, key: KEY, savePath: SAVE_PATH });

  const tab = (name) => page.locator(".tabbar .tab", { hasText: name });
  const chainCard = (id) => page.locator(`.chain-card[data-chain="${id}"]`);
  const addInput = (id) => chainCard(id).locator(".addr-add .addr-input");
  const addButton = (id) => chainCard(id).locator(".addr-add button");
  const rows = (id) => chainCard(id).locator(".addr-row");
  const scanCalls = () => page.evaluate(() => window.__SCAN_CALLS__);

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector("#grid .cell", { timeout: 10000 });

  console.log("\n[1] Tab bar gains Random and Settings on the right");
  const labels = await page.locator(".tabbar .tab").allTextContents();
  assert(labels.length === 4, "four tabs present", JSON.stringify(labels));
  assert(labels.join(",") === "Hex,Game,Random,Settings", "labels in order", labels.join(","));

  console.log("\n[2] Settings lists the saved book");
  await tab("Settings").click();
  await page.waitForSelector('.chain-card[data-chain="bitcoin"] .addr-row', { timeout: 5000 });
  assert((await page.locator(".chain-card").count()) === 3, "three chain cards");
  assert((await rows("bitcoin").count()) === 1, "one BTC address loaded");
  assert((await rows("ethereum").count()) === 1, "one ETH address loaded");
  assert((await rows("solana").count()) === 1, "one SOL address loaded");
  assert(
    (await rows("bitcoin").locator(".addr-input").inputValue()) === BTC,
    "BTC row shows the saved address",
  );
  assert(
    (await page.locator(".settings-path").textContent()).includes("addresses.json"),
    "JSON path shown",
  );

  console.log("\n[3] Settings add / edit / delete / save");
  await addInput("bitcoin").fill("bc1qexampledeprecated");
  await addButton("bitcoin").click();
  assert((await rows("bitcoin").count()) === 2, "Add appends a row");
  assert((await addInput("bitcoin").inputValue()) === "", "Add clears the draft");

  const second = rows("bitcoin").nth(1).locator(".addr-input");
  await second.fill("bc1qeditedaddress");
  await page.locator("#btn-save-addresses").click();
  await page.waitForSelector("#settings-toast", { timeout: 5000 });
  assert(
    await page.evaluate(() => window.__SAVED__?.bitcoin?.includes("bc1qeditedaddress")),
    "edited address reached save_addresses",
  );
  assert(
    (await page.evaluate(() => window.__SAVED__?.bitcoin?.length)) === 2,
    "saved list has both BTC addresses",
  );

  await rows("bitcoin").nth(1).locator(".addr-del").click();
  assert((await rows("bitcoin").count()) === 1, "Delete removes the row");
  assert(
    await page.evaluate(() => window.__SAVED__?.bitcoin?.length) === 2,
    "delete is not persisted until Save",
  );
  await page.locator("#btn-save-addresses").click();
  await page.waitForTimeout(100);
  assert(
    (await page.evaluate(() => window.__SAVED__?.bitcoin?.length)) === 1,
    "Save persists the deletion",
  );
  await page.screenshot({ path: SETTINGS_SCREENSHOT });

  console.log("\n[4] Random shows 32 byte cards and the target counts");
  await tab("Random").click();
  assert((await page.locator("#random-grid .rand-cell").count()) === 32, "32 byte cards");
  assert(
    (await page.locator("#random-grid .rand-cell.placeholder").count()) === 32,
    "placeholders before the first scan",
  );
  assert(
    (await page.locator("#random-target-btc").textContent())?.trim() === "1",
    "Settings edits are visible to Random",
  );

  console.log("\n[5] Start scans; tab switch stops the loop");
  await page.locator("#btn-random-scan").click();
  await page.waitForTimeout(250);
  assert((await page.locator("#btn-random-scan").textContent())?.includes("Stop"), "button shows Stop");
  assert((await scanCalls()) > 1, "the scan loop is running", String(await scanCalls()));
  assert(
    (await page.locator("#random-grid .rand-cell").allTextContents()).every((t) => /^[0-9a-f]{2}$/.test(t)),
    "cards show the last key's bytes",
  );
  assert(
    Number((await page.locator("#random-checked").textContent()).replace(/[^0-9]/g, "")) > 0,
    "checked counter advanced",
  );
  assert(
    (await page.locator("#random-eth-addr").textContent())?.trim() === ETH,
    "ETH address derived",
  );
  assert(
    (await page.locator(".random-chain").first().locator(".chain-type").allTextContents()).join(",") ===
      "P2PKH (compressed),P2PKH (uncompressed),P2SH-P2WPKH,P2WPKH",
    "Bitcoin rows use the backend-supplied form labels, both key encodings included",
  );

  await tab("Hex").click();
  await page.waitForTimeout(50);
  const leftAt = await scanCalls();
  await page.waitForTimeout(250);
  assert((await scanCalls()) === leftAt, "hiding the tab stops scan calls", `${leftAt} -> ${await scanCalls()}`);
  assert(!(await page.locator("#random-grid").isVisible()), "Random panel hidden");

  await tab("Random").click();
  assert(
    (await page.locator("#btn-random-scan").textContent())?.includes("Start"),
    "returning does not auto-resume",
  );

  console.log("\n[6] A hit freezes the scan and shows the match");
  await page.evaluate(() => {
    window.__MATCH_AFTER__ = window.__SCAN_CALLS__ + 1;
  });
  await page.locator("#btn-random-scan").click();
  await page.waitForSelector("#random-match", { timeout: 5000 });
  assert((await page.locator("#random-match").count()) === 1, "match panel appears");
  assert(
    (await page.locator("#random-match").textContent())?.includes("ADDRESS MATCH"),
    "match title present",
  );
  assert(
    (await page.locator("#random-match").textContent())?.includes("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"),
    "matched address shown",
  );
  assert(
    (await page.locator("#random-save-path").textContent())?.includes(SAVE_PATH),
    "saved match path shown",
  );
  assert(
    (await page.locator("#btn-random-scan").textContent())?.includes("Start"),
    "scan stops on a match",
  );
  const matchedAt = await scanCalls();
  await page.waitForTimeout(200);
  assert((await scanCalls()) === matchedAt, "no further scan calls after the match");

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

console.log(`\nscreenshots: ${SETTINGS_SCREENSHOT}\n             ${SCREENSHOT}`);
console.log(failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILURE(S): ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
