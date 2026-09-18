// The auto-play robot (design §14). Requirement 4 gives it what the canvas
// paints and nothing else; requirement 5 hands it the rest of a monster's
// numbers only once the player is inside that monster's sense circle.
//
// Two pure functions and a tuning table, in the same shape as `sim.ts` and
// `keymap.ts`: no Phaser, no DOM, no clock, no randomness. `decide` is a pure
// function of the view, so the same frame always yields the same move and a
// test can pin a whole trajectory without a browser in the loop.
//
// **The fog is the module boundary, not a convention.** This file never imports
// `MONSTER_ARCHETYPES`, and `PerceivedMonster` has no field for a hidden stat —
// so there is no way to write the cheat by accident. A monster's numbers reach
// the policy only through `RevealedStats`, which `perceive` fills in only while
// the player is inside that monster's `senseRange`. `MONSTER_ARCHETYPES` is
// deliberately public in `sim.ts`; the enforcement lives here, in what this
// module is willing to look at.

import { bombLanding, TUNING, type SimState } from "./sim";
import type {
  Dir,
  ItemKind,
  ItemStats,
  MonsterKind,
  MoveInput,
  PlayerStats,
} from "./types";

// ── Perception (design §14.1, requirements 4 and 5) ─────────────────────────

/** What contact buys: the four fields requirement 5 names, and no others. */
export interface RevealedStats {
  attackPower: number;
  attackSpeed: number;
  attackRange: number;
  moveSpeed: number;
}

/**
 * A monster as the robot sees it.
 *
 * Everything outside `stats` is public (design §10.3): the body, the dotted
 * sense ring, the damage bar and the region borders are all painted on the
 * canvas, so a human reads them off the screen. `kind` is public by the same
 * argument — the silhouette and colour are drawn — but the policy deliberately
 * does not look up per-kind numbers from it. See `PRIOR_DPS`.
 */
export interface PerceivedMonster {
  id: number;
  kind: MonsterKind;
  posX: number;
  posY: number;
  dir: Dir;
  /** `m_range`. Public: it is the ring drawn around the monster. */
  senseRange: number;
  /** Public: the damage bar. */
  hpFrac: number;
  /** Non-null **exactly** while the player is inside `senseRange`. */
  stats: RevealedStats | null;
}

/**
 * Ground that is about to hurt, with nothing standing on it (design §15).
 *
 * Today that means exactly one thing — where a thrown bomb will land — and it
 * is deliberately *not* a `Threat`. A `Threat` is a monster: something that can
 * be farmed, fled from, chased, and counted as revealed or not. A bomb is none
 * of those, and folding the two together would put it in the farming pool, where
 * the robot would walk to a bomb in order to attack it.
 *
 * Modelled as a plain static patch, because that is what the canvas shows: a
 * reticle on the ground for as long as the bomb is in the air, and nothing about
 * *when* it goes off. Nothing is lost by leaving the fuse out — the patch exists
 * for exactly the window in which it is dangerous, and the robot reading it as
 * "do not stand here, now" is precisely what a human does with the same picture.
 *
 * **Bullets are deliberately not hazards**, and the asymmetry is the point of
 * this interface rather than a gap in it. A 280px/s shot crosses a hunter's 26px
 * reach in 0.09s, which is under human reaction time, so a robot that dodged
 * them would be playing from information no player has and would be pretending
 * to a skill nobody watching could reproduce. Ignoring them is the honest model
 * — and it is also why the *bomb* is the slow shot in the first place: a
 * constant fuse is a constant warning, and only a slow attacker needs one.
 */
export interface Hazard {
  x: number;
  y: number;
  /**
   * How close the player's *centre* may come before the blast lands on them:
   * `blast` plus the player's own body, which is the exact test `sim.ts`
   * applies — the same "two bodies touching" rule potions are collected under
   * (§8.4). Wider than the painted reticle by the player's radius, and it has to
   * be: the reticle is the explosion, and the robot is not a point.
   */
  reach: number;
  /** What it deals to whoever is still standing there when it lands. */
  damage: number;
}

/**
 * One frame of what the robot knows.
 *
 * Holds no clock and no previous frame: requirement 5's reveal is *not*
 * remembered, so the whole of the robot's knowledge is rebuilt from the sim
 * every frame. That is what keeps `decide` a pure function of its argument.
 */
export interface RobotView {
  width: number;
  height: number;
  /** The robot's own stats — it is the player, so it knows these exactly. */
  player: PlayerStats;
  monsters: PerceivedMonster[];
  /** Potion kind, position and remaining life. The flicker is a tell (§10.3). */
  items: ItemStats[];
  /** Bombs in the air, as the ground they are about to hit (design §15). */
  hazards: Hazard[];
}

/** What the robot decided to do, for the HUD and for the tests. */
export type RobotIntent = "flee" | "heal" | "loot" | "kite" | "roam";

/**
 * Project the sim down to the robot's view.
 *
 * The one rule that matters is the `stats` line: non-null exactly when the
 * player is inside this monster's sense circle, recomputed every frame and
 * never cached. Stepping in reveals; stepping out hides again.
 */
export function perceive(sim: SimState): RobotView {
  const p = sim.player;
  const monsters: PerceivedMonster[] = sim.monsters.map((m) => {
    const near = Math.hypot(m.posX - p.posX, m.posY - p.posY) <= m.senseRange;
    return {
      id: m.id,
      kind: m.kind,
      posX: m.posX,
      posY: m.posY,
      dir: m.dir,
      senseRange: m.senseRange,
      hpFrac: m.maxHp > 0 ? m.hp / m.maxHp : 0,
      stats: near
        ? {
            attackPower: m.attackPower,
            attackSpeed: m.attackSpeed,
            attackRange: m.attackRange,
            moveSpeed: m.moveSpeed,
          }
        : null,
    };
  });

  return {
    width: sim.width,
    height: sim.height,
    player: { ...p },
    monsters,
    // Items are copied for the same reason the player is: the view must not
    // alias live sim state, or a caller could reach back through it.
    items: sim.items.map((it) => ({ ...it })),
    // Bombs become the ground they are aimed at, and bullets are left out
    // entirely — see `BOMB_WEIGHT` for why that asymmetry is the honest one.
    //
    // The composition of `reach` is where the one new import in this file comes
    // from. `TUNING.playerRadius` is the robot's *own body*, and this module
    // knows its own stats by definition; the fog this file enforces is about
    // *monsters*, whose numbers live in `MONSTER_ARCHETYPES` and are still not
    // imported here or reachable from anything the view carries.
    hazards: sim.projectiles
      .filter((b) => b.kind === "bomb")
      .map((b) => {
        const at = bombLanding(b);
        return { x: at.x, y: at.y, reach: b.blast + TUNING.playerRadius, damage: b.damage };
      }),
  };
}

// ── Tuning (design §11) ─────────────────────────────────────────────────────

