#!/usr/bin/env node
/**
 * End-to-end regression net for the Hex tab.
 *
 * It drives the *real* frontend in a browser and stubs only the Tauri IPC
 * bridge (`window.__TAURI_INTERNALS__.invoke`), so everything above the
 * `invoke()` boundary is exercised for real: the runes state, the templates,
 * the hover cycles and the auto loop. Each assertion below describes
 * observable behaviour, not implementation — it survives refactors of
 * `src/hex/` and fails only when the tab actually behaves differently.
 *
 * Usage:
 *   npm run test:e2e                 # starts a dev server if none is running
 *   VIZLUCK_URL=http://localhost:1420/ npm run test:e2e
 *
 * The browser is Playwright's bundled Chromium when it is installed, falling
 * back to the system Google Chrome (`npx playwright install chromium` avoids
 * the fallback).
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.VIZLUCK_URL ?? "http://localhost:1420/";
const SCREENSHOT = join(tmpdir(), "vizluck-hex-tab.png");
const SERVER_TIMEOUT_MS = 60_000;

// The fixture is deliberately small but not degenerate: two byte-groups (so the
// dropdown has a real choice and group sorting matters), and every puzzle's
// `end_top` is the 0 overflow sentinel, which is the case the real dataset hits.
const h160 = (c) => c.repeat(40);
const PUZZLES = [
  { puzzle_number: 71, hex_bytes_len: 4, start_hex: "00000000", end_hex: "ffffffff", hash160: h160("a"), start_top: 0x01, end_top: 0 },
  { puzzle_number: 72, hex_bytes_len: 4, start_hex: "00000000", end_hex: "ffffffff", hash160: h160("b"), start_top: 0x02, end_top: 0 },
  { puzzle_number: 73, hex_bytes_len: 4, start_hex: "00000000", end_hex: "ffffffff", hash160: h160("c"), start_top: 0x03, end_top: 0 },
  { puzzle_number: 80, hex_bytes_len: 5, start_hex: "0000000000", end_hex: "ffffffffff", hash160: h160("d"), start_top: 0x04, end_top: 0 },
  { puzzle_number: 81, hex_bytes_len: 5, start_hex: "0000000000", end_hex: "ffffffffff", hash160: h160("e"), start_top: 0x05, end_top: 0 },
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

/** Reuse a running dev server; start (and later stop) one only if needed. */
async function ensureServer() {
  if (await reachable()) {
    console.log(`using the dev server already at ${BASE_URL}`);
    return null;
  }
  console.log(`no dev server at ${BASE_URL} — starting one...`);
  // `detached` makes the child a process-group leader, so stopServer can signal
  // npm *and* the vite it spawns in one call.
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

// ── Browser ─────────────────────────────────────────────────────────────────

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

  await page.addInitScript((puzzles) => {
    window.__MATCH_MODE__ = false; // flipped by the match-freeze phases
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args = {}) => {
        const hex = () =>
          Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
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
            return args.private_keys.map(info);
          case "derive_full":
            return info(args.private_key_hex);
          case "random_and_derive":
            return info(hex());
          case "random_and_hash160":
            return {
              private_key_hex: hex(),
              compressed_hash160: "9".repeat(40),
              address_match: window.__MATCH_MODE__ ? true : false,
              save_path: window.__MATCH_MODE__ ? "/tmp/vizluck-fake-match.txt" : null,
            };
          default:
            throw new Error("unstubbed command: " + cmd);
        }
      },
    };
  }, PUZZLES);

  const gridText = () => page.locator("#grid").textContent();
  const tab = (name) => page.locator(".tabbar .tab", { hasText: name });

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector("#grid .cell", { timeout: 10000 });

  console.log("\n[1] Hex tab renders (group mode)");
  assert((await page.locator(".brand").textContent())?.trim() === "vizluck", "brand present");
  assert(await page.locator("#keys-rate").isVisible(), "keys/s subheader present");
  assert((await page.locator("#group-select option").count()) === 3, "group dropdown populated");
  assert((await page.locator("#group-select").inputValue()) === "4", "group dropdown shows the active group");
  assert((await page.locator("#grid .cell").count()) === 3, "grid width = bytes-1 (group_4)");
  assert((await page.locator("#puzzle-blocks .pblock").count()) === 3, "one block per group puzzle");
  await page.waitForSelector("#info .addr-info", { timeout: 5000 });
  assert((await page.locator("#info .addr-info").count()) === 3, "AddrInfo panels rendered");
  assert((await page.locator(".pblock-num").first().textContent())?.includes("#71"), "block shows puzzle number");
  assert(await page.locator("#divider").isVisible(), "divider visible in group mode");
  assert((await page.locator("#btn-random").textContent())?.includes("Random"), "Random button label");
  assert((await page.locator("#btn-auto").textContent())?.includes("Auto"), "Auto button label");

  console.log("\n[2] Tab bar");
  assert((await page.locator(".tabbar .tab").count()) === 2, "two tabs present");
  assert((await page.locator(".tabbar .tab").allTextContents()).join(",") === "Hex,Game", "tab labels are Hex,Game");
  assert(await page.locator("#grid").isVisible(), "Hex content visible on load");

  console.log("\n[3] Auto runs in the background across tab switches");
  await page.locator("#btn-auto").click();
  await page.waitForTimeout(150);
  assert(await page.locator("body").evaluate((b) => b.classList.contains("auto-running")), "body.auto-running set");
  assert((await page.locator("#btn-auto").textContent())?.includes("Stop"), "Auto button flipped to Stop");
  const a1 = await gridText();
  await page.waitForTimeout(400);
  assert(a1 !== (await gridText()), "grid advances while auto runs");
  await tab("Game").click();
  await page.waitForTimeout(200);
  assert(!(await page.locator("#grid").isVisible()), "Hex hidden on Game tab");
  // Phaser boots asynchronously, so wait for the canvas rather than asserting
  // on it directly. Only the placeholder assertion needed changing here — the
  // "two tabs / labels are Hex,Game" checks above still hold.
  await page.waitForSelector(".game-host canvas", { timeout: 5000 });
  assert(await page.locator(".game-host canvas").isVisible(), "Game canvas mounted");
  const h1 = await gridText();
  await page.waitForTimeout(900);
  assert(h1 !== (await gridText()), "auto keeps advancing while Hex is hidden");

  console.log("\n[4] Switch back must NOT reset");
  await tab("Hex").click();
  await page.waitForTimeout(200);
  assert(await page.locator("#grid").isVisible(), "Hex visible again");
  const cells = await page.locator("#grid .cell").allTextContents();
  assert(cells.length === 3 && cells.every((c) => /^[0-9a-f]{2}$/.test(c.trim())), "grid cells intact", JSON.stringify(cells));
  assert((await page.locator("#info .addr-info").count()) === 3, "AddrInfo panels survived");
  assert((await page.locator("#puzzle-blocks .pblock").count()) === 3, "blocks survived");
  assert(await page.locator("body").evaluate((b) => b.classList.contains("auto-running")), "auto still running");
  for (let i = 0; i < 3; i++) {
    await tab("Game").click();
    await page.waitForTimeout(120);
    await tab("Hex").click();
    await page.waitForTimeout(120);
  }
  const fc = await page.locator("#grid .cell").allTextContents();
  assert(fc.length === 3 && fc.every((c) => /^[0-9a-f]{2}$/.test(c.trim())), "grid fine after 3 round-trips", JSON.stringify(fc));

  console.log("\n[5] Hover cycles");
  await page.locator("#btn-auto").click(); // stop auto; hover is inert while it runs
  await page.waitForTimeout(150);
  assert(!(await page.locator("body").evaluate((b) => b.classList.contains("auto-running"))), "auto stopped");
  await page.locator("#grid .cell").nth(0).hover();
  await page.waitForTimeout(200);
  assert((await page.locator("#grid .cell.cycling").count()) === 1, "grid cell enters .cycling on hover");
  const c1 = await page.locator("#grid .cell").nth(0).textContent();
  await page.waitForTimeout(250);
  assert(c1 !== (await page.locator("#grid .cell").nth(0).textContent()), "hovered grid cell counts through its range");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  assert((await page.locator("#grid .cell.cycling").count()) === 0, ".cycling cleared on mouse-out");
  await page.locator("#puzzle-blocks .pblock").nth(1).hover();
  await page.waitForTimeout(200);
  assert((await page.locator(".pblock.cycling").count()) === 1, "pblock enters .cycling on hover");
  assert((await page.locator(".addr-info.active").count()) === 1, "matching AddrInfo panel gets .active");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  assert((await page.locator(".pblock.cycling").count()) === 0, "pblock .cycling cleared on mouse-out");
  assert((await page.locator(".addr-info.active").count()) === 0, "panel .active cleared on mouse-out");
  await page.locator("#info .addr-info .card").first().click();
  await page.waitForTimeout(200);
  assert(await page.locator("#toast").isVisible(), "clicking a card shows the copy toast");

  console.log("\n[6] Custom range mode");
  await page.locator("#range-input").fill("80000000:ffffffff");
  await page.waitForTimeout(600);
  assert(!(await page.locator("#divider").isVisible()), "divider hidden in custom mode");
  assert(!(await page.locator("#puzzle-blocks").isVisible()), "puzzle blocks hidden in custom mode");
  assert((await page.locator("#group-select").inputValue()) === "", "group dropdown reset to placeholder");
  assert((await page.locator("#grid .cell").count()) === 4, "grid width = custom range byte length");
  await page.waitForSelector("#info .addr-info", { timeout: 5000 });
  assert((await page.locator("#info .addr-info").count()) === 1, "single AddrInfo panel in custom mode");
  assert((await page.locator("#info .addr-info-head").count()) === 0, "custom panel has no #N head");
  assert((await page.locator("#error").isVisible()) === false, "no error shown for a valid range");
  await page.locator("#range-input").fill("not-a-range");
  await page.waitForTimeout(600);
  assert(await page.locator("#error").isVisible(), "invalid range surfaces an error");

  console.log("\n[7] Match freeze");
  await page.locator("#range-input").fill("");
  await page.locator("#group-select").selectOption("4");
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.__MATCH_MODE__ = true;
  });
  await page.locator("#btn-random").click();
  await page.waitForTimeout(600);
  assert((await page.locator("#match-banner").count()) === 1, "match banner appears");
  assert((await page.locator(".match-title").textContent())?.includes("MATCH FOUND"), "banner title correct");
  assert(await page.locator("#btn-random").isDisabled(), "Random disabled after match");
  assert(await page.locator("#btn-auto").isDisabled(), "Auto disabled after match");
  assert((await page.locator(".pblock.matched").count()) >= 1, "matched puzzle block marked");
  assert((await page.locator(".addr-info.matched").count()) >= 1, "matched panel marked");

  // Geometry: the banner belongs above the grid, spanning the content width.
  // It used to be inserted inside `.grid-wrap`, which is a flex row, so it
  // rendered as a narrow column beside the grid and pushed the grid off-centre.
  const bannerBox = await page.locator("#match-banner").boundingBox();
  const mainBox = await page.locator("main.main").boundingBox();
  const gridBox = await page.locator("#grid").boundingBox();
  assert(
    bannerBox.width >= mainBox.width * 0.9,
    "banner spans the content width",
    `banner ${Math.round(bannerBox.width)}px vs main ${Math.round(mainBox.width)}px`,
  );
  assert(
    gridBox.y >= bannerBox.y + bannerBox.height - 2,
    "grid sits below the banner, not beside it",
    `banner ends at ${Math.round(bannerBox.y + bannerBox.height)}, grid starts at ${Math.round(gridBox.y)}`,
  );
  const gridCentre = gridBox.x + gridBox.width / 2;
  assert(
    gridCentre >= mainBox.x + mainBox.width * 0.4 && gridCentre <= mainBox.x + mainBox.width * 0.6,
    "grid stays horizontally centred",
    `grid centre ${Math.round(gridCentre)}`,
  );

  console.log("\n[8] Hover match marks the cell; the next derivation clears it");
  // Leave group mode (also the only way out of the [7] freeze, since the
  // Random/Auto buttons stay locked while frozen).
  await page.evaluate(() => {
    window.__MATCH_MODE__ = false;
  });
  await page.locator("#range-input").fill("80000000:ffffffff");
  await page.waitForTimeout(600);
  assert((await page.locator("#grid .cell.matched").count()) === 0, "no frozen cell after leaving group mode");

  await page.evaluate(() => {
    window.__MATCH_MODE__ = true;
  });
  await page.locator("#grid .cell").nth(0).hover();
  await page.waitForTimeout(400);
  assert((await page.locator("#grid .cell.matched").count()) === 1, "hovered cell frozen green on match");
  assert(await page.locator("#btn-random").isDisabled(), "buttons locked after a hover match");
  assert((await page.locator("#match-banner").count()) === 1, "banner shown for a hover match too");

  await page.evaluate(() => {
    window.__MATCH_MODE__ = false;
  });
  await page.locator("#range-input").fill("80000001:ffffffff");
  await page.waitForTimeout(600);
  assert((await page.locator("#grid .cell.matched").count()) === 0, "cell .matched cleared by the next derive");
  assert(!(await page.locator("#btn-random").isDisabled()), "buttons unlocked by the next range");

  console.log("\n[9] Console errors");
  // A missing #id is the classic symptom of the markup and the logic drifting
  // apart, which is exactly the failure mode this net exists to catch.
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
