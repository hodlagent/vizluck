#!/usr/bin/env node
/**
 * The robot tuning sweep (design §14.5 / §14.6).
 *
 * The numbers in `docs/game-design.md` and in `robot.ts`'s comments are
 * *measured*, and until now the measurement was an ad-hoc run nobody could
 * reproduce — §14.6 records one set of figures being withdrawn for exactly that
 * reason. This is the recipe, as a script: 96 seeds from the family the policy
 * was tuned against, both arms, reporting the stats those comments quote plus a
 * few the current open questions need.
 *
 * It is deliberately **not** in `npm run test:e2e`. The regression suite runs a
 * twelve-seed sample in seconds; this runs 96 seeds × 2 arms × 600 s at 60 Hz,
 * which is minutes. Run it when a constant moves, not on every commit.
 *
 * Usage:
 *   npm run sweep:robot                              # 96 seeds, the full sweep
 *   SWEEP_SEEDS=12 npm run sweep:robot               # a cheap look
 *   SWEEP_OVERRIDE=CHASE=2.5 npm run sweep:robot     # tune without editing source
 *   SWEEP_OVERRIDE=GOAL.flee=10 npm run sweep:robot  # nested tables use a dot path
 *   SWEEP_OVERRIDE=M.hunter.senseRange=140 npm run sweep:robot  # world knob (`M.`)
 *   SWEEP_SEEDS=12 SWEEP_OVERRIDE=RISK_CAP=1000 npm run sweep:robot
 *   SWEEP_VERBOSE=1 npm run sweep:robot              # also print per-seed rows
 *   SWEEP_ZONES=1 npm run sweep:robot                # add the 6×4 position maps
 *   VIZLUCK_URL=http://localhost:1420/ npm run sweep:robot
 *
 * `SWEEP_ZONES` adds two heat maps of where the robot spends its time, plus a
 * second one restricted to t ≥ 10 s. It is off by default because a 6×4 map is a
 * lot of output for a question most sweeps are not asking. It exists for one
 * question in particular: the player spawns at the centre of the arena, so a map
 * of all frames partly shows where the robot woke up. The t ≥ 10 s map is the
 * spawn control — if the hot cells are the same in both, the hot corner is a
 * place it *goes*, not a place it *starts*.
 *
 * `SWEEP_OVERRIDE` mutates the exported `ROBOT` table inside the page before any
 * run starts. `as const` is a TypeScript assertion, so the object is an ordinary
 * one at runtime and this is a legitimate tuning hook — but it means an override
 * is *not* the shipped build, so a number produced under one must be re-checked
 * without it before it goes in a comment. Comma-separate several.
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";

const BASE_URL = process.env.VIZLUCK_URL ?? "http://localhost:1420/";
const SERVER_TIMEOUT_MS = 60_000;
const SEEDS = Number(process.env.SWEEP_SEEDS ?? 96);
const VERBOSE = process.env.SWEEP_VERBOSE === "1";
const OVERRIDES = (process.env.SWEEP_OVERRIDE ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Dev server ──────────────────────────────────────────────────────────────
// Verbatim from `tests/game-sim.mjs`, like the browser launch below: these
// scripts are standalone by design, and a shared helper module would be the
// first thing to quietly drift from the suite it is supposed to match.

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

// ── Reporting ───────────────────────────────────────────────────────────────

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fixed = (x, n = 2) => x.toFixed(n);
// Where on the floor the robot spends its time, and which way it is going when
// it is near an edge. Off by default because it is a wide block of output; the
// question it answers ("why does it keep ending up on the boundary?") is one
// that keeps coming back, so it is worth having as a switch rather than as a
// throwaway script. See the `SWEEP_ZONES` note in the usage header.
const ZONES = process.env.SWEEP_ZONES === "1";
const ZC = 6;
const ZR = 4;
// Elapsed-time buckets, in seconds, for the spawn control.
const BUCKETS = [5, 15, 30, Infinity];
// Pack-size buckets, in *two* readings, because "引到几只怪" has two defensible
// definitions in this game and they disagree by a factor of two:
//
//  - `aware` — monsters with the player inside their `senseRange`. This is the
//    sim's own aggro test (`m.attacking` is exactly `dist <= m.senseRange`,
//    §6.2), so it is the set that is chasing and shooting. Its weakness is that
//    a hunter's `senseRange` is 260px, i.e. 41% of the 960×540 arena's area, so
//    it counts monsters a human would not point at and call "the ones I pulled".
//  - `close` — monsters within 120px, the policy's own `CLUSTER_RADIUS`: the
//    knot around the player rather than everyone who has noticed.
//
// `monsters aware of player  mean` already exists and answers "is the arena
// crowded"; neither of these replaces it, because that is a question about the
// centre of the distribution and these are questions about its *shape*. The
// edges are the user's: 1–4 is the pack worth committing to, 0 is nothing to
// farm, 5+ is already more than a kite can hold. Frames and kills are bucketed
// on the same read, so the two columns are directly comparable.
const PACK_EDGES = [0, 4, 8];
const packLabels = ["0", "1-4", "5-8", "9+"];
// The "knot around the player" radius for the `close` reading. Same 120 as
// `ROBOT.CLUSTER_RADIUS`, which is the policy's existing notion of a knot, so
// the statistic and the rule it is meant to justify cannot drift apart.
const CLOSE_RADIUS = 120;
// The wall band, in px, for the death statistics below. Same fixed 70 as the
// sampler's own `NEAR_WALL` — which is scoped inside the page-evaluate body and
// so is invisible down here — and fixed for the same reason: the number has to
// stay comparable across arms when the margin itself is what is being swept.
const NEAR_WALL = 70;

function row(label, value) {
  console.log(`  ${label.padEnd(38)}${value}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  const seeds = [];
  for (let i = 1; i <= SEEDS; i++) seeds.push(i * 1013 + 7);

  const data = await page.evaluate(async ([seedList, overrides, ZC, ZR, ZONES, BUCKETS, PACK_EDGES, CLOSE_RADIUS]) => {
    const sim = await import("/src/game/sim.ts");
    const robot = await import("/src/game/robot.ts");

    const applied = [];
    for (const o of overrides) {
      // `GOAL.flee=10` walks one level into a nested table; plain `HYST=6` does
      // not. `GOAL` is the only nested one today, and it needs the path form
      // because the weights inside it are per-intent knobs the sweep has to be
      // able to reach — several constants have now turned out to rest on
      // measurements from a world that no longer exists, and a knob that cannot
      // be re-measured is a knob that keeps its stale justification.
      //
      // A leading `M.` roots the path at `MONSTER_ARCHETYPES` instead of
      // `ROBOT`: `M.hunter.senseRange=140`. That second root was added for one
      // question in particular — whether the arena's *aggro* count (9+ on 72.7%
      // of frames, §14.5) is a property of the policy or of the radii, since a
      // hunter's 260px sense is 41% of the floor's area and no amount of kiting
      // policy can change what is already chasing. Without this the only way to
      // ask it was to edit `sim.ts`, which is a world change rather than a
      // measurement.
      const [path, raw] = o.split("=");
      const value = Number(raw);
      const parts = path.split(".");
      const monster = parts[0] === "M";
      let host = monster ? sim.MONSTER_ARCHETYPES : robot.ROBOT;
      const rest = monster ? parts.slice(1) : parts;
      for (const part of rest.slice(0, -1)) host = host?.[part];
      const key = rest[rest.length - 1];
      if (typeof host?.[key] !== "number" || !Number.isFinite(value)) {
        applied.push(`${o} (IGNORED: unknown key or non-numeric value)`);
        continue;
      }
      host[key] = value;
      applied.push(`${path}=${value}`);
    }

    /** mulberry32 — verbatim from `tests/game-sim.mjs`, and it has to be: a
     *  different generator means a different 96 trajectories. */
    const rngFrom = (seed) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const CAP = 600;
    const DT = 1 / 60;
    const rows = [];

    const TAU = Math.PI * 2;
    /** Fold an angle difference into (-π, π] so a wrap is not a 359° turn. */
    const wrapPi = (a) => {
      let v = a;
      while (v > Math.PI) v -= TAU;
      while (v < -Math.PI) v += TAU;
      return v;
    };

    for (const seed of seedList) {
      const idleRun = sim.createSim({ rng: rngFrom(seed) });
      while (idleRun.alive && idleRun.time < CAP) sim.stepSim(idleRun, { dx: 0, dy: 0 }, DT);

      const run = sim.createSim({ rng: rngFrom(seed) });
      const st = robot.createRobotState();
      const intents = { flee: 0, heal: 0, loot: 0, kite: 0, roam: 0 };
      let frames = 0;
      let idleFrames = 0;
      let contact = 0;
      let escaped = 0;
      let retreatEntries = 0;
      let wasRetreating = false;
      let crowdSum = 0;
      let crowdPeak = 0;
      // Pack-size buckets, one entry per `PACK_EDGES` gap plus the open top, and
      // one pair per reading (see `PACK_EDGES` above). Frames are bucketed on
      // the read taken *before* the step — the same pass `crowd` comes from, so
      // the three agree. A kill lands during the step and is attributed to the
      // bucket that was in force when the frame began; that is the only ordering
      // available, since `stepSim` reports kills as a counter rather than as
      // events, and it is the right one for the question: "while N monsters were
      // on us, how much did we kill".
      const mk = () => new Array(PACK_EDGES.length + 1).fill(0);
      const awareFrames = mk();
      const awareKills = mk();
      const closeFrames = mk();
      const closeKills = mk();
      const packBucket = (n) => {
        let b = 0;
        while (b < PACK_EDGES.length && n > PACK_EDGES[b]) b++;
        return b;
      };
      let lastDx = 0;
      let lastDy = 0;
      let streak = 0;
      let longestRun = 0;
      let reversals = 0;
      let fleeStreak = 0;
      const fleeSpans = [];
      // How close to the arena edge the robot runs. The user reported it
      // reaching the boundary and then sliding along it with no room to dodge
      // sideways; this is the statistic that says whether that is true, and
      // whether a change fixed it. Measured against a *fixed* 70px rather than
      // `ROBOT.WALL_MARGIN` so the number stays comparable across arms when the
      // margin itself is the thing being swept.
      const NEAR_WALL = 70;
      let nearWallFrames = 0;
      let edgeSum = 0;
      // Of the frames near a wall, which way is the robot actually going? The
      // chosen input is decomposed against the radial from the arena centre:
      // outward means pressing at the wall, tangential means sliding along it,
      // inward means leaving. That split is the whole diagnosis — "it ends up on
      // the boundary" and "it walks into the boundary" are different defects and
      // only one of them is about the wall at all.
      let nearWallMoving = 0;
      let nearWallOutward = 0;
      let nearWallTangential = 0;
      let nearWallRadialSum = 0;
      let openMoving = 0;
      let openRadialSum = 0;
      // Intent mix, split by band — is it at the wall because it *flees* there?
      const nearIntents = { flee: 0, heal: 0, loot: 0, kite: 0, roam: 0 };
      const openIntents = { flee: 0, heal: 0, loot: 0, kite: 0, roam: 0 };
      const zoneFrames = new Array(ZR * ZC).fill(0);
      const zoneLate = new Array(ZR * ZC).fill(0);
      let lateFrames = 0;
      // Clearance and heading by elapsed run time. **This is the control for the
      // spawn**: `sim.ts` starts the player at the centre of the arena, and a
      // median run is short enough that a plain position map mostly shows where
      // the robot woke up rather than where it chose to go. If the boundary
      // share decays with time it is a startup artefact; if it holds or grows,
      // the boundary is an attractor.
      const bucketFrames = BUCKETS.map(() => 0);
      const bucketNear = BUCKETS.map(() => 0);
      const bucketEdge = BUCKETS.map(() => 0);

      // ── Circling: is it orbiting, or only leaving? ─────────────────────
      // `flee` gained a tangential half so that a retreat curves instead of
      // running radially into whatever wall is behind it, and the user's ask is
      // "兜圈子". Neither survival nor clearance can say whether that happened:
      // a robot that runs straight away and one that circles both open
      // distance. The difference is entirely in the *sign* of the turning, so
      // that is what is recorded.
      //
      // Two channels, because they fail in different ways:
      //
      //  - `bearing` sweeps the player's angle as seen from `dangerCentre` —
      //    the reference the policy itself orbits, recomputed per frame exactly
      //    as `dangerCentre` does it (dps-weighted, within `DISENGAGE_RADIUS`,
      //    `PRIOR_DPS` for a monster whose stats the robot cannot see). Its
      //    weakness is that the reference *moves*: monsters converge on the
      //    player, so even a straight line drifts a little around it.
      //  - `turn` is the player's own heading change. Reference-free, and 0 by
      //    construction on a straight run, so it cannot be fooled by that.
      //
      // Each is reported as a rate and as a *consistency*, `|Σdθ| / Σ|dθ|`,
      // where 1.0 is a sustained orbit in one direction and ~0.0 is dithering.
      // Consistency is computed **per seed and only then aggregated**, never
      // over the pooled frames of every seed: each seed's orbit may wind either
      // way, and pooling would cancel two clean orbits into an apparent zero.
      let orbAbs = 0;
      let orbNet = 0;
      let orbFrames = 0;
      let orbRadiusSum = 0;
      let lastBearing = null;
      let turnAbs = 0;
      let turnNet = 0;
      let lastHeading = null;
      // Breaking aggro is a per-monster event, so the tally is keyed by id
      // across frames rather than summed over the crowd.
      let aggroBreaks = 0;
      const prevAggro = new Map();

      while (run.alive && run.time < CAP) {
        // Sampled *before* the step: "given that we were being hit, did the gap
        // open?" — the statistic §14.5's escape rate is defined on.
        const near = run.monsters.reduce(
          (a, m) => {
            const d = Math.hypot(m.posX - run.player.posX, m.posY - run.player.posY);
            return d < a.d ? { m, d } : a;
          },
          { m: null, d: Infinity },
        );
        const inReach = near.m !== null && near.d <= near.m.attackRange;
        const id = near.m === null ? -1 : near.m.id;

        // How many monsters are aware of the player — the input the risk field
        // sums. Under the leash this was bounded by one region's population;
        // the sweep's open question (§14.6) is whether it now grows without
        // bound as everything converges on wherever the player is standing.
        // `close` is the same pass under the tighter radius — see `PACK_EDGES`.
        let crowd = 0;
        let close = 0;
        for (const m of run.monsters) {
          const d = Math.hypot(m.posX - run.player.posX, m.posY - run.player.posY);
          if (d <= m.senseRange) crowd++;
          if (d <= CLOSE_RADIUS) close++;
          // The aggro tally. `escape rate in contact` above answers "did the gap
          // open while we were inside reach" — a per-frame question. Breaking
          // aggro is a *different* mechanic with a *different* cost: it needs
          // enough net gain to carry the player clear of `senseRange`, and
          // §14.5 quantifies that as ~3.9s of unbroken running at a 40px/s
          // closing difference (160 moveSpeed − 120 hunter). Nothing else in
          // this report can see it, and the orbit spends exactly that budget:
          // a tangential component does not open the gap, so it buys dodging
          // with the run's escape. `m.attacking` is written by the previous
          // frame's `stepSim` (`dist <= m.senseRange`), so a true→false across
          // two of these reads is one real break. Monsters that die simply
          // vanish from `run.monsters` and cannot post a false one.
          const was = prevAggro.get(m.id) ?? false;
          if (was && !m.attacking) aggroBreaks++;
          prevAggro.set(m.id, m.attacking);
        }
        crowdSum += crowd;
        if (crowd > crowdPeak) crowdPeak = crowd;
        const aware = packBucket(crowd);
        const clos = packBucket(close);
        awareFrames[aware]++;
        closeFrames[clos]++;
        const killsBefore = run.kills;

        const edge = Math.min(
          run.player.posX,
          run.width - run.player.posX,
          run.player.posY,
          run.height - run.player.posY,
        );
        if (edge <= NEAR_WALL) nearWallFrames++;
        edgeSum += edge;

        const decision = robot.decide(robot.perceive(run), st);
        if (decision.input.dx === 0 && decision.input.dy === 0) idleFrames++;
        intents[decision.intent]++;
        if (st.retreating && !wasRetreating) retreatEntries++;
        wasRetreating = st.retreating;
        frames++;

        // The radial decomposition, and the zone tally. Only moving frames are
        // classified: idle has no direction, and its share is already reported.
        {
          const rx = run.player.posX - run.width / 2;
          const ry = run.player.posY - run.height / 2;
          const rlen = Math.hypot(rx, ry) || 1;
          const dx0 = decision.input.dx;
          const dy0 = decision.input.dy;
          const moving0 = dx0 !== 0 || dy0 !== 0;
          const dlen = Math.hypot(dx0, dy0) || 1;
          const radial = moving0 ? (dx0 / dlen) * (rx / rlen) + (dy0 / dlen) * (ry / rlen) : 0;
          const near = edge <= NEAR_WALL;
          (near ? nearIntents : openIntents)[decision.intent]++;
          if (moving0) {
            if (near) {
              nearWallMoving++;
              nearWallRadialSum += radial;
              // 0.707 splits the 90° cone around "straight at the wall" from the
              // two cones that slide along it.
              if (radial > 0.707) nearWallOutward++;
              else if (radial < -0.707) {
                /* inward — counted by subtraction in the report */
              } else nearWallTangential++;
            } else {
              openMoving++;
              openRadialSum += radial;
            }
          }
          if (ZONES) {
            const col = Math.min(ZC - 1, Math.floor((run.player.posX / run.width) * ZC));
            const rowi = Math.min(ZR - 1, Math.floor((run.player.posY / run.height) * ZR));
            zoneFrames[rowi * ZC + col]++;
            if (run.time >= 10) {
              zoneLate[rowi * ZC + col]++;
              lateFrames++;
            }
          }
          {
            let b = 0;
            while (run.time >= BUCKETS[b]) b++;
            bucketFrames[b]++;
            if (near) bucketNear[b]++;
            bucketEdge[b] += edge;
          }
        }

        // ── Direction stability ────────────────────────────────────────────
        // `escape rate` asks "did the gap open while we were in contact"; this
        // asks "did the robot hold a heading at all". They are different
        // failures and they have to be told apart, because the escape mechanic
        // is not a per-frame one: breaking a hunter's aggro needs ~3.9s of
        // *unbroken* running (160px of net gain at the 40px/s closing
        // difference), and a robot that reverses every six frames can never
        // accumulate it. A reversal is moving → a different non-zero
        // direction; stopping is not one, since idle is its own (already
        // reported) failure.
        const dx = decision.input.dx;
        const dy = decision.input.dy;
        if (dx !== 0 || dy !== 0) {
          if (dx === lastDx && dy === lastDy) streak++;
          else {
            if (lastDx !== 0 || lastDy !== 0) reversals++;
            streak = 1;
          }
          if (streak > longestRun) longestRun = streak;
        } else {
          streak = 0;
        }
        lastDx = dx;
        lastDy = dy;

        // ── How long each retreat lasts ────────────────────────────────────
        // The judgement on the narrowed `flee` is an *interval*, not a ceiling:
        // a latch that never releases and a latch that chatters are both
        // failures, and the entry count alone cannot tell them from a handful
        // of real retreats. So record the spans themselves.
        if (decision.intent === "flee") fleeStreak++;
        else if (fleeStreak > 0) {
          fleeSpans.push(fleeStreak);
          fleeStreak = 0;
        }

        // ── The circling tally ─────────────────────────────────────────────
        {
          const px = run.player.posX;
          const py = run.player.posY;
          // `dangerCentre`, recomputed the way the policy computes it. The
          // reveal test is `perceive`'s, and an unrevealed monster carries
          // `PRIOR_DPS` — get either wrong and this measures a reference the
          // robot never had.
          let dw = 0;
          let dsx = 0;
          let dsy = 0;
          for (const m of run.monsters) {
            const d = Math.hypot(m.posX - px, m.posY - py);
            if (d > robot.ROBOT.DISENGAGE_RADIUS) continue;
            const dps = d <= m.senseRange ? m.attackPower * m.attackSpeed : robot.ROBOT.PRIOR_DPS;
            if (dps <= 0) continue;
            dw += dps;
            dsx += m.posX * dps;
            dsy += m.posY * dps;
          }
          if (dw > 0) {
            const bearing = Math.atan2(py - dsy / dw, px - dsx / dw);
            orbFrames++;
            orbRadiusSum += Math.hypot(px - dsx / dw, py - dsy / dw);
            if (lastBearing !== null) {
              const d = wrapPi(bearing - lastBearing);
              orbAbs += Math.abs(d);
              orbNet += d;
            }
            lastBearing = bearing;
          } else {
            // No reference at all: a gap in the series, not a zero in it. A
            // difference across one would be measured against a centroid that
            // does not exist.
            lastBearing = null;
          }
          const hx = decision.input.dx;
          const hy = decision.input.dy;
          if (hx !== 0 || hy !== 0) {
            const heading = Math.atan2(hy, hx);
            if (lastHeading !== null) {
              const d = wrapPi(heading - lastHeading);
              turnAbs += Math.abs(d);
              turnNet += d;
            }
            lastHeading = heading;
          } else {
            // Idle is not a heading, and the turn across one is not a turn the
            // robot made.
            lastHeading = null;
          }
        }

        sim.stepSim(run, decision.input, DT);
        if (run.kills > killsBefore) {
          const n = run.kills - killsBefore;
          awareKills[aware] += n;
          closeKills[clos] += n;
        }

        if (inReach && run.alive) {
          const after = run.monsters.find((m) => m.id === id);
          if (after) {
            contact++;
            const d = Math.hypot(after.posX - run.player.posX, after.posY - run.player.posY);
            if (d > near.d + 0.05) escaped++;
          }
        }
      }
      if (fleeStreak > 0) fleeSpans.push(fleeStreak);
      // ── Where it died ──────────────────────────────────────────────────────
      // The user's report has now survived three rounds of frame-share metrics,
      // and the reason is visible in this file: every wall statistic above is a
      // *share of frames*, and a robot can spend 59% of its life near a wall
      // without ever being trapped — while dying in a corner every single run.
      // "贴着边界走" is a complaint about the *end*, so measure the end.
      //
      // `surround` is `1 - |mean unit vector to the chasers|`: 0.0 means they are
      // all on one side (a wall of them, but somewhere to run), 1.0 means ringed.
      // It is the quantity that actually distinguishes "pinned against a wall
      // with an escape lane" from "boxed in", and nothing else here sees it.
      const dEdge = Math.min(
        run.player.posX,
        run.width - run.player.posX,
        run.player.posY,
        run.height - run.player.posY,
      );
      let dSx = 0;
      let dSy = 0;
      let dSense = 0;
      let dReach = 0;
      for (const m of run.monsters) {
        const dm = Math.hypot(m.posX - run.player.posX, m.posY - run.player.posY);
        if (dm <= m.senseRange) {
          dSense++;
          dSx += (m.posX - run.player.posX) / (dm || 1);
          dSy += (m.posY - run.player.posY) / (dm || 1);
        }
        if (dm <= m.attackRange) dReach++;
      }
      const deathSurround = dSense ? 1 - Math.hypot(dSx, dSy) / dSense : 0;
      // A corner is both axes inside the wall band — the place the user names.
      const deathCorner =
        Math.min(run.player.posX, run.width - run.player.posX) <= NEAR_WALL &&
        Math.min(run.player.posY, run.height - run.player.posY) <= NEAR_WALL;

      // The spatial prediction, in one number: of the monsters still alive, how
      // many are standing in the region they spawned in? With no leash and no
      // way home, this is expected to decay over a run — the arena's 3×3 stops
      // being a set of basins and becomes a spawn-rate table.
      let homed = 0;
      for (const m of run.monsters) {
        if (sim.regionIndexAtPoint(run.width, run.height, m.posX, m.posY) === m.region) homed++;
      }

      rows.push({
        seed,
        ratio: run.time / idleRun.time,
        capped: run.time >= CAP,
        time: run.time,
        // The ratio's denominator. A change to the *world* — spawn point,
        // monster density, arena — moves the control too, so a ratio can rise
        // while the robot's own seconds fall. §14.5 requires the two arms of a
        // comparison to share a world; printing both sides raw is what makes
        // that checkable instead of assumed.
        idleTime: idleRun.time,
        kills: run.kills,
        pickups: Object.values(run.pickups).reduce((a, b) => a + b, 0),
        frames,
        idleFrames,
        dEdge,
        deathCorner,
        deathSurround,
        dSense,
        dReach,
        contact,
        escaped,
        aggroBreaks,
        retreatEntries,
        longestRun,
        reversals,
        fleeSpans,
        crowdMean: frames ? crowdSum / frames : 0,
        crowdPeak,
        awareFrames,
        awareKills,
        closeFrames,
        closeKills,
        nearWallFrames,
        edgeMean: frames ? edgeSum / frames : 0,
        nearWallMoving,
        nearWallOutward,
        nearWallTangential,
        nearWallRadialSum,
        openMoving,
        openRadialSum,
        nearIntents,
        openIntents,
        zoneFrames,
        zoneLate,
        lateFrames,
        bucketFrames,
        bucketNear,
        bucketEdge,
        alive: run.monsters.length,
        homed,
        intents,
        orbitAbs: orbAbs,
        orbitNet: orbNet,
        orbitFrames: orbFrames,
        orbitRadiusSum: orbRadiusSum,
        turnAbs,
        turnNet,
      });
    }

    return { rows, applied, seeds: seedList.length, cap: CAP, dt: DT };
  }, [seeds, OVERRIDES, ZC, ZR, ZONES, BUCKETS, PACK_EDGES, CLOSE_RADIUS]);

  const { rows, applied, cap, dt } = data;

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const median = ratios[ratios.length >> 1];
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  // Lower decile rather than a quartile: the tail is what these constants are
  // for, and with 96 samples P10 is still four seeds wide.
  const p10 = ratios[Math.floor(0.1 * (ratios.length - 1))];
  const frames = sum((r) => r.frames);
  const contact = sum((r) => r.contact);
  const crowdMean = rows.reduce((a, r) => a + r.crowdMean, 0) / rows.length;
  const crowdPeak = Math.max(...rows.map((r) => r.crowdPeak));
  const alive = sum((r) => r.alive);
  const homed = sum((r) => r.homed);
  const intents = { flee: 0, heal: 0, loot: 0, kite: 0, roam: 0 };
  for (const r of rows) for (const k of Object.keys(intents)) intents[k] += r.intents[k];

  // Direction stability. Reported in seconds rather than frames because the
  // number it has to be compared against is the escape mechanic's ~3.9s.
  const asc = (a, b) => a - b;
  const runs = rows.map((r) => r.longestRun * dt).sort(asc);
  const revs = rows.map((r) => r.reversals).sort(asc);
  const spans = rows.flatMap((r) => r.fleeSpans).sort(asc);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const mid = (a) => (a.length ? a[a.length >> 1] : 0);
  const spanMean = avg(spans) * dt;
  const spanMedian = mid(spans) * dt;
  // The share of retreat frames that sit in a retreat *worth* having. A span
  // under half a second cannot open a gap on anything that is chasing, so it is
  // motion spent without buying distance — the chatter §14.2 records.
  const spanFrames = spans.reduce((a, b) => a + b, 0);
  const usefulSpans = spans.filter((s) => s * dt >= 0.5).reduce((a, b) => a + b, 0);

  console.log(
    `\n[ sweep ] robot vs idle control — ${rows.length} seeds, cap ${cap}s, dt 1/60`,
  );
  if (applied.length) console.log(`[ sweep ] ROBOT overrides: ${applied.join(" ")}`);
  console.log("");

  row("survival ratio  median", `${fixed(median)}x`);
  row("survival ratio  mean", `${fixed(mean)}x`);
  row("survival ratio  P10", `${fixed(p10)}x`);
  row("survival ratio  worst", `${fixed(ratios[0])}x`);
  row("survival ratio  best", `${fixed(ratios[ratios.length - 1])}x`);
  row("runs reaching the cap", `${rows.filter((r) => r.capped).length}/${rows.length}`);
  // Absolute seconds, both sides. The ratio alone cannot tell "the robot got
  // better" from "the control got worse" — see the `idleTime` note above.
  const robotSecs = rows.map((r) => r.time).sort(asc);
  const idleSecs = rows.map((r) => r.idleTime).sort(asc);
  row("robot survives  median", `${fixed(mid(robotSecs))}s`);
  row("robot survives  mean", `${fixed(avg(robotSecs))}s`);
  row("idle survives  median", `${fixed(mid(idleSecs))}s`);
  row("idle survives  mean", `${fixed(avg(idleSecs))}s`);
  row("kills (total)", sum((r) => r.kills));
  row("pickups (total)", sum((r) => r.pickups));
  console.log("");
  row("idle frames", `${pct(sum((r) => r.idleFrames) / frames)} of ${frames}`);
  row("contact frames", `${contact} (${pct(contact / frames)} of all)`);
  row("escape rate in contact", `${pct(contact ? sum((r) => r.escaped) / contact : 0)}`);
  // The other half of "did it get away", and the one the orbit spends. Read the
  // two together: `escape rate` can rise while this falls, because opening the
  // gap for one frame is not the same as carrying it clear of `senseRange`.
  row(
    "aggro breaks  total / per run",
    `${sum((r) => r.aggroBreaks)}  /  ${fixed(avg(rows.map((r) => r.aggroBreaks)), 2)}`,
  );
  row("retreat-latch entries", sum((r) => r.retreatEntries));
  console.log("");
  // ── Wall proximity — how much room does it keep to dodge in? ──────────────
  // Being near the edge is not itself a failure, but the user's report is that
  // the robot reaches it and then slides along it, which leaves no sideways
  // room. Read this with `escape rate`: if the near-wall share is high and the
  // escape rate is low, the wall is where it is dying.
  row("frames near a wall (<=70px)", `${pct(sum((r) => r.nearWallFrames) / frames)} of ${frames}`);
  // ...and the same figure per seed, median. The frame-weighted number above is
  // the honest answer to "what fraction of the robot's life is spent at a wall",
  // but it is *dominated by the longest runs*, so a single seed that survives
  // four times as long drowns the other thirty-one. That matters here: an
  // earlier grid showed near-wall falling 76.6% → 51.1% at exactly one weight,
  // on an arm whose kill count was 334 against ~50 everywhere else — one lucky
  // seed, not a behavioural change. Report both; trust the median for "did the
  // policy change", the weighted one for "how does a life look".
  row(
    "frames near a wall  median",
    `${pct(mid(rows.map((r) => (r.frames ? r.nearWallFrames / r.frames : 0)).sort(asc)))} per seed`,
  );
  row("mean clearance to nearest edge", `${fixed(avg(rows.map((r) => r.edgeMean)), 0)} px`);
  // ── Where it died — the metric the frame shares were standing in for ──────
  row(
    "death: distance to nearest edge",
    `median ${fixed(mid(rows.map((r) => r.dEdge)), 0)} px   mean ${fixed(avg(rows.map((r) => r.dEdge)), 0)} px`,
  );
  row("death: inside the wall band", `${pct(rows.filter((r) => r.dEdge <= NEAR_WALL).length / rows.length)} of runs`);
  row("death: in a corner", `${pct(rows.filter((r) => r.deathCorner).length / rows.length)} of runs`);
  row(
    "death: chaser angular coverage",
    `${fixed(mid(rows.map((r) => r.deathSurround)))} median  (1.0 ringed, 0.0 one side)`,
  );
  row(
    "death: chasers sensing / in reach",
    `${fixed(mid(rows.map((r) => r.dSense)), 1)}  /  ${fixed(mid(rows.map((r) => r.dReach)), 1)}`,
  );
  // ...and *why* it is there. `outward` is walking at the wall, `tangential` is
  // sliding along it, and the rest is leaving. A robot that ends up on the
  // boundary by sliding is a different problem from one that walks into it: the
  // second wants a stronger wall term, the first wants a reason to turn inward.
  {
    const nwMoving = sum((r) => r.nearWallMoving);
    const outward = sum((r) => r.nearWallOutward);
    const tangential = sum((r) => r.nearWallTangential);
    const inward = nwMoving - outward - tangential;
    row(
      "  near a wall, moving: which way",
      `outward ${pct(nwMoving ? outward / nwMoving : 0)}  tangential ${pct(
        nwMoving ? tangential / nwMoving : 0,
      )}  inward ${pct(nwMoving ? inward / nwMoving : 0)}`,
    );
    // Positive = away from the arena centre. This is the sign that says whether
    // the boundary is being *sought* (a goal pointing outward) or merely *ended
    // up at* (a slide that ran out of wall).
    row(
      "  mean radial component",
      `near wall ${fixed(nwMoving ? sum((r) => r.nearWallRadialSum) / nwMoving : 0)}   open ${fixed(
        sum((r) => r.openMoving) ? sum((r) => r.openRadialSum) / sum((r) => r.openMoving) : 0,
      )}`,
    );
    const bandIntents = (key) => {
      const t = { flee: 0, heal: 0, loot: 0, kite: 0, roam: 0 };
      for (const r of rows) for (const k of Object.keys(t)) t[k] += r[key][k];
      const total = Object.values(t).reduce((a, b) => a + b, 0) || 1;
      return Object.entries(t)
        .map(([k, v]) => `${k} ${pct(v / total)}`)
        .join(" ");
    };
    row("  intent near a wall", bandIntents("nearIntents"));
    row("  intent in the open", bandIntents("openIntents"));
    // The control for the spawn point: the player starts in the middle of the
    // arena, so anything measured over the whole run is partly measuring where
    // it woke up.
    const bFrames = BUCKETS.map((_, i) => sum((r) => r.bucketFrames[i]));
    const bNear = BUCKETS.map((_, i) => sum((r) => r.bucketNear[i]));
    const bEdge = BUCKETS.map((_, i) => sum((r) => r.bucketEdge[i]));
    let prev = 0;
    row(
      "  by run time: near-wall share",
      BUCKETS.map((b, i) => {
        const lo = prev;
        prev = b;
        const label = b === Infinity ? `${lo}s+` : `${lo}-${b}s`;
        return `${label} ${pct(bFrames[i] ? bNear[i] / bFrames[i] : 0)}`;
      }).join("   "),
    );
    row(
      "  by run time: mean clearance",
      BUCKETS.map((b, i) => {
        const label = b === Infinity ? "elsewhere" : `under ${b}s`;
        return `${fixed(bFrames[i] ? bEdge[i] / bFrames[i] : 0, 0)}px ${label}`;
      }).join("   "),
    );
    row("  frames in each bucket", bFrames.join(" / "));
  }
  console.log("");
  if (ZONES) {
    const zf = new Array(ZR * ZC).fill(0);
    for (const r of rows) for (let i = 0; i < zf.length; i++) zf[i] += r.zoneFrames[i];
    const zTotal = zf.reduce((a, b) => a + b, 0) || 1;
    console.log(`\n[ sweep ] share of frames by zone (${ZC}x${ZR}, top-left first)`);
    const max = Math.max(...zf);
    for (let r = 0; r < ZR; r++) {
      const cells = [];
      for (let c = 0; c < ZC; c++) {
        const v = zf[r * ZC + c] / zTotal;
        // A bar so the shape is readable at a glance and the numbers stay exact.
        const bar = "█".repeat(max ? Math.round((zf[r * ZC + c] / max) * 10) : 0);
        cells.push(`${pct(v).padStart(6)} ${bar.padEnd(10)}`);
      }
      console.log(`  ${cells.join(" ")}`);
    }
    // The same map for t >= 10s only. The player spawns at the centre of the
    // arena, so the map above is dominated by the first few seconds of every
    // run. This one is the closest thing to a policy preference.
    const zl = new Array(ZR * ZC).fill(0);
    for (const r of rows) for (let i = 0; i < zl.length; i++) zl[i] += r.zoneLate[i];
    const lTotal = zl.reduce((a, b) => a + b, 0) || 1;
    const lateFrames = sum((r) => r.lateFrames);
    console.log(
      `\n[ sweep ] same, after t=10s (${lateFrames} of ${frames} frames — the spawn has decayed)`,
    );
    const lmax = Math.max(...zl);
    for (let r = 0; r < ZR; r++) {
      const cells = [];
      for (let c = 0; c < ZC; c++) {
        const v = zl[r * ZC + c] / lTotal;
        const bar = "█".repeat(lmax ? Math.round((zl[r * ZC + c] / lmax) * 10) : 0);
        cells.push(`${pct(v).padStart(6)} ${bar.padEnd(10)}`);
      }
      console.log(`  ${cells.join(" ")}`);
    }
    console.log("");
  }
  // ── Direction stability — is the robot *going* anywhere? ──────────────────
  // The pair to watch together: a long straight run is what breaks aggro, and
  // reversals are what prevent it. Neither is visible in the survival ratio
  // when survival has collapsed into one long retreat.
  row("longest straight run  mean", `${fixed(avg(runs))}s`);
  row("longest straight run  median", `${fixed(mid(runs))}s`);
  row("longest straight run  best", `${fixed(runs[runs.length - 1] ?? 0)}s`);
  row("direction reversals  mean", `${fixed(avg(revs), 0)} per run`);
  row("direction reversals  median", `${fixed(mid(revs), 0)} per run`);
  row(
    "flee spans",
    `${spans.length}  mean ${fixed(spanMean)}s  median ${fixed(spanMedian)}s  longest ${fixed(
      (spans[spans.length - 1] ?? 0) * dt,
    )}s`,
  );
  row(
    "flee frames in spans >=0.5s",
    `${pct(spanFrames ? usefulSpans / spanFrames : 0)} of ${spanFrames}`,
  );
  // ── Is it circling? ──────────────────────────────────────────────────────
  // The pair that answers the user's ask directly. Consistency is per seed,
  // then aggregated; the rates are in degrees per second, so a full lap is 360.
  {
    const DEG = 180 / Math.PI;
    const cons = (r) => (r.orbitAbs > 1e-9 ? Math.abs(r.orbitNet) / r.orbitAbs : 0);
    const hcons = (r) => (r.turnAbs > 1e-9 ? Math.abs(r.turnNet) / r.turnAbs : 0);
    const secs = (r) => r.frames * dt || 1;
    const orbCons = rows.map(cons).sort(asc);
    const turnCons = rows.map(hcons).sort(asc);
    const orbRate = rows.map((r) => (Math.abs(r.orbitNet) / secs(r)) * DEG).sort(asc);
    const turnRate = rows.map((r) => (Math.abs(r.turnNet) / secs(r)) * DEG).sort(asc);
    const radii = rows.map((r) => (r.orbitFrames ? r.orbitRadiusSum / r.orbitFrames : 0)).sort(asc);
    const cover = rows.map((r) => (r.frames ? r.orbitFrames / r.frames : 0)).sort(asc);
    row(
      "circling: bearing consistency",
      `${fixed(mid(orbCons))}  mean ${fixed(avg(orbCons))}  (1.0 orbits, 0.0 dithers)`,
    );
    row("circling: bearing sweep", `${fixed(mid(orbRate), 0)} deg/s  median`);
    row("circling: heading consistency", `${fixed(mid(turnCons))}  mean ${fixed(avg(turnCons))}`);
    row("circling: heading turn", `${fixed(mid(turnRate), 0)} deg/s  median`);
    row(
      "circling: mean radius",
      `${fixed(mid(radii), 0)} px  (a reference exists on ${pct(mid(cover))} of frames)`,
    );
  }
  console.log("");
  row("monsters aware of player  mean", `${fixed(crowdMean)}`);
  row("monsters aware of player  peak", `${crowdPeak}`);
  // The distribution behind that mean, with kills attributed to the same read.
  // Report both a share of frames and a rate, because they answer different
  // halves of the question: the share says how often the robot is *in* the
  // one-to-four situation, the rate says whether it converts it. A pack it can
  // farm and a pack it merely survives look identical in the frame count alone.
  {
    const block = (name, framesKey, killsKey) => {
      const aFrames = packLabels.map((_, i) => sum((r) => r[framesKey][i]));
      const aKills = packLabels.map((_, i) => sum((r) => r[killsKey][i]));
      const aTotal = aFrames.reduce((a, b) => a + b, 0);
      row(
        `${name}  frames`,
        packLabels.map((l, i) => `${l}:${pct(aTotal ? aFrames[i] / aTotal : 0)}`).join("  "),
      );
      row(`${name}  kills`, packLabels.map((l, i) => `${l}:${aKills[i]}`).join("  "));
      // Kills per 1000 frames spent in the bucket — the conversion rate, on the
      // same scale for every bucket regardless of how much time each one gets.
      row(
        `${name}  kills/1k frames`,
        packLabels
          .map((l, i) => `${l}:${fixed(aFrames[i] ? (aKills[i] / aFrames[i]) * 1000 : 0, 1)}`)
          .join("  "),
      );
    };
    block("pack aware", "awareFrames", "awareKills");
    block("pack close", "closeFrames", "closeKills");
  }
  row("alive at end (per run avg)", `${fixed(alive / rows.length, 1)}`);
  row("of those, standing in home region", `${pct(alive ? homed / alive : 0)}`);
  console.log("");
  row(
    "intent share",
    Object.entries(intents)
      .map(([k, v]) => `${k} ${pct(v / frames)}`)
      .join("  "),
  );

  if (VERBOSE) {
    console.log(
      "\n  seed        ratio   time   kills  pickups  idle%   contact  escape%  crowd  homed" +
        "   run(s)  revs  flees  orbitAbs  orbitNet  refFrames",
    );
    for (const r of rows) {
      console.log(
        `  ${String(r.seed).padEnd(10)}` +
          `${fixed(r.ratio).padStart(6)}x` +
          `${fixed(r.time, 0).padStart(7)}` +
          `${String(r.kills).padStart(8)}` +
          `${String(r.pickups).padStart(9)}` +
          `${pct(r.idleFrames / r.frames).padStart(8)}` +
          `${String(r.contact).padStart(9)}` +
          `${pct(r.contact ? r.escaped / r.contact : 0).padStart(9)}` +
          `${fixed(r.crowdMean).padStart(7)}` +
          `${pct(r.alive ? r.homed / r.alive : 0).padStart(7)}` +
          `${fixed(r.longestRun * dt).padStart(9)}` +
          `${String(r.reversals).padStart(6)}` +
          `${String(r.fleeSpans.length).padStart(7)}` +
          `${fixed(r.orbitAbs, 1).padStart(9)}` +
          `${fixed(r.orbitNet, 1).padStart(9)}` +
          `${String(r.orbitFrames).padStart(11)}`,
      );
    }
  }

  console.log("");
  await browser.close();
}

const server = await ensureServer();
try {
  await run();
} finally {
  stopServer(server);
}