export const ROBOT = {
  /**
   * Target selection: how far apart two monsters can be and still count as one
   * cluster, what each extra neighbour is worth, and the distance that costs a
   * point of the same scale.
   *
   * The score is `pack × CLUSTER_WEIGHT − dist / CLUSTER_DIST`, so it trades
   * company against walking. With the shipped numbers a lone monster 60px away
   * scores −0.5 and a knot of five at 250px scores +0.4, i.e. it will walk past
   * a straggler to set up on a group. That is the user's "附近聚集起来最多的那
   * 群" and it is also the better farm: the ring tactic fights whatever comes
   * into range, and a group that walks to you in single file is more kills per
   * unit of walking.
   *
   * See `pickTarget` for the reachability filter that runs ahead of this.
   */
  CLUSTER_RADIUS: 120,
  CLUSTER_WEIGHT: 0.5,
  CLUSTER_DIST: 120,

  /**
   * Lookahead horizon, in seconds: how far ahead a candidate step is judged.
   * The robot re-decides every frame, so this is not its step size — it is the
   * reach of its consequences, and it wants to be comparable to the distance a
   * monster covers while closing.
   */
  PROBE_S: 0.25,

  /**
   * What an un-revealed monster is assumed to be.
   *
   * This is the load-bearing choice in the whole fog design. Requirement 5
   * exists so that contact *buys* something, which only happens if ignorance is
   * actually costly — so the prior cannot be the average monster, and it
   * certainly cannot be the weakest one. Assuming a pushover walks the robot
   * into brutes; assuming the worst means it never engages and starves. A
   * hunter is the middle archetype and the one most likely to be closing on
   * you, so the robot treats every stranger as one until it can look.
   */
  PRIOR_DPS: 9.6, // hunter: 8 attackPower × 1.2 attackSpeed
  PRIOR_REACH: 26, // hunter
  /** ...and it assumes a hunter's speed when judging whether it can disengage. */
  PRIOR_SPEED: 120,

  /**
   * Scale of the risk field, in multiples of the damage a monster actually
   * deals.
   *
   * The exchange rate between "standing where something is hunting me" and
   * "walking toward what I want" — and it is load-bearing, because everything
   * else that competes with it (the goal weights, the wall penalty) is fixed.
   * Too high and the robot refuses to engage and starves; too low and it walks
   * into piles. Measured over 48 seeds, survival climbs monotonically with it up
   * to about 3, where it flattens: the median robot then outlives a stationary
   * one by ~7×, and — since a bigger field means more kiting, not less — it
   * lands *more* kills, not fewer. Every other constant here is cosmetic next to
   * this one.
   */
  CHASE: 3,

  /**
   * Exponent of the proximity curve outside a monster's reach. Below 1 so the
   * curve is convex: it holds its value and drops late, rather than pricing the
   * midpoint between reach and notice as nearly free.
   */
  FALLOFF: 0.4,
  /**
   * How much worse standing on top of a monster is than standing at the edge of
   * its reach. The inside-reach branch runs from `1` at `reach` to `1 + PROX` at
   * zero distance, so the field keeps a gradient even once the robot is being
   * hit — without which there is nothing to escape along.
   */
  PROX: 1,

  /**
   * What a bomb's damage is worth in the risk field, per point of it.
   *
   * 1 means "a bomb reads as its own damage", which is the honest unit: the
   * field's scale is `dps × CHASE × proximity`, and a bomb's damage is the one
   * number the canvas does not show but the *effect* does — it is thrown by a
   * brute the robot can see, at a reticle it can see, and paying the full hit is
   * what stepping into that reticle actually costs. With a brute's 18 that is 54
   * at the edge of the circle and 108 dead centre, against 28.8 for a hunter at
   * the edge of its reach.
   *
   * **In the pure case this number is inert, and that is the clamp's doing, not
   * an oversight.** Every candidate delta is clamped to `RISK_CAP`, so anything
   * over ~4 per unit of proximity saturates: 1 and 20 produce byte-identical
   * decisions for a robot standing in a bomb with nothing else around, and the
   * robot leaves the circle either way. Where it stops being inert is the case
   * that matters — an escape route that runs into something else. Step out of
   * the blast into a hunter's reach and the raw delta is `28.8 − 54`, still a
   * reward; at 0.2 it would be `28.8 − 10.8`, a penalty, and the robot would
   * stand in the bomb rather than take the hunter. So the knob is live exactly
   * where the field has to arbitrate, and flat where it does not.
   *
   * **Measured, and it turns out to be inert at fleet scale too.** Over the
   * 96-seed sweep (design §14.5), 0 / 1 / 20 are the same run: median 6.49x,
   * mean 6.57x, worst 3.56x and 96/96 reaching the cap in all three arms, with
   * kills 23020 / 23002 / 23096, idle frames 55.7 / 55.9 / 56.0% and escapes
   * 66 / 66 / 67%. So bombs are **not** the anti-idleness tool §14.6 hoped for
   * — that defect is the region-border step, and no hazard term touches it.
   * The term earns its place as correctness rather than as a fix: a human can
   * read the reticle and step out, so a robot that ignored it would be playing
   * a different, blinder game than the one the canvas is showing.
   */
  BOMB_WEIGHT: 1,

  /**
   * The goal-directive weight per intent.
   *
   * **Every one of these is below `RISK_CAP` 12, and that is a live tension
   * rather than a design.** A saturated risk delta — which a crowded field
   * produces routinely now that the leash is gone (§6.2) — can therefore
   * outvote any of them, so "risk steers, never vetoes" (this file's own words,
   * and the comment on `RISK_CAP`) is not actually true of any rung here. This
   * tension *is* the dithering §14.6 records: the risk term swings ±12 against
   * a goal credit of ~7, and `HYST` is what has to bridge the difference.
   *
   * `flee` used to be the exception at 14, and 6 is what replaced it. That was
   * measured in the leashed world; since the leash removal changed this whole
   * table's operating point it was **re-measured here**, 96 seeds, flee = 6 /
   * 8 / 10 / 14 → worst seed 1.25× / 0.96× / 0.71× / 1.06×. The medians are
   * flat (2.48 / 2.49 / 2.48 / 2.12) and 8 actually kills more (258 against
   * 175), so the decision is made on the tail alone: only 6 keeps *every* seed
   * above standing still, and a 0.71× worst seed is a robot that dies sooner
   * than not playing at all. The tail is what this knob is for.
   *
   * There is no longer any rung that deliberately clears the cap. The one that
   * did — `KITE_CONTACT_WEIGHT` — was deleted: the latch's entry condition
   * became the same `nearest.dist <= nearest.reach` test, which made the arm
   * that read it unreachable (see the `weight` note in `decide`).
   */
  GOAL: { flee: 6, heal: 9, loot: 6, kite: 6, roam: 6 } as const,

  /** Extra clearance beyond the target's reach when picking the standoff ring. */
  BAND: 8,
  /**
   * How far *inside* the player's own reach the standoff ring is set.
   *
   * Requirement: hold the target just inside our own `attackRange` — close
   * enough that the auto-attack (§5.1) lands, far enough that the ring is
   * plainly outside the target's reach. With `attackRange` 55 this puts the
   * ring at 51, against a longest monster reach of 34 (a brute).
   *
   * The floor is `reach + BAND`, so a hypothetical monster whose reach
   * approached our own would push the ring *outward* — the safe direction to
   * fail — rather than letting the clamp plant the robot inside its reach.
   */
  STANDOFF_MARGIN: 4,
  /**
   * How much of a disengagement goal is a tangential (orbiting) bias rather
   * than a radial correction. Without it the robot walks straight backwards
   * until a wall stops it; with it, it circles the target instead.
   *
   * **Both** rungs that disengage read a knob of this shape — `kite` reads
   * this one, `flee` reads `FLEE_ORBIT`, and the two values differ (0.6 and
   * 1.2) for the reason recorded there. That `flee` was originally the one
   * rung without any tangential term is what still walked the robot into
   * corners after the spawn and room-weight repairs, and the mechanism is the
   * radial term's *shape*, not its size: `kite`'s vanishes at the standoff ring
   * so the orbit takes over there, while `flee`'s never vanishes, which makes
   * "away from the danger" a gradient flow whose only attractor in a bounded
   * arena is the boundary — and the wall-slide then projects what is left of it
   * *along* the wall, one-dimensionally, into a corner. See §14.6.
   *
   * The tangential half is also the correct dodge in this combat system rather
   * than merely the prettier one (§7): bullets aim where the player stood, so
   * over the 0.182s flight to the 51px ring a 160px/s player travels 29.1px
   * across the firing line against an 11.5px hit threshold, while retreating
   * *along* that line stays on it and is overtaken by 120px/s of closing speed.
   */
  ORBIT: 0.6,

  /**
   * The same knob for `flee`, and it is a separate one because the two rungs
   * cannot share a value.
   *
   * `kite`'s orbit is bounded above by its radial term: while the target is
   * landing blows the radial must outrank the orbit, or the robot circles a
   * monster it is being hit by — the defect §14.2 records at length, measured
   * at 72% of contact frames when the radial was the weaker half. That caps
   * `kite` below 1.0 and puts the shipped 0.6 where it is.
   *
   * `flee` has no such bound, and it wants much more. Measured over 96 seeds,
   * raising the *shared* knob moved every wall statistic: near-wall frames
   * 63.1% (shipped) → 60.5% → 47.5% at 1.2, clearance 82 → 85 → 96px, and the
   * near-wall share by run time — 51.9 / 63.5 / 75.8 / 100% at 0.6 — flattened
   * to 44.5 / 44.4 / 51.0 / 54.8%, which is the user's complaint actually
   * going away rather than merely shrinking. Survival rose with it, 14.13 →
   * 17.95s median.
   *
   * **But that grid cannot say which half of the change did the work**, and
   * this is why the constant is split rather than re-valued: raising the orbit
   * also raises the goal's *magnitude*, `hypot(1, orbit)`, so 1.2 is
   * `flee`'s goal at 1.56 against 1.17 — a 34% stronger intent, which is what
   * `GOAL.flee` would have bought too. The two arms that separate them:
   * `GOAL.flee` 8 at `FLEE_ORBIT` 0.6 (matched goal strength, 6 × 1.562 ≈
   * 8 × 1.166) buys **nothing** — near-wall 61.6%, clearance 83px, survival
   * 14.52s, all at or below the 0.6 baseline — while `FLEE_ORBIT` 1.2 at an
   * unchanged `GOAL.flee` 6 reaches 57.9% / 90px / 16.77s. **The orbit is
   * doing the work, not the magnitude.** The shared-knob grid's larger win was
   * mostly `kite`, which the kite-only arm confirms (§14.6).
   *
   * The grid for *this* constant, all 96 seeds, `GOAL.flee` held at 6:
   *
   * | `FLEE_ORBIT` | near-wall | clearance | 5-15s | 15-30s | 30s+ | survives | bearing cons. |
   * |---|---|---|---|---|---|---|---|
   * | 0.0 (pure radial) | 58.6% | 82px | 63.5% | 75.8% | 100.0% | 14.13s | 0.11 |
   * | 0.6 | 60.4% | 83px | 66.9% | 67.4% | 64.4% | 13.60s | 0.11 |
   * | 0.9 | 60.2% | 83px | 64.8% | 64.8% | 63.4% | 16.68s | 0.13 |
   * | **1.2 (shipped)** | **57.9%** | **90px** | **58.7%** | **61.4%** | 73.3% | 16.77s | **0.17** |
   * | 1.5 | 56.5% | 91px | 57.7% | 65.9% | 72.8% | 17.07s | 0.14 |
   *
   * 1.2 is the knee and the peak of the chirality criterion, which is the one
   * §14.2 nominates as primary. On outcomes alone the surface between 0.9 and
   * 1.2 is nearly flat, and 0.9 holds the flatter 30s+ bucket; past 1.2 the
   * trend turns — consistency *falls* to 0.14 and reversals rise to 22, which
   * is overshoot rather than more circling. The 30s+ column is the weakest
   * number here and the smallest sample (roughly the top of the survival
   * distribution), which is why it does not overrule the rest, but it is the
   * one to watch if a later change pushes runs longer.
   *
   * A threshold argument from statics says stop at 0.6: `hypot(1, f)` divides
   * the outward speed, so 160/hypot(1, 0.9) = 119px/s already sits under the
   * hunter's 120px/s and §14.5's ~3.9s escape at a 40px/s closing difference
   * becomes *never*. It was measured, and it is **wrong about this sim**:
   * aggro breaks per run go 17.1 → 17.3 → 21.2 → 21.7 across 0.0 → 0.6 → 0.9 →
   * 1.2, i.e. *up*, and are flat per second of life. Monsters do not run a
   * clean straight-line chase — they move at `wanderSpeedScale` with
   * 8-direction snapping and stop at `attackRange × 0.7` (§6.2) — so the break
   * is dominated by lateral geometry rather than by net straight-line gain.
   * The static model is recorded only so the next reader does not re-derive it
   * and act on it.
   */
  FLEE_ORBIT: 1.2,

  /** A potion further away than this is not worth the walk. */
  LOOT_RANGE: 320,
  /** Below this score a potion is not worth diverting for. */
  LOOT_SCORE: 0.35,
  /** hp fraction below which a heal outranks every other potion. */
  HEAL_HP: 0.62,
  /** hp fraction below which the robot disengages entirely. */
  FLEE_HP: 0.35,
  /**
   * Ceiling on the risk term's contribution to a candidate's score.
   *
   * The risk term is a *delta*, and a delta is unbounded at a cliff edge — which
   * a region border is. Crossing into a populated region switches several
   * monsters on at once, so the delta there ran to ~55 against a goal credit of
   * at most 8.5, and the term stopped steering and started vetoing: the robot
   * stood still for up to 73 seconds at a stretch, at full health, 120px from
   * any wall, scoring nothing. Measured with the bound absent, 264 of 369 long
   * idle stretches posted zero kills, nearly all of them parked at the same spot
   * just inside a border.
   *
   * **What the bound buys, re-measured on the ballistics build (§15), 96 seeds.**
   * Against an effectively absent bound (1000): survival is *identical* — median
   * 6.49x, mean 6.57x, worst 3.56x, 96/96 seeds reaching the 10-minute cap in
   * both arms — and so are kills (23002 against 22992, 0.04% apart) and idle
   * frames (55.9% against 54.7%). The one axis this constant clearly owns is the
   * **escape rate: 66% against 37%.** Of the frames where a monster is inside its
   * own reach, the capped robot opens the gap two times in three; the uncapped
   * one, whose risk term saturates and vetoes every candidate, mostly does not.
   * That is the user's own report ("怪物冲到player面前了，player没有跑"), and it is a
   * better reason for this constant than anything recorded here before.
   *
   * A set of figures recorded at this spot earlier no longer reproduces and is
   * withdrawn: a large kill swing (23345 → 11738 per 48 seeds), a trimmed idle
   * share (0.55 → 0.48 of frames), and a survival cost (cap 95/96 against 96/96,
   * worst case 1.78x). None of the four survives measurement now — the tail cost
   * in particular is gone entirely, both arms reaching the cap on 96/96 seeds
   * **with the same worst seed**. What the bound does *not* do is remove the
   * stalemate: §14.6 is still open, and at 12 the clamped risk still outweighs
   * `GOAL.flee` 6.
   *
   * Raising it to 20 makes it inert (identical statistics to omitting it), and
   * that re-verified too — 35% escape against the uncapped 37%, kills and idle
   * within a percent of each other — so 12 is deliberately the value that still
   * does something.
   */
  RISK_CAP: 12,

  /**
   * `KITE_MAX_RISK` and `KITE_SAFE_RISK` are in the risk field's own units —
   * `dps × CHASE × proximity` — so they are **coupled to `CHASE`** and must be
   * re-tuned with it, not held fixed. The natural yardstick is one hunter at the
   * edge of its reach, which the default constants put at
   * `PRIOR_DPS × CHASE` = 28.8. A brute reads 32.4 at its reach and 64.8 at zero
   * distance.
   */

  /**
   * Risk above which the robot will not detour for a potion.
   *
   * Requirement: a fight that costs more than it returns is not worth walking
   * into for loot. Deliberately low — under a third of a hunter's reach-risk —
   * because the loot rung otherwise outranks the standoff and can drag the robot
   * *toward* whatever is hitting it, chasing a potion. Measured over 48 seeds,
   * tolerating more risk here does not make the robot braver so much as lazier:
   * every step up costs kills (9905 → 4200) and doubles its idling, because a
   * robot that tolerates more risk spends the difference standing still rather
   * than farming. Retreating early and often is what both survives *and* scores
   * here, which is not the trade intuition expects.
   *
   * Note this gates only `power` / `agility` / `vitality`. `heal` is decided
   * above it, on purpose: a wounded robot must never be blocked from medicine by
   * a risk threshold — that was a separate, measured dead-code bug.
   */
  KITE_MAX_RISK: 9,
  /**
   * Risk below which a retreat is considered over.
   *
   * The second of the latch's two exits; `FLEE_RELEASE_DIST` is the first and
   * the one that fires in practice. Measured: a hunter raises risk to 9.6
   * inside its reach and drops it to 2.9 thirty pixels out, so a bang-bang
   * controller turns around every half second and never covers the ground to
   * anywhere safer — which is why a retreat is latched at all rather than
   * re-decided each frame.
   *
   * **This used to be the *only* exit, and that was §14.6's absorbing latch.**
   * `hereRisk` is a sum over every aware monster, so the exit contour sits at
   * roughly "every aware monster at the edge of its sense range" — a radius
   * that grows with the crowd, in an arena where five to seven monsters are
   * aware at all times. See `FLEE_RELEASE_DIST`.
   *
   * What is left for it to do is the retreats contact cannot explain: a bomb
   * field the robot has already stepped out of, or a latch left over from a
   * fight that ended while it was running.
   */
  KITE_SAFE_RISK: 4.5,
  /**
   * Score bonus for repeating last frame's input, in the same units as the
   * goal weights.
   *
   * **This is the fix for the robot's vibration** — and it was found by
   * disbelieving the previous reading of this same comment. Every frame is
   * judged over a `PROBE_S` step of ~40px while the robot actually advances
   * ~2.8px, so it is forever committing to a long move, overshooting, and
   * committing to the reverse. What made that fatal rather than cosmetic is the
   * *magnitude* relationship the previous version of this comment missed: with
   * the region leash gone (§6.2) the risk field is high everywhere, so the risk
   * term's ±`RISK_CAP` 12 swing outbids the goal term (`GOAL.flee` 6 ×
   * |goal| 1.166 ≈ 7.0) on most candidates, and a saddle that moves every frame
   * flips adjacent directions with it. At 1.5 — 12% of a risk swing — the bonus
   * was far too small to hold a heading against that.
   *
   * Measured over 96 seeds, as the *total* commitment the robot feels: 3.5 (the
   * shipped 1.5 plus the 2 that used to sit in `MOVE_MARGIN`) → 90 reversals/run
   * and a longest unbroken straight run of 1.37s; **8 → 20 reversals/run,
   * longest run 2.95s**. The escape mechanic needs ~3.9s unbroken to break a
   * hunter's aggro, so at 3.5 the robot could not disengage at all — it was not
   * retreating, it was vibrating in place, which is what the user saw and
   * reported.
   *
   * The cost is real and measured: the escape rate in contact falls 66.1% →
   * 46.0%, because a robot that holds a heading reacts less often to a monster
   * that touches it. Survival and kills do not suffer (§14.6 carries both).
   *
   * Above this it over-commits: stability keeps improving (11 reversals at an
   * effective 10) but there the worst seed falls to 0.92× — a run that dies
   * *faster* than standing still. 8 is the knee, chosen for the worst case, not
   * the mean.
   *
   * That "effective" is doing real work here, and is the reason this constant
   * absorbed another one: it used to be 1.5, and a second constant
   * (`MOVE_MARGIN`, an extra tie-breaking margin for the previous direction)
   * sat on the same comparison. Both granted the previous direction a bonus in
   * these same score units, so the robot only ever felt their sum. Measured: 6
   * here with 2 there and 8 here with none produce *byte-identical* sweep
   * output across 96 seeds and all eight reported statistics. The reading above
   * is the sum, re-attributed to the one knob that was left.
   *
   * The pre-removal reading that "raising this *lengthens* the bad episodes"
   * (worst net-zero streak 747 → 1817 frames from 3 → 8) was measured in the
   * leashed world, where the field was low and the bad episodes were a
   * different phenomenon. It does not reproduce here: longest straight run
   * rises monotonically through 10.
   */
  HYST: 8,
  /**
   * How far the nearest threat must be before a retreat is considered over.
   *
   * The latch's exit, and the reason `flee` can end at all. The latch used to
   * be absorbing: with `KITE_SAFE_RISK` 4.5 as the only exit, and `hereRisk` a
   * *sum* over every aware monster, the exit contour sat at roughly "every
   * aware monster at the edge of its sense range", which in the unleased world
   * is nowhere. Measured then: 96 seeds produced **102 latch entries in
   * total** — about one unbroken retreat per run, median span 15.7s, longest
   * 49.1s, `flee` at 96.1% of all frames. It was not a rung any more, it was
   * the mode.
   *
   * 60 is chosen against the ring, not against the monsters: the kite holds
   * station at `attackRange − STANDOFF_MARGIN` = 51, which is *inside* 60, so
   * an ordinary farm never trips the release and a retreat that has opened real
   * distance always does. It also clears the widest `reach` (a brute's 34), so
   * a released robot is outside everything's blows.
   *
   * 60 rather than 70 because of the worst seed, which is the binding case:
   * over 48 seeds 70 gave a worst of 1.26× and 60 gave 1.41×, with kills 83 →
   * 88 and the escape rate 48.3% → 49.0%. Small, and all three move the same
   * way. With the release in place the latch is a real rung: 96 seeds now
   * produce 294 entries (≈3 per run), median span 2.15s, and 98.7% of all
   * `flee` frames sit in spans of at least 0.5s — so the chatter §14.2 warns
   * about has not come back.
   *
   * `hereRisk < KITE_SAFE_RISK` is kept as a second exit rather than replaced:
   * it is the only thing that can end a retreat from a threat that is not
   * closing (a bomb field, a stale latch), and it costs nothing to keep both.
   * The two are ORed — an earlier draft ANDed them, which made the positional
   * exit dead code in exactly the crowd it exists for.
   */
  FLEE_RELEASE_DIST: 60,
  /**
   * Deadband on the kite ring's radial error, in px.
   *
   * `err` saturates over `attackRange − desired` — **4px** as shipped — so
   * within four pixels of the ring the radial term swings the full 0→1 while
   * the orbit term holds at 0.6, which rotates the goal direction by ~59° in
   * less than two frames of travel. Since both bodies move 2–2.8px/frame,
   * `target.dist` crosses `desired` constantly and the rotation is continuous.
   * Inside the deadband the radial term is zero and the orbit decides alone,
   * which is a stable heading.
   *
   * Asymmetric on purpose, and the outer half is the one that matters: it must
   * stay *below* `STANDOFF_MARGIN`, because the ring sits that many pixels
   * inside our own attack range and a wider outer deadband would let the robot
   * settle outside its own 55px reach — orbiting a monster it never hits. That
   * failure has been measured here before; see the `desired` note.
   *
   * **Measured marginal, and recorded that way rather than as a win.** Over 96
   * seeds, 6 against 0: reversals 20 → 26/run, latch entries 294 → 354, and
   * *nothing else moves* — worst seed 1.25× both ways, escape rate 46.0% vs
   * 46.1%, longest run 2.95s vs 2.94s. So it does move the two things it was
   * built to move, by ~20%, and is otherwise free. It is no longer load-bearing
   * for stability: `HYST` 8 does that job, and the reversal count would still
   * be 26 without this.
   */
  KITE_ERR_DEADBAND: 6,
  /** The outer half of the kite deadband — see `KITE_ERR_DEADBAND`. */
  KITE_ERR_DEADBAND_OUT: 3,
  /**
   * How far off the locked route the robot may drift before the objective lock
   * is thrown away and re-chosen.
   *
   * A *fraction* of the route, not a distance: the limit is `d × this`, where
   * `d` is the length of the `origin → objective` line as it stood when the
   * lock was taken. The user's rule, and the scaling is the point — a target
   * 500px away tolerates a 167px lateral excursion, while a target 150px away
   * does not, and one number covers both.
   *
   * It needs a floor, and the floor is the kite ring's own radius: at small `d`
   * (the lock taken on something already underfoot) `d/3` falls below the
   * radius of the circle the robot legitimately orbits on, and every frame of
   * ordinary farming would re-lock. `objectiveLimit` supplies it.
   */
  OBJECTIVE_DEVIATION_FRAC: 1 / 3,
  /**
   * How close something must be for low hp alone to justify disengaging.
   *
   * Without this the robot flees on `hpFrac` alone, which is a real trap: hp
   * stays low until regen refills it, so a wounded robot whose nearest monster
   * is a stranger 240px away that has not noticed it would flee forever, from
   * nothing, instead of looting or regenerating. Roughly a hunter's sense
   * range — inside it, a monster has noticed you; outside it, you are not in a
   * fight.
   */
  DISENGAGE_RADIUS: 220,

  /** Inside this radius a monster is worth farming rather than ignoring. */
  FARM_RADIUS: 260,

  /**
   * The largest pack the robot will stand and fight: the user's 「引到了 1-4 只怪
   * 后，就该风筝了」. Above this it is a swarm, and a swarm is what `flee` is
   * for — the ring tactic holds a ring around *one* monster, and clearing
   * distance from a threat you cannot out-position is the only move left.
   *
   * **4 is the user's number, not a fitted one.** It is worth recording what it
   * costs, because the measurement says the situation it describes is not the
   * common one: at 36 monsters on a 960×540 arena a hunter's 260px `senseRange`
   * covers 41% of the floor, so the *aggro* count is 9+ on 72.7% of frames and
   * 1–4 on 3.6% (96 seeds, §14.5). See `PACK_RADIUS` for why the gate is not
   * written on that number.
   */
  PACK_MAX: 4,

  /**
   * How near a monster has to be to count as part of the pack *on* the player,
   * which is the count `PACK_MAX` is compared against.
   *
   * The same 120 as `CLUSTER_RADIUS` on purpose, and kept separate so that
   * moving the targeting knot stays a decision about targeting. "Pulled" is
   * read as *on you* rather than *aware of you*, and that is a measurement
   * rather than a preference: gating on the sim's own aggro test
   * (`dist <= senseRange`, §6.2) would fire on 3.6% of frames — dead code
   * wearing the appearance of a rule, which §14.1 has already had to withdraw
   * once for exactly this — while gating on this radius fires on 36.0%. The set
   * the rule is about is also the right one on the merits: kiting is about
   * staying outside the reach of what can touch you, and a hunter 260px away is
   * not something you orbit, it is something you might walk toward.
   *
   * **Neither reading gives the rule a working domain, and that is the honest
   * summary of this constant.** At 3.6% it almost never fires; at 36.0% it
   * fires, but on a set the user did not mean — so the gate is written on the
   * reading that at least runs, and the whole mechanism's contribution stays a
   * wash (96 seeds: 6.10× → 6.27×, 80 → 81 kills, §14.2). The knob that does
   * move this world is `MONSTER_ARCHETYPES.hunter.senseRange`, not this one:
   * 260 → 140 puts 1–4 at 59.2% of frames and kills at 80 → 330.
   */
  PACK_RADIUS: 120,

  /**
   * Weight on the wall penalty. The per-axis term is squared, so this is the
   * cost of standing *in* a corner (2 of them) and falls off to nothing at
   * `WALL_MARGIN`. Big enough to outbid a goal weight pointing outward, which
   * is what lets a cornered robot walk out instead of pressing itself flat.
   */
  WALL_MARGIN: 70,
  WALL_WEIGHT: 10,

  /**
   * Weight on the **corner penalty**: how much worse the *same* threat is when
   * there is nowhere to escape it in *either* axis.
   *
   * `WALL_WEIGHT` above charges for standing near an edge on its own account and
   * is a veto, not a reason. This is the reason, and it exists because three
   * rounds of adding *shape* to the goal (orbit, chirality, arc) bought the user
   * almost nothing: at 40 genuine failure frames — pressed to a wall and sliding
   * along it — neutralising `WALL_WEIGHT` flips 0/40 moves and neutralising the
   * room term 0/40, while zeroing the risk field's cap flips 27/40. The terms
   * written to keep the robot off walls are never consulted. The field that
   * decides is the risk field, so the risk field is what has to change.
   *
   * **Why the risk field sends it to the edge at all.** `riskAt` is a sum over
   * nearby monsters, so the risk minimum is wherever the fewest of them are —
   * and at an arena edge they are all on one side, which makes the boundary the
   * locally safest ground in the field. That is the mechanism behind "总是倾向于
   * 往角落里或者边界上跑", and no goal-shaped term can outvote it.
   *
   * Damage taken per second of **exposure**, 48 seeds, bucketed by distance to
   * the nearest edge and controlled for how many monsters were within 150px:
   *
   * | monsters within 150px | edge ≤70 | 70–240 | >240 | time in each |
   * |---|---|---|---|---|
   * | 0 | 0.00 | 0.00 | — | 1.5% / 0.2% / 0.0% |
   * | 1 | 1.22 | 1.02 | — | 3.8% / 0.5% / 0.0% |
   * | 2 | 1.72 | 3.65 | — | 5.4% / 1.2% / 0.0% |
   * | 3 | 2.72 | 6.18 | 0.00 | 4.3% / 1.1% / 0.2% |
   * | 4–5 | 4.24 | 2.30 | 0.00 | 5.1% / 1.9% / 0.2% |
   * | **6+** | **7.87** | **5.03** | **4.63** | **38.3% / 30.9% / 5.5%** |
   *
   * The last row is where the robot lives — 75% of its life is spent with six or
   * more monsters inside 150px — and there the wall band reads 1.56× the
   * mid-field at equal threat density. The top row is the control that says the
   * hazard is an *interaction*: with nothing nearby a corner is free (0.00 dmg/s
   * at every distance). Hence a multiplier on `riskAt` rather than a term beside
   * it — a flat charge would price an empty corner that costs nothing.
   *
   * **That table is confounded, and the confound is what this constant's shape
   * came from.** It conditions on the *old* policy's positions, and a policy
   * changes which positions it visits in which states, so "damage per second
   * while in band X" is not "damage per second if you live in band X". The first
   * formulation tried — pricing the whole wall band, `1 + TRAP_WEIGHT * (push_x
   * + push_y)` — took the robot's wall share from 56.6% to 12.0% and its corner
   * deaths to zero, exactly as asked, and cost **16% of median survival** with
   * *32% more damage per second* (7.46 → 9.82). It is not a tuning matter: 0.25,
   * 0.5, 0.75, 1 and 2 all cost about the same 5s, so the response is a
   * threshold rather than a gradient. The boundary is load-bearing ground for
   * this robot, and every unit of pressure off it is paid for in health.
   *
   * So the wall is left alone and only the *corner* is priced — `2 × TRAP_WEIGHT
   * × trapPush(x) × trapPush(y)`, a product, so a single wall costs nothing and
   * the 70×70 corner box costs everything. The user's instinct was right about
   * *where* and wrong about *why*: the corner is genuinely the worst ground, but
   * the fix is to stop camping it, not to stop using walls.
   *
   * 5, measured against both `0` and higher values. Paired per-seed over 96
   * seeds, and repeated on a **disjoint** 96 (seed offset 300) because the
   * survival median has fooled this project twice:
   *
   * | TRAP_WEIGHT | survival med (train / holdout) | P10 (train / holdout) | dmg/sec | paired better/worse |
   * |---|---|---|---|---|
   * | 0 | 16.77 / 19.60 | 6.17 / 6.78 | 7.46 / 6.75 | — |
   * | 2 | 22.88 / 22.15 | 8.83 / 7.55 | 6.14 / 6.43 | 48/30 · 35/37 |
   * | **5** | **22.33 / 22.93** | **8.83 / 9.28** | **6.20 / 6.05** | **54/25 · 46/33** |
   * | 8 | — / 22.58 | — / 8.12 | — / 6.17 | — / 43/36 |
   * | 12 | — / 21.80 | — / 8.12 | — / 6.32 | — / 38/39 |
   *
   * The honest reading: the train-seed medians flatter it and 8 and 12 fall off,
   * so the durable claim is the one that holds on *both* sets — the worst decile
   * of runs gains ~40% (6.2 → 8.8s, 6.8 → 9.3s) and damage per second falls
   * ~10–15%, which is the user's actual symptom (两次都很快就死). Median survival
   * is the weaker claim at +13–17%.
   *
   * **What this does not do is stop the robot using the boundary.** Wall share is
   * 56.6% before and 59.5% after — unchanged, deliberately. Anything that moves
   * that number costs survival, per the table above. If the user wants the
   * boundary itself abandoned, the lever is the *world* (what makes the edge a
   * refuge), not another weight here.
   *
   * The hazard is not exotic. **98.0% of all damage across those 48 runs was
   * bullets** (contact 1.0%, bombs 1.1%), and a shot is fired at where the player
   * *stood* — so the same monster connects more often when both escape
   * directions are a wall. That geometry is what a human reads as "don't get
   * cornered", which is why pricing it costs the robot no information a player
   * lacks: it still never models a bullet, it only knows it has less room.
   */
  TRAP_WEIGHT: 5,

  /**
   * Clear space, in px, beyond which more of it is worth nothing.
   *
   * The room term has to be **inert in open ground**, and that is not cosmetic.
   * Measured with no reference at all, the arena's own shape biases the robot:
   * from the centre there is 480px of runway along the long axis and 270px along
   * the short one, so an unsaturating room term would quietly make every open
   * floor decision a vote for the long axis — a steering effect nobody asked for
   * and nothing in the design wants. Saturating at 90 collapses those to the
   * same score and leaves the term no opinion at all until a wall is close.
   *
   * 90 is chosen against the two distances that matter at the edge: it is a
   * little over twice the 41px a bomb dodge needs (`bombBlast` + `playerRadius`)
   * and comfortably clear of `WALL_MARGIN` 70, so the whole wall band is inside
   * the ramp and the term has resolved an opinion before the wall penalty starts
   * to bite.
   *
   * That the ramp should be *tight* is measured, not assumed. Widening it to 140
   * — so the term has an opinion 140px out instead of 90 — is worse on every
   * axis it was built for and breaks the tail besides: clearance 49px → 46px,
   * escape rate 56.9% → 53.4%, and the worst seed falls to 0.72×, well under the
   * idle control. A term that is active across most of the arena is no longer
   * answering "is there a wall in the way", and it starts to compete with the
   * goal on open ground where it has no business having a preference.
   */
  ROOM_REF: 90,
  /**
   * Weight on the room term — the reward for heading somewhere with space to
   * maneuver in, as opposed to merely being somewhere.
   *
   * **It only has to be a steer, and it only has to be small.** Every frame the
   * direction already being walked is in the candidate set and collects `HYST`
   * 8, so a term worth less than that cannot flip a heading on its own — and 4
   * is comfortably under. What it can do is the thing nothing else in the score
   * does: give "inward" a *positive* reason. The wall penalty only stops
   * charging once the robot is out; it never pulls, and the reason the robot sat
   * at 33px for 85% of its life is that the alternatives to sliding along the
   * boundary all had something actively against them — `flee`'s goal points
   * outward and is deleted by the wall-slide, while inward is where the monsters
   * are, so risk charges for it. Room is the first term in the score that pays
   * for going inward on ground that is otherwise merely cheaper.
   *
   * Measured over 96 seeds, and the reason the value is 4 rather than "as high
   * as it goes": clearance 33px → 49px, near-wall frames 85.3% → 75.6% and
   * escape rate 46.0% → 56.9%, with the fighting *better* than before (194 kills
   * against 175) and every survival order statistic at or above the baseline.
   * The intended effect is bought almost entirely by 4 — at 6 it is 53px and
   * 55.8%, at 10 it is 63px and 57.1% — and past 6 the extra room starts to cost
   * the run instead: 10 pulls the robot off fights (138 kills), shortens its
   * committed runs to 1.85s, and 8 is the point where a seed does worse than
   * standing still (worst 0.82×). Being pinned is fatal; being *free* is not
   * free either.
   */
  ROOM_WEIGHT: 4,
  /**
   * Weight on the room term while the intent is `flee`.
   *
   * The measurement above says the *reason* room cannot simply be worth more is
   * that a single global weight makes the robot pay for inward room on frames
   * where it is fighting — at 10 it takes 138 kills against 194 at 4, and its
   * committed runs shorten from 2.33s to 1.85s. But that cost is not the room
   * term's fault in general; it is the room term arguing with `kite`, which
   * *wants* to stand in the ring at 51px, near the pack.
   *
   * `flee` is the opposite case, and it is the one the user's report is about.
   * Of the five rungs it is the only one whose goal is defined without any
   * reference to the arena — purely radially away from the danger centroid — so
   * it is the only one that can point out of the arena, and the wall-slide then
   * turns that into a one-dimensional slide that ends in a corner. Measured:
   * 76.6% of frames within 70px of an edge, moving outward on 28.1% of the
   * near-wall frames against inward on 16.0%, and `flee` is 77.3% of the frames
   * spent near a wall against 66.2% in the open. So the intent split is not a
   * tuning convenience: it separates the rung that has the defect from the rung
   * that has the objection.
   *
   * Measured over 96 seeds with the spawn at the arena centre, `4` being the
   * arm where the split is inert (`ROOM_WEIGHT_FLEE === ROOM_WEIGHT`):
   *
   *   W    near-wall (median)   clearance   survives (median)   worst seed
   *   4          63.9%            77px          15.57s            2.82×
   *   6          58.6%            82px          14.13s            2.10×
   *   8          57.0%            85px          13.23s            2.10×
   *
   * It works, and it is a bad deal past 6: the first two points buy 5.3 points
   * of near-wall share and 5px of clearance, and the next two buy 1.6 points and
   * 3px for another 0.9s of survival. 6 is where the curve is still moving.
   *
   * **And the whole effect is half what a 32-seed grid said it was.** That grid
   * put near-wall at 53.5% and clearance at 86px for W=8, against 57.0% and 85px
   * at 96 seeds — the small sample had flattered it, the same way it flattered
   * the outlier that made an earlier W=8 arm read as a 25-point win. Tune at 96
   * or do not quote the number.
   */
  ROOM_WEIGHT_FLEE: 6,
} as const;

