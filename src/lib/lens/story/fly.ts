// The STORY's fly-through span: the /lens demo's dive (explore/demos.ts
// d-flythrough) re-hosted on the scroll, from `flythrough` through
// `constellations` and `trails`, ending inside `rewrap`.
//
// THE CAMERA IS NEVER OVERRIDDEN — the LENS travels. The camera parks on the
// optical axis at the dive's opening pose and the model moves instead:
// x_model = X_PARK − x_camera. The fov ramp is the only camera-side term.
//
// Every other law here is the demo's, transcribed over the same FLY knobs
// (optics/fly-core.ts); if a number disagrees with the demo, the demo is right.
// One exception: the STREAK fall is re-hosted onto the WORMHOLE's fall window
// (flyStreakAt) so the ring and the smear it is made of end together.
//
// LAZY MODULE: statically imports optics/ uniform boxes (three/tsl node graphs
// that must stay out of the homepage's initial chunk), so it is reachable ONLY
// through hero-driver's dynamic import() and must NEVER be re-exported from
// index.ts.
//
// WHAT IT OWNS: the aperture and focus channels (value AND target, so the
// driver's per-frame writes cannot fight it), the sky/warp uniforms, the
// realistic↔ink blend, the glass swap, the room light and glass glint, the
// lens' dolly and body cover, and the camera's fov. It does NOT touch
// zoom/explode/assemble, and it never PLACES the camera.
import type { CameraPose, SceneHandle } from "../core/scene";
import { clamp01, lerp, smoothstep } from "../core/math";
import { isLightTheme, watchTheme } from "../core/theme";
import { rangeOf, atFrac, REVEAL_END, SKY_OUT_END, DIVE_P0 } from "./story";
import {
  FLY,
  flyPose,
  travelRemap,
  passageFade,
  poseCamX,
  passageOrder,
  GLASS_SPANS,
} from "../optics/fly-core";
import { uWormhole } from "../optics/wormhole-post";
import { uStarMix, uStarStreak, uStarRing } from "../optics/starfield";

const flyR = rangeOf("flythrough");
const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");
/** Where the camera starts leaving the internals pose: the flythrough scene's
 *  own approach, over which the rig swings onto the axis and parks. */
export const CAM_IN = flyR.p0;
// DIVE_P0 — the end of that approach — lives in story/story.ts rather than
// here, because hero-driver's body-fade tile must end on exactly that number
// and cannot import from this lazy module.
/** The span's last frame, where the dive hands the scene back. It must sit PAST
 *  the fov hand-back (FOV_BACK): exit() writes a `null` override, which is a
 *  cut, so the two fovs have to already agree by here. */
export const EXIT_END = atFrac(rwR, 0.58);
/** Where the transmissive glass hands back — inside the span, after the blind
 *  journey home and before the reveal's crossfade, so the material cut lands
 *  under the full body cover. Any ink over the dive's clones would stomp them,
 *  so this must precede INK_RETURN[0]. */
export const GLASS_OUT = atFrac(rwR, 0.055);
/** The ink's way back, [start, end]. The start is the body-fade top
 *  (flyRevealAt saturates there), so the appearance itself plays realistic and
 *  the dissolve begins on the first frame the lens is wholly drawn. */
export const INK_RETURN: [number, number] = [
  atFrac(rwR, 0.16),
  atFrac(rwR, 0.36),
];
/** scroll-p slack past each edge before the span's side effects are torn down,
 *  so a scrub sitting on an edge cannot thrash enter()/exit(). Every frame
 *  inside it is a frame of the WRONG look, so it stays about half a notch. */
export const HYST = 0.005;

/** The look's hand-over — 1 = the story's ink, 0 = the realistic lens the dive
 *  flies through. One material, so this is a blend, not a cut.
 *
 *  BOTH RAMPS SIT OUTSIDE THE GLASS SUB-SPAN, hysteresis included: the elements
 *  still swap a material for the transmissive clones, and any ink while those
 *  are mounted would stomp them. */
export const flyInkAt = (p: number) =>
  1 -
  smoothstep(CAM_IN, DIVE_P0 - HYST, p) *
    (1 - smoothstep(INK_RETURN[0], INK_RETURN[1], p));

/** The framing's centre, the ink's ramp inverted: 1 = the optical axis is in
 *  the middle of the frame. Named rather than inlined so story/state.ts can
 *  report exactly what frame() writes. */
export const flyCentreAt = (p: number) => 1 - flyInkAt(p);

