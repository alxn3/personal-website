// THE SKY TURNS — the driver behind the `trails` scene: the star field rotates
// about the middle of the frame, every star dragging an arc of ink behind it.
//
// LAZY MODULE, like story/fly.ts and story/constellations.ts: it statically
// imports optics/ (three/tsl node graphs), so it is reachable ONLY through
// hero-driver's dynamic import() and must NEVER be re-exported from index.ts.
//
// ONE θ, TWO WRITES — `uSkySpin` (star discs + authored strokes) and `setSweep`
// (how much arc history to draw) get the SAME number every frame. Nothing else
// writes `uSkySpin`.
//
// The arcs ride the STARFIELD GROUP for its per-frame camera-centring, and the
// attach is re-asked every active frame because the fly mounts and unmounts the
// starfield underneath it.

import type { SceneHandle } from "../core/scene";
import { smoothstep } from "../core/math";
import { rangeOf, atFrac } from "./story";
import { TURN_P0, turnAt } from "./reveal";
import { isLightTheme, watchTheme } from "../core/theme";
import { uSkySpin } from "../optics/starfield";
import { createStarTrails, TRAIL_SWEEP_MAX } from "../optics/star-trails";

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");

/** Where the envelope has finished falling. It must land before SKY_OUT_END —
 *  the field's ink goes out before the star discs do, never arcs on empty sky. */
export const ENV_END = atFrac(rwR, 0.28);

/** Slack past each edge of the driven span before the arcs are detached, so a
 *  scrub on an edge cannot thrash attach/detach; inside it the mesh hangs on
 *  the starfield at envelope 0. */
const SPAN_PAD = 0.02;
export const SPAN_P0 = tR.p0 - SPAN_PAD;
export const SPAN_P1 = ENV_END + SPAN_PAD;

/** Where the sky starts turning, and the gate the ambient drift accrues behind.
 *  It must be ONE number for both, or the drift pulls stars off their strokes. */
const SWEEP_P0 = TURN_P0;

/**
 * THE SWEEP, radians: how far the sky has turned at p — the chapter's own turn
 * (story/reveal.ts `turnAt`) at this field's amplitude. Exactly 0 before
 * SWEEP_P0, so a scrub back into the constellations leaves the sky untilted.
 */
export const trailSweepAt = (p: number): number => TRAIL_SWEEP_MAX * turnAt(p);

/** The arcs' envelope. Rises after the constellation strokes have started to
 *  go, so the two kinds of sky ink are never both at full, and falls with the
 *  sky across `rewrap`'s first third (ENV_END). */
export const trailEnvAt = (p: number): number =>
  smoothstep(atFrac(tR, 0.02), atFrac(tR, 0.12), p) *
  (1 - smoothstep(atFrac(rwR, 0.02), ENV_END, p));

/** The drift, radians per second, added to the scrolled sweep while p is inside
 *  the turning part of the scene, so a parked field stays alive. */
export const AMBIENT_SPIN_RATE = 0.012;

/** …and the ceiling on it, radians, so a parked tab cannot wind the sky up
 *  without limit. An absolute angle, not a share of the sweep. */
export const AMBIENT_MAX = 0.2;

/** …and how fast that residue is given back once p drops below the turn,
 *  radians per second. `uSkySpin` must reach EXACTLY 0 there: below the turn,
 *  residue is strokes pointing at empty sky and names off their stars. */
export const AMBIENT_DECAY = AMBIENT_MAX;

export interface StoryTrails {
  /** Upload the arcs' vertex buffer off the gesture. Idempotent, and a no-op
   *  once the arcs are mounted for real. */
  warm(): void;
}

/**
 * Start the trails. Registers a scene.onEvaluate callback for the life of the
 * page — no teardown, because the hero's scene is never disposed.
 */
export function createStoryTrails(scene: SceneHandle): StoryTrails {
  const trails = createStarTrails({ light: isLightTheme() });

  watchTheme((l) => {
    trails.setTheme(l);
    scene.invalidate();
  });

  /** the drift's accumulated angle, radians — accrues only inside the turn */
  let ambient = 0;
  let lastTheta = NaN;
  let lastEnv = NaN;

  scene.onEvaluate((p, dtMs) => {
    const dt = dtMs / 1000;
    if (p >= SWEEP_P0 && p <= tR.p1)
      ambient = Math.min(AMBIENT_MAX, ambient + AMBIENT_SPIN_RATE * dt);
    else if (p < SWEEP_P0) ambient = Math.max(0, ambient - AMBIENT_DECAY * dt);

    // one θ, both writes, unconditionally — before any early return, or the
    // starfield (which outlives this span) holds its last angle
    const theta = trailSweepAt(p) + ambient;
    uSkySpin.value = theta;
    trails.setSweep(theta);

    // written unconditionally too: a fast flick can leave the scene between two
    // frames, and a held opacity freezes a field of arcs on the sky
    const env = trailEnvAt(p);
    trails.setEnvelope(env);
    // live while either write moved: the drift keeps the sky turning parked
    const moved = theta !== lastTheta || env !== lastEnv;
    lastTheta = theta;
    lastEnv = env;

    if (env <= 0) {
      // past the span's edges the mesh comes off the starfield; inside them it
      // stays attached at zero, saving the re-attach on a small scrub
      if (trails.object.parent && (p < SPAN_P0 || p > SPAN_P1))
        scene.starfieldDetach(trails.object);
      return moved;
    }

    // story/fly.ts mounts and unmounts the starfield under us, so the attach is
    // re-asked every active frame; it is a no-op once attached
    scene.starfieldAttach(trails.object);
    return moved;
  });

  let warmed = false;
  return {
    warm() {
      if (warmed) return;
      warmed = true;
      // through the pass as well: the arcs are worn over the dive's span, where
      // the pass keys its own pipeline
      if (!trails.object.parent) scene.warmDraw([trails.object], true);
    },
  };
}
