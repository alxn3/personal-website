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
import { lerp, smoothstep } from "../core/math";
import { rangeOf, atFrac } from "./story";
import { TURN_P0, turnAt } from "./reveal";
import { isLightTheme, watchTheme } from "../core/theme";
import { uSkySpin } from "../optics/starfield";
import { createStarTrails, TRAIL_SWEEP_MAX } from "../optics/star-trails";
import { createCrownArc, CROWN_LOOK } from "../optics/crown-arc";

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

// ── THE CROWN ───────────────────────────────────────────────────────────────
// One arc of the field is not a star's (optics/crown-arc.ts): it rides a circle
// concentric with the field's for the whole scene, then RESOLVES onto the front
// element's silhouette as the field goes out, holds there alone, and leaves.
//
// IT OUTLIVES THE SKY, so it hangs on the SCENE ROOT (addOverlay) rather than
// the starfield group — which it can do because it is screen space and owns no
// sky geometry. A crown that died with the sky would be gone before the element
// it points at was drawn.
//
// AND IT TRACKS: the front element's drawn disc grows by more than 2× over the
// fov hand-back, the reveal overshoot and the camera chain's release, so the
// target is read every frame through SceneHandle.projectDrawn — deform
// included, since mid-reassembly the element is drawn well away from the seat
// its object transform reports.

/** The part the crown is drawn around: the front element, the widest disc in
 *  the frame at the reveal. */
const CROWN_PART = "Element_01";

/** The resolve, 0 = one more trail, 1 = the lens's edge.
 *
 *  BOTH EDGES ARE PINNED TO THE FIELD'S FADE: it opens where `trailEnvAt`
 *  starts falling, so the crown leaves the family on the frame the family
 *  starts to leave, and lands at 0.75 of that fade's span. It therefore
 *  RESOLVES ACROSS the live hand-off below rather than handing to it at its
 *  foot; the two compose as nested lerps in the driver, and the circles they
 *  blend between are concentric and equal at the hand-off's foot, so the
 *  overlap is continuous. */
export const crownResolveAt = (p: number): number =>
  smoothstep(atFrac(rwR, 0.02), atFrac(rwR, 0.215), p);

/** The hand-over from the authored landing circle to the element's own, opening
 *  on the beat the element is DRAWN — earlier it is behind the camera or fully
 *  faded glass, and an arc chasing what nobody can see just wanders the frame.
 *  It parks on `CROWN_LOOK.lens`, which IS the element's disc at this window's
 *  foot, so this and the resolve above are lerps toward the same target. */
export const crownLiveAt = (p: number): number =>
  smoothstep(atFrac(rwR, 0.14), atFrac(rwR, 0.22), p);

/** The crown's own envelope: rises with the field, falls LATE and alone. Its
 *  fall must open after the reveal has uncovered the front element and after
 *  both the field (`trailEnvAt`) and the sky (SKY_OUT_END) are gone, so the
 *  last mark of the chapter is one arc lying on a lens you can see. */
export const crownEnvAt = (p: number): number =>
  smoothstep(atFrac(tR, 0.02), atFrac(tR, 0.12), p) *
  (1 - smoothstep(atFrac(rwR, 0.34), atFrac(rwR, 0.48), p));

/** Slack past the crown's own span before it comes off the scene root. It shares
 *  SPAN_P0 with the arcs but outlives them by a fifth of the rewrap scene, which
 *  is why it needs an edge of its own — exported for story/cost.ts, whose crown
 *  column would otherwise re-spell it. */
export const CROWN_P1 = atFrac(rwR, 0.48) + SPAN_PAD;

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
  /** Upload the arcs' vertex buffer and the crown's off the gesture. Idempotent,
   *  and a no-op once either is mounted for real. */
  warm(): void;
}

/**
 * Start the trails. Registers a scene.onFrame callback for the life of the page
 * — no teardown, because the hero's scene is never disposed.
 */
export function createStoryTrails(scene: SceneHandle): StoryTrails {
  const trails = createStarTrails({ light: isLightTheme() });
  const crown = createCrownArc({ light: isLightTheme() });

  watchTheme((l) => {
    trails.setTheme(l);
    crown.setTheme(l);
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

    // THE CROWN, on its own schedule and its own parent — and BEFORE the field's
    // early return, since it outlives the last trail.
    const t = crownResolveAt(p);
    const cEnv = crownEnvAt(p);
    // WHERE THE ARC IS HEADING: the authored landing circle until the element is
    // back in front of the camera, then the element's own drawn disc. Asked for
    // only while the crown is on screen — it walks the op field on the CPU.
    const live = cEnv > 0 ? scene.projectDrawn(CROWN_PART) : null;
    const k = live ? crownLiveAt(p) : 0;
    const lens = CROWN_LOOK.lens;
    crown.setShape(
      lerp(CROWN_LOOK.trail.cx, lerp(lens.cx, live ? live.x : 0, k), t),
      lerp(CROWN_LOOK.trail.cy, lerp(lens.cy, live ? live.y : 0, k), t),
      lerp(CROWN_LOOK.trail.r, lerp(lens.r, live ? live.r : 0, k), t),
      // as a trail the head rides the turn and the arc IS the history behind it;
      // as the lens it is a fixed arc centred on the top of the circle
      lerp(CROWN_LOOK.phi0 + theta, CROWN_LOOK.phi0 + CROWN_LOOK.span / 2, t),
      lerp(theta, CROWN_LOOK.span, t),
      t,
    );
    crown.setEnvelope(cEnv);
    if (cEnv <= 0) {
      if (crown.object.parent && (p < SPAN_P0 || p > CROWN_P1))
        scene.removeOverlay(crown.object);
    } else if (!crown.object.parent) scene.addOverlay(crown.object);

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
      const owed = [trails.object, crown.object].filter((o) => !o.parent);
      // through the pass as well — the arcs and the crown are worn over the
      // dive's span, where the pass keys its own pipeline
      if (owed.length) scene.warmDraw(owed, true);
    },
  };
}