/** The sky's way out — the mirror of the dive's `pSkyIn` window. The stars ramp
 *  to nothing WHILE the backdrop blends to the rewrap stage's tint, so the
 *  unmount at the span's edge happens between two frames of the same color.
 *  1 through the whole dive and both sky scenes; 0 from SKY_OUT_END on. */
export const skyOutAt = (p: number) =>
  1 - smoothstep(atFrac(rwR, 0.02), SKY_OUT_END, p);

/** Dive progress: the flythrough scene scrubs the dive from the end of its
 *  approach (DIVE_P0); the two sky scenes hold its end frame. */
export const flyDiveP = (p: number) =>
  clamp01((p - DIVE_P0) / (flyR.p1 - DIVE_P0));

/** THE SKY'S WAY IN, on the DIVE's own clock (the demo's `FLY.pSkyIn`): no
 *  stars before the camera reaches the mount. The mirror of skyOutAt above. */
export const flySkyInAt = (pFly: number) =>
  smoothstep(FLY.pSkyIn[0], FLY.pSkyIn[1], pFly);

/** What the sky fade uniforms get: the arrival, less the reveal's fade. Exactly
 *  0 outside the span, so it agrees with exit()'s teardown and story/state.ts
 *  can report it everywhere. */
export const flySkyMixAt = (p: number) => flySkyInAt(flyDiveP(p)) * skyOutAt(p);

/** The darkness: the room and the glass' reflections going out with the barrel,
 *  on the dive's clock and RELEASED by the sky's fade (× skyOutAt) so the light
 *  is already back when exit() sets it to 1. Levels are lerped in frame(). */
export const flyDarkAt = (p: number) =>
  smoothstep(FLY.pDark[0], FLY.pDark[1], flyDiveP(p)) * skyOutAt(p);

/** The pinch at story p: the demo's own arc, whole — alive exactly while the
 *  dive visibly travels, spent by 0.84 of it. Also drives the ring's ramp: the
 *  sprite band's swing from radial to tangential is half the same feature, so
 *  it must be exactly 0 through `trails` (the perfect circles). */
export const flyWarpAt = (p: number) => {
  const pFly = flyDiveP(p);
  return (
    smoothstep(FLY.pWormhole[0], FLY.pWormhole[1], pFly) *
    (1 - smoothstep(FLY.pWormhole[1], FLY.pWormhole[2], pFly))
  );
};

/** The streaks — the demo's rise (behind the pinch's: the smear wants a throat
 *  to smear into) and the PINCH's fall rather than the demo's own. The ring is
 *  MADE of the streaks, and a streak of zero length swings nothing, so both
 *  halves of the feature must end on the same frame. */
export const flyStreakAt = (p: number) => {
  const pFly = flyDiveP(p);
  return (
    smoothstep(FLY.pStreak[0], FLY.pStreak[1], pFly) *
    (1 - smoothstep(FLY.pWormhole[1], FLY.pWormhole[2], pFly))
  );
};

/** Where the parked camera sits, world X. The dive's path opens with the camera
 *  `FLY.distFar` behind the lens, so parking there makes the model's dolly
 *  exactly 0 on the dive's first frame; the flythrough story row is authored
 *  from the same number. */
export const X_PARK = -FLY.distFar;

/** The dive's pose at story p, through the interior remap (FLY.insideRate) —
 *  held at the first pose until the approach is over. Read TWICE: as the
 *  model's dolly below, and as the passage fade's ruler. */
export const flyPoseAt = (p: number) =>
  flyPose(travelRemap(flyDiveP(p), FLY.pInside, FLY.insideRate));

/** Where the reveal is played, world X: the lens comes back to here, 3.5 units
 *  PAST home, so the exploded shell does not fill the frame on the dive's wide
 *  fov. Not a new home — the story's poses orbit the ORIGIN, so flySeatAt gives
 *  this distance back before the camera chain starts to move. */
export const REVEAL_X = 3.5;

/** The journey back — 0 while the lens is out on the dive, 1 once it reaches
 *  the reveal's park (REVEAL_X; not home yet, see flySeatAt). Its own ease, not
 *  a reversed dive, whose tail would slide 28 units in a hundredth of p.
 *
 *  IT RUNS BLIND: the lens travels through the camera's own position, so every
 *  frame of this window must sit under the body cover — hence it ends before
 *  the reveal window the cover lifts over, and starts in the trails' hold. */
export const flyReturnAt = (p: number) =>
  smoothstep(atFrac(tR, 0.9), atFrac(rwR, 0.05), p);