/**
 * How much a potion is worth before distance, given how hurt the robot is.
 *
 * `vitality` leads because its +5% compounds for the whole run, and `heal` is
 * conditional because §8.3 spills a surplus rather than banking it: at full hp
 * a heal potion restores nothing, so it is worth a detour only when it happens
 * to be underfoot. The threshold sits just under 1 so a top-up taken in passing
 * still counts as worth having.
 */
function potionValue(kind: ItemKind, hpFrac: number): number {
  switch (kind) {
    case "heal":
      return hpFrac < 0.95 ? 1 : 0.12;
    case "power":
      return 0.9;
    case "agility":
      return 0.9;
    case "vitality":
      return 1.05;
    default: {
      const never: never = kind;
      throw new Error(`unhandled item kind: ${String(never)}`);
    }
  }
}

// ── The policy (design §14.2) ───────────────────────────────────────────────

/**
 * The policy's memory: whether it is disengaging, and what it has committed to.
 *
 * The retreat latch exists because a threshold on instantaneous risk is a
 * bang-bang controller, and a bang-bang controller cannot retreat. Measured: a
 * single hunter raises risk to 9.6 inside its reach and drops it to 2.9 thirty
 * pixels further out, so a robot that starts fleeing at one number and stops at
 * the other turns around every half second and never covers the couple of
 * hundred pixels to anywhere safer. It dies in the middle, oscillating.
 *
 * Note what is *not* here: nothing about monsters. Requirement 5's reveal is
 * still recomputed from scratch every frame and never remembered — `perceive`
 * is pure and the view is the whole of what the robot knows about the world.
 *
 * **The objective lock is the one thing that looks like an exception and is
 * not.** It stores a *world position* — `objectiveX/objectiveY` — chosen from
 * the public view, which is a fact about the arena rather than about the
 * robot's knowledge of it: §14.1's fog governs what the robot can perceive, and
 * it perceived this. What the lock must never become is a memory of monsters;
 * it is a point on the map, and every use of it re-reads the live view to find
 * which monster is nearest it. A lock whose monsters have all died is dropped
 * on the next frame, not remembered.
 */
