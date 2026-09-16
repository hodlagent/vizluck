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

import { bombLanding, regionIndexAtPoint, TUNING, type SimState } from "./sim";
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
  /** Home region index — derivable from the grid painted on the floor. */
  region: number;
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
      region: m.region,
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
   * rather than a design.** A saturated risk delta — which a region-border probe
   * produces routinely, see `KITE_CONTACT_WEIGHT` — can therefore outvote any
   * of them, so "risk steers, never vetoes" (this file's own words, and the
   * comment on `RISK_CAP`) is not actually true of any rung here. `flee` used to
   * be the exception at 14; it is not any more, because 6 measured better on
   * every survival axis (over 96 seeds: mean 6.57x against 6.36x, median 6.49x
   * against 6.44x, worst 3.56x against 0.09x, 96/96 runs reaching the cap
   * against 93/96). The one place
   * that genuinely needs to clear the cap now says so explicitly, in
   * `KITE_CONTACT_WEIGHT`.
   *
   * The margin is thinner than it was recorded at (the flee-14 arm used to lose
   * 7 seeds to the cap, now it loses 3, and its median is within 0.05x of 6's)
   * — but the tail is what this knob is for, and the 0.09x worst seed is a
   * robot that dies almost immediately while standing still, which no median
   * hides. Re-measured after the ballistics change (§15); both arms on the same
   * 96 seeds.
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
   * Weight of the ring goal once the target is inside its own `reach`.
   *
   * **This is the half of the fix for the user's "怪物冲到player面前了，
   * player没有跑", and it has to be at least `RISK_CAP`.** The ring goal was
   * never wrong — with `dotAway` 0.99 it points away about as well as a
   * direction can — it simply lost the vote. Over a `PROBE_S` step of ~40px the
   * risk term is dominated by a single discontinuity: `riskAt` honours the
   * region leash, so a probe that crosses a border reports the risk of a
   * *different region*, worth +55 in the measured frames and clamped to
   * `RISK_CAP` 12. The robot stood 29px from a border with two 260-sense
   * hunters just beyond it, so the one direction that would have opened the gap
   * was scored against monsters that could not touch it yet: goal 5.53 against
   * risk 8.17 at `GOAL.kite` 6, and 15.5 against 8.17 here.
   *
   * Measured over 96 seeds, sweeping the weight on the ballistics build (§15):
   * 6 → 44%, 10 → 37%, **12 → 66%**, 14 → 69%. The shape is the one claimed — a
   * step between 10 and 12, where the goal credit first matches a saturated risk
   * delta — but the step is to 66%, not to the 81% recorded here before the
   * `KITE_BAND` fix moved the contact-frame count (§14.2), and **14 no longer
   * costs anything measurable**: every arm reaches the cap on 96/96 seeds with
   * worst case 3.56x. So 12 is kept as the *cheapest* weight that clears the cap
   * rather than as a strictly better one. The 12-to-14 gap (66% against 69%) is
   * small enough that moving would need an argument of its own, and this change
   * did not make one. The number is still not tuned — it is `RISK_CAP`, and the
   * step exists because that is where a saturation stops being one.
   *
   * Deliberately **not** `GOAL.flee`. They were the same knob for one revision
   * and should not be: at `GOAL.flee` 6 the survival tail is markedly better
   * (worst 3.56x, 96/96 runs reaching the 10-minute cap) than at 14 (worst
   * 0.09x, 93/96), while the escape rate wants a weight of at least 12. The two
   * requirements pull in opposite directions and are now separate.
   */
  KITE_CONTACT_WEIGHT: 12,
  /**
   * How much of the kite goal is a tangential (orbiting) bias rather than a
   * radial correction. Without it the robot walks straight backwards until a
   * wall stops it; with it, it circles the target instead.
   */
  ORBIT: 0.6,

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
   * `PANIC` and `KITE_SAFE_RISK` are in the risk field's own units —
   * `dps × CHASE × proximity` — so they are **coupled to `CHASE`** and must be
   * re-tuned with it, not held fixed. The natural yardstick is one hunter at the
   * edge of its reach, which the default constants put at
   * `PRIOR_DPS × CHASE` = 28.8. A brute reads 32.4 at its reach and 64.8 at zero
   * distance.
   */

  /**
   * Risk at the current spot above which the robot abandons the fight entirely
   * and runs for another region.
   *
   * This is the *emergency* exit, and it is deliberately high enough that an
   * ordinary scrap never reaches it: 44 is above one hunter's reach-risk (28.8)
   * and one brute's (32.4), and means "a brute is inside its reach and close",
   * "two hunters", or worse. Contact below that is `kite`'s job, not `flee`'s.
   *
   * **It used to be 16, and that was the bug the user reported.** The trigger
   * was `hereRisk > PANIC || hereRisk > KITE_MAX_RISK`, and since
   * `KITE_MAX_RISK` was 9 the second clause silently swallowed the first — so
   * *any* contact at all (one wanderer at its reach is 12) fired a full retreat
   * to another region. Combined with a `flee` goal that pointed at a region
   * centre, the robot walked *through* the monster hitting it to get there:
   * measured over 24 seeds, it closed the gap on 50.3% of all frames where a
   * monster was inside its own `attackRange`, and on 76.8% of those frames where
   * the refuge happened to lie behind the attacker. See `FLEE_RADIAL`.
   */
  PANIC: 44,
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
   * The hysteresis gap against `PANIC`, and the reason a retreat is committed
   * rather than re-litigated every frame. Measured: a hunter raises risk to 9.6
   * inside its reach and drops it to 2.9 thirty pixels out, so a bang-bang
   * controller turns around every half second and never covers the ground to
   * anywhere safer.
   */
  KITE_SAFE_RISK: 4.5,
  /**
   * Score bonus for repeating last frame's input, in the same units as the
   * goal weights.
   *
   * **This damps the robot's twitch; it does not cure it, and it is worth being
   * precise about which.** Every frame is judged over a `PROBE_S` step of ~40px
   * while the robot actually advances ~2.8px, so it is forever committing to a
   * long move, overshooting, and committing to the reverse. The sticky bonus
   * removes the *cheap* reversals — the ones between two nearly-tied candidates
   * — which cuts the reversal rate from 0.74 of moving frames to 0.61 and is
   * worth a little survival and a lot of kills on its own.
   *
   * It does not remove the expensive ones. Where the risk field differs sharply
   * between the two probed endpoints the reverse still wins by more than the
   * bonus, and the robot will oscillate between two positions ~6px apart for up
   * to ~13s of net-zero motion. Worse, raising this value *lengthens* those
   * episodes (measured, the worst streak grows 747 → 1817 frames from 3 → 8)
   * because a larger bonus locks the robot into the cycle more firmly, and past
   * ~20 it stops moving entirely. So this is deliberately small — 1.5, the
   * bottom of the useful band — and §14.6 records the cycle as an open defect
   * that belongs to the probe/step ratio, not to this constant.
   */
  HYST: 1.5,
  /**
   * Weight of the *radial* half of a retreat — straight away from the nearest
   * threat.
   *
   * This is the primary escape component, and promoting it is the fix for the
   * user's report. The old goal was the refuge region's centre and nothing else,
   * so when the refuge lay behind the attacker the robot walked into it: the
   * goal carried a weight of 14 against a risk delta clamped at `RISK_CAP` 12,
   * and the 0.12 nudge meant to correct that was two orders of magnitude too
   * small to matter.
   */
  FLEE_RADIAL: 1,
  /**
   * Weight of the *tangential* half of a retreat, oriented toward the refuge.
   *
   * Same trick as the kite's orbit, for the same reason: it turns "run through
   * the monster" into "curve around it". Without it a retreat pushed straight
   * back is a retreat into whichever wall is behind the robot.
   */
  FLEE_ORBIT: 0.6,
  /**
   * Charge per pixel for running to a refuge region, so the robot prefers a
   * mediocre region next door to an empty one across the arena. Small: a full
   * crossing costs less than one brute.
   */
  REFUGE_DIST: 0.04,
  /**
   * How close something must be for low hp alone to justify disengaging.
   *
   * Without this the robot flees on `hpFrac` alone, which is a real trap: hp
   * stays low until regen refills it, so a wounded robot whose nearest monster
   * is a leashed stranger 240px away would flee forever, from nothing, instead
   * of looting or regenerating. Roughly a hunter's sense range — inside it, a
   * monster has noticed you; outside it, you are not in a fight.
   */
  DISENGAGE_RADIUS: 220,

  /** Inside this radius a monster is worth farming rather than ignoring. */
  FARM_RADIUS: 260,

  /**
   * Weight on the wall penalty. The per-axis term is squared, so this is the
   * cost of standing *in* a corner (2 of them) and falls off to nothing at
   * `WALL_MARGIN`. Big enough to outbid a goal weight pointing outward, which
   * is what lets a cornered robot walk out instead of pressing itself flat.
   */
  WALL_MARGIN: 70,
  WALL_WEIGHT: 10,
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
 * The policy's one piece of memory: whether it is currently disengaging.
 *
 * This exists because a threshold on instantaneous risk is a bang-bang
 * controller, and a bang-bang controller cannot retreat. Measured: a single
 * hunter raises risk to 9.6 inside its reach and drops it to 2.9 thirty pixels
 * further out, so a robot that starts fleeing at one number and stops at the
 * other turns around every half second and never covers the couple of hundred
 * pixels to anywhere safer. It dies in the middle, oscillating.
 *
 * Note what is *not* here: nothing about monsters. Requirement 5's reveal is
 * still recomputed from scratch every frame and never remembered — `perceive`
 * is pure and the view is the whole of what the robot knows about the world.
 * This is the policy remembering its own decision, which is a different thing,
 * and it is deliberately one boolean wide.
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
}

