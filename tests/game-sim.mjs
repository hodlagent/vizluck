#!/usr/bin/env node
/**
 * Regression net for the Game tab's two pure modules: `src/game/sim.ts` and
 * `src/game/keymap.ts`.
 *
 * Neither touches Phaser, the DOM or Tauri, so they can be driven exactly —
 * but they are TypeScript, and this repo has no test runner that transpiles TS
 * for Node. Rather than add one, the checks run *inside the browser*, importing
 * the modules through the dev server's own module graph. Same toolchain, same
 * transform, no new dependency.
 *
 * What lives here rather than in `game-tab.mjs`: everything that needs either
 * determinism (an injected rng) or wall-clock the UI test can't afford — dying,
 * respawn timing, the region leash, and the byte-distribution guarantee that
 * design §3.3 rests on.
 *
 * Usage:
 *   npm run test:e2e                 # starts a dev server if none is running
 *   VIZLUCK_URL=http://localhost:1420/ npm run test:e2e
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const BASE_URL = process.env.VIZLUCK_URL ?? "http://localhost:1420/";
const SCREENSHOT = join(tmpdir(), "vizluck-game-sim.png");
const SERVER_TIMEOUT_MS = 60_000;

// Matches `game-tab.mjs`: b = 9 is the real dataset's smallest byte length, so
// the free-byte count (b - 1 = 8) is the tightest case the layout has to handle.
const PUZZLE_A = {
  puzzle_number: 71, hex_bytes_len: 9,
  start_hex: "4" + "0".repeat(17), end_hex: "7f" + "f".repeat(17),
  hash160: "a".repeat(40), start_top: 0x40, end_top: 0x80,
};
const PUZZLE_B = { ...PUZZLE_A, puzzle_number: 72, hash160: "b".repeat(40) };

const failures = [];

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

// ── The checks (run in the page) ────────────────────────────────────────────

async function run() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  const results = await page.evaluate(async ([puzzleA, puzzleB]) => {
    const out = [];
    const check = (cond, label, detail = "") => out.push({ ok: !!cond, label, detail: String(detail) });

    const sim = await import("/src/game/sim.ts");
    const keymap = await import("/src/game/keymap.ts");

    /** mulberry32 — small, fast, and reproducible across runs. */
    const rngFrom = (seed) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const fresh = () => sim.createSim({ rng: rngFrom(12345) });

    /** Strip the arena down to one puppet so a step is fully determined. */
    const solo = (s, kind, region, place) => {
      s.monsters.length = 0;
      // Potions from an earlier kill would otherwise be lying around for the
      // player to walk into mid-test, changing stats the check thought it owned.
      s.items.length = 0;
      const cfg = s.configs[region];
      const m = {
        id: 999, kind, dir: 0, moveSpeed: 0, attackSpeed: 1,
        attackPower: 0, attackRange: 20, senseRange: 400,
        hp: 10, maxHp: 10, posX: 0, posY: 0,
        attackCooldown: 1e9, region, attacking: false, wanderTimer: 1e9,
      };
      place(m, cfg);
      s.monsters.push(m);
      return m;
    };

    const inRegion = (m, cfg) =>
      m.posX >= cfg.x && m.posX <= cfg.x + cfg.w && m.posY >= cfg.y && m.posY <= cfg.y + cfg.h;

    // ── §4 Regions ─────────────────────────────────────────────────────────
    {
      const s = fresh();
      check(s.monsters.length === 30, "createSim fills every region to its target", s.monsters.length);
      const counts = s.configs.map((c) => s.monsters.filter((m) => m.region === c.index).length);
      check(
        counts.every((n, i) => n === s.configs[i].targetCount),
        "each region starts at its own target count",
        counts.join(","),
      );
      check(
        s.configs[0].targetCount === 2 && s.configs[4].targetCount === 6,
        "corner is the poor tier and centre the rich one",
        `${s.configs[0].targetCount} vs ${s.configs[4].targetCount}`,
      );
      check(
        s.configs[0].respawnSeconds > s.configs[4].respawnSeconds,
        "corner respawns slower than centre",
        `${s.configs[0].respawnSeconds} vs ${s.configs[4].respawnSeconds}`,
      );
      for (const cfg of s.configs) {
        const inside = s.monsters.filter((m) => m.region === cfg.index).every((m) => inRegion(m, cfg));
        if (!inside) check(false, `spawns for region ${cfg.index} land inside it`);
      }
      check(true, "every spawn lands inside its own region");
    }

    // ── §5.1 Movement is a *speed*, in all eight directions ────────────────
    //
    // The player used to move by `(dx, dy) × moveSpeed × dt` **without
    // normalising**, while monsters walked along unit `DIR_VECTORS` — so a
    // diagonal travelled √2 × moveSpeed (226.3 px/s against a stated 160) and
    // holding two keys was free speed. That is the "移动的太快了，跟瞬移一样，
    // 明显不符合它的 move speed" report. The robot's probe step depends on the
    // fix too: it is `moveSpeed × PROBE_S` in every direction, so if a diagonal
    // ever travels further again, `decide` starts weighing a step it cannot take.
    {
      const dt = 1 / 60;
      const want = sim.TUNING.moveSpeed * dt;
      const steps = [];
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          if (dx === 0 && dy === 0) continue;
          const s = fresh();
          // Nothing to bump into and nothing to be pushed by: the step is the
          // only thing that moves the player.
          s.monsters.length = 0;
          const x0 = s.player.posX;
          const y0 = s.player.posY;
          sim.stepSim(s, { dx, dy }, dt);
          steps.push({ dir: `${dx},${dy}`, d: Math.hypot(s.player.posX - x0, s.player.posY - y0) });
        }
      }
      const off = steps.filter((s) => Math.abs(s.d - want) >= 1e-9);
      check(
        off.length === 0,
        "all eight directions move exactly moveSpeed × dt",
        off.length
          ? off.map((s) => `${s.dir}: ${s.d.toFixed(4)}`).join(" ")
          : `${want.toFixed(4)}px per step`,
      );
      // Pinned to the literal, so retuning `moveSpeed` has to come here and say
      // so rather than sliding through.
      check(
        Math.abs(steps.find((s) => s.dir === "1,0").d - 160 * dt) < 1e-9,
        "and moveSpeed is the 160 the tuning table advertises",
        `${(steps.find((s) => s.dir === "1,0").d / dt).toFixed(1)} px/s`,
      );
    }

    // ── §6.2 The leash ─────────────────────────────────────────────────────
    {
      const s = fresh();
      // A hunter in the centre, with a sense range that would otherwise reach
      // right across the arena — the exact case the leash exists for.
      const m = solo(s, "hunter", 4, (mm) => {
        mm.posX = s.configs[4].x + 2;
        mm.posY = s.configs[4].y + 2;
        mm.moveSpeed = 120;
        mm.senseRange = 4000;
      });
      // Player parked in the corner region, far outside the hunter's region.
      s.player.posX = s.configs[0].x + s.configs[0].w / 2;
      s.player.posY = s.configs[0].y + s.configs[0].h / 2;

      let leftRegion = false;
      for (let i = 0; i < 400; i++) {
        sim.stepSim(s, { dx: 0, dy: 0 }, 0.05);
        if (!inRegion(m, s.configs[4])) leftRegion = true;
      }
      check(!leftRegion, "a chasing monster never leaves its home region");
      check(m.attacking === false, "a monster does not aggro a player outside its region");
      check(
        s.player.hp === s.player.maxHp,
        "the corner tier really is a refuge",
        `${s.player.hp}/${s.player.maxHp}`,
      );
    }

    // ── §6.1 Aggro inside the region ───────────────────────────────────────
    {
      const s = fresh();
      const m = solo(s, "hunter", 4, (mm) => {
        mm.posX = s.configs[4].x + s.configs[4].w - 5;
        mm.posY = s.configs[4].y + s.configs[4].h - 5;
        mm.moveSpeed = 0;
      });
      s.player.posX = s.configs[4].x + 10;
      s.player.posY = s.configs[4].y + 10;
      sim.stepSim(s, { dx: 0, dy: 0 }, 0.05);
      check(m.attacking === true, "a monster aggros a player inside its own region");
    }

    // ── Death freezes the run (§8) ─────────────────────────────────────────
    {
      const s = fresh();
      s.monsters.length = 0;
      s.player.hp = 5;
      s.player.posX = s.configs[0].x + 40;
      s.player.posY = s.configs[0].y + 40;
      const brute = {
        id: 1, kind: "brute", dir: 0, moveSpeed: 0, attackSpeed: 1,
        attackPower: 18, attackRange: 40, senseRange: 400,
        hp: 90, maxHp: 90, posX: s.player.posX, posY: s.player.posY,
        attackCooldown: 0, region: 0, attacking: false, wanderTimer: 1e9,
      };
      s.monsters.push(brute);

      sim.stepSim(s, { dx: 0, dy: 0 }, 0.05);
      check(s.alive === false, "hp reaching 0 ends the run");
      check(s.player.hp === 0, "hp floors at 0 rather than going negative", s.player.hp);

      const frozenAt = s.time;
      const frozenTick = s.tick;
      for (let i = 0; i < 100; i++) sim.stepSim(s, { dx: 1, dy: 1 }, 0.05);
      check(s.time === frozenAt, "the survival clock is frozen after death", s.time);
      check(s.tick === frozenTick, "the sim stops stepping after death");
      check(s.kills === 0, "a dead player kills nothing");
    }

    // ── Respawn (§4, "n 秒后刷新") ─────────────────────────────────────────
    {
      const s = fresh();
      const home = 4; // centre: the region whose respawn time we are testing
      const cfg = s.configs[home];
      const m = solo(s, "hunter", home, (mm) => {
        mm.hp = 1;
        mm.posX = s.player.posX;
        mm.posY = s.player.posY;
      });
      s.player.posX = cfg.x + cfg.w / 2;
      s.player.posY = cfg.y + cfg.h / 2;
      m.posX = s.player.posX;
      m.posY = s.player.posY;
      s.attackCooldown = 0;

      const before = s.monsters.length;
      sim.stepSim(s, { dx: 0, dy: 0 }, 0.05);
      check(s.monsters.length === before - 1, "the player's auto-attack kills a weakened monster");
      check(s.kills === 1, "the kill is counted");
      check(s.xp > 0, "the kill paid experience", s.xp);
      check(s.regions[home].pending.length === 1, "a respawn was queued in the monster's home region");

      // Just short of the delay: still dead.
      let t = 0;
      while (t < cfg.respawnSeconds - 0.2) {
        sim.stepSim(s, { dx: 0, dy: 0 }, 0.05);
        t += 0.05;
      }
      check(s.monsters.length === 0, "nothing respawns before the delay elapses", t.toFixed(2));

      while (t < cfg.respawnSeconds + 0.3) {
        sim.stepSim(s, { dx: 0, dy: 0 }, 0.05);
        t += 0.05;
      }
      check(s.monsters.length === 1, "the monster respawns once the delay elapses", t.toFixed(2));
      check(s.monsters[0]?.region === home, "it respawns in its home region", s.monsters[0]?.region);
      check(inRegion(s.monsters[0], cfg), "it respawns inside that region's bounds");
    }

    // ── §4.4 + §8.2 + §8.3 The upgrade system ──────────────────────────────
    //
    // Everything below runs on `bare()`: an arena with no monsters, so the only
    // thing that can move a stat is the potion the check itself put on the
    // floor. `maxHp` and friends leave the sim as products of 1.05s, so every
    // float assertion goes through `near` rather than `===`.
    {
      const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
      const bare = () => {
        const s = fresh();
        s.monsters.length = 0;
        s.items.length = 0;
        // `createSim` starts the player *out* of combat (`sinceDamage` already
        // past the delay), so a bare arena drips 1 hp/s back on. Suppressing it
        // keeps each check about the one stat it placed and nothing else — an
        // "hp is unchanged" assertion would otherwise fail on a 0.05 regen tick.
        s.sinceDamage = 0;
        return s;
      };
      // Standing still by default; the pickup checks pass a direction to drive
      // the player past a potion, which is the case that used to fail.
      const step = (s, input = { dx: 0, dy: 0 }, dt = 0.05) => sim.stepSim(s, input, dt);
      /** Put a potion under the player's feet (or `at` a given offset). */
      const floor = (s, kind, dx = 0, dy = 0, life = sim.TUNING.itemLifetime) => {
        s.items.push({
          id: 9000 + s.items.length,
          kind,
          posX: s.player.posX + dx,
          posY: s.player.posY + dy,
          life,
        });
      };

      // Monster HP escalation is a pure function of survival time...
      check(sim.monsterHpMul(0) === 1, "monsterHpMul(0) is 1", sim.monsterHpMul(0));
      check(sim.monsterHpMul(59.9) === 1, "monsterHpMul is flat until the minute is up");
      check(near(sim.monsterHpMul(60), 1.05), "monsterHpMul(60) is ×1.05", sim.monsterHpMul(60));
      check(
        near(sim.monsterHpMul(180), 1.05 ** 3),
        "monsterHpMul compounds per minute",
        sim.monsterHpMul(180),
      );

      // ...and it reaches a spawn that happens *after* the minute, not before.
      {
        const home = 4;
        const cfg = fresh().configs[home];
        const early = fresh();
        const m0 = solo(early, "hunter", home, () => {});
        m0.hp = 1;
        m0.posX = early.player.posX;
        m0.posY = early.player.posY;
        early.attackCooldown = 0;
        sim.stepSim(early, { dx: 0, dy: 0 }, 0.05);

        const s = fresh();
        const m = solo(s, "hunter", home, () => {});
        m.hp = 1;
        m.posX = s.player.posX;
        m.posY = s.player.posY;
        s.attackCooldown = 0;
        s.time = sim.TUNING.monsterHpEvery; // one minute already survived
        sim.stepSim(s, { dx: 0, dy: 0 }, 0.05);
        check(s.kills === 1, "the puppet dies in both arms of the HP check");

        let t = 0;
        while (t < cfg.respawnSeconds + 0.3) {
          sim.stepSim(s, { dx: 0, dy: 0 }, 0.05);
          sim.stepSim(early, { dx: 0, dy: 0 }, 0.05);
          t += 0.05;
        }
        // Both respawns happened after minute 1 for `s` and minute 0 for
        // `early`, so the pair isolates the multiplier from the archetype.
        check(
          near(early.monsters[0]?.maxHp ?? 0, 35, 1e-9),
          "a monster spawned in the first minute has the archetype's raw hp",
          early.monsters[0]?.maxHp,
        );
        check(
          near(s.monsters[0]?.maxHp ?? 0, 35 * 1.05, 1e-6),
          "a monster spawned after a minute has ×1.05 hp",
          s.monsters[0]?.maxHp,
        );
        check(
          s.monsters[0]?.hp === s.monsters[0]?.maxHp,
          "it spawns at full health, not merely with a bigger ceiling",
        );
      }

      // Level-up: the ceiling moves, the current hp does not (design §8.2).
      {
        const s = bare();
        const m = solo(s, "hunter", 4, () => {});
        m.hp = 1;
        m.posX = s.player.posX;
        m.posY = s.player.posY;
        s.attackCooldown = 0;
        s.xp = 95; // hunter pays 20, so this crosses the 100-point bar
        s.player.hp = 50;
        sim.stepSim(s, { dx: 0, dy: 0 }, 0.05);
        check(s.level === 2, "crossing the xp bar levels the player up", s.level);
        check(s.xp === 15, "the surplus carries into the next level", s.xp);
        check(near(s.player.maxHp, 105, 1e-6), "a level raises max hp ×1.05", s.player.maxHp);
        check(s.player.hp === 50, "a level does not heal", s.player.hp);
        check(
          s.player.attackPower === sim.TUNING.attackPower &&
            s.player.moveSpeed === sim.TUNING.moveSpeed,
          "a level grants no attack power or speed — potions own those",
        );
      }

      // The drop table. `rollDrops` is a plain function over `rng`, so the whole
      // probability model can be driven from stubs and from one seeded stream.
      {
        check(
          sim.rollDrops(() => 0).length === 4,
          "rng 0 everywhere drops all four potions",
          sim.rollDrops(() => 0).join(","),
        );
        check(
          sim.rollDrops(() => 0.99).length === 0,
          "rng 0.99 everywhere drops nothing — a kill is not guaranteed loot",
        );

        // Independence, stated as a sequence: only the power trial passes, and
        // the three failures around it neither cancel it nor add to it.
        const seq = [0.99, 0.01, 0.99, 0.99];
        let i = 0;
        const got = sim.rollDrops(() => seq[i++]);
        check(
          got.length === 1 && got[0] === "power",
          "each kind is an independent trial, not one weighted pick",
          got.join(","),
        );

        let draws = 0;
        sim.rollDrops(() => (draws++, 0.5));
        check(draws === 4, "a kill consumes exactly four rng draws", draws);

        // The distribution itself, off a fixed seed.
        const rng = rngFrom(987654321);
        const counts = { heal: 0, power: 0, agility: 0, vitality: 0 };
        const N = 20000;
        let empty = 0;
        for (let k = 0; k < N; k++) {
          const kinds = sim.rollDrops(rng);
          if (kinds.length === 0) empty++;
          for (const kind of kinds) counts[kind]++;
        }
        const frac = empty / N;
        check(
          frac > 0.4 && frac < 0.56,
          "most kills drop nothing",
          `${(frac * 100).toFixed(1)}% empty`,
        );
        check(
          Object.values(counts).every((c) => c > 0),
          "all four potions do drop",
          JSON.stringify(counts),
        );
        check(
          counts.heal > counts.power && counts.power > counts.vitality,
          "the rarer potions are actually rarer",
          JSON.stringify(counts),
        );
        const total = Object.values(counts).reduce((a, b) => a + b, 0) / N;
        const expected = Object.values(sim.DROP_CHANCE).reduce((a, b) => a + b, 0);
        check(
          near(total, expected, 0.03),
          "the observed drop rate matches the sum of the per-kind chances",
          `${total.toFixed(3)} vs ${expected.toFixed(3)}`,
        );
      }

      // Pickup is by radius, and the radius is **two bodies touching**, not the
      // player's centre landing inside the potion (design §8.4). The player's
      // own radius counts.
      const REACH = sim.TUNING.playerRadius + sim.TUNING.pickupRadius;
      {
        const s = bare();
        floor(s, "heal", REACH + 1, 0);
        step(s);
        check(s.items.length === 1 && s.pickups.heal === 0, `a potion ${REACH + 1}px away is not picked up`);

        const t = bare();
        floor(t, "heal", REACH - 1, 0);
        step(t);
        check(t.items.length === 0 && t.pickups.heal === 1, `a potion ${REACH - 1}px away is picked up`);
      }

      // The same rule has to hold while the player is *moving*, which is where
      // it used to fail. A player steers with the eight directions, so they
      // sweep past a potion rather than threading their centre through it; a
      // threshold measured from the centre alone meant the sweep collected
      // nothing, and the potion only popped once they had stopped and nudged
      // their centre into the last few pixels. Every case below is a run
      // straight along +x with the potion set off to one side.
      {
        const walk = (side) => {
          const s = bare();
          floor(s, "heal", 30, side);
          for (let i = 0; i < 60 && s.items.length > 0; i++) step(s, { dx: 1, dy: 0 }, 1 / 60);
          return s;
        };

        // 8px off the path: the player's body covers the potion for the whole
        // pass. This is the exact case that went uncollected before.
        const clipped = walk(8);
        check(
          clipped.pickups.heal === 1,
          "a potion 8px off the path is picked up while running past it",
          `items=${clipped.items.length} pickups=${clipped.pickups.heal}`,
        );

        const grazed = walk(REACH - 1);
        check(grazed.pickups.heal === 1, "a potion grazed at the edge of the reach is picked up");

        // Outside the reach, running over it is not enough. The potion is a
        // place to go (design §8.3), not a magnet — this is the check that
        // fails if the radius is ever widened into one.
        const missed = walk(REACH + 2);
        check(
          missed.items.length === 1 && missed.pickups.heal === 0,
          "a potion outside the reach is left on the floor",
          `items=${missed.items.length} pickups=${missed.pickups.heal}`,
        );
      }

      // The four effects, each asserted against the other three: a swapped
      // `switch` arm is the kind of bug that otherwise ships silently.
      {
        const s = bare();
        s.player.hp = 90;
        floor(s, "heal");
        step(s);
        check(s.player.hp === 100, "a heal potion tops up to the cap, never past it", s.player.hp);
        check(s.player.maxHp === 100, "a heal potion does not raise the cap", s.player.maxHp);
        floor(s, "heal");
        step(s);
        check(s.player.hp === 100, "a heal at full hp overflows nothing", s.player.hp);
        check(s.pickups.heal === 2, "both heals were counted", s.pickups.heal);

        const p = bare();
        floor(p, "power");
        step(p);
        check(
          near(p.player.attackPower, 8 * 1.05, 1e-9) && near(p.player.attackSpeed, 1.5 * 1.05, 1e-9),
          "a power potion raises attack power and attack speed together",
          `${p.player.attackPower} / ${p.player.attackSpeed}`,
        );
        check(p.player.moveSpeed === 160, "a power potion leaves move speed alone");

        const a = bare();
        floor(a, "agility");
        step(a);
        check(
          near(a.player.moveSpeed, 160 * 1.05, 1e-9),
          "an agility potion raises move speed",
          a.player.moveSpeed,
        );
        check(a.player.attackPower === 8, "an agility potion leaves attack power alone");

        const v = bare();
        v.player.hp = 60;
        floor(v, "vitality");
        step(v);
        check(
          near(v.player.maxHp, 105, 1e-6),
          "a vitality potion raises the cap ×1.05",
          v.player.maxHp,
        );
        check(v.player.hp === 60, "a vitality potion restores nothing", v.player.hp);
      }

      // Aging happens before collection, and expiry is what that ordering buys.
      {
        const s = bare();
        floor(s, "heal", 200, 0, 0.05);
        step(s);
        check(s.items.length === 0, "a potion past its lifetime is gone");

        const t = bare();
        floor(t, "heal", 200, 0, 0.06);
        step(t);
        check(t.items.length === 1, "a potion still inside its lifetime survives the step");

        // The load-bearing half: a potion that expires under the player's feet
        // expires, rather than being counted as a pickup. The renderer reads a
        // vanished item as one or the other purely from this ordering.
        const u = bare();
        floor(u, "heal", 0, 0, 0.05);
        step(u);
        check(
          u.items.length === 0 && u.pickups.heal === 0,
          "an expiring potion is not collected on its way out",
        );
      }

      // Items are not key material (design §8.4): `V` is fixed-length, so a
      // dropped potion must not shift a single byte's owner.
      {
        const s = bare();
        s.player.hp = 70;
        floor(s, "power", 30, 30);
        floor(s, "vitality", -30, 20);
        const withItems = keymap.buildStateVector(sim.snapshot(s));
        s.items.length = 0;
        const without = keymap.buildStateVector(sim.snapshot(s));
        check(
          withItems.length === without.length && withItems.every((b, j) => b === without[j]),
          "potions on the floor do not touch the state vector",
          `${withItems.join(",")} vs ${without.join(",")}`,
        );
      }
    }

    // ── §3 Key mapping ─────────────────────────────────────────────────────
    {
      const s = fresh();
      for (let i = 0; i < 40; i++) sim.stepSim(s, { dx: 0, dy: 0 }, 0.05);
      const snap = sim.snapshot(s);
      const { keyHex, baseBytes } = keymap.gameKeyHex(snap, puzzleA);

      const b = puzzleA.hex_bytes_len;
      check(keyHex.length === 64, "the key is 32 bytes of hex", keyHex.length);
      check(keyHex.slice(0, (32 - b) * 2) === "0".repeat((32 - b) * 2), "the padding bytes are all zero");
      const top = parseInt(keyHex.slice((32 - b) * 2, (32 - b) * 2 + 2), 16);
      check(
        top >= puzzleA.start_top && top <= puzzleA.end_top - 1,
        "the bounded byte stays inside the puzzle's range",
        `0x${top.toString(16)}`,
      );
      check(baseBytes.length === b - 1, "exactly b-1 free bytes are produced", baseBytes.length);
      check(keyHex.slice(-(b - 1) * 2) === baseBytes.join(""), "the free bytes are the tail of the key");
      check(baseBytes.every((x) => /^[0-9a-f]{2}$/.test(x)), "every free byte is 2-char lowercase hex");

      // Determinism, and puzzle identity in the seed: `V` carries no puzzle
      // number, so without folding it into the seed both puzzles would emit
      // the same byte stream.
      const a2 = keymap.gameKeyHex(snap, puzzleA).baseBytes;
      const bBytes = keymap.gameKeyHex(snap, puzzleB).baseBytes;
      check(a2.join("") === baseBytes.join(""), "the same state yields the same free bytes");
      check(bBytes.join("") !== baseBytes.join(""), "a different puzzle yields a different byte stream");
      check(keymap.gameKeyHex(snap, puzzleA).owners.length === b - 1, "every free byte has an owner label");
    }

    // ── §3.3 The reason for the hybrid mapping ─────────────────────────────
    {
      const s = fresh();
      s.monsters.length = 0;
      // Byte j=0 is owned by `player.dir`, which has only 8 possible values. A
      // direct mapping would pin that byte to 8 of 256 values and waste 97% of
      // its range; the diffuse term is what buys the coverage back.
      //
      // `V` is a pure function of the live world now (design §3.4), so there is
      // no tick counter to nudge and novelty has to come from state the player
      // really moves. Two coprime periods, because one quantised byte is only
      // 256 states and this samples 400 times.
      check(s.player.dir === 0, "the player starts facing east", s.player.dir);
      const seen = new Set();
      let dirByte = "";
      const step = s.width / 256;
      for (let i = 0; i < 400; i++) {
        s.player.posX = (i % 256) * step;
        s.player.hp = 100 - (i % 101);
        dirByte = keymap.gameBaseBytes(sim.snapshot(s), puzzleA).baseBytes[0];
        seen.add(dirByte);
      }
      check(
        seen.size > 120,
        "a low-cardinality field still spreads across its byte",
        `${seen.size}/400 samples, ${dirByte} last`,
      );
    }

    // ── §14 The robot: perception, the fog, and the headline survival proof ──
    {
      const robot = await import("/src/game/robot.ts");

      // ── §14.1 Requirement 4/5: the fog is exactly a sense-circle test ────
      {
        const s = fresh();
        const m = solo(s, "brute", 4, (mm, cfg) => {
          mm.posX = cfg.x + cfg.w / 2;
          mm.posY = cfg.y + cfg.h / 2;
        });
        // Park the player far outside the circle, then step inside it. The
        // projection is rebuilt per frame, so this is the whole of requirement
        // 5: inside means revealed, outside means not.
        const far = m.senseRange + 200;
        s.player.posX = m.posX + far;
        s.player.posY = m.posY;

        const out = robot.perceive(s);
        const hidden = out.monsters.find((x) => x.id === m.id);
        check(hidden.stats === null, "a monster outside its sense ring keeps its stats hidden");
        check(hidden.kind === "brute", "but its kind is still public — the silhouette is drawn", hidden.kind);
        check(hidden.senseRange === m.senseRange, "and so is its sense range — the ring is drawn");
        check(
          "attackPower" in hidden === false && "moveSpeed" in hidden === false,
          "an un-revealed monster carries no stat fields at all",
          Object.keys(hidden).join(","),
        );

        s.player.posX = m.posX + m.senseRange - 5;
        const inside = robot.perceive(s).monsters.find((x) => x.id === m.id);
        check(inside.stats !== null, "stepping inside the ring reveals the stats");
        check(
          inside.stats?.attackPower === m.attackPower && inside.stats?.moveSpeed === m.moveSpeed,
          "and the revealed numbers are the monster's real ones",
          JSON.stringify(inside.stats),
        );

        // ...and stepping back out hides them again: the reveal is not memory.
        s.player.posX = m.posX + far;
        const again = robot.perceive(s).monsters.find((x) => x.id === m.id);
        check(again.stats === null, "stepping back out hides them again — the reveal is not remembered");
      }

      // ── §14.2 `decide` is a pure function of the view ────────────────────
      {
        const s = fresh();
        const view = robot.perceive(s);
        const stA = robot.createRobotState();
        const stB = robot.createRobotState();
        const d1 = robot.decide(view, stA);
        const d2 = robot.decide(view, stB);
        check(
          d1.input.dx === d2.input.dx && d1.input.dy === d2.input.dy && d1.intent === d2.intent,
          "the same view and a fresh policy state yield the same move",
          `${d1.intent}(${d1.input.dx},${d1.input.dy})`,
        );
        check(
          typeof d1.intent === "string" && ["flee", "heal", "loot", "kite", "roam"].includes(d1.intent),
          "the intent is one of the five the ladder can produce",
          d1.intent,
        );

        // Same seed twice ⇒ identical trajectory. This is what makes every
        // other check here meaningful rather than merely observed.
        const trace = () => {
          const sim2 = fresh();
          const st = robot.createRobotState();
          const moves = [];
          for (let i = 0; i < 600; i++) {
            const inp = robot.decide(robot.perceive(sim2), st).input;
            moves.push(`${inp.dx},${inp.dy}`);
            sim.stepSim(sim2, inp, 1 / 60);
          }
          return moves.join("|");
        };
        check(trace() === trace(), "a seeded run replays move-for-move");
      }

      // ── §14.2 It retreats from something that is actually hitting it ─────
      {
        const s = fresh();
        const m = solo(s, "brute", 4, (mm, cfg) => {
          mm.posX = cfg.x + cfg.w / 2;
          mm.posY = cfg.y + cfg.h / 2;
        });
        // Real numbers, and close enough that the first attack roll lands:
        // this is the one situation the robot must never sit in.
        m.attackPower = 12;
        m.attackSpeed = 1;
        m.attackRange = 30;
        m.senseRange = 400;
        m.hp = 1e9;
        m.maxHp = 1e9;
        s.monsters.length = 0;
        s.monsters.push(m);
        s.items.length = 0;
        s.player.posX = m.posX + 12;
        s.player.posY = m.posY;

        const startGap = Math.abs(s.player.posX - m.posX);
        const st = robot.createRobotState();
        for (let i = 0; i < 90; i++) robot.decide(robot.perceive(s), st);
        // Drive it for real, not just decide: a decision that is never applied
        // is not a retreat.
        for (let i = 0; i < 90; i++) {
          sim.stepSim(s, robot.decide(robot.perceive(s), st).input, 1 / 60);
        }
        const endGap = Math.hypot(s.player.posX - m.posX, s.player.posY - m.posY);
        check(
          endGap > startGap && endGap > m.attackRange,
          "parked inside a revealed monster's reach, the robot backs out of it",
          `${startGap.toFixed(0)}px -> ${endGap.toFixed(0)}px (reach ${m.attackRange})`,
        );
      }

      // ── §14.2 With nothing in range, it goes and gets in range ───────────
      //
      // The user's report: "robot 的 range 范围内没有怪物的时候，应该……尝试去攻
      // 击最近的那一个". The approach rung already existed and already aimed at the
      // monster; what it did not do was *move*. The risk delta is clamped at
      // `RISK_CAP` 12 and the kite weight is 6, so every step that closed the
      // distance carried a positive delta it could not outbid — while idle sat
      // at exactly 0 and won by default. Measured over 24 seeds, of the 723892
      // frames with nothing inside our own range the robot was idle on 72.4% and
      // closed the distance on only 14.6%, stalling a median 36px short of its
      // own ring with idle streaks up to 1615 frames.
      //
      // Both bodies sit in region 4, so this is not the cross-border case — it
      // takes the plain "there is a monster over there and I am not near it".
      {
        const s = fresh();
        const m = solo(s, "wanderer", 4, (mm, cfg) => {
          mm.posX = cfg.x + cfg.w / 2;
          mm.posY = cfg.y + cfg.h / 2;
        });
        m.senseRange = 400;
        m.hp = 1e9;
        m.maxHp = 1e9;
        s.monsters.length = 0;
        s.monsters.push(m);
        s.items.length = 0;
        // 150px out: past our reach (55), inside the farm radius, same region.
        s.player.posX = m.posX + 150;
        s.player.posY = m.posY;

        const st = robot.createRobotState();
        for (let i = 0; i < 90; i++) robot.decide(robot.perceive(s), st); // settle
        const startGap = Math.hypot(s.player.posX - m.posX, s.player.posY - m.posY);
        for (let i = 0; i < 3600; i++) {
          sim.stepSim(s, robot.decide(robot.perceive(s), st).input, 1 / 60);
        }
        const endGap = Math.hypot(s.player.posX - m.posX, s.player.posY - m.posY);
        check(
          endGap <= s.player.attackRange,
          "with nothing in range, it closes to within its own range",
          `${startGap.toFixed(0)}px -> ${endGap.toFixed(0)}px (range ${s.player.attackRange})`,
        );
      }

      // ── §14.2 A wounded robot walks to the medicine ─────────────────────
      {
        const s = fresh();
        s.monsters.length = 0;
        s.items.length = 0;
        // Put a leashed stranger in another region purely so the robot is not
        // in a world with nothing to do — it must still prefer the potion.
        solo(s, "brute", 8, (mm, cfg) => {
          mm.posX = cfg.x + 10;
          mm.posY = cfg.y + 10;
        });
        s.player.hp = Math.max(1, s.player.maxHp * 0.3);
        const dropped = {
          id: 4242, kind: "heal", posX: s.player.posX + 60, posY: s.player.posY,
          life: 30, region: 0,
        };
        s.items.push(dropped);

        const before = s.pickups.heal;
        const st = robot.createRobotState();
        for (let i = 0; i < 240 && s.pickups.heal === before; i++) {
          sim.stepSim(s, robot.decide(robot.perceive(s), st).input, 1 / 60);
        }
        check(s.pickups.heal > before, "a wounded robot with a heal potion on the floor collects it", `t=${s.time.toFixed(1)}s`);
      }

      // ── §14.2 It stays in the arena ──────────────────────────────────────
      {
        const s = fresh();
        const st = robot.createRobotState();
        let inBounds = true;
        for (let i = 0; i < 3600; i++) {
          sim.stepSim(s, robot.decide(robot.perceive(s), st).input, 1 / 60);
          const p = s.player;
          if (p.posX < 0 || p.posX > s.width || p.posY < 0 || p.posY > s.height) inBounds = false;
        }
        check(inBounds, "a minute of play never leaves the arena");
      }

      // ── §14.5 The headline: the robot outlives standing still, and plays ─
      //
      // Seeds are `i * 1013 + 7`, the same family the policy was tuned against,
      // and the thresholds are grounded in a 96-seed headless sweep rather than
      // in these twelve: there, the median run outlives an idle control by
      // 7.14×, every one of the 96 seeds reaches the cap, and the worst still
      // manages 3.59×. Asserting the median rather than a mean is deliberate —
      // one unlucky trajectory cannot move it, and survival is genuinely
      // bimodal.
      {
        const SEEDS = [];
        for (let i = 1; i <= 12; i++) SEEDS.push(i * 1013 + 7);
        const CAP = 600;
        const ratios = [];
        let capped = 0, kills = 0, pickups = 0;
        let contact = 0, escaped = 0;

        for (const seed of SEEDS) {
          const idleRun = sim.createSim({ rng: rngFrom(seed) });
          while (idleRun.alive && idleRun.time < CAP) sim.stepSim(idleRun, { dx: 0, dy: 0 }, 1 / 60);

          const run = sim.createSim({ rng: rngFrom(seed) });
          const st = robot.createRobotState();
          while (run.alive && run.time < CAP) {
            // The nearest monster, and whether it is already hitting us — the
            // state the user reported on. Sampled before the step, so the
            // measurement is "given that we were being hit, did the gap open?".
            const near = run.monsters.reduce(
              (a, m) => {
                const d = Math.hypot(m.posX - run.player.posX, m.posY - run.player.posY);
                return d < a.d ? { m, d } : a;
              },
              { m: null, d: Infinity },
            );
            const inReach = near.m !== null && near.d <= near.m.attackRange;
            const id = near.m === null ? -1 : near.m.id;

            sim.stepSim(run, robot.decide(robot.perceive(run), st).input, 1 / 60);

            if (inReach && run.alive) {
              const after = run.monsters.find((m) => m.id === id);
              if (after) {
                contact++;
                const d = Math.hypot(after.posX - run.player.posX, after.posY - run.player.posY);
                if (d > near.d + 0.05) escaped++;
              }
            }
          }
          ratios.push(run.time / idleRun.time);
          if (run.time >= CAP) capped++;
          kills += run.kills;
          pickups += Object.values(run.pickups).reduce((a, b) => a + b, 0);
        }

        ratios.sort((a, b) => a - b);
        const median = ratios[ratios.length >> 1];
        check(
          median >= 3,
          "the robot outlives an idle player by several times (median)",
          `${median.toFixed(2)}x over ${SEEDS.length} seeds`,
        );
        check(capped >= 10, "and most runs reach the 10-minute cap rather than dying", `${capped}/${SEEDS.length}`);
        check(
          ratios[0] > 1,
          "even the worst seed outlives standing still",
          `worst ${ratios[0].toFixed(2)}x`,
        );
        // "Plays rather than hides": a robot that only survived by retreating
        // would clear the ratio above with nothing to show for it.
        check(kills > 0 && pickups > 0, "and it is playing, not hiding", `${kills} kills, ${pickups} pickups`);

        // ── §14.2 The user's report, as a number ──────────────────────────
        //
        // "怪物冲到player面前了，player没有跑." The retreat test above does not
        // catch this one and never did — it parks the robot beside a single
        // monster in an otherwise empty arena, where the escape direction has
        // nothing in its way. The real failure was positional: `riskAt` honours
        // the region leash (design §6.2), so a `PROBE_S` step of 40px
        // (`moveSpeed` 160 × 0.25) that crosses a border reports the risk of a
        // *different region*, and when the escape direction was the one pointing
        // at that border the risk term vetoed it. It needs the whole arena to
        // reproduce, not a puppet.
        //
        // Measured over the 96-seed sweep: 26-34% of contact frames opened the
        // gap before `KITE_CONTACT_WEIGHT` existed, 66% under the shipped policy
        // (`docs/game-design.md` §14.5 cites the same run). The threshold sits
        // below that because this is a twelve-seed sample and the statistic is
        // noisy.
        const escapeRate = contact ? escaped / contact : 0;
        check(
          escapeRate > 0.55,
          "in contact, it opens the gap rather than standing there",
          `${(escapeRate * 100).toFixed(0)}% of ${contact} contact frames`,
        );
      }
    }

    return out;
  }, [PUZZLE_A, PUZZLE_B]);

  console.log("\n[game-sim] pure simulation");
  let inSim = true;
  for (const r of results) {
    // The key-mapping block is the second half of the list; a cheap separator
    // beats threading a group name through every check.
    if (inSim && r.label.startsWith("the key is 32 bytes")) {
      console.log("\n[game-sim] key mapping");
      inSim = false;
    }
    if (r.ok) {
      console.log(`  PASS  ${r.label}`);
    } else {
      failures.push(r.label);
      console.log(`  FAIL  ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }

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

console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} FAILURE(S): ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
