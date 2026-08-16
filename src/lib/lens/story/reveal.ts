// ============================================================================
// THE REVEAL — ONE ROTATION, HANDED FROM THE SKY TO THE LENS.
//
// The sky chapter ends by turning: every star drags an arc about the middle of
// the frame (story/trails.ts). The reveal opens INSIDE that turn — the exploded
// shell crossfades in over the last of the arcs (story/fly.ts flyRevealAt) — and
// the owner's beat is that the audience never sees the rotation stop and start
// again: the arcs are still turning as the pieces arrive, the pieces are already
// turning the same way, and the sky then goes out from under a lens that
// carries the figure on alone — and keeps turning for the whole reassembly.
//
// SO BOTH READ THE SAME SHAPE, and this file is it. `turnAt` is the chapter's
// turn, normalized: story/trails.ts scales it by the arcs' own half-revolution
// (TRAIL_SWEEP_MAX). The lens' roll runs the same accel-and-cruise on a window
// of its own (`rollTurnAt` — out to the reassembly's end, not the reveal's) and
// story/hero-driver.ts hands the pieces that angle with the sign that makes
// their unwind the sky's own direction. One shape, two windows — the sky's
// figure and the pieces' spin cannot drift apart in KIND, while the pieces'
// RATE stays an owner dial (REVEAL_ROLL_MAX).
//
// WHY IT IS ITS OWN MODULE AND NOT trails.ts: that file statically imports
// optics/ (the trail engine's three/tsl graphs) and is therefore reachable only
// through hero-driver's dynamic import(). The driver is the homepage's initial
// chunk and cannot import it back. This module imports nothing but the story
// table and the math helpers, so both sides can have it.
// ============================================================================

import { clamp01 } from "../core/math";
import { SKY_OUT_END, atFrac, rangeOf } from "./story";

const tR = rangeOf("trails");

/** WHERE THE TURN STARTS, as a scroll position: a quarter into the trails
 *  scene, and exactly the far edge of the constellation ink's fade
 *  (story/constellations.ts, trails-local [0, 0.25]).
 *
 *  THE LATE START IS THE POINT. That ink is anchored to UNROTATED star
 *  directions, so anything that turns the sky while it is still legible pulls
 *  the stars out from under their own strokes. `turnAt` is exactly 0 below this
 *  point — not nearly 0 — which is also what keeps the dive's own rendering
 *  bit-for-bit unchanged. */
export const TURN_P0 = atFrac(tR, 0.25);

/** …AND WHERE IT ENDS: SKY_OUT_END (story/story.ts), the frame the last of
 *  the sky is exactly gone. The turn's ease reaches cruise and stays there
 *  (see `turnAt`), so its far edge is the one place the angular rate steps —
 *  and this frame is where that step costs nothing: the arcs' own envelope
 *  runs out at rewrap-local 0.28 (story/trails.ts) and the star discs' fade
 *  (story/fly.ts skyOutAt) lands on exactly 0 HERE, so nothing that turns is
 *  drawn on the frame the turning stops.
 *
 *  NOT REVEAL_END ANY MORE — the owner's fluid-transition correction moved
 *  the sky's whole exit deeper into the scene (SKY_OUT_END's comment carries
 *  the story), and the turn must cruise as long as any arc is visible or the
 *  sweep would stall on screen, which is the exact stall `turnAt`'s shape
 *  exists to prevent. (The PIECES' own C1 edge no longer rides this number at
 *  all: their roll runs on `rollTurnAt`'s window below, gated by the assemble
 *  channel — a double zero of its own.) */
export const TURN_P1 = SKY_OUT_END;

/** The share of the turn spent winding up to cruising speed. */
const WIND_UP = 0.4;

/**
 * THE CHAPTER'S TURN at scroll position p, normalized 0 → 1.
 *
 * ACCELERATE, THEN CRUISE — a rate that ramps up over the first `WIND_UP` of
 * the window and then holds, i.e. the integral of a smoothstep, normalized so
 * the turn completes at TURN_P1. Not the smoothstep itself, which is what this
 * used to be: a smoothstep DECELERATES into its far edge, and with that edge
 * parked inside the trails scene the sky was already dead still by the time the
 * reveal crossfaded over it — the owner, on the shipped beat: "have the trails
 * continue spinning during the transition". A turn that is still at cruise when
 * the last arc fades is the fix, and it has to be a rate law rather than a
 * later saturation point: pushing a smoothstep's edge out merely moves the
 * stall, it does not remove it.
 *
 * The foot is untouched: rate 0 at TURN_P0, and exactly 0 below it.
 */