/** …and the last leg, from the reveal's park to the origin: 0 through the whole
 *  reveal, 1 once the lens is exactly home. The last of the staggered movers
 *  (chain creep at CAM_RELEASE_F, fov push at FOV_BACK[0], then this).
 *
 *  IT MUST FINISH EARLY: the chain's poses orbit the ORIGIN, so a lens short of
 *  it is a lens off the frame's centre by the sine of the camera's swing, and
 *  the chain leaves at CAM_RELEASE_F, before this window even opens. */
export const flySeatAt = (p: number) =>
  smoothstep(REVEAL_END, atFrac(rwR, 0.34), p);

/** The reveal — the exploded lens coming back on screen, 0 = covered, 1 = fully
 *  drawn. The pieces arrive at full explosion, already rolling in the sky's own
 *  direction (story/reveal.ts revealRollAt), and the trails sweep on past this
 *  window's top so the exchange is not a blink.
 *
 *  IT IS PLAYED ON A DEAD-STILL CAMERA. Nothing camera-side moves for any frame
 *  of this window: the chain is held through CAM_RELEASE_F, the fov hand-back
 *  has not opened (FOV_BACK), and the lens is parked at REVEAL_X — so the
 *  pieces' spin, fade-in and assembly are the only motion in the frame. */
export const flyRevealAt = (p: number) =>
  smoothstep(atFrac(rwR, 0.06), atFrac(rwR, 0.16), p);

/** The body cover, this span's half of the `setBodyFade` channel: 1 = the model
 *  is drawn, 0 = it is not. Down over the dive's last tenth (the return crosses
 *  the camera), back up over the reveal.
 *
 *  EXACTLY 1 AT DIVE_P0: the driver holds a constant 1 below that edge (nothing
 *  hides the lens before the dive) and this owns it above, so there is an owner
 *  at every p and no step where they meet. */
export const flyBodyFadeAt = (p: number) =>
  1 - smoothstep(0.9, 1, flyDiveP(p)) * (1 - flyRevealAt(p));

/** Where the framing goes back to the story — the fly's fov (70) unwinding to
 *  the story chain's (42), a real 1.8× push-in.
 *
 *  It opens on SKY_OUT_END because the ramp SCALES the sky (the starfield is
 *  geometry on the camera), so that is the earliest frame it cannot bend a star
 *  or a live trail. It must FINISH before the span releases the override, since
 *  exit() writes `null`, which is a cut — hence EXIT_END sits past its end. */
export const FOV_BACK: [number, number] = [SKY_OUT_END, atFrac(rwR, 0.52)];

export const flyFovBackAt = (p: number) =>
  smoothstep(FOV_BACK[0], FOV_BACK[1], p);

/** The override's mix: how much of the fly's fov is in force (1 = wholly the
 *  dive's, 0 = wholly the story chain's). Named so state.ts reads it. */
export const flyFovMixAt = (p: number) => 1 - flyFovBackAt(p);

/** …and WHICH fov that is: the pose's own, or the park's where a path segment
 *  omits it. */
export const flyFovOf = (pose: CameraPose) => pose.fov ?? FLY.fovFar;

/** The dolly, world X: the model's placement under the parked camera. The dive
 *  is authored as a camera flying to `camX`; parked at X_PARK, the identical
 *  frame comes from putting the model at X_PARK − camX (nothing else in the
 *  scene is world-anchored — the sky rides the camera).
 *
 *  Then two legs back: the blind journey to the reveal's park (flyReturnAt) and
 *  the last units home (flySeatAt). Their windows do not overlap, so the
 *  composition holds in between. 0 outside the span, where the story owns
 *  the lens. */
export const flyDollyAt = (p: number) =>
  lerp(
    lerp(X_PARK - poseCamX(flyPoseAt(p)), REVEAL_X, flyReturnAt(p)),
    0,
    flySeatAt(p),
  );

/** The demo's iris ramp: stopped down at the park, wide open by the end of the
 *  approach and held. Fully open BEFORE the glass (FLY.pAperture's law). */
export const flyApertureAt = (pFly: number) =>
  lerp(
    FLY.apertureShut,
    0,
    smoothstep(FLY.pAperture[0], FLY.pAperture[1], pFly),
  );

/** …and the demo's focus rack: the dial finds the new world once the front
 *  element is behind us, so the stars resolve on open sky. */
export const flyFocusAt = (pFly: number) =>
  smoothstep(FLY.pFocus[0], FLY.pFocus[1], pFly);