export interface RobotState {
  retreating: boolean;
  /**
   * The input chosen last frame, so a marginal winner can keep it.
   *
   * `HYST` documents what this is and is not worth. Kept on the state rather
   * than in the module so a new run starts with no inherited preference.
   */
  lastDx: number;
  lastDy: number;
  /**
   * Where the robot has committed to clearing: the centroid of the cluster it
   * picked, frozen at the moment it picked it.
   *
   * Frozen on purpose. Re-deriving the centroid every frame would track the
   * monsters as they mill about, which is most of what made the old argmax
   * dither — the destination has to sit still for the walk toward it to be a
   * walk rather than a twitch.
   */
  objectiveX: number;
  objectiveY: number;
  /**
   * Where the robot was standing when it took the lock — the near end of the
   * route, and the only thing the deviation test measures against.
   *
   * Without it "have I been pushed off course?" has no course to be off: the
   * perpendicular distance from a *current* position to a line through that
   * same position is zero by construction.
   */
  originX: number;
  originY: number;
  /** False when there is nothing to lock onto, or the lock was just dropped. */
  locked: boolean;
  /**
   * Which way a retreat orbits: `+1` or `-1`, fixed at the moment the latch was
   * set and held until it releases.
   *
   * `kite` re-derives its side every frame from the target direction, which is
   * stable because a single monster's bearing is. `flee`'s reference is
   * `dangerCentre`, and a centroid *drifts*: as the robot arcs around it the
   * tangent rotates too, and once it passes perpendicular to the direction of
   * the arena centre the derived sign flips — mid-retreat, reversibly, frame
   * after frame. That is the same class of vibration `dangerCentre` was
   * introduced to end, arriving by a different route. One decision per retreat
   * costs one boolean-shaped field and removes the possibility.
   *
   * A retreat always begins with `retreating` false (see `createRobotState`),
   * so the latch's first frame is always available to set this and no separate
   * "unset" marker is needed.
   */
  orbitSign: 1 | -1;
}

export function createRobotState(): RobotState {
  return {
    retreating: false,
    lastDx: 0,
    lastDy: 0,
    objectiveX: 0,
    objectiveY: 0,
    originX: 0,
    originY: 0,
    locked: false,
    orbitSign: 1,
  };
}

/** The nine inputs the robot chooses between, the idle one first. */
const CANDIDATES: readonly MoveInput[] = [
  { dx: 0, dy: 0 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: -1 },
];

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * The empty hazard set, for the queries that are about monsters only.
 *
 * Only one call site uses it (`hereRisk`), and it exists so that the exclusion
 * reads as a decision with a name rather than as an argument somebody forgot.
 */
const NO_HAZARDS: readonly Hazard[] = [];

/** Unit vector from `a` to `b`, or null when the two points coincide. */
function unitTo(ax: number, ay: number, bx: number, by: number): [number, number] | null {
  const dx = bx - ax;
  const dy = by - ay;
  const d = Math.hypot(dx, dy);
  return d > 1e-6 ? [dx / d, dy / d] : null;
}

