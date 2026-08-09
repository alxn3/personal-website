// ============================================================================
// THE SKY TURNS — the driver behind the `trails` scene. The lines are gone, the
// quote is holding, and the whole field begins to rotate about a point low in
// the frame, every bright star dragging an arc of ink behind it: a long
// exposure, and the last thing the sky does before the lens comes back.
//
// LAZY MODULE, exactly like story/fly.ts and story/constellations.ts. It
// statically imports optics/ (the trail engine and the starfield's spin
// uniforms), which drag three/tsl node graphs into whatever chunk they land in,
// so this file is reachable ONLY through hero-driver's dynamic import() and must
// NEVER be re-exported from index.ts.
//
// ONE θ, TWO WRITES — the file's whole invariant. `uSkySpin` turns the star
// discs and the authored strokes (optics/starfield.ts); `setSweep` tells the
// arcs how much history to draw. Both are handed the SAME number every frame, so
// an arc's head is by construction at the disc it belongs to. Nothing else in
// the codebase writes `uSkySpin` — story/fly.ts runs on the same scroll frames
// and never touches it.
//
// SCROLL FIRST, TIME SECOND. The sweep is scrubbed by p (scrub back and the sky
// un-rotates, honestly), with a small AMBIENT drift on top so a reader parked
// mid-scene sees a sky that is alive rather than frozen. The ambient uses an
// ACCUMULATED dt clamped to 100 ms — story/internals.ts's rule, because the hero
// stops its render loop whenever the canvas leaves the viewport and a law keyed
// to absolute time would jump on return.
//
// IT OWNS NOTHING THE STORY DRIVES: no channels, no camera, no materials — one
// attached object and two uniforms. It rides the STARFIELD GROUP
// (SceneHandle.starfieldAttach) so the arcs inherit that group's per-frame
// camera-centring, and it re-asks for the attach every active frame because the
// fly mounts and unmounts the starfield underneath it.
// ============================================================================

import type { SceneHandle } from "../core/scene";
import { lerp, smoothstep } from "../core/math";
import { rangeOf, atFrac } from "./story";
import { isLightTheme, watchTheme } from "../core/theme";
import { uSkySpin } from "../optics/starfield";
import { createStarTrails, TRAIL_SWEEP_MAX } from "../optics/star-trails";
import { createCrownArc, CROWN_LOOK } from "../optics/crown-arc";

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");

/** Where the envelope has finished falling — the sky's own fade into the reveal
 *  (Task 2 dims the backdrop over the same window). */
const ENV_END = atFrac(rwR, 0.18);

/** Slack past each edge of the driven span before the arcs are detached, so a
 *  scrub parked on an edge cannot thrash attach/detach. Inside it the mesh simply
 *  hangs on the starfield at envelope 0. */
const SPAN_PAD = 0.02;
const SPAN_P0 = tR.p0 - SPAN_PAD;
const SPAN_P1 = ENV_END + SPAN_PAD;

/** WHERE THE SKY STARTS TURNING, as a scroll position — the sweep's own p0, and
 *  the gate the ambient drift accrues behind. ONE number for both: everything
 *  that rotates the sky has to wait for the constellation ink together, or the
 *  drift would pull the stars off their strokes exactly as the sweep would. */
const SWEEP_P0 = atFrac(tR, 0.2);

/**
 * THE SWEEP, radians: how far the sky has turned at p. Zero until a fifth of the
 * way into the trails scene, saturating at TRAIL_SWEEP_MAX by 90% through it —
 * the turn is finished before the reveal starts, so the last beat of the chapter
 * is a fade and not a fade over a move.
 *
 * THE LATE START IS THE POINT. The constellation ink is anchored to UNROTATED
 * star directions (story/constellations.ts spawns strokes from fixed endpoints
 * and its labels sit on fixed headings), so any rotation while that ink is still
 * on the sky pulls the stars out from under their own strokes. The ink lets go
 * over trails-local [0, 0.25] (`constellationEnvAt`); starting here at 0.2 holds
 * the field still through nearly all of that, and the smoothstep's flat foot
 * covers the rest: by the point the turn has moved the outermost star even two
 * pixels (local ≈ 0.224), the strokes are under 3% opacity.
 *
 * A smoothstep saturates at BOTH ends, so this is exactly 0 anywhere before that
 * point: scrub back into the constellations and the sky is bit-for-bit untilted,
 * which is what keeps the dive's rendering unchanged.
 */
