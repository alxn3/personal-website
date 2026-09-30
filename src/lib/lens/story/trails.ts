// The `trails` scene: the star field rotates about the frame centre and every
// star leaves an arc behind it.
//
// Lazy module: only hero-driver's dynamic import() may reach it, and index.ts
// must never re-export it.
//
// The same angle goes to `uSkySpin` (stars and constellation lines) and to
// `setSweep` (arc length) every frame; nothing else writes `uSkySpin`. The arcs
// ride the starfield group, which fly.ts mounts and unmounts.

import type { SceneHandle } from "../core/scene";
import { smoothstep } from "../core/math";
import { rangeOf, atFrac } from "./story";
import { TURN_P0, turnAt } from "./reveal";
import { isLightTheme, watchTheme } from "../core/theme";
import { uSkySpin } from "../optics/starfield";
import { createStarTrails, TRAIL_SWEEP_MAX } from "../optics/star-trails";

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");

/** Story p where the arcs have fully faded; must come before SKY_OUT_END so
 *  the arcs go before the stars. */
export const ENV_END = atFrac(rwR, 0.28);

/** Story-p span the arcs stay attached over, padded so scrubbing at an edge
 *  doesn't thrash attach/detach. */
const SPAN_PAD = 0.02;
export const SPAN_P0 = tR.p0 - SPAN_PAD;
export const SPAN_P1 = ENV_END + SPAN_PAD;

/** Sky rotation at p, radians. Exactly 0 before TURN_P0, which also gates
 *  the ambient drift. */
export const trailSweepAt = (p: number): number => TRAIL_SWEEP_MAX * turnAt(p);

/** Arc opacity: in early in `trails` (after the constellation lines start to
 *  go), out by ENV_END. */
export const trailEnvAt = (p: number): number =>
  smoothstep(atFrac(tR, 0.02), atFrac(tR, 0.12), p) *
  (1 - smoothstep(atFrac(rwR, 0.02), ENV_END, p));

/** Slow extra spin while inside the turn, rad/s, so a parked sky still moves. */
export const AMBIENT_SPIN_RATE = 0.012;

/** Cap on the extra spin, radians. */
export const AMBIENT_MAX = 0.2;

/** Rate the extra spin unwinds below the turn, rad/s; it must reach exactly 0
 *  there so lines and names stay on their stars. */
export const AMBIENT_DECAY = AMBIENT_MAX;

export interface StoryTrails {
  /** Pre-upload the arc buffers. Idempotent. */
  warm(): void;
}

/** Start the trails. Registers a per-frame callback for the life of the page. */
export function createStoryTrails(scene: SceneHandle): StoryTrails {
  const trails = createStarTrails({ light: isLightTheme() });

  watchTheme((l) => {
    trails.setTheme(l);
    scene.invalidate();
  });

  /** extra drift angle, radians */
  let ambient = 0;
  let lastTheta = NaN;
  let lastEnv = NaN;

  scene.onEvaluate((p, dtMs) => {
    const dt = dtMs / 1000;
    if (p >= TURN_P0 && p <= tR.p1)
      ambient = Math.min(AMBIENT_MAX, ambient + AMBIENT_SPIN_RATE * dt);
    else if (p < TURN_P0) ambient = Math.max(0, ambient - AMBIENT_DECAY * dt);

    // always write the angle and opacity, before any early return, so nothing
    // is left stale after a fast scroll
    const theta = trailSweepAt(p) + ambient;
    uSkySpin.value = theta;
    trails.setSweep(theta);
    const env = trailEnvAt(p);
    trails.setEnvelope(env);
    // request frames while either value is changing
    const moved = theta !== lastTheta || env !== lastEnv;
    lastTheta = theta;
    lastEnv = env;

    // the starfield may be (re)mounted at any time; attaching is a no-op if
    // already attached
    if (env > 0) scene.starfieldAttach(trails.object);
    else if (trails.object.parent && (p < SPAN_P0 || p > SPAN_P1))
      scene.starfieldDetach(trails.object);
    return moved;
  });

  let warmed = false;
  return {
    warm() {
      if (warmed) return;
      warmed = true;
      // also through the post pass, which is active while the arcs show
      if (!trails.object.parent) scene.warmDraw([trails.object], true);
    },
  };
}
