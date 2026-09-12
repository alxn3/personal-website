// The story's fly-through span: from `flythrough` through `constellations` and
// `trails`, ending inside `rewrap`. The camera is never placed — the LENS
// travels: the camera parks on the optical axis at the dive's opening pose and
// the model moves (x_model = X_PARK − x_camera); the fov ramp and the framing
// centre are the only camera-side terms. Everything is written from
// `evaluate(pE)`, called by the driver's evaluate step at the eased story p.
// Laws and knobs are optics/fly-core.ts's (FLY); the streak fall is re-hosted
// onto the wormhole's fall window (flyStreakAt).
// Owns aperture and focus (value AND target), the sky/warp uniforms, the
// realistic↔ink blend, glass swap, room light, glint, dolly, body cover, fov.
// LAZY: statically imports optics/ node graphs, so reached only through
// hero-driver's import(); never re-exported from index.ts.
import type { CameraPose, SceneHandle } from "../core/scene";
import { clamp01, lerp, smoothstep } from "../core/math";
import { isLightTheme, watchTheme } from "../core/theme";
import {
  rangeOf,
  atFrac,
  span,
  REVEAL_END,
  SKY_OUT_END,
  DIVE_P0,
} from "./story";
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
import {
  uStarMix,
  uStarStreak,
  uStarRing,
  uStreakGain,
  uStarSize,
} from "../optics/starfield";

const flyR = rangeOf("flythrough");
const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");
/** Where the camera starts leaving the internals pose: the flythrough scene's
 *  own approach, over which the rig swings onto the axis and parks. */
export const CAM_IN = flyR.p0;
// DIVE_P0 — the end of that approach — lives in story/story.ts, since
// hero-driver needs it and cannot import from this lazy module.
/** The span's last frame, where the dive hands the scene back. It must sit PAST
 *  the fov hand-back (FOV_BACK): exit() writes a `null` override, which is a
 *  cut, so the two fovs have to already agree by here. */
export const EXIT_END = atFrac(rwR, 0.58);
/** Where the transmissive glass hands back, under the full body cover so the
 *  material cut is unseen. It must precede INK_RETURN[0]: ink over the dive's
 *  clones would stomp them. */
export const GLASS_OUT = atFrac(rwR, 0.055);
/** The ink's way back, [start, end]. The start is the body-fade top, so the
 *  dissolve begins on the first frame the lens is wholly drawn. */
export const INK_RETURN = span("fly.inkBack", [
  atFrac(rwR, 0.16),
  atFrac(rwR, 0.36),
]);
/** story-p slack past each edge before the span's side effects are torn down,
 *  so a scrub sitting on an edge cannot thrash enter()/exit() */
export const HYST = 0.005;
span("fly.span", [DIVE_P0, EXIT_END]);
span("fly.dive", [DIVE_P0, flyR.p1]);
span("fly.glass", [DIVE_P0, GLASS_OUT]);
span("fly.inkOut", [CAM_IN, DIVE_P0 - HYST]);

/** The look's hand-over — 1 = the story's ink, 0 = the realistic lens the dive
 *  flies through. Both ramps must sit outside the glass sub-span, hysteresis
 *  included: ink over the mounted transmissive clones would stomp them. */
export const flyInkAt = (p: number) =>
  1 -
  smoothstep(CAM_IN, DIVE_P0 - HYST, p) *
    (1 - smoothstep(INK_RETURN[0], INK_RETURN[1], p));

/** The framing's centre, the ink's ramp inverted: 1 = the optical axis is in
 *  the middle of the frame. */
export const flyCentreAt = (p: number) => 1 - flyInkAt(p);

/** The sky's way out: the stars ramp to nothing WHILE the backdrop blends to
 *  the rewrap stage's tint, so the unmount lands between two frames of the same
 *  color. 1 through the dive and both sky scenes; 0 from SKY_OUT_END on. */
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
 *  0 outside the span, agreeing with exit()'s teardown. */