export const trailSweepAt = (p: number): number =>
  TRAIL_SWEEP_MAX * smoothstep(SWEEP_P0, atFrac(tR, 0.9), p);

/** THE ARCS' ENVELOPE. Rises just inside the trails scene — after the
 *  constellation strokes have started to go (story/constellations.ts fades them
 *  over trails-local [0, 0.25]), so the two kinds of sky ink are never both at
 *  full — and falls with the sky itself early in `rewrap`: the trails die INTO
 *  the reveal fade rather than being cut with the starfield's unmount. */
export const trailEnvAt = (p: number): number =>
  smoothstep(atFrac(tR, 0.02), atFrac(tR, 0.12), p) *
  (1 - smoothstep(atFrac(rwR, 0.02), ENV_END, p));

// ── THE CROWN ───────────────────────────────────────────────────────────────
// One arc of the field is not a star's (optics/crown-arc.ts). It opens the
// scene sitting exactly where the old sky-anchored crown sat and behaving like
// its neighbours — head on the turn, tail back down the history — then over the
// last two fifths of the scene it RESOLVES: the circle it rides walks up and
// tightens onto the front element's own silhouette, its head opens out to a
// steady arc centred on the top, and its ink flattens from a trail's dying tail
// into an even edge. It then HOLDS THERE, alone, through the storm of returning
// shells, and goes out just as the element it is drawn around becomes the
// obvious thing in the frame.
//
// WHY IT OUTLIVES THE SKY. Every other mark of the chapter dies with the
// starfield, which story/fly.ts unmounts at rewrap-local 0.25 — and the front
// element is not even DRAWN until then (through the dive it is one of the
// transmissive clones, and it comes back as ink at the hand-back). A crown that
// died with the sky would be gone before the thing it points at had appeared. It
// therefore hangs on the SCENE ROOT (SceneHandle.addOverlay), which it can do
// precisely because it is screen space and owns no sky geometry.
//
// AND WHY IT TRACKS. The reveal is not a still frame: the camera reverses back
// through the lens while the shells reel home, and the front element's drawn
// disc crosses ~200 px of screen over the crown's fade alone. A fixed circle
// registers for one frame and is 100 px out two hundred pixels of scroll later.
// So the target is the element's OWN drawn disc, read every frame through
// SceneHandle.projectDrawn — deform included, which matters: mid-reassembly the
// element is drawn ~100 px from the seat its object transform still reports.

/** THE PART THE CROWN IS DRAWN AROUND: the front element, the first piece of
 *  glass the light meets and the widest disc in the frame at the reveal. */
const CROWN_PART = "Element_01";

/** WHERE THE CROWN LEAVES THE FIELD, as a trails-local fraction — the start of
 *  the resolve. Late on purpose: for the first three fifths of the scene the
 *  crown must be indistinguishable from a trail, or there is nothing for it to
 *  resolve OUT of. */
const CROWN_RESOLVE_F0 = 0.6;

/** THE RESOLVE, 0 = one more trail, 1 = the lens's edge. Reaches 1 exactly at
 *  the end of the trails scene, so the whole of `rewrap` is spent held on the
 *  element's circle rather than still travelling toward it. A smoothstep
 *  saturates at both ends: scrub back below the start and the crown is bit-for-
 *  bit a trail again. */
export const crownResolveAt = (p: number): number =>
  smoothstep(atFrac(tR, CROWN_RESOLVE_F0), tR.p1, p);

