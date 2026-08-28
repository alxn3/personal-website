// THE REVEAL — one rotation, handed from the sky to the lens. The sky's arcs
// are still turning as the exploded shell crossfades in, and the lens then
// carries the figure on alone through the whole reassembly, so the audience
// never sees the rotation stop and start again.
//
// BOTH SIDES READ THE SAME SHAPE, which is this file: `turnAt` is the sky's
// turn (story/trails.ts scales it by TRAIL_SWEEP_MAX), `rollTurnAt` is the
// same accel-and-cruise on the lens' own, longer window. One shape, two
// windows — the sky's figure and the pieces' spin cannot drift apart in KIND,
// while the pieces' rate stays a free dial (REVEAL_ROLL_MAX).
//
// IT IS ITS OWN MODULE, NOT part of trails.ts: trails.ts statically imports
// optics/ and so is lazy-only, while hero-driver is in the homepage's initial
// chunk. This file imports only the story table and core math, so both sides
// may have it.

import { clamp01 } from "../core/math";
import { SKY_OUT_END, atFrac, rangeOf } from "./story";

const tR = rangeOf("trails");

/** Where the turn starts: the far edge of the constellation ink's fade
 *  (story/constellations.ts, trails-local [0, 0.25]). It may not start
 *  earlier — that ink is anchored to UNROTATED star directions, so turning the
 *  sky while it is legible pulls the stars out from under their own strokes.
 *  `turnAt` is exactly 0 below this point, not nearly 0. */
export const TURN_P0 = atFrac(tR, 0.25);

/** …and where it ends. The turn cruises into its far edge (see `turnAt`), so
 *  that edge is the one place the angular rate STEPS and it has to sit where
 *  nothing turning is drawn: SKY_OUT_END is exactly where the star discs and
 *  the arcs are both spent. */
export const TURN_P1 = SKY_OUT_END;

/** The share of the turn spent winding up to cruising speed. */
const WIND_UP = 0.4;

/**
 * THE CHAPTER'S TURN at scroll position p, normalized 0 → 1.
 *
 * ACCELERATE, THEN CRUISE — the integral of a smoothstep over the first
 * `WIND_UP` of the window, then a constant rate, normalized to complete at
 * TURN_P1. It must NOT be a plain smoothstep: that decelerates into its far
 * edge, leaving the sky dead still while the last arcs are still on screen,
 * and moving the edge out only moves that stall. Rate is 0 at TURN_P0.
 */
export const turnAt = (p: number): number =>
  accelCruiseAt((p - TURN_P0) / (TURN_P1 - TURN_P0), WIND_UP);

/**
 * THE SHAPE ITSELF, as a normalized 0 → 1 ramp over `u01`; `windUp` is the
 * share of the window spent reaching cruising speed and `windDown` the share
 * spent coming off it again. Two windows ride it, the chapter's turn (which
 * cruises into its edge — windDown 0) and the roll's own.
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
  // ∫smoothstep: the wind-up's own area (windUp·(v³ − v⁴/2), which saturates at
  // windUp/2), the cruise past it, and the wind-down's mirror
  // (windDown·(w − w³ + w⁴/2), saturating at windDown/2). The divisor is the
  // same three terms SATURATED, spelled in the same order, so f(1) is exactly 1
  // and the ramp's far edge is a literal zero for whatever rides `1 − f`. At
  // windDown 0 every added term is an exact zero.
  return (
    (windUp * (v * v * v - 0.5 * v * v * v * v) +
      Math.max(0, Math.min(u, cruiseEnd) - windUp) +
      windDown * (w - w * w * w + 0.5 * w * w * w * w)) /
    (windUp * 0.5 + (cruiseEnd - windUp) + windDown * 0.5)
  );
};

/** How far the chapter turns, radians — optics/star-trails.ts's
 *  TRAIL_SWEEP_MAX, spelled again rather than imported because that module
 *  drags three/tsl into whatever chunk reads it. The two are pinned equal in
 *  __tests__/reveal.test.ts. */