export const turnAt = (p: number): number =>
  accelCruiseAt((p - TURN_P0) / (TURN_P1 - TURN_P0), WIND_UP);

/**
 * THE SHAPE ITSELF, as a normalized 0 → 1 ramp over `u01`, so a second beat can
 * be written in the same grammar without re-deriving it. `windUp` is the share
 * of the window spent reaching cruising speed.
 *
 * SECOND CONSUMER: story/peelcards.ts's `peelSpinAt` — the peel's own spin has
 * the same requirement the turn does (still at cruise where it hands over to
 * something else), so the two share the law rather than a pair of numbers.
 * `turnAt` keeps its OWN normalization (TURN_P0/TURN_P1, WIND_UP) — the shape is
 * shared, the window is not.
 */
export const accelCruiseAt = (u01: number, windUp: number): number => {
  const u = clamp01(u01);
  const v = clamp01(u / windUp);
  // ∫smoothstep: the wind-up's own area (windUp·(v³ − v⁴/2), which saturates
  // at windUp/2) plus the cruise past it, over the whole area so f(1) = 1.
  return (
    (windUp * (v * v * v - 0.5 * v * v * v * v) + Math.max(0, u - windUp)) /
    (1 - windUp / 2)
  );
};

/** HOW FAR THE CHAPTER TURNS, radians — a half revolution, which is
 *  optics/star-trails.ts's TRAIL_SWEEP_MAX. It is spelled again here rather
 *  than imported because that module drags three/tsl into whatever chunk reads
 *  it (see the header); `__tests__/reveal.test.ts` pins the two equal, which is
 *  what makes the direction match below a stated fact. */
export const TURN_MAX = Math.PI;

/** WHERE THE LENS' OWN ROLL ENDS: the reassembly's last frame — a quarter into
 *  caps-on, which is story/envelopes.ts's RETURN window's far edge, where the
 *  assemble channel lands on exactly 0. Spelled from the story table rather
 *  than imported, with the equality pinned in `__tests__/reveal.test.ts`: this
 *  module is the one both the driver and the lazy trails side may import, and
 *  it stays free of envelopes.ts for that reason.
 *
 *  NOT REVEAL_END, and that is the owner's correction (third round on this
 *  beat: "the lens is still not spinning on its axis"). The roll used to ride
 *  the EXPLODE channel and die with it at REVEAL_END — measured on the shipped
 *  build: of the half-revolution wind-up, ~31° happened while the lens was at
 *  all visible, ~13° while it was fully drawn, and the roll was under 1° by
 *  rewrap-local 0.22 while the VISIBLE reassembly (the assemble channel's
 *  fall) ran on five times longer, to caps-on 0.25, with no rotation at all.
 *  The spin is now a property of the lens BEING UNASSEMBLED: it lives exactly
 *  as long as the wrap is out, and is spent on the frame the last piece seats. */
export const ROLL_P1 = atFrac(rangeOf("capsOn"), 0.25);

/**
 * The roll's own accel-and-cruise, on ITS OWN WINDOW: the sky's foot (TURN_P0 —
 * the wind-up still happens over the trails scene, under the body cover, with
 * the constellation ink's law honoured for free) out to the reassembly's end.
 * Same shape as the sky's turn, same WIND_UP share; the cruise is reached at
 * rewrap-local ~0.05, a hundredth of the scene before the crossfade opens at
 * 0.06 (the window grew rewrap-side with the widened hand-over, so the
 * wind-up's end slid up to meet the cover's edge) — the model is still fully
 * covered there, so every visible frame of the roll is AT CRUISE TO WITHIN A
 * PERCENT, or in the hand-back. Not "never in the wind-up": hero-driver's
 * writer samples this at the EASED story position, which lags the raw one, so
 * at any real scroll speed the visible frames sit fractionally inside it. The
 * ramp's shape is what makes that a non-event — smoothstep(u/WIND_UP) is at
 * 99 % of cruise from rewrap-local 0.003 and 95 % from inside the trails
 * scene, so even a 0.2-screenful eased lag cannot show a slow frame.
 */
export const rollTurnAt = (p: number): number =>
  accelCruiseAt((p - TURN_P0) / (ROLL_P1 - TURN_P0), WIND_UP);

/** THE TASTE KNOB: how much total angle the reveal winds up and gives back,
 *  radians. 1.5π puts the roll still to unwind at ~200° on the frame the
 *  crossfade opens — an unmistakable half-revolution-plus played across the
 *  whole visible assembly — at an on-screen cruise of ~99°/screenful of
 *  scroll, under the arcs' own ~124°/screenful, same direction. Retune
 *  freely; the zero edges and the C1 hand-offs below are shape, not this
 *  number. */
