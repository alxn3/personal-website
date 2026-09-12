// The reveal's rotation shape, shared by the sky and the lens: `turnAt` is the
// sky's turn window, `rollTurnAt` the same accel-and-cruise on the lens' own.

import { clamp01 } from "../core/math";
import { SKY_OUT_END, atFrac, rangeOf, span } from "./story";

const tR = rangeOf("trails");

/** Where the turn starts: the far edge of the constellation ink's fade. The ink
 *  is anchored to UNROTATED star directions, so it may not start earlier. */
export const TURN_P0 = atFrac(tR, 0.25);

/** Where the turn ends. The angular rate STEPS at this edge, so it has to sit
 *  where nothing turning is drawn. */
export const TURN_P1 = SKY_OUT_END;
span("turn", [TURN_P0, TURN_P1]);

/** The share of the turn spent winding up to cruising speed. */
const WIND_UP = 0.4;

/**
 * The chapter's turn at scroll position p, normalized 0 → 1: accelerate over
 * `WIND_UP` of the window, then cruise into the far edge. Rate is 0 at TURN_P0.
 */
export const turnAt = (p: number): number =>
  accelCruiseAt((p - TURN_P0) / (TURN_P1 - TURN_P0), WIND_UP);

/**
 * The shape itself, a normalized 0 → 1 ramp over `u01`; `windUp` and `windDown`
 * are the shares of the window spent reaching and leaving cruising speed.
 */
export const accelCruiseAt = (
  u01: number,
  windUp: number,
  windDown = 0,
): number => {
  const u = clamp01(u01);
  const v = clamp01(u / windUp);
  // the two ramps may not overlap: past that the divisor collapses and the
  // ramp stops being monotone
  const cruiseEnd = Math.max(windUp, 1 - windDown);
  const w = windDown > 0 ? clamp01((u - cruiseEnd) / windDown) : 0;
  // ∫smoothstep: the wind-up's area, the cruise past it, the wind-down's
  // mirror — over those same three terms saturated, so f(1) is exactly 1.
  return (
    (windUp * (v * v * v - 0.5 * v * v * v * v) +
      Math.max(0, Math.min(u, cruiseEnd) - windUp) +
      windDown * (w - w * w * w + 0.5 * w * w * w * w)) /
    (windUp * 0.5 + (cruiseEnd - windUp) + windDown * 0.5)
  );
};

/** How far the chapter turns, radians. Must stay equal to optics/star-trails.ts
 *  TRAIL_SWEEP_MAX, spelled again to keep three/tsl out of this chunk. */
export const TURN_MAX = Math.PI;

/** Where the lens' own roll ends: the rewrap's last frame, so the descent opens
 *  on a model that is dead still. */
export const ROLL_P1 = rangeOf("rewrap").p1;

/** The share of the roll's window spent coming off cruise, which is what lands
 *  its far edge at zero RATE. */
const ROLL_WIND_DOWN = 0.3;

/**
 * The roll's own accel-and-cruise, on its own window: the sky's foot out to the
 * rewrap's end. The wind-up must stay inside the trails scene, under the body
 * cover, so the roll is at cruise before the shell's crossfade uncovers it.
 */
export const rollTurnAt = (p: number): number =>
  accelCruiseAt((p - TURN_P0) / (ROLL_P1 - TURN_P0), WIND_UP, ROLL_WIND_DOWN);

/** How much total angle the reveal winds up and gives back, radians. */
export const REVEAL_ROLL_MAX = 1.5 * Math.PI;

/**
 * The lens' own roll, radians about the OPTICAL AXIS — written onto the model by
 * story/hero-driver.ts as a rigid model roll, not the explode recipe's `spin`.
 *
 * Negative, winding up to zero, so the lens arrives at the ending unrolled.
 * Scaled by the explode channel and masked below the trails scene, which zeroes
 * the near edge; `1 − rollTurnAt` zeroes the far edge at zero rate. C1 between.
 */
export const revealRollAt = (p: number, explode: number): number =>
  p < tR.p0 ? 0 : -REVEAL_ROLL_MAX * (1 - rollTurnAt(p)) * explode;