export function createRobotState(): RobotState {
  return { retreating: false, lastDx: 0, lastDy: 0 };
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
 * The centre of the region worth running to.
 *
 * Disengaging cannot be left to the risk term, which is why this exists. Risk
 * is probed a quarter-second ahead — about 40px — and a region border worth
 * crossing is usually further than that, so from anywhere but the edge of a
 * region the risk gradient says nothing about the border at all. The earlier
 * revision steered by "run away from the crowd" instead, which is worse: it is
 * pure geometry with no idea that monsters are leashed (§6.2), so it fled a
 * losing fight in the centre straight into a fresh region's population.
 *
 * What is left is the honest question — *which region is safest* — and it is
 * answerable from public information alone: the borders are painted on the
 * floor, and the monsters standing in each region are visible. Cost is that
 * region's population plus a charge for the run, so the robot prefers a nearby
 * mediocre region to a distant empty one.
 *
 * Un-revealed monsters are priced at the same conservative prior as everywhere
 * else; revealed ones at what they actually deal.
 */
function refugeRegion(
  view: RobotView,
  threats: readonly Threat[],
  px: number,
  py: number,
): { cx: number; cy: number } | null {
  const cw = view.width / 3;
  const ch = view.height / 3;
  const danger = new Array<number>(9).fill(0);
  for (const t of threats) danger[t.m.region] += t.dps;

  let best: { cx: number; cy: number } | null = null;
  let bestCost = Infinity;
  for (let r = 0; r < 9; r++) {
    const cx = ((r % 3) + 0.5) * cw;
    const cy = (Math.floor(r / 3) + 0.5) * ch;
    const cost = danger[r] + ROBOT.REFUGE_DIST * Math.hypot(cx - px, cy - py);
    if (cost < bestCost) {
      bestCost = cost;
      best = { cx, cy };
    }
  }
  return best;
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
 * Choose what to farm.
 *
 * The user's ask: "移动到某个/某群怪物附近……尝试去攻击最近的那个，或者附近聚集
 * 起来最多的那群" — the nearest monster, or the biggest cluster of them. So the
 * score trades distance against company, and what it buys is a reason to walk
 * past a lone wanderer and set up on a knot of three.
 *
 * **Reachability comes first, and it is a filter rather than a weight.** A
 * monster whose home region is ours can chase us and we can reach it without
 * ever changing jurisdiction; one across a border cannot, and going to it means
 * paying the region step — which is precisely where the robot used to stall at
 * 56px against a 55px range, one pixel short of attacking, forever. So if there
 * is anything at all in our own region the pool is that, and only an empty
 * region sends us hunting abroad.
 *
 * Within the pool: `pack` counts the monsters clustered around a candidate, and
 * distance is charged against it. Both numbers come from the public view — the
 * same positions a human reads off the canvas (§14.1).
 */
function pickTarget(
  view: RobotView,
  threats: readonly Threat[],
  hereRegion: number,
): Threat | null {
  if (threats.length === 0) return null;
  const home = threats.filter((t) => t.m.region === hereRegion);
  const pool = home.length > 0 ? home : threats;

  let best: Threat | null = null;
  let bestScore = -Infinity;
  for (const t of pool) {
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
  return best;
}

/**
 * Expected damage per second taken by standing at `(x, y)`.
 *
 * Summed over monsters, with two rules that carry the whole policy:
 *
 * 1. **The leash term.** A monster contributes nothing to a position outside
 *    its *home* region, because it cannot follow the player across the border
 *    (§6.2). This is what makes "step over the line" a real move in the robot's
 *    repertoire rather than a coincidence — and it is public information: the
 *    borders are painted on the floor and the leash is plainly observable.
 *
 * 2. **The proximity curve.** `dps` is what a monster deals once it has you, but
 *    standing at the edge of its reach is not the same as standing at the edge
 *    of its notice: the closer it is, the less room there is to leave. So the
 *    field is `dps × CHASE × proximity`, where `proximity` is 1 at `reach`,
 *    falls to 0 at `senseRange`, and climbs inside `reach` as the gap closes.
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
 * Hazards (design §15) are summed alongside the monsters but obey neither of
 * those rules, because neither is true of them. There is no leash: a bomb is
 * already in the air and will go off wherever it lands, so crossing a region
 * border is no shelter from it — the leash exists because a monster cannot
 * follow you (§6.2), and an explosion is not following anything. And there is no
 * falloff *past* the edge: a blast is a hard boundary, not a gradient of
 * likelihood, so the sum stops dead at `reach` instead of trailing off to
 * `senseRange`. Inside it the same proximity curve applies, since "dead centre
 * is worse than the rim" is as true of a circle of ground as of a monster's
 * reach.
 */
function riskAt(
  view: RobotView,
  threats: readonly Threat[],
  hazards: readonly Hazard[],
  x: number,
  y: number,
  exclude: number | null = null,
  regionOverride: number | null = null,
): number {
  const region =
    regionOverride ?? regionIndexAtPoint(view.width, view.height, x, y);
  let risk = 0;
  for (const t of threats) {
    if (t.m.id === exclude) continue;
    if (t.m.region !== region) continue; // the leash
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
  // *commitments* below are made on — panic, the retreat latch, whether a potion
  // is worth walking to — and those are judgments about whether to stay in the
  // fight, not about where to put a foot. A bomb is a 0.3s event that the ground
  // under the robot is about to have; if it counted here it would read as
  // `PANIC` (108 against a threshold of 44), trigger a committed retreat, and
  // send the robot running for another region because a brute threw something.
  // Stepping out of the circle is the whole correct response, and that is what
  // the candidate deltas below do with it.
  const hereRisk = riskAt(view, threats, NO_HAZARDS, px, py);

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
  // `target` is what the kite and roam rungs actually walk toward.
  const hereRegion = regionIndexAtPoint(view.width, view.height, px, py);
  let nearest: Threat | null = null;
  for (const t of threats) {
    if (nearest === null || t.dist < nearest.dist) nearest = t;
  }
  const target = pickTarget(view, threats, hereRegion);

  // Three ways to decide a fight is not worth having. `PANIC` is "this is
  // overwhelming" — a brute on top of us, or a pack — and it is high enough that
  // an ordinary scrap never reaches it, because contact below it is the kite
  // rung's job. The other is low hp with something actually close: firing on
  // `hpFrac` alone means fleeing leashed strangers across the arena that are not
  // chasing and cannot reach.
  //
  // Note what is *not* here any more: a threshold on everyday contact. The old
  // trigger was `hereRisk > PANIC || hereRisk > KITE_MAX_RISK` with PANIC at 16
  // and KITE_MAX_RISK at 9, so the second clause swallowed the first and any
  // single monster in reach sent the robot running for another region — through
  // the monster, since that was where the goal pointed. See `PANIC`.
  const toCentre = unitTo(px, py, view.width / 2, view.height / 2);
  const healDist = bestHeal
    ? Math.hypot(bestHeal.item.posX - px, bestHeal.item.posY - py)
    : Infinity;
  const healIsNearerThanDanger = bestHeal !== null && (nearest === null || healDist < nearest.dist);
  const threatened =
    hereRisk > ROBOT.PANIC ||
    (hpFrac < ROBOT.FLEE_HP &&
      nearest !== null &&
      nearest.dist <= ROBOT.DISENGAGE_RADIUS);

  // Latch it. Entering is easy; leaving needs the risk to actually be gone, so
  // the retreat is committed rather than re-litigated every frame. The gap
  // between the two thresholds is the whole point — see `RobotState`.
  if (threatened) state.retreating = true;
  else if (hereRisk < ROBOT.KITE_SAFE_RISK) state.retreating = false;
  const inDanger = state.retreating;

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
    // Disengaging: straight away from what is on us, curving toward the safest
    // region. The radial half leads so the escape never routes through the
    // attacker; the tangential half, oriented toward the refuge, is what stops
    // a retreat from being a straight backpedal into the wall behind.
    intent = "flee";
    const refuge = refugeRegion(view, threats, px, py);
    if (nearest) {
      const away = unitTo(nearest.m.posX, nearest.m.posY, px, py);
      if (away) {
        goalX = ROBOT.FLEE_RADIAL * away[0];
        goalY = ROBOT.FLEE_RADIAL * away[1];
        const toRef = refuge ? unitTo(px, py, refuge.cx, refuge.cy) : null;
        if (toRef) {
          // Perpendicular to the escape line, oriented by whichever side also
          // leads to the refuge. Same construction as the kite's orbit.
          const tx = -away[1];
          const ty = away[0];
          const s = tx * toRef[0] + ty * toRef[1] < 0 ? -1 : 1;
          goalX += ROBOT.FLEE_ORBIT * s * tx;
          goalY += ROBOT.FLEE_ORBIT * s * ty;
        }
      }
    } else if (refuge) {
      // Nothing on us but still latched (the hp clause, usually): just go.
      const u = unitTo(px, py, refuge.cx, refuge.cy);
      if (u) {
        goalX = u[0];
        goalY = u[1];
      }
    }
    if (Math.hypot(goalX, goalY) < 1e-6 && toCentre) {
      // Standing on top of it: fall back to the middle, which at least is not a
      // corner.
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
    // to get out of step with the "retreat" one.
    intent = "kite";
    const u = unitTo(px, py, target.m.posX, target.m.posY);
    if (u) {
      const desired = clamp(
        p.attackRange - ROBOT.STANDOFF_MARGIN,
        target.reach + ROBOT.BAND,
        p.attackRange - 2,
      );
      // Proportional, not a sign: at the ring the radial term vanishes and the
      // robot orbits instead of chattering between "in" and "out".
      //
      // The error is normalised *asymmetrically*, and that is load-bearing.
      // Outside the ring it saturates at the distance we are outside our **own
      // attack range**; inside it saturates at the target's own reach. Measured:
      // with a single symmetric band of 30 the radial term was still only 0.567
      // at a brute's reach — weaker than the 0.6 orbit — so the robot circled a
      // monster while it was being hit, which is 72% of all contact frames.
      // Saturating at `reach` means the retreat is at full strength exactly when
      // the target starts landing blows, and the radial term (1.0) then outranks
      // the orbit (0.6) as it must.
      //
      // The outside band used to be `KITE_BAND` 30, and that was wrong in the
      // same way, just in the direction nobody had measured. An error of 30
      // means the radial term only reaches 0.6 — parity with the orbit — at 18px
      // outside the ring, i.e. 69px from the target. Since our range is 55px,
      // *the robot could orbit permanently outside its own attack range*: it
      // circled a stationary monster at 58px and never once hit it. Saturating
      // over `ourRange − desired` — the width of the band in which we are
      // outside our own reach, 4px as shipped — puts the radial term at full
      // strength for the whole approach and lets the ring, not the orbit,
      // decide when to stop. See the "with nothing in range" check.
      const err =
        target.dist >= desired
          ? clamp(
              (target.dist - desired) / Math.max(1, p.attackRange - desired),
              0,
              1,
            )
          : -clamp(
              (desired - target.dist) / Math.max(1, desired - target.reach),
              0,
              1,
            );
      // Perpendicular to the target direction, oriented by whether it also
      // carries the robot toward the middle of the arena. That is what stops a
      // kite from spiralling into a corner and dying there.
      const tx = -u[1];
      const ty = u[0];
      const s = toCentre && tx * toCentre[0] + ty * toCentre[1] < 0 ? -1 : 1;
      goalX = err * u[0] + ROBOT.ORBIT * s * tx;
      goalY = err * u[1] + ROBOT.ORBIT * s * ty;
    }
  } else {
    // Nothing nearby worth having: go and find something. Positions are public,
    // so "the nearest monster" is always answerable and the robot never idles.
    intent = "roam";
    if (target) {
      const u = unitTo(px, py, target.m.posX, target.m.posY);
      if (u) {
        goalX = u[0];
        goalY = u[1];
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
  // farming, and `KITE_CONTACT_WEIGHT` below owns that case.
  const ignoring =
    (intent === "kite" || intent === "roam") && target !== null && target.dist > p.attackRange
      ? target.m.id
      : null;
  const hereForScore =
    ignoring === null
      ? riskAt(view, threats, view.hazards, px, py)
      : riskAt(view, threats, view.hazards, px, py, ignoring);
  // Hazards *are* in this baseline, unlike in the `hereRisk` above, and both
  // halves of that are deliberate. The delta is measured against where the robot
  // is standing, so a bomb underfoot has to be in the baseline for stepping out
  // of the circle to register as the gain it is: with the baseline monster-only,
  // leaving a bomb would be priced as pure monster gradient and could tie with
  // simply standing in it — and ties fall to idle. In the baseline, standing
  // still scores 0 and every step out of the circle scores a clamped reward, so
  // "move" wins the frame the reticle appears.
  // A ring that has already been breached is a retreat, not a farm, and it has
  // to be priced like one — at `KITE_CONTACT_WEIGHT`, which is `RISK_CAP` and
  // therefore the cheapest bid that can outvote a saturated risk delta. Nothing
  // else changes: the ring still converges on `desired`, so the robot backs off
  // to just inside its own reach and stops there rather than leaving the region,
  // which is the "慢慢远离怪物，但是又不能跑的太远" the user asked for. Gated on
  // `reach` rather than on the ring, because `reach` is the moment blows start
  // landing and the moment this has to be decisive. See the constant for the
  // measurements.
  const weight =
    intent === "kite" && nearest !== null && nearest.dist <= nearest.reach
      ? ROBOT.KITE_CONTACT_WEIGHT
      : ROBOT.GOAL[intent];
  let bestInput: MoveInput = CANDIDATES[0];
  let bestScore = -Infinity;

  for (const c of CANDIDATES) {
    // The probe must be the *real* step this input would produce, which since
    // `sim.ts` normalises its movement vector is the same distance in every
    // direction. Measuring it as `c.dx`/`c.dy` instead — probing a diagonal at
    // √2 × step — was a real defect: the diagonal probed 56px against 40px, so
    // it crossed region borders far more often, and since a border crossing
    // saturates the risk term every diagonal was vetoed. Measured: the robot
    // chose a diagonal on 0.0% of 172991 moving frames, purely from that.
    const mag = Math.hypot(c.dx, c.dy) || 1; // idle has no direction
    const nx = clamp(px + (c.dx / mag) * step, 0, view.width);
    const ny = clamp(py + (c.dy / mag) * step, 0, view.height);

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
    // **The baseline is the worse of the two worlds, and that is what lets the
    // robot approach across a border at all.** `riskAt` honours the region leash
    // (§6.2), so `hereRisk` and `riskAt(next)` are sums over *different sets* of
    // monsters whenever the step crosses a border — the delta then prices "I
    // changed region" as though it were "I moved toward danger". Measured on the
    // stalled frames: 166863 of 166919 were blocked by risk, 96% of them crossed
    // a border, and the crossing lit a median of 4 monsters that the leash had
    // been hiding, taking the raw delta to ~23 and the clamped one to the cap.
    //
    // Taking `max` of the two worlds fixes it without weakening the field.
    // Crossing into a *worse* region stops being a cliff, because the baseline
    // rises to that region's own value — leaving only the genuine gradient
    // within it. Crossing into a *better* one keeps its full reward, because the
    // baseline stays at the worse world being left, so escaping a region that is
    // hunting you is worth exactly what it was worth before. Both directions
    // become "priced in whichever world is more dangerous", which is the
    // conservative reading and the one that does not confuse a change of
    // jurisdiction with a change of position.
    const destRegion = regionIndexAtPoint(view.width, view.height, nx, ny);
    // ...but only for the *deliberate approach*, never as a general licence to
    // cross. Applied to every candidate it is catastrophic, and measurably so:
    // the robot stops paying for jurisdiction changes anywhere, wanders into
    // whichever region looks cheapest to enter, and gets surrounded — median
    // survival 7.14x -> 4.68x, seeds reaching the cap 96/96 -> 50/96, worst seed
    // 3.59x -> 0.33x, while kills *rose* 7169 -> 10734. Greedy and dead.
    //
    // Scoped to a step that closes on the committed target, it fixes exactly the
    // defect and nothing else. What makes that safe rather than a loophole is
    // that the target's endpoint is the ring, and the ring is outside the
    // target's own reach by construction — so the approach has a stop condition
    // the robot has already agreed to. Every *other* monster is still priced in
    // full at the destination, border or no border, which is why this cannot
    // walk it into a pack: the pack is not the target, so the pack still votes.
    const toward =
      ignoring !== null &&
      target !== null &&
      Math.hypot(target.m.posX - nx, target.m.posY - ny) < target.dist - 0.01;
    const base =
      !toward || destRegion === hereRegion
        ? hereForScore
        : Math.max(hereForScore, riskAt(view, threats, view.hazards, px, py, ignoring, destRegion));
    const delta = riskAt(view, threats, view.hazards, nx, ny, ignoring) - base;
    const risk = clamp(delta, -ROBOT.RISK_CAP, ROBOT.RISK_CAP);

    // Standing near a wall is bad on its own account: it removes the directions
    // a kite needs to retreat into, and a corner is where runs end. Quadratic,
    // so it is nearly free in open ground and decisive in a corner — the flat
    // version this replaced was far too weak to outbid a goal pointing outward.
    const wall = ROBOT.WALL_WEIGHT * (wallPush(nx, view.width) + wallPush(ny, view.height));

    const score = goal - risk - wall;

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
    if (score + sticky > bestScore) {
      bestScore = score + sticky;
      bestInput = c;
    }
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