export const flySkyMixAt = (p: number) => flySkyInAt(flyDiveP(p)) * skyOutAt(p);

/** The darkness: the room and the glass' reflections going out with the barrel,
 *  on the dive's clock and released by the sky's fade (× skyOutAt) so the light
 *  is already back when exit() sets it to 1. */
export const flyDarkAt = (p: number) =>
  smoothstep(FLY.pDark[0], FLY.pDark[1], flyDiveP(p)) * skyOutAt(p);

/** The pinch at story p, the demo's own arc. Also drives the ring's ramp, which
 *  must be exactly 0 through `trails` (the perfect circles). */
export const flyWarpAt = (p: number) => {
  const pFly = flyDiveP(p);
  return (
    smoothstep(FLY.pWormhole[0], FLY.pWormhole[1], pFly) *
    (1 - smoothstep(FLY.pWormhole[1], FLY.pWormhole[2], pFly))
  );
};

/** The streaks — the demo's rise, but the PINCH's fall: the ring is made of the
 *  streaks, so both halves of the feature must end on the same frame. */
export const flyStreakAt = (p: number) => {
  const pFly = flyDiveP(p);
  return (
    smoothstep(FLY.pStreak[0], FLY.pStreak[1], pFly) *
    (1 - smoothstep(FLY.pWormhole[1], FLY.pWormhole[2], pFly))
  );
};

/** The throat's swell: the streaks lengthen and the discs grow through the
 *  wormhole's peak, so the torrent climaxes instead of holding one intensity.
 *  Exactly 1 outside the window. */
const THROAT_SWELL = { streak: 0.6, size: 0.3, window: [0.3, 0.44, 0.62] };
export const flyThroatSwellAt = (p: number) => {
  const pFly = flyDiveP(p);
  const [w0, w1, w2] = THROAT_SWELL.window;
  return smoothstep(w0, w1, pFly) * (1 - smoothstep(w1, w2, pFly));
};

/** Where the parked camera sits, world X: `FLY.distFar` behind the lens, so the
 *  model's dolly is exactly 0 on the dive's first frame. */
export const X_PARK = -FLY.distFar;

/** The dive's pose at story p, through the interior remap (FLY.insideRate) —
 *  held at the first pose until the approach is over. */
export const flyPoseAt = (p: number) =>
  flyPose(travelRemap(flyDiveP(p), FLY.pInside, FLY.insideRate));

/** Where the reveal is played, world X: past home, so the exploded shell does
 *  not fill the frame on the dive's wide fov. Not a new home — the story's
 *  poses orbit the ORIGIN, and flySeatAt gives this distance back. */
export const REVEAL_X = 3.5;

/** The journey back — 0 while the lens is out on the dive, 1 once it reaches
 *  the reveal's park (REVEAL_X; not home yet, see flySeatAt). The lens travels
 *  through the camera's own position, so every frame of this window must sit
 *  under the body cover. */
export const flyReturnAt = (p: number) =>
  smoothstep(atFrac(tR, 0.9), atFrac(rwR, 0.05), p);

/** …and the last leg, from the reveal's park to the origin: 0 through the whole
 *  reveal, 1 once the lens is exactly home. It must finish early — the chain's
 *  poses orbit the ORIGIN, so a lens short of it sits off the frame's centre by
 *  the sine of the camera's swing. */
export const flySeatAt = (p: number) =>
  smoothstep(REVEAL_END, atFrac(rwR, 0.34), p);

/** The reveal — the exploded lens coming back on screen, 0 = covered, 1 = fully
 *  drawn. Nothing camera-side may move over this window: the chain is held
 *  through CAM_RELEASE_F, the fov hand-back has not opened (FOV_BACK), and the
 *  lens is parked at REVEAL_X. */
export const flyRevealAt = (p: number) =>
  smoothstep(atFrac(rwR, 0.06), atFrac(rwR, 0.16), p);

