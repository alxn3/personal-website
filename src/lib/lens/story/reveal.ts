// The ending's rotations: the sky's turn (turnAt) and the lens' roll back to
// rest (revealRollAt), both accelerate-then-cruise curves.

import { clamp01 } from "../core/math";
import { SKY_OUT_END, atFrac, rangeOf, span } from "./story";

const trailsScene = rangeOf("trails");

/** Where the sky starts turning: once the constellation ink (drawn on the
 *  unturned sky) has faded. */
export const TURN_P0 = atFrac(trailsScene, 0.25);

/** Where the sky's turn ends, abruptly, so the sky must be gone by then. */
export const TURN_P1 = SKY_OUT_END;
span("turn", [TURN_P0, TURN_P1]);

/** The share of the turn spent speeding up. */
const WIND_UP = 0.4;

/** The sky's turn at p, 0..1: speeds up from rest, then cruises. */
export const turnAt = (p: number): number =>
  accelCruiseAt((p - TURN_P0) / (TURN_P1 - TURN_P0), WIND_UP);

/** A 0..1 ramp over `u01` that speeds up over `windUp`, cruises, and slows
 *  down over the last `windDown` (both shares of the window). */
const accelCruiseAt = (u01: number, windUp: number, windDown = 0): number => {
  const u = clamp01(u01);
  const v = clamp01(u / windUp);
  // the two ramps may not overlap
  const cruiseEnd = Math.max(windUp, 1 - windDown);
  const w = windDown > 0 ? clamp01((u - cruiseEnd) / windDown) : 0;
  // integrated smoothstep: wind-up + cruise + wind-down, normalized so f(1) = 1
  return (
    (windUp * (v * v * v - 0.5 * v * v * v * v) +
      Math.max(0, Math.min(u, cruiseEnd) - windUp) +
      windDown * (w - w * w * w + 0.5 * w * w * w * w)) /
    (windUp * 0.5 + (cruiseEnd - windUp) + windDown * 0.5)
  );
};

/** How far the sky turns, radians. Must equal optics/star-trails.ts
 *  TRAIL_SWEEP_MAX (not imported, to keep three/tsl out of this chunk). */
export const TURN_MAX = Math.PI;

/** Where the lens' roll ends: the end of the rewrap, so the descent starts
 *  with the lens still. */
export const ROLL_P1 = rangeOf("rewrap").p1;

/** The share of the roll spent slowing to a stop. */
const ROLL_WIND_DOWN = 0.3;

/** The roll's progress, 0..1, from TURN_P0 to ROLL_P1. It must reach
 *  cruising speed while the lens is still hidden, in the trails scene. */
export const rollTurnAt = (p: number): number =>
  accelCruiseAt((p - TURN_P0) / (ROLL_P1 - TURN_P0), WIND_UP, ROLL_WIND_DOWN);

/** The roll's full angle, radians. */
export const REVEAL_ROLL_MAX = 1.5 * Math.PI;

/** The lens' roll about its optical axis at p, radians: it unwinds from
 *  −REVEAL_ROLL_MAX to 0 as the lens comes back, scaled by the explode. 0
 *  before the trails scene. */
export const revealRollAt = (p: number, explode: number): number =>
  p < trailsScene.p0 ? 0 : -REVEAL_ROLL_MAX * (1 - rollTurnAt(p)) * explode;