/** THE HAND-OVER FROM THE AUTHORED LANDING CIRCLE TO THE ELEMENT'S OWN, over
 *  rewrap-local [0.25, 0.32] — i.e. from the beat the shading hands back and the
 *  element starts being DRAWN. Not before: for everything earlier the element is
 *  behind the camera or invisible glass, and an arc chasing a thing nobody can
 *  see is just an arc wandering the frame. So it parks on `CROWN_LOOK.lens`,
 *  which is measured to be exactly the element's disc at 0.25, and starts to
 *  follow at the frame the lens turns up inside it. */
export const crownLiveAt = (p: number): number =>
  smoothstep(atFrac(rwR, 0.25), atFrac(rwR, 0.32), p);

/** THE CROWN'S OWN ENVELOPE. It rises with the field (one chapter, one arrival)
 *  and falls LATE and alone, over rewrap-local [0.30, 0.44] — which starts after
 *  the shading has handed back at 0.25 and the front element is finally being
 *  DRAWN, so the arc spends its whole fade lying on a lens you can see rather
 *  than on the promise of one. The field is long gone by then (`trailEnvAt` ends
 *  at 0.18) and so is the sky: the last thing the chapter leaves on screen is
 *  one arc on the front element, going out as the lens takes the frame. */
export const crownEnvAt = (p: number): number =>
  smoothstep(atFrac(tR, 0.02), atFrac(tR, 0.12), p) *
  (1 - smoothstep(atFrac(rwR, 0.3), atFrac(rwR, 0.44), p));

/** Slack past the crown's own span before it comes off the scene root. */
const CROWN_P1 = atFrac(rwR, 0.44) + SPAN_PAD;

/** THE DRIFT, radians per second, added to the scrolled sweep while p is inside
 *  the turning part of the scene. Tiny: over the ten-odd seconds a reader might
 *  park there it adds about a tenth of a radian — enough that the field is
 *  visibly alive, far too little to make a scrub back read as dishonest. */
export const AMBIENT_SPIN_RATE = 0.012;

/** …and the ceiling on it, radians. A tab left parked in the trails scene must
 *  not wind the sky up without limit: at about two-thirds of a scrolled sweep
 *  the drift stops, which keeps the total turn inside what the arcs were tuned
 *  for and keeps the unwind below a few seconds. */
export const AMBIENT_MAX = 0.35;

/** …and how fast that residue is given back once p drops below the turn,
 *  radians per second. `uSkySpin` must reach EXACTLY 0 there, and this is the
 *  half of that the scroll law cannot do.
 *
 *  IT IS AMBIENT_MAX PER SECOND, AND THAT RATIO IS THE POINT. Only the STARS
 *  turn with the spin: the sky's dynamic ink (optics/constellation-lines.ts and
 *  the labels) is anchored to UNROTATED directions and does not follow it. So
 *  every second of residue left after a scrub back into `constellations` — where
 *  that ink is at FULL opacity — is a second of strokes pointing at empty sky and
 *  names sitting off their stars. At the cap that is one second; at 0.08 (the
 *  first shipped value) it was four and a half, and plainly broken to look at. */
export const AMBIENT_DECAY = AMBIENT_MAX;

/**
 * Start the trails. Registers a scene.onFrame callback for the life of the page
 * — like story/constellations.ts there is no teardown, because the hero's scene
 * is never disposed.
 */
export function createStoryTrails(scene: SceneHandle): void {
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

    // ONE θ, BOTH WRITES, UNCONDITIONALLY — before any early return. The spin is
    // a property of the starfield, which outlives this driver's active span: if
    // the idle path skipped the write, a scrub back into the dive would find the
    // sky still holding the last angle it was handed.
    const theta = trailSweepAt(p) + ambient;
    uSkySpin.value = theta;
    trails.setSweep(theta);

    // ZERO FIRST, ALWAYS (story/constellations.ts's lesson): a fast flick across
    // the fall window can take p from inside the scene to outside it between two
    // frames, and without an unconditional write the last opacity the shader was
    // handed would hold — freezing a field of arcs on the sky.
    const env = trailEnvAt(p);
    trails.setEnvelope(env);

    // THE CROWN, on its own schedule and its own parent — and BEFORE the field's
    // early return, because it is still on screen for a fifth of `rewrap` after
    // the last trail has gone.
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
}
