// The internals scene's AMBIENT CHOREOGRAPHY — the story's only motion that
// runs on TIME instead of scroll: the focus group racks and the iris breathes
// while the shell is off, both parked at zero outside the scene.
//
// PHASE-CONTINUOUS, NOT WALL-CLOCK: the loops read an ACCUMULATED dt clamped
// per frame, never performance.now() itself, because the hero stops its render
// loop when the canvas leaves the viewport and an absolute-time law would skip
// most of a cycle across the gap.
//
// ONE OWNER INSIDE THE SPAN. This module writes from scene.onFrame while
// hero-driver writes from the scroll rAF, with no ordering guarantee between
// them — so the two are separated by RANGE, not order: hero-driver gates its
// focus reset and aperture ramp OUT of this span. Both channels are written
// value AND target, so the ease can never chase the other's stale target.
//
// THE HANDOFF: the aperture must reach the fly-through's parked f/22 with no
// jump, so the breath is dead before the pre-shut ramp starts.

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

/** Both ambient envelopes at story position `p`, zero outside the scene. They
 *  share a rise and fall at different times: the breath must be gone before
 *  the pre-shut ramp starts, while the rack may run on because focus hands
 *  nothing to the fly until well inside the dive. */
export const internalsEnvAt = (p: number): InternalsEnv => {
  // The ambient wakes in the CARDS scene, not at the internals boundary: the
  // peel bares the mechanism a scene early and a glass column sitting dead
  // under the orbiting cards reads as a prop.
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
  // ONE ramp, not two: `preShutAt` is the same function hero-driver writes
  // OUTSIDE this span, so the law is continuous across both scene edges.
  clamp01(preShutAt(p) + internalsBreathAt(t, p));

/** Start the ambient. Registers a scene.onFrame callback for the life of the
 *  page — there is no teardown because the hero's scene is never disposed. */
export function createInternalsAmbient(scene: SceneHandle): void {
  /** the PHASE clock: accumulates only while the span is active and RESETS on
   *  every re-entry, so both loops start from their zero (focus home, iris
   *  open). A free-running clock lets a fling land mid-stroke, and the
   *  p-envelopes cannot help: a fling crosses their rise in one frame. */
  let tAcc = 0;
  let inside = false;
  let last = performance.now();
  scene.onFrame(() => {
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;
    // THE SCROLL p, NOT THE EASED CHANNEL: `storyTarget` is what hero-driver's
    // frame() was handed, so all three writers of these channels gate on ONE p
    // and their spans tile it without a gap. The eased `state.story` lags, and
    // a fling ending past this scene would strand the iris shut with no scroll
    // left to correct it.
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
