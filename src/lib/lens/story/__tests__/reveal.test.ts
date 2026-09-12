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
import { flyBodyFadeAt, flyRevealAt } from "../fly";
// THE CHANNELS THEMSELVES, not copies: the laws below are pinned against the
// expressions the hero actually writes.
import { assembleAt, explodeAt, shellFadeAt } from "../envelopes";

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");
const capR = rangeOf("capsOn");

const rate = (f: (p: number) => number, p: number, h = 1e-6) =>
  (f(p + h) - f(p - h)) / (2 * h);

describe("the chapter's turn", () => {
  it("is exactly still before its foot — the dive's identity", () => {
    // toBe, not toBeCloseTo: the constellation ink is anchored to UNROTATED
    // star directions and the rodrigues turn is the identity only at literal 0.
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
    // The sky outlives the reveal, so the turn cruises as long as any arc or
    // disc is drawn and its one rate step lands where nothing turning is shown.
    expect(TURN_P1).toBe(SKY_OUT_END);
    expect(TURN_P1).toBeGreaterThan(REVEAL_END);
    expect(turnAt(TURN_P1)).toBeCloseTo(1, 12);
    expect(turnAt(atFrac(rwR, 0.5))).toBeCloseTo(1, 12);
    expect(turnAt(1)).toBeCloseTo(1, 12);
  });

  it("accelerates then CRUISES — it does not decelerate into its edge", () => {
    // the trails keep spinning through the transition; a smoothstep would read
    // ~0 at both of the outer samples here
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
    // The DIRECTION is the sky's (the arcs hand the figure over with the turn's
    // sense unbroken) and the shape is the same accel-and-cruise, but the
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

  it("ends the roll where the REWRAP does — the descent opens on a still model", () => {
    // The carrier (explode) is a saturated 1 across this scene, so the roll's
    // far edge is the TURN's alone: `rollTurnAt` reaches exactly 1 on the scene
    // boundary and comes off cruise into it, landing angle AND rate on zero.
    expect(ROLL_P1).toBe(rwR.p1);
    expect(ROLL_P1).toBe(rangeOf("capsOn").p0);
    expect(rollTurnAt(ROLL_P1)).toBe(1);
    expect(explodeAt(ROLL_P1)).toBe(1);
    expect(Math.abs(revealRollAt(ROLL_P1, explodeAt(ROLL_P1)))).toBe(0);
    // …and it stays exactly 0 for the whole descent, whatever the spread does
    const capR = rangeOf("capsOn");
    for (let i = 0; i <= 20; i++) {
      const p = atFrac(capR, i / 20);
      expect(Math.abs(revealRollAt(p, explodeAt(p))), `capsOn ${i / 20}`).toBe(
        0,
      );
    }
  });

  it("keeps the WRAP out of the ending entirely — one recipe holds the cloud", () => {
    // The parked pose must be RIGID, and it cannot be while two saturated
    // recipes sum their deltas onto one wedge. The wrap therefore runs over the
    // cards chapter and nowhere else: assemble is a literal 0 through the
    // ending, so the cloud and its descent are the explode recipe's alone.
    for (let i = 0; i <= 40; i++) {
      expect(assembleAt(atFrac(rwR, i / 40)), `rewrap ${i / 40}`).toBe(0);
      expect(assembleAt(atFrac(capR, i / 40)), `capsOn ${i / 40}`).toBe(0);
    }
    expect(assembleAt(rwR.p1)).toBe(0);
    expect(assembleAt(1)).toBe(0);
    // …and it really does run somewhere: the cards chapter, saturated
    const cards = rangeOf("cards");
    expect(assembleAt(atFrac(cards, 0.05))).toBe(1);
  });

  it("winds up NEGATIVE, is UNMISTAKABLE while visible, and gives it all back", () => {
    // the direction: growing toward 0 runs the same way on screen as the sky's
    // turn, and uSkySpin grows the same way
    expect(revealRollAt(atFrac(rwR, 0.06), 1)).toBeLessThan(0);
    expect(revealRollAt(atFrac(rwR, 0.06), 1)).toBeGreaterThan(
      revealRollAt(tR.p0, 1),
    );
    // THE VISIBLE BUDGET: on the frame the crossfade opens, the roll still to
    // be given back must be a clear half revolution's worth, since everything
    // spent before it is spent under the body cover.
    const atOpen = Math.abs(
      revealRollAt(atFrac(rwR, 0.06), explodeAt(atFrac(rwR, 0.06))),
    );
    expect(atOpen).toBeGreaterThan(Math.PI / 2);
    // …and still visibly alive DEEP into the reassembly. The 15° floor is what
    // is left once the same angle is given back over the shorter window.
    const midAssembly = Math.abs(
      revealRollAt(atFrac(rwR, 0.6), explodeAt(atFrac(rwR, 0.6))),
    );
    expect(midAssembly).toBeGreaterThan(Math.PI / 12);
    // NOT spent at REVEAL_END: the camera chain releases there at zero rate, so
    // a lens still rolling under it is what makes the ending one gesture. The
    // roll's own zero is ROLL_P1, pinned above.
    expect(revealRollAt(REVEAL_END, explodeAt(REVEAL_END))).toBeLessThan(0);
  });

  it("is EXACTLY 0 wherever the model is seated", () => {
    // the explode channel is the second factor, so everything before the
    // teardown is bit-for-bit unrolled whatever the turn does. (Math.abs only
    // because −k × 1 × 0 is −0, which Object.is does not read as 0.)
    for (const p of [0, 0.3, rangeOf("flythrough").p0, 1])
      expect(Math.abs(revealRollAt(p, 0)), `p ${p}`).toBe(0);
    // …and the channel itself is 0 on those frames, so the composed write is
    for (const p of [0, rangeOf("flythrough").p0])
      expect(explodeAt(p), `explode at ${p}`).toBe(0);
  });

  it("stays 0 through the CARDS scene, which is not this chapter's", () => {
    // THE CHAPTER MASK: below TURN_P0 the `1 − rollTurnAt` factor sits at full
    // amplitude, so without the mask the model would spin a fifth of a
    // revolution through the scene where the shell comes apart.
    const cards = rangeOf("cards");
    const lit = atFrac(cards, 0.15);
    expect(assembleAt(lit), "the wrap really is live there").toBeGreaterThan(
      0.5,
    );
    for (let i = 0; i <= 40; i++) {
      const p = atFrac(cards, i / 40);
      expect(Math.abs(revealRollAt(p, explodeAt(p))), `cards ${i / 40}`).toBe(
        0,
      );
    }
    // …and the mask's own edge is free: the explode channel's rise opens INSIDE
    // the trails scene, so the hard step multiplies zero by zero
    const trails = rangeOf("trails");
    expect(explodeAt(trails.p0)).toBe(0);
    expect(Math.abs(revealRollAt(trails.p0, explodeAt(trails.p0)))).toBe(0);
  });

  it("holds the pieces at FULL EXPLOSION for the WHOLE reveal, and past it", () => {
    // The reveal must START fully expanded, with the shell pieces on the larger
    // radius: the channel is exactly 1 from the crossfade to the scene's last
    // frame, the collapse living in the ending.
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

  it("is FREE over the trails scene because nothing there is drawn", () => {
    // The roll rides the SPREAD channel, whose rise opens early and steeply
    // inside the trails scene. That is invisible only because the model is not
    // on screen there, so a change that lifts the body cover earlier is a
    // change to the wind-up and fails here first.
    for (let i = 0; i <= 40; i++) {
      const p = atFrac(tR, i / 40);
      expect(flyBodyFadeAt(p), `body cover at trails ${i / 40}`).toBe(0);
      expect(flyRevealAt(p), `reveal at trails ${i / 40}`).toBe(0);
      expect(shellFadeAt(p), `shell at trails ${i / 40}`).toBe(0);
    }
  });

  it("advances monotonically and lands at zero RATE — no snap anywhere", () => {
    // C1 by construction, with no seam inside the visible window: the gate is a
    // saturated 1 across it. Walked for monotonicity from the cover's lift to
    // the seat, and pinned at the far edge where the wind-down lands rate 0.
    const roll = (p: number) => revealRollAt(p, explodeAt(p));
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
