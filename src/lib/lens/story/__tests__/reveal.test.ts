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
import { assembleAt, explodeAt, shellFadeAt } from "../envelopes";

const trailsScene = rangeOf("trails");
const rewrapScene = rangeOf("rewrap");
const bloomScene = rangeOf("capsOn");

const rate = (f: (p: number) => number, p: number, h = 1e-6) =>
  (f(p + h) - f(p - h)) / (2 * h);

/** n + 1 evenly spaced fractions through a scene */
const through = (r: typeof trailsScene, n = 40) =>
  Array.from({ length: n + 1 }, (_, i) => atFrac(r, i / n));

/** the drawn roll: revealRollAt at the explode channel's own value */
const roll = (p: number) => revealRollAt(p, explodeAt(p));

describe("the sky's turn", () => {
  it("is exactly 0 until it starts, then monotone and never past 1", () => {
    // exactly 0: the constellation ink is drawn on the unturned sky
    expect(turnAt(TURN_P0)).toBe(0);
    let prev = -1;
    for (let i = 0; i <= 400; i++) {
      const p = i / 400;
      const v = turnAt(p);
      if (p <= TURN_P0) expect(v, `p ${p}`).toBe(0);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it("completes at SKY_OUT_END, once the sky is gone, and stays there", () => {
    expect(TURN_P1).toBe(SKY_OUT_END);
    expect(TURN_P1).toBeGreaterThan(REVEAL_END);
    expect(turnAt(TURN_P1)).toBeCloseTo(1, 12);
    expect(turnAt(atFrac(rewrapScene, 0.5))).toBeCloseTo(1, 12);
    expect(turnAt(1)).toBeCloseTo(1, 12);
  });

  it("accelerates then cruises, without slowing into its edge", () => {
    const cruise = rate(turnAt, atFrac(trailsScene, 0.8));
    expect(rate(turnAt, atFrac(trailsScene, 0.26))).toBeLessThan(0.2 * cruise); // leaves at rest
    expect(rate(turnAt, atFrac(trailsScene, 0.9))).toBeCloseTo(cruise, 6); // holding
    expect(rate(turnAt, atFrac(rewrapScene, 0.27))).toBeCloseTo(cruise, 6); // as the arcs go (env out at 0.28)
    expect(rate(turnAt, atFrac(rewrapScene, 0.31))).toBeCloseTo(cruise, 6); // to the end (SKY_OUT_END 0.32)
  });
});

describe("the reveal's rotation", () => {
  it("turns the lens in the sky's direction, on its own window and rate", () => {
    expect(TURN_MAX).toBe(TRAIL_SWEEP_MAX);
    for (let i = 0; i <= 40; i++) {
      const p = TURN_P0 + ((TURN_P1 - TURN_P0) * i) / 40;
      // the roll and the sky's sweep never move in opposite directions
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

  it("is exactly 0 before the trails scene and from the rewrap's end on", () => {
    // the roll ends where the rewrap does, so the descent starts still
    expect(ROLL_P1).toBe(rewrapScene.p1);
    expect(ROLL_P1).toBe(bloomScene.p0);
    expect(rollTurnAt(ROLL_P1)).toBe(1);
    expect(explodeAt(ROLL_P1)).toBe(1);
    // (Math.abs because the product can be −0)
    for (let i = 0; i <= 400; i++) {
      const p = i / 400;
      if (p < trailsScene.p0 || p >= ROLL_P1)
        expect(Math.abs(roll(p)), `p ${p}`).toBe(0);
    }
    for (const p of [trailsScene.p0, ROLL_P1, ...through(bloomScene, 20)])
      expect(Math.abs(roll(p)), `p ${p}`).toBe(0);
    // the mask's hard edge is harmless: explode is still 0 there
    expect(explodeAt(trailsScene.p0)).toBe(0);
  });

  it("keeps assemble out of the ending: only explode moves the pieces there", () => {
    for (const p of [...through(rewrapScene), ...through(bloomScene)])
      expect(assembleAt(p), `p ${p}`).toBe(0);
    // it does run, in the cards scene
    expect(assembleAt(atFrac(rangeOf("cards"), 0.05))).toBe(1);
  });

  it("starts negative, is clearly visible, and unwinds to 0", () => {
    const open = atFrac(rewrapScene, 0.06);
    expect(revealRollAt(open, 1)).toBeLessThan(0);
    expect(revealRollAt(open, 1)).toBeGreaterThan(
      revealRollAt(trailsScene.p0, 1),
    );
    // over a quarter turn still to go when the lens comes into view
    expect(Math.abs(roll(open))).toBeGreaterThan(Math.PI / 2);
    // still over 15° to go midway through the reassembly
    expect(Math.abs(roll(atFrac(rewrapScene, 0.6)))).toBeGreaterThan(
      Math.PI / 12,
    );
    // still rolling at REVEAL_END
    expect(roll(REVEAL_END)).toBeLessThan(0);
  });

  it("holds the pieces fully exploded for the whole reveal, and past it", () => {
    const open = atFrac(rewrapScene, 0.06);
    expect(flyRevealAt(open)).toBe(0);
    expect(rate(explodeAt, open)).toBe(0);
    for (const p of through(rewrapScene))
      expect(explodeAt(p), `p ${p}`).toBe(1);
    // with the roll the only thing moving
    expect(revealRollAt(atFrac(rewrapScene, 0.1), 1)).toBeGreaterThan(
      revealRollAt(open, 1),
    );
  });

  it("winds up during the trails scene, where the lens is hidden", () => {
    for (const p of through(trailsScene)) {
      expect(flyBodyFadeAt(p), `body cover at ${p}`).toBe(0);
      expect(flyRevealAt(p), `reveal at ${p}`).toBe(0);
      expect(shellFadeAt(p), `shell at ${p}`).toBe(0);
    }
  });

  it("advances monotonically and lands at zero rate", () => {
    const from = atFrac(rewrapScene, 0.02);
    let prev = roll(from);
    for (let i = 1; i <= 900; i++) {
      const p = from + ((ROLL_P1 - from) * i) / 900;
      const v = roll(p);
      expect(v, `roll advances at p ${p}`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    const cruise = rate(roll, atFrac(rewrapScene, 0.08));
    expect(rate(roll, ROLL_P1 - 1e-4)).toBeLessThan(cruise / 100);
    expect(rate(roll, ROLL_P1 + 1e-4)).toBe(0);
  });
});