export const REVEAL_ROLL_MAX = 1.5 * Math.PI;

/**
 * THE LENS' OWN ROLL, radians about the OPTICAL AXIS — written straight onto
 * the model by story/hero-driver.ts (SceneHandle.setModelOrientation). The
 * reveal is shot dead down that axis, so on screen it is a rotation about the
 * middle of the frame: the same figure the arcs are drawing, in the same plane.
 *
 * A RIGID ROLL, AND THAT IS THE WHOLE MECHANISM. The rotation used to be the
 * explode recipe's `spin` knob — an `orbit` inside the pipeline, whose angle is
 * `flight × spin` and therefore existed only while the pieces were falling in.
 * Two things were wrong with it and only one was the coupling: the reveal
 * happens with the ASSEMBLE channel still at full, and that recipe's wrap
 * displaces every piece by its own vector, which the orbit does NOT turn — so
 * the composed piece rode an off-centre circle and a "rotation" swung its radius
 * from 0.65 frame heights down to 0.10 and back (measured, projectDrawn). That
 * pinch is the owner's "weird kinda movement". Rolling the MODEL turns the seat,
 * the explode and the wrap together: every piece keeps its radius to four
 * decimals and advances by exactly this angle, which is what "the pieces rotate
 * in place" has to mean.
 *
 * THE `explode.spin` KNOB (0.7 rad) RE-ARMS THAT PATHOLOGY wherever explode and
 * assemble are live together: the orbit turns a piece's seat and explode but
 * not the wrap's own displacement. The story is safe by arithmetic — the two
 * overlap only inside CONSTRUCT's foot, with the wrap already ≤ 0.033 — but the
 * bench is not: an animation may drive both channels deep at once, and no
 * story-side window can bound a recipe.
 *
 * ITS DIRECTION IS THE SKY'S; ITS RATE IS ITS OWN. The first cut of this beat
 * matched the sky's rate by identity, and the owner's complaint outranked the
 * match (see ROLL_P1): the roll now runs on its own window and REVEAL_ROLL_MAX,
 * still growing the same way on screen as `uSkySpin` (measured: +0.3 rad of
 * roll advances every tracked piece's screen angle by +17.2°), so the arcs
 * hand the figure to the pieces with the turn's sense unbroken.
 *
 * NEGATIVE, WINDING UP TO ZERO: the lens has to arrive at the ending unrolled,
 * so the reveal's rotation is a wind-up being GIVEN BACK. The wind-up itself
 * happens over the trails scene with the model 16 units behind the camera
 * under a body cover.
 *
 * SCALED BY THE ASSEMBLE CHANNEL — the second factor, and the one that ends
 * the beat. The turn is a property of the LENS BEING UNASSEMBLED: full while
 * the wrap is out, given back as the pieces fly home, so the roll persists
 * through the whole visible reassembly and is spent exactly when the last
 * piece seats (ROLL_P1, the channel's own last frame). It also makes both
 * edges free: exactly 0 for the whole story before the teardown (channel 0 —
 * so the dive renders bit-for-bit unchanged), exactly 0 from ROLL_P1 on
 * (channel 0 AND turn 1 — a double zero, so the rate lands at 0 too), and C1
 * in between because both factors are C1. No snap anywhere, by construction
 * rather than by tuning.
 *
 * …AND SCOPED TO THIS CHAPTER by the `p < tR.p0` mask, because the assemble
 * channel runs TWICE on the track (story/envelopes.ts CARDS_APART takes the
 * lens apart a chapter earlier) and below TURN_P0 the `1 − rollTurnAt` factor
 * sits at full amplitude. The mask multiplies zero by zero at its edge — the
 * tail wrap's rise opens at trails-local 0.15 — so the law stays C1.
 */
export const revealRollAt = (p: number, assemble: number): number =>
  p < tR.p0 ? 0 : -REVEAL_ROLL_MAX * (1 - rollTurnAt(p)) * assemble;

// WHERE THE PIECES START FALLING IN is no longer a reveal-era constant and no
// longer lives here: the collapse left this scene for the ending, where it
// overlaps the bloom (story/envelopes.ts CONSTRUCT, in caps-on). What that
// constant was FOR — the owner's "it doesn't start from the fully expanded
// state", against a fall that used to open at trails-local 0.95 and uncover a
// shell already 40% of the way home — is now bought outright: the explode
// channel is exactly 1 from the crossfade through the whole of this scene, so
// the reveal is pure rotation on a constant radius from end to end.