/** The body cover, this span's half of the `setBodyFade` channel: 1 = the model
 *  is drawn, 0 = it is not. Down over the dive's last tenth, back up over the
 *  reveal. Exactly 1 at DIVE_P0, where the driver's constant 1 hands over. */
export const flyBodyFadeAt = (p: number) =>
  1 - smoothstep(0.9, 1, flyDiveP(p)) * (1 - flyRevealAt(p));

/** Where the framing goes back to the story — the fly's fov unwinding to the
 *  story chain's. It may not open before SKY_OUT_END (the ramp scales the sky,
 *  which is geometry on the camera) and must finish before EXIT_END, where
 *  exit() releases the override with a cut. */
export const FOV_BACK = span("fly.fovBack", [SKY_OUT_END, atFrac(rwR, 0.52)]);

export const flyFovBackAt = (p: number) =>
  smoothstep(FOV_BACK[0], FOV_BACK[1], p);

/** The override's mix: how much of the fly's fov is in force (1 = wholly the
 *  dive's, 0 = wholly the story chain's). */
export const flyFovMixAt = (p: number) => 1 - flyFovBackAt(p);

/** …and WHICH fov that is: the pose's own, or the park's where a path segment
 *  omits it. */
export const flyFovOf = (pose: CameraPose) => pose.fov ?? FLY.fovFar;

