// ============================================================================
// THE SKY TURNS — the driver behind the `trails` scene. The lines are gone, the
// quote is holding, and the whole field begins to rotate about the middle of the
// frame, every star dragging an arc of ink behind it: a long exposure, and the
// last thing the sky does before the lens comes back.
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
import { TURN_P0, turnAt } from "./reveal";
import { isLightTheme, watchTheme } from "../core/theme";
import { uSkySpin } from "../optics/starfield";
import { createStarTrails, TRAIL_SWEEP_MAX } from "../optics/star-trails";
import { createCrownArc, CROWN_LOOK } from "../optics/crown-arc";

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");

/** Where the envelope has finished falling — rewrap-local 0.28, a long fade
 *  spent OVER the reveal and the collapse (the owner's fluid-transition
 *  correction: at the old 0.18 the arcs were gone almost the frame the lens
 *  finished drawing, and a fast scroll cut straight from sky to lens). The
 *  fully drawn shell now turns under the fading arcs from rewrap-local 0.16
 *  to here — both figures of the one rotation on screen together — and the
 *  arcs still die INTO the sky's own fade, whose far edge sits at 0.32
 *  (story/story.ts SKY_OUT_END): the field's ink is out a twenty-fifth of the
 *  scene before the star discs go, sky first, never arcs on empty sky. */
export const ENV_END = atFrac(rwR, 0.28);

/** Slack past each edge of the driven span before the arcs are detached, so a
 *  scrub parked on an edge cannot thrash attach/detach. Inside it the mesh simply
 *  hangs on the starfield at envelope 0.
 *
 *  EXPORTED with ENV_END, and for its reason: story/cost.ts counts the arcs'
 *  one draw at p and may not spell this window a second time. */
const SPAN_PAD = 0.02;
export const SPAN_P0 = tR.p0 - SPAN_PAD;
export const SPAN_P1 = ENV_END + SPAN_PAD;

/** WHERE THE SKY STARTS TURNING, as a scroll position — the turn's own p0
 *  (story/reveal.ts TURN_P0), re-used here as the gate the ambient drift accrues
 *  behind. ONE number for both: everything that rotates the sky has to wait for
 *  the constellation ink together, or the drift would pull the stars off their
 *  strokes exactly as the sweep would. */
const SWEEP_P0 = TURN_P0;

/**
 * THE SWEEP, radians: how far the sky has turned at p — the chapter's own turn
 * (story/reveal.ts `turnAt`) at this field's amplitude.
 *
 * THE SHAPE IS NOT THIS FILE'S, and that is the point: the same law drives the
 * PIECES' orbit through the reveal (story/hero-driver.ts writes the explode
 * recipe's spin from `revealSpinAt`), so the arcs and the shell turn at one
 * rate and the crossfade reads as a single rotation handed over rather than one
 * figure cut for another. It is also why the turn is no longer over inside this
 * scene: it holds its cruising rate until REVEAL_END, well past the arcs' own
 * fade, so nothing on screen decelerates before it goes (the owner: "have the
 * trails continue spinning during the transition").
 *
 * Exactly 0 anywhere before SWEEP_P0 — scrub back into the constellations and
 * the sky is bit-for-bit untilted, which is what keeps the dive's rendering
 * unchanged.
 */
export const trailSweepAt = (p: number): number => TRAIL_SWEEP_MAX * turnAt(p);

/** THE ARCS' ENVELOPE. Rises just inside the trails scene — after the
 *  constellation strokes have started to go (story/constellations.ts fades them
 *  over trails-local [0, 0.25]), so the two kinds of sky ink are never both at
 *  full — and falls with the sky itself across `rewrap`'s first third: the
 *  trails die OVER the reveal and the collapse (ENV_END above carries the
 *  owner's fluid-transition story) rather than being cut with the starfield's
 *  unmount. */
export const trailEnvAt = (p: number): number =>
  smoothstep(atFrac(tR, 0.02), atFrac(tR, 0.12), p) *
  (1 - smoothstep(atFrac(rwR, 0.02), ENV_END, p));

