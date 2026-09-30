// The internals scene's ambient motion, which runs on time rather than scroll:
// the focus group racks back and forth and the iris breathes. It runs on the
// frame's accumulated dt (not wall-clock), so it pauses when the hero does.
// Inside its span this module, not hero-driver, writes focus and aperture.

import type { SceneHandle } from "../core/scene";
import { clamp01, smoothstep } from "../core/math";
import { rangeOf, atFrac } from "./story";
import { preShutAt } from "./envelopes";

const internals = rangeOf("internals");
const cards = rangeOf("cards");

/** Start writing slightly early, while both writers' values are 0. */
const LEAD_IN = 0.02;

/** One focus rack, out and back, ms. */
const RACK_MS = 7000;
/** One iris breath, ms. */
const BREATH_MS = 5000;
/** How far the iris breathes (f/2.8 to about f/8). */
const BREATH_DEPTH = 0.55;

export interface InternalsEnv {
  /** amplitude envelope for the iris breath */
  breath: number;
  /** amplitude envelope for the focus rack */
  rack: number;
}

/** Both amplitudes at p. They start in the cards scene, once the mechanism is
 *  bare; the breath ends before the aperture's pre-shut ramp starts. */
export const internalsEnvAt = (p: number): InternalsEnv => {
  const wake = smoothstep(atFrac(cards, 0.15), atFrac(cards, 0.35), p);
  return {
    breath:
      wake *
      (1 - smoothstep(atFrac(internals, 0.5), atFrac(internals, 0.6), p)),
    rack:
      wake *
      (1 - smoothstep(atFrac(internals, 0.8), atFrac(internals, 0.95), p)),
  };
};

/** Focus at loop time t: one rack every RACK_MS, starting and ending at 0. */
export const internalsFocusAt = (t: number, env: number): number =>
  env * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / RACK_MS));

/** The breath added to the aperture at loop time t, starting and ending at 0. */
export const internalsBreathAt = (t: number, p: number): number =>
  internalsEnvAt(p).breath *
  BREATH_DEPTH *
  (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / BREATH_MS));

/** The aperture inside the span: the shared pre-shut ramp plus the breath. */
export const internalsApertureAt = (t: number, p: number): number =>
  clamp01(preShutAt(p) + internalsBreathAt(t, p));

/** Start the ambient motion for the life of the page. */
export function createInternalsAmbient(scene: SceneHandle): void {
  /** loop time, ms; reset on every entry so both loops start from rest */
  let tAcc = 0;
  let inside = false;
  scene.onEvaluate((p, dt) => {
    if (p < cards.p0 - LEAD_IN || p > internals.p1) {
      inside = false;
      return false;
    }
    if (!inside) {
      inside = true;
      tAcc = 0;
    }
    const env = internalsEnvAt(p);
    // the clock runs only while a loop is live; otherwise the scene may sleep
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