/**
 * Where a retreat is measured *from*: the danger the robot is running out of.
 *
 * `flee`'s direction used to be `unitTo(nearest)`, and in a crowd the *identity*
 * of the nearest monster is not a stable thing. Two monsters whose distances
 * differ by ~30px cross each other at up to 280px/s of relative motion, so the
 * argmin changes hands about ten times a second, and each swap reverses the
 * escape vector by up to 180°. Measured: 187 reversals per 21s run — one every
 * seven frames — and a longest unbroken straight run of 1.44s, against the
 * ~3.9s of unbroken running that breaking a hunter's aggro requires. The robot
 * was not fleeing, it was vibrating in place.
 *
 * A weighted centroid has no identity to swap. Two monsters trading places move
 * it a few pixels, continuously, and the escape direction that comes out of it
 * is continuous with it — which is what lets a retreat actually cover ground.
 *
 * Weighted by `dps`, the same currency as `riskAt` and `centroidOf`, so "where
 * the danger is" stays one idea across the policy. Only threats inside
 * `DISENGAGE_RADIUS` count: a centroid dragged by something across the arena
 * would point the retreat at the middle of the map rather than away from the
 * fight.
 *
 * Returns null when nothing is near enough, which the `flee` rung reads as
 * "nothing local left to run from".
 *
 * Note what the release is *not* measured against. The centroid is the right
 * source for a *direction* and the wrong one for a *distance*: when six
 * monsters have the robot surrounded, their weighted centre is standing on top
 * of it however far each individual one is, so a release gated on
 * `dangerCentre().dist` is unreachable in exactly the crowd it exists for.
 * Measured: `flee` stayed at 94% of frames with the exit written that way. The
 * latch's exit is gated on the *nearest* threat instead — enter at its reach,
 * leave at `FLEE_RELEASE_DIST`, one quantity, a real hysteresis pair.
 */
function dangerCentre(threats: readonly Threat[]): { cx: number; cy: number } | null {
  let w = 0;
  let sx = 0;
  let sy = 0;
  for (const t of threats) {
    if (t.dist > ROBOT.DISENGAGE_RADIUS) continue;
    const weight = t.dps;
    if (weight <= 0) continue;
    w += weight;
    sx += t.m.posX * weight;
    sy += t.m.posY * weight;
  }
  if (w <= 0) return null;
  return { cx: sx / w, cy: sy / w };
}

/**
 * How boxed-in one axis is at `v`: 0 in open ground, 1 hard against a wall.
 * Squared by the caller's weight, which is what lets the penalty vanish over
 * most of the arena and bite only near the edge.
 */
function wallPush(v: number, extent: number): number {
  const d = Math.min(v, extent - v);
  if (d >= ROBOT.WALL_MARGIN) return 0;
  const t = (ROBOT.WALL_MARGIN - d) / ROBOT.WALL_MARGIN;
  return t * t;
}

/**
 * How boxed-in one axis is at `v`, as a **fraction**: 0 at `WALL_MARGIN` out, 1
 * hard against the wall.
 *
 * The linear twin of `wallPush`, and deliberately not the same function. That
 * one is squared because it is a veto and has to stay out of the way until the
 * edge is genuinely close; this one prices a hazard that is measured as *flat
 * across the band*, so squaring it would undercharge exactly the part of the
 * band that costs the most — see the table on `TRAP_WEIGHT`.
 */
function trapPush(v: number, extent: number): number {
  const d = Math.min(v, extent - v);
  if (d >= ROBOT.WALL_MARGIN) return 0;
  return (ROBOT.WALL_MARGIN - d) / ROBOT.WALL_MARGIN;
}

/**
 * How much worse every threat at `(x, y)` is for want of somewhere to go: 1
 * anywhere but a corner, up to `1 + 2 * TRAP_WEIGHT` in one.
 *
 * The two pushes are **multiplied**, not summed, and that is the whole design:
 * a sum prices the entire wall band, which was tried and costs 16% of median
 * survival for 32% more damage taken — the boundary is load-bearing ground for
 * this robot. The product is zero unless *both* axes are boxed in, so a wall is
 * untouched and only the escape-proof box pays. `TRAP_WEIGHT` carries the
 * measurements for both forms.
 *
 * A multiplier on `riskAt` rather than a term beside it, so it is inert where
 * the field is already zero — an empty corner costs nothing, which is what the
 * measurement says it costs. Note the consequence for the score: the *product*
 * is what has a spatial gradient now, and its minimum is no longer the corner.
 * Nothing that reads `riskAt` directly (`hereRisk`, and with it every threshold
 * in the intent ladder) sees any of it, which is what keeps the blast radius to
 * the one quantity that was steering.
 */
function trapAt(x: number, y: number, w: number, h: number): number {
  return 1 + 2 * ROBOT.TRAP_WEIGHT * trapPush(x, w) * trapPush(y, h);
}

/**
 * Distance from `(x, y)` to the arena edge along the unit direction `(dx, dy)`.
 *
 * The ray-vs-rectangle slab test in closed form — the rectangle is axis-aligned,
 * so whichever axis runs out first is the answer, and `Infinity` is the honest
 * result for an axis the ray never moves along.
 *
 * This is "runway": how far the robot gets before the arena stops it. It is a
 * different question from `wallPush`, which asks only how close it is standing.
 * A robot 33px from the left wall has 33px of runway leftward, 270px upward and
 * 920px rightward, and the whole point of the room term is that those three are
 * not the same move.
 */
function clearance(x: number, y: number, dx: number, dy: number, w: number, h: number): number {
  const tx = dx > 0 ? (w - x) / dx : dx < 0 ? x / -dx : Infinity;
  const ty = dy > 0 ? (h - y) / dy : dy < 0 ? y / -dy : Infinity;
  return Math.min(tx, ty);
}

/**
 * How much room there is to maneuver in, standing at `(x, y)` and heading along
 * the unit direction `(dx, dy)`.
 *
 * The user's report is what this exists for: the robot reaches the boundary and
 * then only moves *along* it, which leaves it nowhere to dodge to. Two things
 * are measured, and the tighter one wins.
 *
 * **Runway** is where the heading leads — `clearance` along it. **Lateral room**
 * is the space to break off sideways: the `min` of the clearances along both
 * perpendiculars, because a robot running parallel to a wall it is hugging has
 * one perpendicular aimed straight into that wall, and half a dodge is not a
 * dodge. Taking the tighter of the two is what makes sliding along a wall score
 * *below* heading away from it: at 33px out, running parallel has 33px of
 * lateral room while running inward has 270px, and that gap is the entire steer.
 *
 * Idle has no heading, so there is no runway and no lateral to measure; the room
 * it has is the room it is standing in. Feeding the idle zero-vector through the
 * ray test would return `Infinity` on both axes and hand standing still a
 * perfect score, which is how a "get me out of this corner" term would talk the
 * robot into never leaving.
 */
function roomAt(x: number, y: number, dx: number, dy: number, w: number, h: number): number {
  if (dx === 0 && dy === 0) return Math.min(x, w - x, y, h - y);
  return Math.min(
    clearance(x, y, dx, dy, w, h),
    clearance(x, y, -dy, dx, w, h),
    clearance(x, y, dy, -dx, w, h),
  );
}

/** A monster with the numbers the policy actually branches on. */
interface Threat {
  m: PerceivedMonster;
  /** Damage per second it deals while in reach, revealed or assumed. */
  dps: number;
  /** The distance at which it starts hitting. */
  reach: number;
  /** The distance it can be expected to close at. */
  speed: number;
  revealed: boolean;
  dist: number;
}

function asThreat(m: PerceivedMonster, px: number, py: number): Threat {
  const s = m.stats;
  return {
    m,
    dps: s ? s.attackPower * s.attackSpeed : ROBOT.PRIOR_DPS,
    reach: s ? s.attackRange : ROBOT.PRIOR_REACH,
    speed: s ? s.moveSpeed : ROBOT.PRIOR_SPEED,
    revealed: s !== null,
    dist: Math.hypot(m.posX - px, m.posY - py),
  };
}

/**
 * A committed knot of monsters: the one to fight, and where the knot *is*.
 *
 * Both halves come out of one pass so they cannot disagree about which knot
 * they are talking about. `t` is the monster to walk at — a member, never the
 * centre, because the standoff ring around a monster is the whole tactic and
 * the centre of a cluster is the one place in it with no ring to stand on.
 * `cx`/`cy` is the dps-weighted centroid, which is what the objective lock
 * freezes and what the deviation test measures against.
 */
interface Objective {
  t: Threat;
  cx: number;
  cy: number;
}

/**
 * Choose what to farm.
 *
 * The user's ask: "移动到某个/某群怪物附近……尝试去攻击最近的那个，或者附近聚集
 * 起来最多的那群" — the nearest monster, or the biggest cluster of them. So the
 * score trades distance against company, and what it buys is a reason to walk
 * past a lone wanderer and set up on a knot of three.
 *
 * **Every monster is reachable, so the pool is simply all of them.** The pool
 * used to be filtered to the robot's own region, on the argument that a monster
 * across a border could not chase and going to it meant paying the region step
 * — which is precisely where the robot used to stall at 56px against a 55px
 * range, one pixel short of attacking, forever. §6.2's leash is gone and with it
 * the argument: reach is now nothing but distance, and distance is already the
 * second half of this score. What is left of reachability is `CLUSTER_DIST`
 * below, which makes a far-away cluster lose to a near one rather than banning
 * it. A consequence worth naming: the target no longer jumps to the far side of
 * the map the moment the last monster in our region dies — the pool never
 * changed, so there is nothing to jump between.
 *
 * Within the pool: `pack` counts the monsters clustered around a candidate, and
 * distance is charged against it. Both numbers come from the public view — the
 * same positions a human reads off the canvas (§14.1).
 *
 * The centroid is computed for the winner alone, in a second O(n) pass rather
 * than inside the O(n²) search. It does not change which monster is picked —
 * `CLUSTER_WEIGHT` and `CLUSTER_DIST` still decide that — so what they now
 * choose is *which knot to commit to*, and the monster that gets fought is
 * whichever member of it is nearest.
 */