export function createStoryFly(scene: SceneHandle): {
  frame(p: number): void;
  warm(): Promise<void>;
} {
  let active = false;
  /** the transmissive glass sub-span's own flag (GLASS_OUT) — a subset of
   *  `active` in time, never true without it. */
  let glassOn = false;
  let warmed = false;
  /** the dolly this module last wrote — it is the only writer, and the ruler
   *  below may only be measured while it is 0 (see enter). */
  let dollyNow = 0;
  let warnedOffRest = false;
  /** the elements REAR TO FRONT with their rearmost world X — the ruler the
   *  passage fade reads, measured once per page load at channel rest. */
  let passage: { id: string; x0: number }[] = [];
  /** the measurement in `passage` was taken at rest, so it is the real ruler
   *  and no later activation may re-take it. */
  let passageAtRest = false;
  const fades: Record<string, number> = {};
  /** the tint the sky fades INTO: the rewrap scene's stage color, which is what
   *  the page paints behind the canvas once the starfield unmounts. */
  let rewrapBg = isLightTheme() ? rwR.scene.bgLight : rwR.scene.bg;
  watchTheme((l) => {
    rewrapBg = l ? rwR.scene.bgLight : rwR.scene.bg;
  });

  function enter(p: number) {
    // The spans come off the CPU geometry in its rest pose, so a measurement
    // taken mid-move places the elements wrong. A good measurement is kept for
    // the life of the page; a bad one (deep link into the span) serves its own
    // activation only and is replaced by the first that catches rest.
    if (!passageAtRest) {
      // AT REST INCLUDES AT HOME: worldAxialSpans measures the model where it
      // stands, so a measurement with the lens dollied out would be up to 25
      // world units off. This module is the dolly's only writer and it is 0
      // outside the span, so the term states an invariant, not a live case.
      const atRest =
        dollyNow === 0 &&
        Math.abs(scene.state.zoom) +
          Math.abs(scene.state.explode) +
          Math.abs(scene.state.assemble) <
          0.01;
      if (!atRest && !warnedOffRest) {
        warnedOffRest = true;
        console.warn("lens fly: measuring spans off-rest");
      }
      passage = passageOrder(scene.worldAxialSpans(Object.keys(GLASS_SPANS)));
      passageAtRest = atRest;
    }
    // THE GLASS ONLY MOUNTS BELOW ITS OWN EDGE. Activating from above (a scrub
    // back down across EXIT_END) must not clone meshes wearing ink — such a
    // clone carries no transmission and would poison the clone cache. The gate
    // in frame() remounts it under the body cover once p crosses GLASS_OUT.
    if (p <= GLASS_OUT) mountGlass();
    // The always-on dust would float in front of the sky.
    scene.setDust(false);
    // Fire-and-forget: a mount that never lands leaves a dive minus the stars.
    void scene.enableStarfield(true).then((ok) => {
      if (!ok) console.warn("lens fly: starfield failed to start");
    });
    void scene.enableWormholePost(true).then((ok) => {
      if (!ok) console.warn("lens fly: wormhole post pass failed to start");
    });
  }

  /** Compile the dive before it is needed: the wormhole pass' pipeline plus a
   *  second pipeline per material, all of which three builds the first time the
   *  look is DRAWN. warmFly draws that frame into a 1×1 off-screen target with
   *  the same knobs enter() uses. Driven at idle from hero-driver prefetch. */
  async function warm() {
    if (warmed || active) return;
    warmed = true;
    await scene.warmFly(GLASS_SPANS);
  }

  /** The transmissive sub-span's two edges — see GLASS_OUT for why the swap has
   *  a life of its own inside the span. Mount is idempotent-by-flag; both are
   *  called from enter()/exit() AND from the gate in frame(). */
  function mountGlass() {
    if (glassOn) return;
    glassOn = true;
    scene.setGlassTransmissive(true, GLASS_SPANS);
    scene.setGlassFade(1);
  }

  function releaseGlass() {
    if (!glassOn) return;
    glassOn = false;
    // Per-element fades back to 1 BY ID: the setter only writes the ids it is
    // handed, so an empty record restores nothing — and the write is a no-op
    // once the swap is off, hence before setGlassTransmissive(false).
    for (const id of Object.keys(GLASS_SPANS)) fades[id] = 1;
    scene.setGlassElementFade(fades);
    // The elements' own materials go back on here, at GLASS_OUT on the
    // scroll-through path: under the full body cover, so the cut is invisible.
    scene.setGlassTransmissive(false);
  }

  function exit() {
    releaseGlass();
    scene.setDust(true);
    scene.setRoomLight(1);
    scene.setGlassGlint(1);
    scene.setBodyFade(1);
    // THE LENS GOES HOME WITH THE SPAN: a no-op on the way out, but a scrub
    // back out of the dive can leave at any dolly and the story owns a lens at
    // the origin.
    dollyNow = 0;
    scene.setLensDolly(0);
    scene.setStoryFov(null);
    uStarMix.value = 0;
    uWormhole.value = 0;
    uStarStreak.value = 0;
    uStarRing.value = 0;
    // BEFORE the unmount: setSkyDim is a no-op on an unmounted starfield, so a
    // dim left on would still be there for the NEXT mount.
    scene.setSkyDim(0, rewrapBg);
    void scene.enableStarfield(false);
    void scene.enableWormholePost(false);
  }

  return {
    warm,
    frame(p) {
      const pFly = flyDiveP(p);
      const pose = flyPoseAt(p);
      // LEAVE FIRST, THEN THE LOOK, THEN ARRIVE. exit() hands the elements
      // their materials back and must run BEFORE any ink returns to them;
      // enter() clones those materials and must run AFTER the last of it is
      // gone. The edges already guarantee this; the order keeps it true if one
      // is ever moved.
      if (active && (p < DIVE_P0 - HYST || p > EXIT_END + HYST)) {
        active = false;
        exit();
      }
      scene.setInkMix(flyInkAt(p));
      // …AND THE FRAMING CENTRES WITH IT, written every frame, active or not:
      // the swing belongs to the approach and must be over before the first
      // dive frame rather than at it.
      scene.setStoryCentre(flyCentreAt(p));
      if (!active && p >= DIVE_P0 && p <= EXIT_END) {
        active = true;
        enter(p);
      }
      if (!active) return;
      // THE GLASS SUB-SPAN'S OWN GATE (see GLASS_OUT): off at the edge, back on
      // a hysteresis BELOW it, so a scrub parked on the edge cannot thrash the
      // clones.
      if (glassOn && p > GLASS_OUT) releaseGlass();
      else if (!glassOn && p < GLASS_OUT - HYST) mountGlass();
      // Value AND target on both channels: the driver's own per-frame writes
      // land before this call, and tick()'s ease would otherwise chase them.
      const a = flyApertureAt(pFly);
      scene.state.aperture = a;
      scene.state.apertureTarget = a;
      const f = flyFocusAt(pFly);
      scene.state.focus = f;
      scene.state.focusTarget = f;
      // No stars before the dive and one window back out, both folded into
      // flySkyMixAt — this uniform is this module's on every active frame.
      const sky = flySkyMixAt(p);
      const out = skyOutAt(p);
      uStarMix.value = sky;
      // the ground under the fading stars walks to the color of the stage that
      // is about to replace it — the unmount's cut lands on matching frames
      scene.setSkyDim(1 - out, rewrapBg);
      // AND THE ROOM GOES OUT WITH IT, released by the sky's fade (× out) so
      // the model is never a black silhouette on a light stage and exit()'s
      // setRoomLight(1) lands as a no-op.
      const dark = flyDarkAt(p);
      scene.setRoomLight(lerp(1, FLY.darkFloor, dark));
      scene.setGlassGlint(lerp(1, FLY.glintFloor, dark));
      // the frame pinches toward the exit axis and the stars draw out into
      // lines; the ring rides the WORMHOLE's ramp, not the streak's
      const warp = flyWarpAt(p);
      uWormhole.value = warp;
      const streak = flyStreakAt(p);
      uStarStreak.value = streak;
      uStarRing.value = warp;
      // THE DIVE ITSELF: the lens slides past the parked camera, and its fov
      // ramp is the one thing that stays camera-side. At DIVE_P0 the story
      // row's own fov IS this pose's (FLY.fovFar), so the way in has no step.
      dollyNow = flyDollyAt(p);
      scene.setLensDolly(dollyNow);
      scene.setStoryFov(flyFovOf(pose), flyFovMixAt(p));
      // THE BODY GOES WITH IT (flyBodyFadeAt carries the hand-over law).
      scene.setBodyFade(flyBodyFadeAt(p));
      // …and each element goes down as the camera arrives at it: from inside an
      // element three's screen-space transmission blows up, so the camera must
      // never be inside visible glass. Nothing has to bring them back — the
      // fade rides the CLONES, which are gone at GLASS_OUT, so the elements
      // return with the BODY (the write below is a no-op once the swap is off).
      const camX = poseCamX(pose);
      for (const e of passage)
        fades[e.id] = passageFade(camX, e.x0, FLY.passageLead, FLY.passageFade);
      scene.setGlassElementFade(fades);
    },
  };
}
