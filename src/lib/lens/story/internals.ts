// ============================================================================
// The internals scene's AMBIENT CHOREOGRAPHY — the first motion in the story
// that runs on TIME instead of on scroll. The shell is off over this span (the
// shell gate, mounted in hero-driver), so the mechanism itself is the subject:
// the focus group racks in a slow loop and the iris breathes, both parked at
// zero outside the scene so nothing moves where nobody is looking.
//
// PHASE-CONTINUOUS, NOT WALL-CLOCK. The loops read an ACCUMULATED dt clamped to
// 100ms a frame, never performance.now() itself: the hero stops its render loop
// whenever the canvas leaves the viewport (SceneHandle.setPaused) and a law
// keyed to absolute time would skip most of a cycle across the gap — the iris
// would be found mid-close on return.
//
// ONE OWNER INSIDE THE SPAN. This module writes from scene.onFrame (after the
// render) while hero-driver writes from the scroll rAF; those two have NO
// ordering guarantee against each other, so the writers are separated by RANGE
// rather than by order — hero-driver gates its own focus reset and aperture
// ramp OUT of the internals span (see its frame()), leaving this file the only
// writer inside it. Both channels are written value AND target, so tick()'s
// ease can never chase a stale target left by the other writer.
//
// THE HANDOFF. The aperture has to reach the fly-through's parked f/22 with no
// jump, so the breathing amplitude is dead by internals-local 0.6 and the
// pre-shut ramp (local 0.6 → 0.95 — the same expression hero-driver runs
// outside the span) closes the iris from a clean zero baseline.
// ============================================================================

import type { SceneHandle } from "../core/scene";
import { clamp01, smoothstep } from "../core/math";
import { rangeOf, atFrac } from "./story";
import { preShutAt } from "./envelopes";

const inR = rangeOf("internals");
const caR = rangeOf("cards");

/** Lead-in slack: the ambient starts writing a touch before the scene, while
 *  hero-driver still owns the span. Both laws are 0 there, so the two writers
 *  agree over the overlap and the handover at p0 has nothing to step over. */
const LEAD_IN = 0.02;

/** one full rack, out and back, in ms */
const RACK_MS = 7000;
/** one full breath, open and back down, in ms */
const BREATH_MS = 5000;
/** how far the iris breathes: f/2.8 to roughly f/8 on the HUD's stop table */
const BREATH_DEPTH = 0.55;

export interface InternalsEnv {
  /** amplitude envelope for the iris breath */
  breath: number;
  /** amplitude envelope for the focus rack */
  rack: number;
}

/** Both ambient envelopes at story position `p`. They share a rise — the scene
 *  settles first, then the mechanism wakes — and fall at different times: the
 *  breath must be gone before the pre-shut ramp starts at local 0.6, while the
 *  rack is free to run on to 0.95 because focus hands nothing to the fly
 *  (story/fly.ts owns focus only past flythrough.p0, and its own rack does not
 *  start until 0.72 of the dive). Zero everywhere outside the scene. */
export const internalsEnvAt = (p: number): InternalsEnv => {
  // The ambient WAKES IN THE CARDS SCENE, not at the internals boundary: the
  // peel bares the whole mechanism one scene early, and a glass column that
  // sits dead while the cards orbit reads as a prop (owner: "there isn't
  // enough movement there"). The rack and the breath both run from a fifth of
  // the way into cards; everything still winds down on the internals-side
  // windows unchanged.
  const wake = smoothstep(atFrac(caR, 0.15), atFrac(caR, 0.35), p);
  return {
    breath: wake * (1 - smoothstep(atFrac(inR, 0.5), atFrac(inR, 0.6), p)),
    rack: wake * (1 - smoothstep(atFrac(inR, 0.8), atFrac(inR, 0.95), p)),
  };
};

/** The focus channel inside the span: one full rack every RACK_MS, scaled by
 *  the rack envelope. A raised cosine, so the loop both starts and ends at
 *  focus 0 — the envelope can fade it in or out without the group jumping. */
export const internalsFocusAt = (t: number, env: number): number =>
  env * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / RACK_MS));

/** The breathing part of the aperture channel — what gets ADDED to the pre-shut
 *  ramp. Raised cosine again: the iris returns to wide open at the bottom of
 *  every cycle, so killing the envelope never strands it half-shut. */
export const internalsBreathAt = (t: number, p: number): number =>
  internalsEnvAt(p).breath *
  BREATH_DEPTH *
  (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / BREATH_MS));

/** The whole aperture channel inside the span: the story's pre-shut ramp plus
 *  the ambient breath. The two never overlap — the breath envelope is 0 by
 *  local 0.6, which is exactly where the ramp starts — so the sum never exceeds
 *  either law's own intent, and the clamp is belt-and-braces. */
export const internalsApertureAt = (t: number, p: number): number =>
  // ONE ramp, not two. story/envelopes.ts's `preShutAt` is what hero-driver
  // writes OUTSIDE this span; calling it here is what makes "one continuous law
  // across both edges of the scene" a fact rather than a pair of expressions
  // kept textually identical by a comment.
  clamp01(preShutAt(p) + internalsBreathAt(t, p));

/** Start the ambient. Registers a scene.onFrame callback for the life of the
 *  page — there is no teardown because the hero's scene is never disposed. */
export function createInternalsAmbient(scene: SceneHandle): void {
  /** the PHASE clock: accumulates only while the span is active and RESETS on
   *  every re-entry, so both loops always start from their zero (focus home,
   *  iris open). A free-running clock let a fast fling land mid-stroke — the
   *  focus group teleported to wherever the 7s loop happened to be (the
   *  owner's "gearbox moves then snaps back"). The p-envelopes can't help
   *  there: they are functions of scroll, and a fling crosses their whole
   *  rise in one frame. */
  let tAcc = 0;
  let inside = false;
  let last = performance.now();
  scene.onFrame(() => {
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;
    // THE SCROLL p, NOT THE EASED CHANNEL. `storyTarget` is exactly what
    // hero-driver's frame() was handed, so all three writers of these channels
    // — that frame(), story/fly.ts and this callback — gate on ONE p and their
    // spans tile it without a gap. The eased `state.story` lags it by several
    // frames, and hero-driver only runs on scroll EVENTS: a fling that ends
    // just past this scene would leave the eased value still crawling through
    // the span with no scroll left to correct it, and the last write before it
    // converged on inR.p1 would strand the iris shut into the dive approach.
    const p = scene.state.storyTarget;
    if (p < caR.p0 - LEAD_IN || p > inR.p1) {
      inside = false;
      return;
    }
    if (!inside) {
      inside = true;
      tAcc = 0; // re-entry: both loops restart from home
    }
    tAcc += dt;
    const f = internalsFocusAt(tAcc, internalsEnvAt(p).rack);
    scene.state.focus = f;
    scene.state.focusTarget = f;
    const a = internalsApertureAt(tAcc, p);
    scene.state.aperture = a;
    scene.state.apertureTarget = a;
  });
}