export const TURN_MAX = Math.PI;

/** Where the lens' own roll ends: THE REWRAP'S LAST FRAME. The rotation is the
 *  sky's, handed to the lens and spent inside the chapter the sky hands over
 *  to, so the descent opens on a model that is dead still and the fall is the
 *  only thing moving in it. */
export const ROLL_P1 = rangeOf("rewrap").p1;

/** The share of the roll's window spent coming off cruise. The chapter's turn
 *  cannot afford one (its edge sits under live arcs); the roll's edge sits on
 *  the scene boundary with nothing else turning, and this is what lands it at
 *  zero RATE now that the wrap no longer closes under it. */
const ROLL_WIND_DOWN = 0.3;

/**
 * The roll's own accel-and-cruise, on ITS OWN WINDOW: the sky's foot out to the
 * rewrap's end, damped over the last `ROLL_WIND_DOWN` of it. The wind-up must
 * stay inside the trails scene, under the body cover, so the roll is at cruise
 * before the shell's crossfade uncovers it. (hero-driver samples this at the
 * EASED story position, which lags the raw one, so visible frames can sit
 * fractionally inside the wind-up; the ramp is near cruise well before its end,
 * which is what makes that a non-event.)
 */
export const rollTurnAt = (p: number): number =>
  accelCruiseAt((p - TURN_P0) / (ROLL_P1 - TURN_P0), WIND_UP, ROLL_WIND_DOWN);

/** THE TASTE KNOB: how much total angle the reveal winds up and gives back,
 *  radians. Retune freely — the zero edges and the C1 hand-offs below are
 *  shape, not this number. */
export const REVEAL_ROLL_MAX = 1.5 * Math.PI;

/**
 * THE LENS' OWN ROLL, radians about the OPTICAL AXIS — written onto the model
 * by story/hero-driver.ts. The reveal is shot dead down that axis, so on screen
 * it is a rotation about the middle of the frame — the figure the arcs draw.
 *
 * A RIGID MODEL ROLL, deliberately, and NOT the explode recipe's `spin` knob:
 * that turns a piece's seat and explode but not the wrap's own displacement, so
 * wherever explode and assemble are live together the composed piece rides an
 * off-centre circle and its radius pinches instead of rotating in place.
 *
 * NEGATIVE, WINDING UP TO ZERO — the lens has to arrive at the ending unrolled,
 * so this is a wind-up being given back; the wind-up itself happens over the
 * trails scene with the model behind the camera under a body cover.
 *
 * SCALED BY THE EXPLODE CHANNEL, which is what makes the low edge free: the
 * spread's rise opens inside the trails scene and is exactly 0 below it, so the
 * dive and every chapter before it render unchanged, and the roll ramps in with
 * the cloud it turns instead of stepping to full amplitude. Inside the trails
 * scene the wind-up is unconstrained because the body cover (story/fly.ts
 * `flyBodyFadeAt`) holds the model off screen for every frame of it — pinned in
 * __tests__/reveal.test.ts. The FAR edge is the
 * turn's own — the channel is a saturated 1 across the whole rewrap, so
 * `1 − rollTurnAt` carries the landing alone: exactly 0 from ROLL_P1 on, at
 * zero rate, on the wind-down above. C1 in between.
 *
 * …AND SCOPED by the `p < tR.p0` mask, so the cards chapter cannot see the
 * `1 − rollTurnAt` factor at full amplitude. The mask's own edge multiplies
 * zero by zero (the rise opens inside the scene), so the law stays C1.
 */
export const revealRollAt = (p: number, explode: number): number =>
  p < tR.p0 ? 0 : -REVEAL_ROLL_MAX * (1 - rollTurnAt(p)) * explode;

// Where the pieces start falling in is NOT here: the descent is the last
// scene's, from its own foot (story/envelopes.ts CONSTRUCT). The explode
// channel is exactly 1 across this whole chapter, so the reveal is pure
// rotation at a constant radius from end to end.
