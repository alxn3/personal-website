// The internals scene's AMBIENT CHOREOGRAPHY — the story's only motion that
// runs on TIME instead of scroll: the focus group racks and the iris breathes
// while the shell is off, both parked at zero outside the scene.
//
// PHASE-CONTINUOUS, NOT WALL-CLOCK: the loops read the tick's ACCUMULATED dt,
// never performance.now(), since the hero stops rendering when the canvas
// leaves the viewport.
//
// ONE OWNER INSIDE THE SPAN: this module and hero-driver both write from the
// evaluate step, separated by RANGE, not order. Both channels are written
// value AND target, so the ease can never chase a stale target.
//
// THE HANDOFF: the aperture must reach the fly-through's parked f/22 with no
// jump, so the breath is dead before the pre-shut ramp starts.

import type { SceneHandle } from "../core/scene";
import { clamp01, smoothstep } from "../core/math";
import { rangeOf, atFrac } from "./story";
import { preShutAt } from "./envelopes";

const inR = rangeOf("internals");
const caR = rangeOf("cards");

/** Lead-in slack: the ambient starts writing a touch before the scene, where
 *  both laws are 0, so the two writers agree over the overlap. */
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

/** Both ambient envelopes at story position `p`, zero outside the scene. One
 *  rise, two falls: the breath must be gone before the pre-shut ramp starts,
 *  while the rack may run on into the dive. */
export const internalsEnvAt = (p: number): InternalsEnv => {
  // the ambient wakes in the CARDS scene, where the peel has already bared the
  // mechanism, not at the internals boundary
  const wake = smoothstep(atFrac(caR, 0.15), atFrac(caR, 0.35), p);
  return {
    breath: wake * (1 - smoothstep(atFrac(inR, 0.5), atFrac(inR, 0.6), p)),
    rack: wake * (1 - smoothstep(atFrac(inR, 0.8), atFrac(inR, 0.95), p)),
  };
};

/** The focus channel inside the span: one full rack every RACK_MS, scaled by
 *  the rack envelope. A raised cosine, so the loop starts and ends at focus 0. */
export const internalsFocusAt = (t: number, env: number): number =>
  env * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / RACK_MS));

/** The breathing part of the aperture channel — what gets ADDED to the pre-shut
 *  ramp. Raised cosine again, so killing the envelope never strands it
 *  half-shut. */
export const internalsBreathAt = (t: number, p: number): number =>
  internalsEnvAt(p).breath *
  BREATH_DEPTH *
  (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / BREATH_MS));

/** The whole aperture channel inside the span: the story's pre-shut ramp plus
 *  the ambient breath. The two must not overlap — the breath envelope is 0
 *  where the ramp starts. */
export const internalsApertureAt = (t: number, p: number): number =>
  // one ramp, not two: `preShutAt` is the same function hero-driver writes
  // OUTSIDE this span, so the law is continuous across both scene edges
  clamp01(preShutAt(p) + internalsBreathAt(t, p));

/** Start the ambient. Registers a scene.onEvaluate callback for the life of
 *  the page; the hero's scene is never disposed, so there is no teardown. */
export function createInternalsAmbient(scene: SceneHandle): void {
  /** the PHASE clock: accumulates only while the span is active and RESETS on
   *  every re-entry, so both loops start from their zero (focus home, iris
   *  open) rather than mid-stroke */
  let tAcc = 0;
  let inside = false;
  scene.onEvaluate((p, dt) => {
    if (p < caR.p0 - LEAD_IN || p > inR.p1) {
      inside = false;
      return false;
    }
    if (!inside) {
      inside = true;
      tAcc = 0; // re-entry: both loops restart from home
    }
    const env = internalsEnvAt(p);
    // the phase clock runs only while an envelope is open: with both shut the
    // writes below are constants of p, and the scene may sleep
    const live = env.rack > 0 || env.breath > 0;
    if (live) tAcc += dt;
    const f = internalsFocusAt(tAcc, env.rack);
    scene.state.focus = f;
    scene.state.focusTarget = f;
    const a = internalsApertureAt(tAcc, p);
    scene.state.aperture = a;
    scene.state.apertureTarget = a;
    return live;
  });
}
