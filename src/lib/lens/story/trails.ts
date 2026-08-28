// THE SKY TURNS — the driver behind the `trails` scene: the whole star field
// rotates about the middle of the frame, every star dragging an arc of ink
// behind it, the last thing the sky does before the lens comes back.
//
// LAZY MODULE, like story/fly.ts and story/constellations.ts: it statically
// imports optics/ (three/tsl node graphs), so it is reachable ONLY through
// hero-driver's dynamic import() and must NEVER be re-exported from index.ts.
//
// ONE θ, TWO WRITES — the file's whole invariant. `uSkySpin` turns the star
// discs and the authored strokes; `setSweep` tells the arcs how much history to
// draw. Both get the SAME number every frame, so an arc's head is by
// construction at the disc it belongs to. Nothing else writes `uSkySpin`.
//
// SCROLL FIRST, TIME SECOND: the sweep is scrubbed by p, with a small AMBIENT
// drift on top so a parked reader sees a live sky. The ambient accumulates dt
// clamped to 100 ms, since the hero stops rendering off-viewport.
//
// IT OWNS NOTHING THE STORY DRIVES — one attached object and two uniforms. It
// rides the STARFIELD GROUP so the arcs inherit its per-frame camera-centring,
// and re-asks for the attach every active frame because the fly mounts and
// unmounts the starfield underneath it.

import type { SceneHandle } from "../core/scene";
import { smoothstep } from "../core/math";
import { rangeOf, atFrac } from "./story";
import { TURN_P0, turnAt } from "./reveal";
import { isLightTheme, watchTheme } from "../core/theme";
import { uSkySpin } from "../optics/starfield";
import { createStarTrails, TRAIL_SWEEP_MAX } from "../optics/star-trails";

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");

/** Where the envelope has finished falling: a long fade spent OVER the reveal
 *  and the collapse, so the drawn shell turns under the fading arcs. It must
 *  land before SKY_OUT_END — the field's ink goes out before the star discs
 *  do, never arcs on an empty sky. */
export const ENV_END = atFrac(rwR, 0.28);

/** Slack past each edge of the driven span before the arcs are detached, so a
 *  scrub on an edge cannot thrash attach/detach; inside it the mesh hangs on
 *  the starfield at envelope 0. Exported so story/cost.ts reads the window
 *  rather than re-spelling it. */
const SPAN_PAD = 0.02;
export const SPAN_P0 = tR.p0 - SPAN_PAD;
export const SPAN_P1 = ENV_END + SPAN_PAD;

/** Where the sky starts turning, and the gate the ambient drift accrues behind.
 *  ONE number for both: everything that rotates the sky waits for the
 *  constellation ink together, or the drift pulls stars off their strokes. */
const SWEEP_P0 = TURN_P0;

/**
 * THE SWEEP, radians: how far the sky has turned at p — the chapter's own turn
 * (story/reveal.ts `turnAt`) at this field's amplitude.
 *
 * The SHAPE is not this file's on purpose: the same law drives the pieces'
 * orbit through the reveal, so the arcs and the shell turn at one rate and the
 * crossfade reads as a single rotation handed over. Exactly 0 before SWEEP_P0,
 * so a scrub back into the constellations leaves the sky bit-for-bit untilted.
 */
export const trailSweepAt = (p: number): number => TRAIL_SWEEP_MAX * turnAt(p);

/** The arcs' envelope. Rises after the constellation strokes have started to
 *  go, so the two kinds of sky ink are never both at full, and falls with the
 *  sky across `rewrap`'s first third (ENV_END). */
export const trailEnvAt = (p: number): number =>
  smoothstep(atFrac(tR, 0.02), atFrac(tR, 0.12), p) *
  (1 - smoothstep(atFrac(rwR, 0.02), ENV_END, p));

/** The drift, radians per second, added to the scrolled sweep while p is inside
 *  the turning part of the scene. Tiny: enough that a parked field is visibly
 *  alive, too little to make a scrub back read as dishonest. */
export const AMBIENT_SPIN_RATE = 0.012;

/** …and the ceiling on it, radians, so a parked tab cannot wind the sky up
 *  without limit. HELD IN ABSOLUTE ANGLE, not as a share of the sweep: a
 *  fraction would grow with the turn and stop reading as a drift. */
export const AMBIENT_MAX = 0.2;

/** …and how fast that residue is given back once p drops below the turn,
 *  radians per second: `uSkySpin` must reach EXACTLY 0 there, and the scroll
 *  law cannot do that half. It is AMBIENT_MAX per second — one second of payback —
 *  because only the STARS turn with the spin, so any residue below the turn is
 *  strokes pointing at empty sky and names sitting off their stars. */
export const AMBIENT_DECAY = AMBIENT_MAX;

export interface StoryTrails {
  /** Upload the arcs' vertex buffer off the gesture. Idempotent, and a no-op
   *  once the arcs are mounted for real. */
  warm(): void;
}

/**
 * Start the trails. Registers a scene.onFrame callback for the life of the page
 * — no teardown, because the hero's scene is never disposed.
 */
export function createStoryTrails(scene: SceneHandle): StoryTrails {
  const trails = createStarTrails({ light: isLightTheme() });

  watchTheme((l) => {
    trails.setTheme(l);
    scene.invalidate();
  });

  /** the drift's accumulated angle, radians — accrues only inside the turn */
  let ambient = 0;
  let last = performance.now();

  scene.onFrame(() => {
    const now = performance.now();
    const dt = Math.min(100, now - last) / 1000;
    last = now;

    const p = scene.state.storyTarget;
    if (p >= SWEEP_P0 && p <= tR.p1)
      ambient = Math.min(AMBIENT_MAX, ambient + AMBIENT_SPIN_RATE * dt);
    else if (p < SWEEP_P0) ambient = Math.max(0, ambient - AMBIENT_DECAY * dt);

    // ONE θ, BOTH WRITES, UNCONDITIONALLY — before any early return. The spin
    // belongs to the starfield, which outlives this driver's active span, so a
    // skipped write would leave the sky holding its last angle.
    const theta = trailSweepAt(p) + ambient;
    uSkySpin.value = theta;
    trails.setSweep(theta);

    // ZERO FIRST, ALWAYS: a fast flick can take p from inside the scene to
    // outside it between two frames, and without an unconditional write the
    // last opacity would hold — freezing a field of arcs on the sky.
    const env = trailEnvAt(p);
    trails.setEnvelope(env);

    if (env <= 0) {
      // Past the span's edges the mesh comes off the starfield entirely; inside
      // them it stays attached at zero, which costs one draw of fully
      // transparent quads and saves the re-attach on a small scrub.
      if (trails.object.parent && (p < SPAN_P0 || p > SPAN_P1))
        scene.starfieldDetach(trails.object);
      return;
    }

    // THE STARFIELD CAN GO OUT FROM UNDER US: story/fly.ts mounts it
    // asynchronously on the way in and unmounts it on the way out, so the first
    // frames of this envelope can find nothing to attach to and a re-entry finds
    // a fresh group. Ask every active frame — two null checks and a no-op once
    // attached, and it is the whole re-attach story.
    scene.starfieldAttach(trails.object);
  });

  let warmed = false;
  return {
    warm() {
      if (warmed) return;
      warmed = true;
      // through the pass as well — the arcs are worn over the dive's span,
      // where the pass keys its own pipeline
      if (!trails.object.parent) scene.warmDraw([trails.object], true);
    },
  };
}