function pickTarget(view: RobotView, threats: readonly Threat[]): Objective | null {
  if (threats.length === 0) return null;

  let best: Threat | null = null;
  let bestScore = -Infinity;
  for (const t of threats) {
    let pack = 0;
    for (const o of view.monsters) {
      if (o.id === t.m.id) continue;
      if (Math.hypot(o.posX - t.m.posX, o.posY - t.m.posY) <= ROBOT.CLUSTER_RADIUS) pack++;
    }
    const score = pack * ROBOT.CLUSTER_WEIGHT - t.dist / ROBOT.CLUSTER_DIST;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (best === null) return null;
  return { t: best, ...centroidOf(threats, best) };
}

/**
 * The dps-weighted centroid of `t` and everything within `CLUSTER_RADIUS` of it.
 *
 * Weighted by dps rather than counted, so a brute anchors the knot harder than
 * the wanderers beside it — the same weighting `riskAt` and the retreat's
 * reference use, which is what keeps "the dangerous part of that group" one
 * idea across the three of them.
 *
 * Weight can be zero (an unrevealed monster carries `PRIOR_DPS`, which is not
 * zero, but a caller could pass a threat with none), so the fallback is `t`
 * itself rather than a division by zero.
 */
function centroidOf(
  threats: readonly Threat[],
  t: Threat,
): { cx: number; cy: number } {
  let w = 0;
  let sx = 0;
  let sy = 0;
  for (const o of threats) {
    if (Math.hypot(o.m.posX - t.m.posX, o.m.posY - t.m.posY) > ROBOT.CLUSTER_RADIUS) continue;
    const weight = o.dps;
    if (weight <= 0) continue;
    w += weight;
    sx += o.m.posX * weight;
    sy += o.m.posY * weight;
  }
  if (w <= 0) return { cx: t.m.posX, cy: t.m.posY };
  return { cx: sx / w, cy: sy / w };
}

/** The threat nearest a world point — the monster a lock is currently about. */
function nearestToPoint(
  threats: readonly Threat[],
  x: number,
  y: number,
): Threat | null {
  let best: Threat | null = null;
  let bestD = Infinity;
  for (const t of threats) {
    const d = Math.hypot(t.m.posX - x, t.m.posY - y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/**
 * How far off the locked route counts as "pushed away from it".
 *
 * `OBJECTIVE_DEVIATION_FRAC` of the route, floored at the radius of the circle
 * the robot legitimately orbits on. The floor is the load-bearing half and it
 * is why this is a function rather than a multiplication at the call site: the
 * lock is taken on a knot, the knot is what the robot then kites around, and a
 * limit smaller than that orbit radius would re-lock the objective every frame
 * — a lock that is really a per-frame recompute wearing extra state.
 */
function objectiveLimit(route: number, ring: number): number {
  return Math.max(route * ROBOT.OBJECTIVE_DEVIATION_FRAC, ring);
}

/**
 * The radius the kite holds station at, standing off from a given `reach`.
 *
 * Shared by the kite rung and by `objectiveLimit`'s floor rather than written
 * twice: the floor has to be *this* number, and two copies of a clamp with
 * three arguments is exactly the kind of thing that drifts apart silently.
 */
function standoffRing(attackRange: number, reach: number): number {
  return clamp(attackRange - ROBOT.STANDOFF_MARGIN, reach + ROBOT.BAND, attackRange - 2);
}

/**
 * The direction a kite (or a roam-approach) walks in, as an unnormalised vector.
 *
 * A proportional pull toward the standoff ring around `target`, plus an orbit of
 * `ORBIT` on one side or the other. The radial error is proportional rather than
 * a sign so that *at* the ring the radial term vanishes and the robot orbits
 * instead of chattering between "in" and "out".
 *
 * The error is normalised *asymmetrically*, and that is load-bearing. Outside
 * the ring it saturates over the distance we are outside our **own attack
 * range**; inside it saturates over the target's own reach. Measured: with a
 * single symmetric band of 30 the radial term was still only 0.567 at a brute's
 * reach — weaker than the 0.6 orbit — so the robot circled a monster while it
 * was being hit, which is 72% of all contact frames. Saturating at `reach` means
 * the retreat is at full strength exactly when the target starts landing blows,
 * and the radial term (1.0) then outranks the orbit as it must.
 *
 * The outside band used to be `KITE_BAND` 30, and that was wrong in the same
 * way, just in the direction nobody had measured. An error of 30 means the
 * radial term only reaches 0.6 — parity with the orbit — at 18px outside the
 * ring, i.e. 69px from the target. Since our range is 55px, *the robot could
 * orbit permanently outside its own attack range*: it circled a stationary
 * monster at 58px and never once hit it. Saturating over `ourRange − desired` —
 * the width of the band in which we are outside our own reach, 4px as shipped —
 * puts the radial term at full strength for the whole approach and lets the
 * ring, not the orbit, decide when to stop.
 *
 * Both bands carry a deadband, and that is a separate repair from the saturation
 * above. `err` reaching full strength over 4px means that within four pixels of
 * the ring the radial term swings the whole 0→1 while the orbit holds at 0.6,
 * which rotates the goal by ~59° in under two frames of travel — and since both
 * bodies move 2–2.8px per frame, `target.dist` crosses `desired` constantly and
 * the rotation is continuous. Inside the deadband the radial term is zero and
 * the orbit decides alone, which is a heading that holds.
 *
 * Extracted from the `kite` rung when `roam` was given the same goal: the two
 * used to differ, and the difference *was* the charge the user objected to —
 * `roam`'s goal was the monster's own position, so from anywhere past
 * `FARM_RADIUS` the robot walked straight at a body instead of stopping on the
 * ring. One ring, one formula, no way for the approach and the standoff to
 * disagree.
 */
function standoffGoal(
  px: number,
  py: number,
  target: Threat,
  attackRange: number,
  side: number,
): [number, number] | null {
  const u = unitTo(px, py, target.m.posX, target.m.posY);
  if (!u) return null;
  const desired = standoffRing(attackRange, target.reach);
  const err =
    target.dist >= desired
      ? clamp(
          (target.dist - desired - ROBOT.KITE_ERR_DEADBAND_OUT) /
            Math.max(1, attackRange - desired),
          0,
          1,
        )
      : -clamp(
          (desired - target.dist - ROBOT.KITE_ERR_DEADBAND) /
            Math.max(1, desired - target.reach),
          0,
          1,
        );
  const tx = -u[1];
  const ty = u[0];
  return [err * u[0] + ROBOT.ORBIT * side * tx, err * u[1] + ROBOT.ORBIT * side * ty];
}

/**
 * Distance from a point to the segment `a → b`, clamped at both ends.
 *
 * The clamping is what makes this the right measure rather than a nuisance.
 * Distance to the *infinite* line would report zero for a robot shoved 400px
 * back down the corridor it came along — the flee vector is roughly
 * anti-parallel to the route, so that is the common case, not a corner one.
 * Against the segment, being pushed past either end moves the nearest point to
 * the endpoint and the distance grows, so a lost fight reads as a deviation
 * from the plan whether the plan was lost sideways or head-on.
 */
function perpendicular(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Expected damage per second taken by standing at `(x, y)`.
 *
 * Summed over every monster in the view that can see the point, by one rule:
 *
 * **The proximity curve.** `dps` is what a monster deals once it has you, but
 * standing at the edge of its reach is not the same as standing at the edge of
 * its notice: the closer it is, the less room there is to leave. So the field is
 * `dps × CHASE × proximity`, where `proximity` is 1 at `reach`, falls to 0 at
 * `senseRange`, and climbs inside `reach` as the gap closes.
 *
 * Why it is shaped this way, rather than the linear ramp it started as: the
 * ramp has to be *continuous* at `reach` and *monotone* in `d`. An earlier
 * revision gave `dps` inside the reach and `dps × CHASE` outside, which is
 * neither — crossing inward past `reach` at CHASE 3.4 *dropped* the risk by
 * 2.4 × dps, so the field quietly paid the robot to step into a brute's reach.
 * The `kite` intent's standoff ring masked it, which is exactly what made it
 * worth removing rather than tuning around.
 *
 * `FALLOFF` is below 1 on purpose: a linear ramp makes 50px from a brute look
 * almost free (0.29 × dps) when it is one step from hitting, so the curve holds
 * its value and drops late instead.
 *
 * Hazards (design §15) are summed alongside the monsters but break the curve at
 * one end: a blast is a hard boundary rather than a gradient of likelihood, so
 * the sum stops dead at `reach` instead of trailing off to `senseRange`. Inside
 * it the same proximity curve applies, since "dead centre is worse than the rim"
 * is as true of a circle of ground as of a monster's reach.
 *
 * **A monster used to contribute nothing outside its own region** (§6.2's
 * leash), and that term is gone along with the leash itself: a monster that can
 * cross the arena to reach you has to be priced everywhere it can reach. What
 * this costs is the robot's cheapest escape — "step over the line and they stop"
 * — and with it the region border's role as a step function in this field. That
 * step was the root cause §14.6 recorded for the robot standing still; see the
 * constant comments for what is left of that story once it is gone.
 */
function riskAt(
  threats: readonly Threat[],
  hazards: readonly Hazard[],
  x: number,
  y: number,
  exclude: number | null = null,
): number {
  let risk = 0;
  for (const t of threats) {
    if (t.m.id === exclude) continue;
    const d = Math.hypot(t.m.posX - x, t.m.posY - y);
    if (d > t.m.senseRange) continue;
    let proximity: number;
    if (d <= t.reach) {
      proximity = 1 + (ROBOT.PROX * (t.reach - d)) / t.reach;
    } else {
      const span = t.m.senseRange - t.reach;
      proximity = span <= 0 ? 1 : Math.pow((t.m.senseRange - d) / span, ROBOT.FALLOFF);
    }
    risk += t.dps * ROBOT.CHASE * proximity;
  }
  for (const h of hazards) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d > h.reach) continue;
    risk += h.damage * ROBOT.BOMB_WEIGHT * ROBOT.CHASE * (1 + (ROBOT.PROX * (h.reach - d)) / h.reach);
  }
  return risk;
}

/**
 * Pick a move for this frame.
 *
 * A three-rung ladder: score every candidate position, choose an intent, then
 * score the nine inputs by how well they serve that intent *net of the risk
 * they add*. The risk term is a **delta** — `riskAt(next) − riskAt(here)` — and
 * that is load-bearing: risk the robot cannot avoid must not paralyse it, so
 * only *changes* are allowed to steer. Grading absolute risk instead freezes
 * the robot solid the moment it finds itself in a crowded arena.
 */
export function decide(
  view: RobotView,
  state: RobotState,
): { input: MoveInput; intent: RobotIntent } {
  const p = view.player;
  const px = p.posX;
  const py = p.posY;
  const hpFrac = p.maxHp > 0 ? p.hp / p.maxHp : 0;

  const threats = view.monsters.map((m) => asThreat(m, px, py));
  // **Monsters only, and that exclusion is deliberate.** This is the number the
  // *commitments* below are made on — the retreat latch's second exit, whether a
  // potion is worth walking to — and those are judgments about whether to stay in
  // the fight, not about where to put a foot. A bomb is a 0.3s event that the
  // ground under the robot is about to have; if it counted here it would read as
  // a full-blown emergency (108, against a hunter's 28.8) and release or hold a
  // committed retreat because a brute threw something. Stepping out of the
  // circle is the whole correct response, and that is what the candidate deltas
  // below do with it.
  const hereRisk = riskAt(threats, NO_HAZARDS, px, py);

  // ── The pack on us ───────────────────────────────────────────────────────
  // The user's rule, in three parts: 「引到了 1-4 只怪后，就该风筝了：绕圈子走位
  // （躲避引来更多怪，确保优先击杀已经引到的怪），而不是到处转悠引来更多怪物，
  // 更不能直接冲向怪物撞过去。」 — commit to the pack that is on you, circle it,
  // kill what you already pulled, and stop treating every new monster as a
  // reason to restart. `PACK_RADIUS`/`PACK_MAX` carry the two numbers and the
  // measurement behind them.
  const pack = threats.filter((t) => t.dist <= ROBOT.PACK_RADIUS);
  const committed = pack.length > 0 && pack.length <= ROBOT.PACK_MAX;

  // ── Potions ──────────────────────────────────────────────────────────────
  // Scored by what they do, discounted by how far the walk is, and skipped
  // outright if they will fade before the robot could arrive.
  //
  // Two winners are tracked, not one. `best` answers "what is the most valuable
  // thing on the floor", which is the `loot` rung's question. `bestHeal`
  // answers "where is the nearest medicine", which is the `heal` rung's — and
  // they are different questions, because a power potion can easily outscore a
  // heal and would otherwise silently veto the wounded robot's trip to the
  // medicine. That veto is not hypothetical: with a single winner the `heal`
  // rung fired on exactly 0.0% of frames across 24 seeded runs, i.e. it was
  // dead code wearing the appearance of a rule.
  let best: { item: ItemStats; score: number } | null = null;
  let bestHeal: { item: ItemStats; score: number } | null = null;
  for (const it of view.items) {
    const dist = Math.hypot(it.posX - px, it.posY - py);
    const eta = dist / Math.max(1, p.moveSpeed);
    if (it.life <= eta) continue; // gone before we get there
    const score =
      potionValue(it.kind, hpFrac) * (1 - clamp(dist / ROBOT.LOOT_RANGE, 0, 1));
    if (best === null || score > best.score) best = { item: it, score };
    if (it.kind === "heal" && (bestHeal === null || score > bestHeal.score)) {
      bestHeal = { item: it, score };
    }
  }

  // ── Commit to disengaging, or not ────────────────────────────────────────
  // `nearest` stays the true nearest and drives the safety gates below — a
  // disengage radius and a "is the medicine nearer than the danger" test are
  // questions about the closest threat, not about the one we chose to farm.
  let nearest: Threat | null = null;
  for (const t of threats) {
    if (nearest === null || t.dist < nearest.dist) nearest = t;
  }

  // ── The objective lock (design §14.2) ────────────────────────────────────
  // The user's strategy: pick a direction by where the monsters are, clear the
  // monsters along it, and re-choose only when actually pushed off course.
  //
  // What this replaces is a per-frame argmax over cluster scores. The argmax
  // was not the robot's main source of dithering — `flee` owns ~96% of frames
  // and never reads it — but it is why the robot had no *destination*: the
  // monster it walked at could change between two frames whose scores were
  // within a hair, so "walk toward the biggest knot" was never a walk, only a
  // twitch. Freezing the knot's centroid gives the walk something that sits
  // still, and §14.6's 187 reversals per run have one fewer contributor.
  const pick = pickTarget(view, threats);
  let objective: Threat | null = null;
  if (pick === null) {
    // Nothing alive to walk at: there is no objective, and holding the last
    // one would be remembering a monster.
    state.locked = false;
  } else {
    let drop = !state.locked;
    if (state.locked) {
      const route = Math.hypot(
        state.objectiveX - state.originX,
        state.objectiveY - state.originY,
      );
      const limit = objectiveLimit(route, standoffRing(p.attackRange, pick.t.reach));
      const dev = perpendicular(
        px,
        py,
        state.originX,
        state.originY,
        state.objectiveX,
        state.objectiveY,
      );
      // The knot is "cleared" when nothing is standing in it any more — but
      // only tested on arrival. Monsters respawn in their home regions on a
      // clock set by the player's level (§4.1: 5.0s at level 1, falling to a
      // 0.8s floor), so a dense
      // area does not stay empty; and a window that happens to open *en route*
      // would re-lock the robot to whatever is nearest it right now — a near
      // knot — and walk it back. That is the flip-flop this lock exists to
      // remove, at a lower frequency.
      const arrived =
        Math.hypot(px - state.objectiveX, py - state.objectiveY) <=
        2 * ROBOT.CLUSTER_RADIUS;
      const held = threats.some(
        (t) =>
          Math.hypot(t.m.posX - state.objectiveX, t.m.posY - state.objectiveY) <=
          ROBOT.CLUSTER_RADIUS,
      );
      drop = dev > limit || (arrived && !held);
    }
    if (drop) {
      state.objectiveX = pick.cx;
      state.objectiveY = pick.cy;
      state.originX = px;
      state.originY = py;
      state.locked = true;
    }
    // Under a lock the monster to fight is the member of the committed knot
    // that is nearest the locked point — a member, never the centre, because
    // the standoff ring is the whole tactic and the centre of a cluster is the
    // one place in it with no ring to stand on.
    objective = nearestToPoint(threats, state.objectiveX, state.objectiveY);
  }
  /**
   * What the kite and roam rungs walk at.
   *
   * 「确保优先击杀已经引到的怪」 reorders this, and only this. Under a committed
   * pack the thing to fight is the monster *on* the robot rather than whichever
   * member of the locked knot is nearest the frozen centroid: the lock is a
   * long-range destination and it is still maintained underneath (its state
   * machine is untouched, so nothing re-picks or dithers here), it just is not
   * what the feet serve while something is already in reach.
   *
   * No new lookup is needed for it. `pick`/`objective` and `nearest` are drawn
   * from the same `threats`, and `committed` requires a non-empty pack, so
   * `nearest.dist <= PACK_RADIUS` whenever `committed` — the nearest threat
   * *is* the nearest pack member, and the "already pulled" set does not need to
   * be searched again to find its closest member.
   */
  const target = (committed ? nearest : (objective ?? pick?.t)) ?? null;

  // Where a retreat is measured from, and what it runs at. One value, shared by
  // the flee goal — a release measured against a different danger than the
  // direction was would let the robot decide it had escaped while still running
  // straight at the thing.
  const danger = dangerCentre(threats);

  // ── The retreat latch ────────────────────────────────────────────────────
  // Both ends are now *local*, and that is the repair §14.6 needed. The old
  // enter test was `hereRisk > PANIC`, a threshold on a **sum** over every
  // aware monster, so the contour it describes grows with the crowd: two
  // hunters at equal distance can trip it from 141px, three from 217px, five
  // from 248px. In an arena with five to seven monsters aware at all times the
  // robot was inside that contour on essentially every frame, and the exit
  // (`hereRisk < KITE_SAFE_RISK`) sat at the same crowd-dependent radius. The
  // latch had no reachable exit: measured, 12 seeds produced 13 retreats — one
  // per run — with a median span of 15.7s and `flee` at 99.8% of all frames.
  //
  // Contact is the honest trigger. It is what the game actually does to you,
  // it is the same test the old ring-breach weight used, and it does not move
  // when the crowd does. The exit is
  // `FLEE_RELEASE_DIST`, which sits *outside* the ring at 51 by construction,
  // so ordinary farming never trips it and a retreat that opened real distance
  // always does. `hereRisk < KITE_SAFE_RISK` stays as a second exit, for the
  // retreats contact cannot explain — a bomb field, a stale latch.
  //
  // **A committed pack was tried here and rejected on measurement.** The
  // argument for it was 「引到了 1-4 只怪后……坚持风筝」: a robot that is
  // successfully kiting produces contact frames as a matter of course, so
  // contact is a trigger without being a reason, and `&& !committed` should let
  // it stand. Swept over 96 seeds, `&& !committed` alone: 存活比中位 5.42×
  // （对照 6.10×）、机器人中位 13.87s（14.83s）、击杀 73（80），flee 从 73.6% 只
  // 降到 72.4% —— **它没有换来风筝，只换来了挨打**。Refusing to leave contact is
  // tanking, and kiting is the opposite: the standing decision is already made
  // by the `kite` rung holding the ring, and the latch is what happens when
  // that failed. See §14.2 for the full attribution.
  const threatened =
    (nearest !== null && nearest.dist <= nearest.reach) ||
    (hpFrac < ROBOT.FLEE_HP &&
      nearest !== null &&
      nearest.dist <= ROBOT.DISENGAGE_RADIUS);
  // Read before the write, so the latch's opening frame can be recognised: that
  // frame is the one place `orbitSign` is decided (see it on `RobotState`).
  const startingRetreat = threatened && !state.retreating;
  if (threatened) state.retreating = true;
  else if (
    nearest === null ||
    nearest.dist > ROBOT.FLEE_RELEASE_DIST ||
    hereRisk < ROBOT.KITE_SAFE_RISK
  ) {
    state.retreating = false;
  }
  const inDanger = state.retreating;

  const toCentre = unitTo(px, py, view.width / 2, view.height / 2);
  const healDist = bestHeal
    ? Math.hypot(bestHeal.item.posX - px, bestHeal.item.posY - py)
    : Infinity;
  const healIsNearerThanDanger =
    bestHeal !== null && (nearest === null || healDist < nearest.dist);

  // ── Intent, first match wins ─────────────────────────────────────────────
  //
  // `heal` sits above `flee` because a wounded robot that disengages and never
  // picks anything up has no way back: regen is 1 hp/s, so hp stays below the
  // disengage threshold the whole time and it flees until it dies — next to the
  // medicine, in the run this was tuned against. But running for a potion is
  // only right when the potion is the *nearer* of the two, so that rung is
  // guarded on distance.
  let intent: RobotIntent;
  let goalX = 0;
  let goalY = 0;

  if (hpFrac < ROBOT.HEAL_HP && healIsNearerThanDanger) {
    // Hurt, and the medicine is closer than whatever hurt us: take it.
    intent = "heal";
    const u = unitTo(px, py, bestHeal!.item.posX, bestHeal!.item.posY);
    if (u) {
      goalX = u[0];
      goalY = u[1];
    }
  } else if (inDanger) {
    // Disengaging: away from where the danger *is*, and around it.
    //
    // The radial half is a single unit vector away from `dangerCentre`. It used
    // to be taken from `nearest`, which changes identity about ten times a
    // second in a crowd; every swap reversed the escape by up to 180° and that
    // was the vibration. `dangerCentre` — the dps-weighted centroid of the
    // threats within `DISENGAGE_RADIUS` — is continuous, and it is the repair.
    //
    // The tangential half is back. It was deleted with the old `refugeRegion`,
    // and the two are separable: what the user's "flee 只做局部脱离" ruled out
    // was a *cross-arena destination*, and the refuge was the only thing that
    // was ever cross-arena. An orbit around the threat is the opposite of a
    // destination — it is the locally-confined manoeuvre. What it must never do
    // is steer by a region, so it steers by the arena centre instead, which is
    // not a place to go but a way to break the tie between the two sides.
    //
    // Without it the goal is a gradient flow whose only attractor in a bounded
    // arena is a wall, and the wall-slide turns what is left of it into a
    // one-dimensional slide whose endpoint is a corner. Measured against the
    // pure-radial control (96 seeds, this round): 58.6% of frames within 70px
    // of an edge as a per-seed median, and that share *rising* over a run —
    // 51.9% under 5s to 63.5% / 75.8% / **100%** by 30s, with mean clearance
    // falling 98 → 74 → 55 → 14px. The corner is where a retreat stops being
    // able to break the aggro that started it.
    //
    // The radial term keeps full strength at 1.0; it is the orbit that grew, to
    // `FLEE_ORBIT` 1.2, so the step's outward component is 1/hypot(1, 1.2) =
    // 64% of it and the rest is lateral. That trade is licensed by measurement,
    // not by taste: the static objection — 160/hypot(1, 1.2) = 102px/s outward
    // is under the hunter's 120px/s — does not hold here, because aggro breaks
    // per run *rise* across this range (17.1 → 21.7). See `FLEE_ORBIT`.
    intent = "flee";
    const from = danger ? unitTo(danger.cx, danger.cy, px, py) : null;
    if (from) {
      const tx = -from[1];
      const ty = from[0];
      // Which side to curve toward is decided once, on the latch's opening
      // frame, and then held — see `RobotState.orbitSign` for why re-deriving
      // it per frame is wrong here when it is right in `kite`.
      if (startingRetreat) {
        state.orbitSign = toCentre && tx * toCentre[0] + ty * toCentre[1] < 0 ? -1 : 1;
      }
      goalX = from[0] + ROBOT.FLEE_ORBIT * state.orbitSign * tx;
      goalY = from[1] + ROBOT.FLEE_ORBIT * state.orbitSign * ty;
    } else if (toCentre) {
      // Nothing on us but still latched (the hp clause, usually, or standing
      // exactly on top of the danger): fall back to the middle, which at least
      // is not a corner.
      goalX = toCentre[0];
      goalY = toCentre[1];
    }
  } else if (best && best.score >= ROBOT.LOOT_SCORE && hereRisk <= ROBOT.KITE_MAX_RISK) {
    // A potion worth the walk — but not through a fight that costs more than the
    // potion returns. `heal` was decided above this, so medicine is never gated.
    intent = "loot";
    const u = unitTo(px, py, best.item.posX, best.item.posY);
    if (u) {
      goalX = u[0];
      goalY = u[1];
    }
  } else if (target && target.dist <= ROBOT.FARM_RADIUS) {
    // Farm it. The goal is not the monster but a ring around it: `desired` is
    // far enough out to stay clear of its reach and close enough in for the
    // auto-attack (§5.1) to land — which is the whole tactic, since only the
    // player's attack is automatic and the monster has to walk to you.
    //
    // The same ring runs in both directions, so this one rung covers the user's
    // two requirements at once: from outside it closes to just within our own
    // range, and from inside it backs off. There is no separate "approach" rule
    // to get out of step with the "retreat" one. The goal itself is built by
    // `standoffGoal`, because `roam` below now uses the same one.
    intent = "kite";
    const u = unitTo(px, py, target.m.posX, target.m.posY);
    if (u) {
      // Perpendicular to the target direction, oriented by whether it also
      // carries the robot toward the middle of the arena. That is what stops a
      // kite from spiralling into a corner and dying there.
      //
      // **「躲避引来更多怪」 was tried here and rejected on measurement.** The
      // candidate rule was to compare the two sides by how many *unpulled*
      // monsters' sense circles one probe step would enter, and take the
      // cheaper side — the cost of a new aggro as an explicit term. Swept over
      // 96 seeds (`KITE_AVOID_MARGIN` 2): 存活比中位 5.58×（对照 6.10×）、机器人
      // 中位 13.30s（14.83s），击杀 80 → 85；而**与下面那条目标改动叠在一起时
      // 击杀从 81 崩到 46**。The mechanism is in `circling: heading
      // consistency`, which fell 0.19 → 0.16 and 0.13 in the two arms: the
      // comparison re-derives chirality every frame from many *moving* bodies,
      // so it dithers the orbit it was meant to improve. That is the same class
      // of vibration `flee` had to latch its side on the opening frame to avoid,
      // and a per-frame margin is not a latch. See §14.2.
      const tx = -u[1];
      const ty = u[0];
      const s = toCentre && tx * toCentre[0] + ty * toCentre[1] < 0 ? -1 : 1;
      const g = standoffGoal(px, py, target, p.attackRange, s);
      if (g) {
        goalX = g[0];
        goalY = g[1];
      }
    }
  } else {
    // Nothing inside `FARM_RADIUS` worth having: go and find something.
    // Positions are public, so "the nearest monster" is always answerable and
    // the robot never idles.
    //
    // **The approach is the same ring, not the monster** — 「更不能直接冲向怪物
    // 撞过去」. This rung used to aim at `target.m.posX/posY`, and from beyond
    // `FARM_RADIUS` the only thing that stopped the robot was arriving, so the
    // walk from 260px in was a straight line at a body. Under the ring goal it
    // closes at full radial strength until the ring at 51 and then stops, which
    // is also why the two rungs can share one formula: the difference between
    // them was never the goal, only how far away the thing being approached is.
    intent = "roam";
    if (target) {
      // Side 1 is arbitrary here and does not matter: beyond `FARM_RADIUS` the
      // radial error saturates at 1, so the goal is dominated by the approach
      // and the orbit is the 0.6 that keeps it a curve rather than a beeline.
      const g = standoffGoal(px, py, target, p.attackRange, 1);
      if (g) {
        goalX = g[0];
        goalY = g[1];
      }
    }
  }

  // ── Wall-slide the goal ──────────────────────────────────────────────────
  // A goal that points into a wall the robot is already against is not a plan,
  // it is a stalemate: every candidate serving it clamps to standing still,
  // which scores 0 risk and therefore beats every real move that costs
  // something. Zeroing the unavailable component leaves whatever is left of the
  // goal — and if the robot is in a corner with both components pointing out,
  // nothing is left, and the wall penalty below walks it back inside.
  if (px <= ROBOT.WALL_MARGIN && goalX < 0) goalX = 0;
  if (px >= view.width - ROBOT.WALL_MARGIN && goalX > 0) goalX = 0;
  if (py <= ROBOT.WALL_MARGIN && goalY < 0) goalY = 0;
  if (py >= view.height - ROBOT.WALL_MARGIN && goalY > 0) goalY = 0;

  // ── Pick the move ────────────────────────────────────────────────────────
  const step = p.moveSpeed * ROBOT.PROBE_S;

  // **The approach must not be vetoed by the very monster it is approaching.**
  //
  // This is the fix for "robot 的 range 范围内没有怪物的时候，应该去攻击最近的
  // 那一个". The approach rung already existed and already aimed at the nearest
  // monster; what it did not do was *move*. The delta is clamped at `RISK_CAP`
  // 12 and the `kite` weight is 6, so every step that closed the distance
  // carried a positive delta it could not outbid — while idle sat at exactly 0
  // and won by default. Measured over 24 seeds: of the 723892 frames with
  // nothing inside our own attack range, the robot was idle on 72.4% and moved
  // toward the nearest monster on only 14.6%, stalling a median 36px short of
  // the ring it was trying to hold, with idle streaks up to 1615 frames.
  //
  // Excluding the target is the principled repair rather than a bigger weight,
  // because the ring already *is* the safety contract for this one monster:
  // `desired` is `ourRange − STANDOFF_MARGIN`, which sits outside the target's
  // reach by construction. The risk field's job is the monsters the robot is
  // *not* deliberately walking at, and those are all still in the sum — so a
  // target standing in a pack still gets the robot stopped at the pack's edge,
  // by the pack. Raising the weight instead would have bought the approach at
  // the price of also walking through everyone else.
  //
  // Gated on being out of our own range: once the target is inside it we are
  // farming, and the latch above has already taken the frame.
  const ignoring =
    (intent === "kite" || intent === "roam") && target !== null && target.dist > p.attackRange
      ? target.m.id
      : null;
  const hereForScore =
    riskAt(threats, view.hazards, px, py, ignoring) * trapAt(px, py, view.width, view.height);
  // Hazards *are* in this baseline, unlike in the `hereRisk` above, and both
  // halves of that are deliberate. The delta is measured against where the robot
  // is standing, so a bomb underfoot has to be in the baseline for stepping out
  // of the circle to register as the gain it is: with the baseline monster-only,
  // leaving a bomb would be priced as pure monster gradient and could tie with
  // simply standing in it — and ties fall to idle. In the baseline, standing
  // still scores 0 and every step out of the circle scores a clamped reward, so
  // "move" wins the frame the reticle appears.
  // A ring that has already been breached *is* a retreat, and it is priced as
  // one — but not here. This used to pay `ROBOT.KITE_CONTACT_WEIGHT` whenever
  // `kite` ran with the target inside its own `reach`, and that arm is now
  // **unreachable**: the latch above enters on exactly `nearest.dist <=
  // nearest.reach`, so any frame that would satisfy this test has already been
  // routed to `flee` before the ladder reaches `kite`. The two were the same
  // predicate, and the latch got there first.
  //
  // Proven, not assumed: overriding the weight to 1000 — a value that would
  // dominate every score if the branch ever ran — leaves the sweep output
  // byte-identical. So the constant was deleted rather than re-tuned: the
  // contact case belongs to `flee` now, and `flee` backs off radially until
  // `FLEE_RELEASE_DIST` and then lets the ring converge on `desired` again,
  // which is the "慢慢远离怪物，但是又不能跑的太远" the user asked for, arrived at
  // from the other side.
  const weight = ROBOT.GOAL[intent];
  // Resolved once, outside the loop: `intent` is settled above and the room
  // weight is now a function of it. See `ROOM_WEIGHT_FLEE` for why the split
  // exists — in short, `kite` has a legitimate objection to being pushed inward
  // and `flee` is the rung that walks into corners.
  const roomWeight = intent === "flee" ? ROBOT.ROOM_WEIGHT_FLEE : ROBOT.ROOM_WEIGHT;
  let bestInput: MoveInput = CANDIDATES[0];
  let bestScore = -Infinity;
  let standing: { input: MoveInput; total: number } | null = null;

  for (const c of CANDIDATES) {
    // The probe must be the *real* step this input would produce, which since
    // `sim.ts` normalises its movement vector is the same distance in every
    // direction. Measuring it as `c.dx`/`c.dy` instead — probing a diagonal at
    // √2 × step — was a real defect: the diagonal probed 56px against 40px, so
    // it crossed region borders far more often, and since a border crossing
    // saturates the risk term every diagonal was vetoed. Measured: the robot
    // chose a diagonal on 0.0% of 172991 moving frames, purely from that.
    const mag = Math.hypot(c.dx, c.dy) || 1; // idle has no direction
    const ux = c.dx / mag;
    const uy = c.dy / mag;
    const nx = clamp(px + ux * step, 0, view.width);
    const ny = clamp(py + uy * step, 0, view.height);

    // The goal is scored against the displacement actually available, not the
    // raw input. Against a wall the two differ: a candidate pointing into it
    // clamps to no movement at all, and grading the raw input would hand that a
    // full goal reward *and* a zero risk delta, since the probed position is
    // the one already underfoot. A robot cornered while fleeing then picks
    // "push harder into the corner" forever — which is exactly what an earlier
    // revision of this function did, and it is what killed the seed-12345 run.
    //
    // `gx`/`gy` are therefore the unit direction of the step (idle excepted,
    // where both are 0), so the goal term measures *alignment* with the intent
    // rather than how far the candidate happens to travel. That matters: while
    // the probe was un-normalised a diagonal carried a √2-magnitude `gx,gy`, so
    // it collected a 41% larger goal credit than an axis step pointing the same
    // way and won contests it had no business winning.
    const gx = (nx - px) / step;
    const gy = (ny - py) / step;
    const goal = weight * (gx * goalX + gy * goalY);

    // Only the *change* in risk steers — see this function's doc comment. And it
    // steers only: the delta is clamped so a cliff edge cannot veto motion
    // outright, which is what `RISK_CAP` documents at length.
    //
    // **The baseline is simply where the robot is standing.** It used to be the
    // worse of two worlds: `riskAt` honoured the region leash (§6.2), so
    // `hereRisk` and `riskAt(next)` were sums over *different sets* of monsters
    // whenever the step crossed a border, and the delta priced "I changed region"
    // as though it were "I moved toward danger". Measured on the stalled frames:
    // 166863 of 166919 were blocked by risk, 96% of them crossed a border, and
    // the crossing lit a median of 4 monsters the leash had been hiding, taking
    // the raw delta to ~23 and the clamped one to the cap.
    //
    // With the leash gone there is only one world: both sums range over the same
    // monsters, so the delta is a genuine spatial gradient and there is nothing
    // left to reconcile. Crossing a border is now priced as the step it is —
    // cheap if the ground beyond is empty, dear if it is not — and the stall that
    // motivated the whole `max` construction has no mechanism left to happen.
    // The trap factor is applied to `next` *and* to the baseline above, so the
    // delta stays a genuine gradient — of `riskAt × trapAt` rather than of
    // `riskAt`. Weighting only one side would compare two different fields and
    // hand the robot a permanent bonus for wherever it happens to be standing.
    // See `TRAP_WEIGHT`: pricing the corner takes the escape-proof box out of
    // the running as the risk minimum, which is the entire point.
    const delta =
      riskAt(threats, view.hazards, nx, ny, ignoring) * trapAt(nx, ny, view.width, view.height) -
      hereForScore;
    const risk = clamp(delta, -ROBOT.RISK_CAP, ROBOT.RISK_CAP);

    // Standing near a wall is bad on its own account: it removes the directions
    // a kite needs to retreat into, and a corner is where runs end. Quadratic,
    // so it is nearly free in open ground and decisive in a corner — the flat
    // version this replaced was far too weak to outbid a goal pointing outward.
    //
    // **This is a veto, and the room term below is the steer.** The two are not
    // redundant and the division of labour is deliberate: this one is a level
    // that says where the robot may *stand*, squared so it stays out of the way
    // until the edge is genuinely close, while `roomAt` is a gradient that says
    // which way is worth *walking*.
    //
    // The gap between them is the defect the user reported. Across the 40px
    // probe this swings by up to 10 — a step out of the wall band costs nothing
    // while a step into it is charged the full weight — so it is not too weak to
    // be felt. What it cannot do is *pull*: it stops charging once the robot is
    // clear, and a penalty that has already been paid gives no reason to take
    // the next step. Nothing else in the score supplied one either. `flee`'s goal
    // points radially outward and the wall-slide above deletes it, so the
    // outward option is gone; inward is where the monsters are, so risk charges
    // for it; and the tangential residue — the one direction left with neither a
    // penalty nor a cost — is what the robot walks along. Measured: 85% of frames
    // within 70px of an edge and a 33px mean clearance, which is less than the
    // 41px a bomb dodge needs.
    const wall = ROBOT.WALL_WEIGHT * (wallPush(nx, view.width) + wallPush(ny, view.height));

    // Room to maneuver, scored on the heading rather than the position — see
    // `roomAt`. Normalised against `ROOM_REF` and clamped, so this is bounded by
    // `roomWeight` and is exactly zero difference between two candidates in
    // open ground.
    const room =
      roomWeight *
      Math.min(roomAt(nx, ny, ux, uy, view.width, view.height) / ROBOT.ROOM_REF, 1);

    const score = goal - risk - wall + room;

    // ...and a nudge toward repeating last frame. The candidate set is nine
    // discrete directions judged over a 40px probe while the robot advances
    // under 3px, so two of them routinely score within a hair of each other and
    // the winner flips on the next frame's overshoot. See `RobotState.lastDx`
    // for the run that died of it.
    //
    // **Idle is excluded, and that exclusion is the fix for the user's "player
    // 没有跑".** The bonus exists to damp reversals *between two opposite
    // directions*, which is a problem only a moving robot has. Idle is not one
    // of those two directions, and it does not need the help: the strict `>`
    // below already hands it every genuine tie. What it did instead was win
    // contests it had no business winning — and because `lastDx/lastDy` start
    // at `(0, 0)`, idle collected the bonus from the first frame of every run
    // and re-earned it every time it paused. Measured on contact frames: the
    // choosing was 63% lateral and only 22% away, and the idle winner was
    // routinely a candidate scoring 0 against a real move scoring 0.83.
    const moving = c.dx !== 0 || c.dy !== 0;
    const sticky = moving && c.dx === state.lastDx && c.dy === state.lastDy ? ROBOT.HYST : 0;

    // Strict `>` with `CANDIDATES` ordered idle-first: ties fall to the lowest
    // index, so a genuinely indifferent frame stands still instead of jittering.
    const total = score + sticky;
    if (total > bestScore) {
      bestScore = total;
      bestInput = c;
    }
    // The standing direction's own score, for the commitment test below. Idle
    // is not a standing direction — see `HYST`'s note on what letting it hold
    // the bonus did.
    if (moving && c.dx === state.lastDx && c.dy === state.lastDy) {
      standing = { input: c, total };
    }
  }

  // ── Commitment ───────────────────────────────────────────────────────────
  // Keep the direction the robot is already walking unless something beats it
  // outright. This is the fix for §14.6's reversals, and the `standing` capture
  // above is what makes it collectable only by a *moving* repeat — idle is
  // never the standing choice, so it must win on its own score like everything
  // else (see `HYST`).
  //
  // The score is `goal − risk − wall + room`, and the halves are mismatched: the
  // goal term caps at `GOAL[intent]` × ~1.17 ≈ 7 while the risk term clamps at
  // ±`RISK_CAP` = ±12. Risk therefore outbids the goal by 1.7×, and on a 40px
  // probe through five to seven aware monsters the winner flips between two
  // adjacent candidates whenever the risk field's local saddle moves — which,
  // with the monsters walking, is most frames. `HYST` is what has to bridge
  // that gap, and at 1.5 it was a twelfth of the risk swing: far too small.
  //
  // It has to be fixed, not just cosmetically, because the escape mechanic is
  // not per-frame: breaking a hunter's aggro takes ~3.9s of unbroken running,
  // so a robot that reverses every seven frames never accumulates it and the
  // mechanic may as well not exist for it.
  //
  // This was once `MOVE_MARGIN`, a second constant applied right here. It was
  // **the same bonus in the same units** — the previous direction winning ties
  // by an extra margin is exactly what `sticky` already does — so the two were
  // really one knob reading `HYST + MOVE_MARGIN`. Measured: `HYST` 6 with
  // `MOVE_MARGIN` 2 and `HYST` 8 with none produce *byte-identical* sweep
  // output over 96 seeds, on all eight reported statistics. Two knobs for one
  // job is one knob too many, so `MOVE_MARGIN` is gone and `HYST` carries the
  // whole commitment.
  if (standing !== null && bestInput !== standing.input && standing.total >= bestScore) {
    bestInput = standing.input;
  }

  state.lastDx = bestInput.dx;
  state.lastDy = bestInput.dy;

  return { input: { dx: bestInput.dx, dy: bestInput.dy }, intent };
}

/** How many of the perceived monsters the robot currently has numbers for. */
export function revealedCount(view: RobotView): number {
  let n = 0;
  for (const m of view.monsters) if (m.stats) n++;
  return n;
}
