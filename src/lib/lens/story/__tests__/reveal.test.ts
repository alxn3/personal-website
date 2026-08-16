import { describe, expect, it } from "vitest";
import { REVEAL_END, SKY_OUT_END, atFrac, rangeOf } from "../story";
import {
  REVEAL_ROLL_MAX,
  ROLL_P1,
  TURN_MAX,
  TURN_P0,
  TURN_P1,
  revealRollAt,
  rollTurnAt,
  turnAt,
} from "../reveal";
import { trailSweepAt } from "../trails";
import { TRAIL_SWEEP_MAX } from "../../optics/star-trails";
import { flyRevealAt } from "../fly";
// THE CHANNELS THEMSELVES, not copies. These used to be hand-rebuilt
// smoothsteps with the note "rebuilt here rather than imported because the
// driver is DOM-bound" — which was true until the envelopes moved out of
// startHeroStory's closure into story/envelopes.ts. The laws below are now
// pinned against the expressions the hero actually writes.
import { RETURN, assembleAt, explodeAt } from "../envelopes";

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");

const rate = (f: (p: number) => number, p: number, h = 1e-6) =>
  (f(p + h) - f(p - h)) / (2 * h);

describe("the chapter's turn", () => {
  it("is exactly still before its foot — the dive's identity", () => {
    // toBe, not toBeCloseTo: story/constellations.ts's ink is anchored to
    // UNROTATED star directions, and optics/starfield.ts's rodrigues is the
    // identity only at a literal 0. Everything upstream of the trails scene
    // renders bit-for-bit as it did.
    for (const p of [
      0,
      0.5,
      rangeOf("flythrough").p0,
      rangeOf("constellations").p1,
      tR.p0,
      atFrac(tR, 0.24),
      TURN_P0,
    ])
      expect(turnAt(p), `p ${p}`).toBe(0);
  });

  it("completes at SKY_OUT_END — the frame the last of the sky is gone — and stays there", () => {
    // NOT REVEAL_END any more (the owner's fluid-transition correction): the
    // sky now outlives the reveal, so the turn must cruise as long as any arc
    // or disc is drawn, and its one rate step lands where nothing that turns
    // is visible (story/reveal.ts TURN_P1's comment).
    expect(TURN_P1).toBe(SKY_OUT_END);
    expect(TURN_P1).toBeGreaterThan(REVEAL_END);
    expect(turnAt(TURN_P1)).toBeCloseTo(1, 12);
    expect(turnAt(atFrac(rwR, 0.5))).toBeCloseTo(1, 12);
    expect(turnAt(1)).toBeCloseTo(1, 12);
  });

  it("accelerates then CRUISES — it does not decelerate into its edge", () => {
    // the whole point of the shape (owner: "have the trails continue spinning
    // during the transition"). A smoothstep would read ~0 at both of the
    // outer samples here.
    const cruise = rate(turnAt, atFrac(tR, 0.8));
    expect(rate(turnAt, atFrac(tR, 0.26))).toBeLessThan(0.2 * cruise); // leaves at rest
    expect(rate(turnAt, atFrac(tR, 0.9))).toBeCloseTo(cruise, 6); // holding
    expect(rate(turnAt, atFrac(rwR, 0.27))).toBeCloseTo(cruise, 6); // as the arcs go (env out at 0.28)
    expect(rate(turnAt, atFrac(rwR, 0.31))).toBeCloseTo(cruise, 6); // to the end (SKY_OUT_END 0.32)
  });

  it("is monotone, and never overshoots", () => {
    let prev = -1;
    for (let i = 0; i <= 400; i++) {
      const v = turnAt(i / 400);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });
});

describe("the reveal's rotation", () => {
  it("turns the lens in the SKY'S OWN DIRECTION, on its own window and rate", () => {
    // THE OWNER CORRECTION (third round on this beat: "the lens is still not
    // spinning on its axis"). The roll used to be the sky's sweep by identity
    // — and that identity is exactly what kept it unreadable: the shared
    // window spent ~83% of the turn under the body cover and the explode gate
    // killed the rest by rewrap-local 0.22, while the visible reassembly ran
    // five times longer with no rotation at all (measured live, task report).
    // So the DIRECTION stays the sky's (the arcs hand the figure over with the
    // turn's sense unbroken), the shape is the same accel-and-cruise, and the
    // window and amplitude are the roll's own.
    expect(TURN_MAX).toBe(TRAIL_SWEEP_MAX); // the sky's half revolution, still pinned
    for (let i = 0; i <= 40; i++) {
      const p = TURN_P0 + ((TURN_P1 - TURN_P0) * i) / 40;
      // same sign of motion: both the sky's sweep and the roll grow toward
      // their far value — the roll's derivative and the sweep's never oppose
      expect(revealRollAt(p, 1), `p ${p}`).toBeCloseTo(
        -REVEAL_ROLL_MAX * (1 - rollTurnAt(p)),
        12,
      );
      if (i > 0) {
        const dSweep = trailSweepAt(p) - trailSweepAt(p - 1e-5);
        const dRoll = revealRollAt(p, 1) - revealRollAt(p - 1e-5, 1);
        expect(dRoll * dSweep, `direction at ${p}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("ends the roll where the pieces seat — the RETURN's own last frame", () => {
    // ROLL_P1 is spelled from the story table (envelopes.ts imports reveal.ts,
    // so reveal.ts cannot read RETURN back); this is the pin that keeps the
    // two the same frame. The assemble channel lands on exactly 0 there, so
    // the roll's far edge is a DOUBLE zero — angle spent AND gate closed —
    // which is what makes the rate land at 0 with it.
    const [, [endScene, endF]] = RETURN as unknown as [
      [string, number],
      [string, number],
    ];
    expect(ROLL_P1).toBe(atFrac(rangeOf(endScene), endF));
    expect(assembleAt(ROLL_P1)).toBe(0);
    expect(rollTurnAt(ROLL_P1)).toBeCloseTo(1, 12);
    expect(Math.abs(revealRollAt(ROLL_P1, assembleAt(ROLL_P1)))).toBe(0);
  });

  it("winds up NEGATIVE, is UNMISTAKABLE while visible, and gives it all back", () => {
    // the direction: growing toward 0 runs the same way on screen as the sky's
    // turn (measured — +0.3 rad of roll advances every tracked piece's screen
    // angle by +17.2°, and uSkySpin grows the same way).
    expect(revealRollAt(atFrac(rwR, 0.06), 1)).toBeLessThan(0);
    expect(revealRollAt(atFrac(rwR, 0.06), 1)).toBeGreaterThan(
      revealRollAt(tR.p0, 1),
    );
    // THE VISIBLE BUDGET — the number the owner's complaint was about. On the
    // frame the crossfade opens, the roll still to be given back must be a
    // clear half revolution's worth (> 90° is the floor; the shipped default
    // is ~180°), because everything spent before this frame is spent under
    // the body cover and might as well not exist.
    const atOpen = Math.abs(
      revealRollAt(atFrac(rwR, 0.06), assembleAt(atFrac(rwR, 0.06))),
    );
    expect(atOpen).toBeGreaterThan(Math.PI / 2);
    // …and it is still visibly alive DEEP into the reassembly (the old gate
    // was dead here at < 1°, which is what read as "not spinning")
    const midAssembly = Math.abs(
      revealRollAt(atFrac(rwR, 0.6), assembleAt(atFrac(rwR, 0.6))),
    );
    expect(midAssembly).toBeGreaterThan(Math.PI / 8);
    // NOT SPENT AT REVEAL_END ANY MORE — deliberately. The camera chain that
    // releases there leaves at zero rate (story/camera.ts moveS), so a lens
    // still rolling under it is the "one gesture" the owner asked the ending
    // to be; the roll's own zero is ROLL_P1 (pinned above).
    expect(revealRollAt(REVEAL_END, assembleAt(REVEAL_END))).toBeLessThan(0);
  });

  it("is EXACTLY 0 wherever the wrap is home", () => {
    // the assemble channel is the second factor, so the whole story before the
    // teardown — the dive included — is bit-for-bit unrolled whatever the turn
    // is doing. (Math.abs only because −k × 1 × 0 is −0, which is 0 to every
    // arithmetic that reads it and not to Object.is — story/trails.ts's own
    // pole case has the same wrinkle.)
    for (const p of [0, 0.3, rangeOf("flythrough").p0, 1])
      expect(Math.abs(revealRollAt(p, 0)), `p ${p}`).toBe(0);
    // …and the channel itself is 0 on those frames, so the composed write is
    for (const p of [0, rangeOf("flythrough").p0, 1])
      expect(assembleAt(p), `assemble at ${p}`).toBe(0);
  });

  it("stays 0 through the CARDS scene's wrap, which is not this chapter's", () => {
    // THE SECOND WRAP. story/envelopes.ts CARDS_WRAP plays the same reassembly
    // as the cards scene's transition, so the assemble channel is no longer a
    // proxy for "the sky chapter is running": below TURN_P0 the `1 − rollTurnAt`
    // factor sits at FULL amplitude, and an ungated law would have spun the
    // model a fifth of a revolution through that scene. The chapter mask is
    // what keeps this beat the sky's alone.
    const cards = rangeOf("cards");
    const mid = atFrac(cards, 0.5);
    expect(assembleAt(mid), "the channel really is live there").toBeGreaterThan(
      0.5,
    );
    for (let i = 0; i <= 40; i++) {
      const p = atFrac(cards, i / 40);
      expect(Math.abs(revealRollAt(p, assembleAt(p))), `cards ${i / 40}`).toBe(
        0,
      );
    }
    // …and the mask's own edge is free: the tail wrap's channel is still
    // exactly 0 where it lifts, so the hard step multiplies zero by zero
    const trails = rangeOf("trails");
    expect(assembleAt(trails.p0)).toBe(0);
    expect(Math.abs(revealRollAt(trails.p0, assembleAt(trails.p0)))).toBe(0);
  });

  it("holds the pieces at FULL EXPLOSION for the WHOLE reveal, and past it", () => {
    // the owner's second note ("it doesn't start from the fully expanded state
    // with the shell pieces sitting on the larger radius"). The fall used to
    // open inside the reveal window itself (rewrap-local 0.12, against
    // story/fly.ts flyRevealAt's [0.06, 0.16]); with the collapse moved to the
    // ending (story/envelopes.ts CONSTRUCT), the channel is exactly 1 from the
    // crossfade to the LAST FRAME OF THE SCENE — a strictly stronger version of
    // the same law, so it is pinned as one.
    const open = atFrac(rwR, 0.06);
    expect(flyRevealAt(open)).toBe(0);
    expect(explodeAt(open)).toBe(1);
    expect(rate(explodeAt, open)).toBe(0);
    for (let i = 0; i <= 40; i++)
      expect(explodeAt(atFrac(rwR, i / 40)), `rewrap ${i / 40}`).toBe(1);
    expect(explodeAt(rwR.p1)).toBe(1);
    // …with the roll the only thing moving across it
    expect(revealRollAt(atFrac(rwR, 0.1), 1)).toBeGreaterThan(
      revealRollAt(open, 1),
    );
  });

  it("advances monotonically and lands at zero RATE — no snap anywhere", () => {
    // C1 by construction (both factors are C1, and a product of C1 functions
    // is C1) — and unlike the explode-gated version there is no seam inside
    // the visible window at all: the gate (assembleAt) is one smoothstep fall
    // across the whole stretch. Walked for monotonicity from the cover's lift
    // to the seat, and pinned at the far edge, where the double zero (turn
    // spent AND channel home) lands the rate itself at 0.
    const roll = (p: number) => revealRollAt(p, assembleAt(p));
    let prev = roll(atFrac(rwR, 0.02));
    for (let i = 1; i <= 900; i++) {
      const p = atFrac(rwR, 0.02) + ((ROLL_P1 - atFrac(rwR, 0.02)) * i) / 900;
      const v = roll(p);
      expect(v, `roll advances at p ${p}`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    const cruise = rate(roll, atFrac(rwR, 0.08));
    expect(rate(roll, ROLL_P1 - 1e-4)).toBeLessThan(cruise / 100);
    expect(rate(roll, ROLL_P1 + 1e-4)).toBe(0);
    expect(Math.abs(roll(ROLL_P1))).toBe(0);
    expect(Math.abs(roll(1))).toBe(0);
  });
});