/** The dolly, world X: the model's placement under the parked camera, at
 *  X_PARK − camX. Then two legs back — the blind journey to the reveal's park
 *  (flyReturnAt) and the last units home (flySeatAt), on non-overlapping
 *  windows. 0 outside the span, where the story owns the lens. */
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
  /** every write the span owns, at the eased story p */
  evaluate(pE: number): void;
  warm(): Promise<void>;
} {
  let active = false;
  /** the transmissive glass sub-span's own flag (GLASS_OUT) — a subset of
   *  `active` in time, never true without it. */
  let glassOn = false;
  let warmed = false;
  /** the dolly this module last wrote — the ruler below may only be measured
   *  while it is 0 (see enter) */
  let dollyNow = 0;
  let warnedOffRest = false;
  /** the elements REAR TO FRONT with their rearmost world X — the ruler the
   *  passage fade reads, measured once per page load at channel rest. */
  let passage: { id: string; x0: number }[] = [];
  /** the measurement in `passage` was taken at rest, so no later activation may
   *  re-take it */
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
    // taken mid-move places the elements wrong. A good one is kept for the life
    // of the page; a bad one is replaced by the first that catches rest.
    if (!passageAtRest) {
      // at rest includes at home: worldAxialSpans measures the model where it
      // stands, so a dollied lens would be measured world units off
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
    // the glass only mounts below its own edge: activating from above must not
    // clone meshes wearing ink, which would poison the clone cache
    if (p <= GLASS_OUT) mountGlass();
    // the always-on dust would float in front of the sky
    scene.setDust(false);
    // fire-and-forget; a mount that never lands leaves a dive minus the stars
    void scene.enableStarfield(true).then((ok) => {
      if (!ok) console.warn("lens fly: starfield failed to start");
    });
    void scene.enableWormholePost(true).then((ok) => {
      if (!ok) console.warn("lens fly: wormhole post pass failed to start");
    });
  }

  /** Compile the dive's pipelines before they are needed, by drawing one frame
   *  into a 1×1 off-screen target. Driven at idle from hero-driver prefetch. */
  async function warm() {
    if (warmed || active) return;
    warmed = true;
    await scene.warmFly(GLASS_SPANS);
  }

  /** The transmissive sub-span's two edges (see GLASS_OUT). Idempotent by flag;
   *  both are called from enter()/exit() AND from the gate in frame(). */
  function mountGlass() {
    if (glassOn) return;
    glassOn = true;
    scene.setGlassTransmissive(true, GLASS_SPANS);
    scene.setGlassFade(1);
  }

  function releaseGlass() {
    if (!glassOn) return;
    glassOn = false;
    // per-element fades back to 1 by id — the setter only writes the ids it is
    // handed, and the write is a no-op once the swap is off, so it must precede
    // setGlassTransmissive(false)
    for (const id of Object.keys(GLASS_SPANS)) fades[id] = 1;
    scene.setGlassElementFade(fades);
    // the elements' own materials go back on here, under the full body cover
    scene.setGlassTransmissive(false);
  }

  function exit() {
    releaseGlass();
    scene.setDust(true);
    scene.setRoomLight(1);
    scene.setGlassGlint(1);
    scene.setBodyFade(1);
    // the lens goes home with the span: a scrub back out of the dive can leave
    // at any dolly, and the story owns a lens at the origin
    dollyNow = 0;
    scene.setLensDolly(0);
    scene.setStoryFov(null);
    uStarMix.value = 0;
    uWormhole.value = 0;
    uStarStreak.value = 0;
    uStarRing.value = 0;
    uStreakGain.value = 1;
    uStarSize.value = 1;
    // before the unmount: setSkyDim is a no-op on an unmounted starfield, so a
    // dim left on would still be there for the next mount
    scene.setSkyDim(0, rewrapBg);
    void scene.enableStarfield(false);
    void scene.enableWormholePost(false);
  }

  return {
    warm,
    evaluate(p) {
      const pFly = flyDiveP(p);
      const pose = flyPoseAt(p);
      // leave first, then the look, then arrive: exit() must return the
      // elements' materials before any ink does, and enter() clones them only
      // after the last of it is gone
      if (active && (p < DIVE_P0 - HYST || p > EXIT_END + HYST)) {
        active = false;
        exit();
      }
      scene.setInkMix(flyInkAt(p));
      // written active or not: the swing belongs to the approach
      scene.setStoryCentre(flyCentreAt(p));
      if (!active && p >= DIVE_P0 && p <= EXIT_END) {
        active = true;
        enter(p);
      }
      if (!active) return;
      // the glass sub-span's own gate (see GLASS_OUT): off at the edge, back on
      // a hysteresis below it, so a parked scrub cannot thrash the clones
      if (glassOn && p > GLASS_OUT) releaseGlass();
      else if (!glassOn && p < GLASS_OUT - HYST) mountGlass();
      // value AND target: the driver's iris writes land before this call
      const a = flyApertureAt(pFly);
      scene.state.aperture = a;
      scene.state.apertureTarget = a;
      const f = flyFocusAt(pFly);
      scene.state.focus = f;
      scene.state.focusTarget = f;
      // no stars before the dive and one window back out, both folded into
      // flySkyMixAt
      const sky = flySkyMixAt(p);
      const out = skyOutAt(p);
      uStarMix.value = sky;
      // the ground under the fading stars walks to the color of the stage that
      // is about to replace it — the unmount's cut lands on matching frames
      scene.setSkyDim(1 - out, rewrapBg);
      // the room goes out with it, released by the sky's fade so the model is
      // never a black silhouette on a light stage
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
      const swell = flyThroatSwellAt(p);
      uStreakGain.value = 1 + THROAT_SWELL.streak * swell;
      uStarSize.value = 1 + THROAT_SWELL.size * swell;
      // the dive itself: the lens slides past the parked camera. At DIVE_P0 the
      // story row's fov IS this pose's (FLY.fovFar), so the way in has no step.
      dollyNow = flyDollyAt(p);
      scene.setLensDolly(dollyNow);
      scene.setStoryFov(flyFovOf(pose), flyFovMixAt(p));
      scene.setBodyFade(flyBodyFadeAt(p));
      // each element goes down as the camera arrives at it: screen-space
      // transmission blows up from inside, so the camera must never be inside
      // visible glass. The fade rides the clones, so nothing brings them back.
      const camX = poseCamX(pose);
      for (const e of passage)
        fades[e.id] = passageFade(camX, e.x0, FLY.passageLead, FLY.passageFade);
      scene.setGlassElementFade(fades);
    },
  };
}