// ── THE CROWN ───────────────────────────────────────────────────────────────
// One arc of the field is not a star's (optics/crown-arc.ts). It rides a circle
// concentric with the field's own for the whole scene — centred on the frame
// like every real trail, at the same flat ink — and then, as the field goes out
// under it, RESOLVES: the circle walks left and tightens onto the front
// element's own silhouette, its head opens out to a steady arc centred on the
// top, and its cross-profile morphs from a trail's soft band into an even edge.
// It then HOLDS THERE, alone, through the storm of returning shells, and goes
// out just as the element it is drawn around becomes the obvious thing in the
// frame.
//
// WHY IT OUTLIVES THE SKY. Every other mark of the chapter dies with the
// starfield, which story/fly.ts fades to nothing at SKY_OUT_END (rewrap-local
// 0.32; the span's own unmount, EXIT_END, sits out at 0.58 now that the fov
// hand-back is de-stacked, but by then there is nothing left drawn) — and the
// front element is not drawn at all until the reveal restores the glass fades
// under it. A crown that died with the sky would be gone before the thing it
// points at had appeared. It therefore hangs on the SCENE ROOT
// (SceneHandle.addOverlay), which it can do precisely because it is screen
// space and owns no sky geometry.
//
// AND WHY IT TRACKS. The CAMERA is dead still through the reveal now
// (story/story.ts REVEAL_END), but the element is not: the pieces are spinning
// and reeling home inside it, and the moment the reveal is over three things
// move at once — the fly hands its fov back (70°→42°, a 1.8× push on everything
// in the frame), the lens gives back the reveal's overshoot (another 1.39×), and
// the story's own camera chain is released and swings off the axis. The front
// element's drawn disc grows by more than 2× across that stretch. A fixed circle
// registers for one frame and is a hundred pixels out a hundred pixels of scroll
// later. So the target is the element's OWN drawn disc, read every frame through
// SceneHandle.projectDrawn — deform included, which matters: mid-reassembly the
// element is drawn well away from the seat its object transform still reports.

/** THE PART THE CROWN IS DRAWN AROUND: the front element, the first piece of
 *  glass the light meets and the widest disc in the frame at the reveal. */
const CROWN_PART = "Element_01";

/** THE RESOLVE, 0 = one more trail, 1 = the lens's edge — over rewrap-local
 *  [0.02, 0.215].
 *
 *  IT RUNS WITH THE FIELD'S OWN FADE, not ahead of it, AT BOTH EDGES, and that
 *  is what fixes the number. `trailEnvAt` starts falling at exactly 0.02, so
 *  the crown leaves the family on the frame the family starts to leave: one arc
 *  walking left and tightening onto the lens while its neighbours go out around
 *  it. Started earlier — it used to open at trails-local 0.6, most of a scene
 *  before anything faded — it read as one trail breaking ranks and sliding
 *  across a sky that was otherwise holding still (the owner: "animates before
 *  the trails disappear"). The FAR edge is the same coupling: it lands at 0.75
 *  of the fade's own span, where it always did. The fade ran [0.02, 0.18] and
 *  the resolve [0.02, 0.14]; the fluid-transition rework moved the fade's far
 *  edge to 0.28 (ENV_END above), so this one moves with it — 0.02 + 0.75·0.26.
 *  Left at 0.14 the crown was finished with the field still at 56 % ink and its
 *  neighbours 0.24 screenfuls from going, which is the old complaint again in
 *  miniature. It now finishes with the field at 16 %.
 *
 *  It therefore RESOLVES ACROSS the live hand-off below rather than handing to
 *  it at its foot: the hand-off opens at 0.14 (where this is 67 % travelled)
 *  and saturates at 0.22, this lands at 0.215, just inside it. The two compose
 *  as nested lerps in the driver below, and the circles they blend between are
 *  concentric and equal at 0.14 (optics/crown-arc.ts CROWN_LOOK.lens is
 *  measured there), so the overlap is continuous — what it costs is that the
 *  arc is still tightening while the element it lands on is being uncovered
 *  (the reveal, up by 0.16), which is the look the widened hand-over asks for
 *  everywhere else in this chapter. A smoothstep saturates at both ends: scrub
 *  back below the start and the crown is bit-for-bit a trail again. */
export const crownResolveAt = (p: number): number =>
  smoothstep(atFrac(rwR, 0.02), atFrac(rwR, 0.215), p);

/** THE HAND-OVER FROM THE AUTHORED LANDING CIRCLE TO THE ELEMENT'S OWN, over
 *  rewrap-local [0.14, 0.22] — i.e. from the beat the element is DRAWN
 *  (story/fly.ts's reveal restores the glass fades as the body cover lifts) and
 *  through the shell's collapse, which is where the arc has to be following a
 *  live disc rather than an authored one: the element is on the optical axis and
 *  the reveal's roll is about that axis, so the thing the crown tracks is the
 *  one part of the frame the turn does not move. Not before: earlier the element
 *  is behind the camera or fully
 *  faded glass, and an arc chasing a thing nobody can see is just an arc
 *  wandering the frame. So it parks on `CROWN_LOOK.lens`, which is MEASURED to
 *  be the element's disc at 0.14, and starts to follow from there — while the
 *  resolve above is still travelling onto that same circle (it lands at 0.215,
 *  just inside this window's far edge). Both are lerps toward the same target,
 *  so the two running together is a continuous blend, not a fight. */
export const crownLiveAt = (p: number): number =>
  smoothstep(atFrac(rwR, 0.14), atFrac(rwR, 0.22), p);

/** THE CROWN'S OWN ENVELOPE. It rises with the field (one chapter, one arrival)
 *  and falls LATE and alone, over rewrap-local [0.34, 0.48] — which starts well
 *  after the reveal has uncovered the front element (0.16) and put its glass back,
 *  so the arc spends its whole fade lying on a lens you can see rather than on
 *  the promise of one. The field is gone by then (`trailEnvAt` ends at 0.28)
 *  and so is the sky (SKY_OUT_END, 0.32 — the fall's foot sits just past it,
 *  so "alone" survived the widened hand-over): the last thing the chapter
 *  leaves on screen is one arc on the front element, going out as the lens
 *  takes the frame under the fov push (story/fly.ts FOV_BACK opens at 0.32,
 *  and the crown tracks the drawn disc, so it rides the push while it fades).
 *
 *  IT NO LONGER WAITS FOR THE SHADING. It used to be placed after the fly span's
 *  own edge (0.25 then, 0.58 now — story/fly.ts EXIT_END sits out past the fov
 *  hand-back), so the fade runs over a lens mid-hand-over — realistic at the
 *  fall's foot, the ink return (story/fly.ts INK_RETURN, [0.16, 0.36]) crossing
 *  under it. Being DRAWN is what the arc needs, not being drawn in ink; the
 *  element is drawn from the reveal on either way. Left where it is
 *  deliberately: the crown's beats are signed off against the reveal, not
 *  against the hand-back. */
export const crownEnvAt = (p: number): number =>
  smoothstep(atFrac(tR, 0.02), atFrac(tR, 0.12), p) *
  (1 - smoothstep(atFrac(rwR, 0.34), atFrac(rwR, 0.48), p));

/** Slack past the crown's own span before it comes off the scene root. It shares
 *  SPAN_P0 with the arcs but outlives them by a fifth of the rewrap scene, which
 *  is why it needs an edge of its own — exported for story/cost.ts, whose crown
 *  column would otherwise re-spell it. */
export const CROWN_P1 = atFrac(rwR, 0.48) + SPAN_PAD;

/** THE DRIFT, radians per second, added to the scrolled sweep while p is inside
 *  the turning part of the scene. Tiny: over the ten-odd seconds a reader might
 *  park there it adds about a tenth of a radian — enough that the field is
 *  visibly alive, far too little to make a scrub back read as dishonest. */
export const AMBIENT_SPIN_RATE = 0.012;

/** …and the ceiling on it, radians. A tab left parked in the trails scene must
 *  not wind the sky up without limit. HELD IN ABSOLUTE ANGLE, not as a share of
 *  the sweep: what a parked reader must not see is the half revolution the scene
 *  promises turning into a visibly longer one, and 0.2 rad is ~11° on top of
 *  180° — about 6% of the turn, and a pixel or so of drift a second at the
 *  frame's edge. (It was 0.35 against the old 0.55 sweep, i.e. two-thirds of the
 *  turn; that same FRACTION of a π sweep would be another 2 rad of sky, which is
 *  not a drift, it is a second scene.) */
export const AMBIENT_MAX = 0.2;

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
