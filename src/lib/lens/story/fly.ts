// The fly-through: from `flythrough` through `constellations` and `trails`,
// ending inside `rewrap`. The camera parks on the lens axis and the LENS moves
// past it (x_model = X_PARK − x_camera); only fov and framing centre change on
// the camera side. Tuning lives in optics/fly-core.ts (FLY).
//
// Owns aperture and focus, the sky and warp uniforms, the realistic↔ink blend,
// the glass swap, room light, glint, dolly, body fade and fov. Every value is a
// pure function of p that matches the driver's own at both span edges; the
// hysteresis only gates mounting.
//
// Lazy module: only hero-driver's dynamic import() may reach it, and index.ts
// must never re-export it.

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
  FLY_EXIT_END,
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
/** Story p where the camera starts swinging onto the lens axis. The swing ends
 *  at DIVE_P0 (in story.ts). */
const CAM_IN = flyR.p0;
/** Last story p of the fly span. Every channel must already match the story's
 *  own values here, because exit() hands them back with a cut. */
export const EXIT_END = FLY_EXIT_END;
/** Story p where the transmissive glass is swapped back, while the body is
 *  hidden. Must come before INK_RETURN starts. */
export const GLASS_OUT = atFrac(rwR, 0.055);
/** Story-p window over which the ink look returns. */
export const INK_RETURN = span("fly.inkBack", [
  atFrac(rwR, 0.16),
  atFrac(rwR, 0.36),
]);
/** Story-p slack past each edge before tearing down, so scrubbing on an edge
 *  doesn't thrash enter()/exit(). */
export const HYST = 0.005;
span("fly.span", [DIVE_P0, EXIT_END]);
span("fly.dive", [DIVE_P0, flyR.p1]);
span("fly.glass", [DIVE_P0, GLASS_OUT]);
span("fly.inkOut", [CAM_IN, DIVE_P0 - HYST]);

/** Ink look amount: 1 = the story's ink, 0 = the realistic lens. Both ramps
 *  must stay outside the glass window (hysteresis included). */
export const flyInkAt = (p: number) =>
  1 -
  smoothstep(CAM_IN, DIVE_P0 - HYST, p) *
    (1 - smoothstep(INK_RETURN[0], INK_RETURN[1], p));

/** How centred the lens axis is in the frame (1 = centred). */
export const flyCentreAt = (p: number) => 1 - flyInkAt(p);

/** Sky visibility on the way out: 1 until early `rewrap`, 0 from SKY_OUT_END,
 *  while the backdrop blends to the rewrap background. */
export const skyOutAt = (p: number) =>
  1 - smoothstep(atFrac(rwR, 0.02), SKY_OUT_END, p);

/** Dive progress 0–1 across the rest of the flythrough scene; held at 1 after. */
export const flyDiveP = (p: number) =>
  clamp01((p - DIVE_P0) / (flyR.p1 - DIVE_P0));

/** Sky fade-in on the dive's own progress. */
export const flySkyInAt = (pFly: number) =>
  smoothstep(FLY.pSkyIn[0], FLY.pSkyIn[1], pFly);

/** Star opacity: fade in on the dive, fade out on the way back. 0 outside the
 *  span. */
export const flySkyMixAt = (p: number) => flySkyInAt(flyDiveP(p)) * skyOutAt(p);

/** Room-light dimming during the dive, released as the sky fades out. */
export const flyDarkAt = (p: number) =>
  smoothstep(FLY.pDark[0], FLY.pDark[1], flyDiveP(p)) * skyOutAt(p);

/** Wormhole pinch amount. Also drives the star ring, which must be 0
 *  throughout `trails`. */
export const flyWarpAt = (p: number) => {
  const pFly = flyDiveP(p);
  return (
    smoothstep(FLY.pWormhole[0], FLY.pWormhole[1], pFly) *
    (1 - smoothstep(FLY.pWormhole[1], FLY.pWormhole[2], pFly))
  );
};

/** Star streak amount. It falls with the pinch so streaks and ring end on the
 *  same frame. */
export const flyStreakAt = (p: number) => {
  const pFly = flyDiveP(p);
  return (
    smoothstep(FLY.pStreak[0], FLY.pStreak[1], pFly) *
    (1 - smoothstep(FLY.pWormhole[1], FLY.pWormhole[2], pFly))
  );
};

/** Extra streak length and star size at the wormhole's peak (0 outside it). */
const THROAT_SWELL = { streak: 0.6, size: 0.3, window: [0.3, 0.44, 0.62] };
const flyThroatSwellAt = (p: number) => {
  const pFly = flyDiveP(p);
  const [w0, w1, w2] = THROAT_SWELL.window;
  return smoothstep(w0, w1, pFly) * (1 - smoothstep(w1, w2, pFly));
};

/** Parked camera X, so the dolly is 0 on the dive's first frame. */
export const X_PARK = -FLY.distFar;

/** Dive camera pose at story p. */
export const flyPoseAt = (p: number) =>
  flyPose(travelRemap(flyDiveP(p), FLY.pInside, FLY.insideRate));

/** World X where the lens is parked for the reveal, so the exploded shell
 *  doesn't fill the wide dive fov. flySeatAt brings it home from here. */
export const REVEAL_X = 3.5;

/** Return trip, 0 → 1, from the dive to REVEAL_X. Must happen entirely while
 *  the body is hidden. */
export const flyReturnAt = (p: number) =>
  smoothstep(atFrac(tR, 0.9), atFrac(rwR, 0.05), p);

/** Final move, 0 → 1, from REVEAL_X to the origin. Must finish early, since
 *  the story's camera orbits the origin. */
export const flySeatAt = (p: number) =>
  smoothstep(REVEAL_END, atFrac(rwR, 0.34), p);

/** Reveal of the exploded lens, 0 = hidden, 1 = fully drawn. The camera must
 *  hold still over this window. */
export const flyRevealAt = (p: number) =>
  smoothstep(atFrac(rwR, 0.06), atFrac(rwR, 0.16), p);

/** Body opacity: fades out over the last tenth of the dive and back in with
 *  the reveal. Exactly 1 at DIVE_P0. */
export const flyBodyFadeAt = (p: number) =>
  1 - smoothstep(0.9, 1, flyDiveP(p)) * (1 - flyRevealAt(p));

/** Story-p window over which the fov returns to the story's. Must start after
 *  SKY_OUT_END and end before EXIT_END. */
export const FOV_BACK = span("fly.fovBack", [SKY_OUT_END, atFrac(rwR, 0.52)]);

export const flyFovBackAt = (p: number) =>
  smoothstep(FOV_BACK[0], FOV_BACK[1], p);

/** Weight of the fly's fov override (1 = fly, 0 = story). */
export const flyFovMixAt = (p: number) => 1 - flyFovBackAt(p);

/** A pose's fov, defaulting to the parked fov. */
export const flyFovOf = (pose: CameraPose) => pose.fov ?? FLY.fovFar;

/** Lens dolly, world X: follows the dive, then returns to REVEAL_X, then to
 *  the origin. 0 outside the span. */
export const flyDollyAt = (p: number) =>
  lerp(
    lerp(X_PARK - poseCamX(flyPoseAt(p)), REVEAL_X, flyReturnAt(p)),
    0,
    flySeatAt(p),
  );

/** Aperture on the dive's progress: stopped down at the start, fully open
 *  before reaching the glass. */
export const flyApertureAt = (pFly: number) =>
  lerp(
    FLY.apertureShut,
    0,
    smoothstep(FLY.pAperture[0], FLY.pAperture[1], pFly),
  );

/** Focus on the dive's progress: racks out once past the front element. */
export const flyFocusAt = (pFly: number) =>
  smoothstep(FLY.pFocus[0], FLY.pFocus[1], pFly);

/** Story-p window where aperture and focus return to the story's rest values
 *  (aperture shut, focus 0), while the body is hidden. */
export const IRIS_BACK = span("fly.irisBack", [
  atFrac(tR, 0.5),
  atFrac(tR, 0.9),
]);

const flyIrisBackAt = (p: number) => smoothstep(IRIS_BACK[0], IRIS_BACK[1], p);

/** Aperture across the whole span, at story p. */
export const flySpanApertureAt = (p: number) =>
  lerp(flyApertureAt(flyDiveP(p)), FLY.apertureShut, flyIrisBackAt(p));

/** Focus across the whole span, at story p. */
export const flySpanFocusAt = (p: number) =>
  lerp(flyFocusAt(flyDiveP(p)), 0, flyIrisBackAt(p));

export function createStoryFly(scene: SceneHandle): {
  /** Write everything the fly owns for story p. */
  evaluate(pE: number): void;
  warm(): Promise<void>;
} {
  let active = false;
  /** transmissive glass mounted; only ever true while `active` */
  let glassOn = false;
  let warmed = false;
  /** last dolly written; element positions can only be measured at 0 */
  let dollyNow = 0;
  let warnedOffRest = false;
  /** glass elements rear to front, with each one's rearmost world X */
  let passage: { id: string; x0: number }[] = [];
  /** whether `passage` was measured with the lens at rest (then it's final) */
  let passageAtRest = false;
  const fades: Record<string, number> = {};
  /** background the sky fades into: the rewrap scene's colour */
  let rewrapBg = isLightTheme() ? rwR.scene.bgLight : rwR.scene.bg;
  watchTheme((l) => {
    rewrapBg = l ? rwR.scene.bgLight : rwR.scene.bg;
  });
  // Star uniforms scaled by the swell. Dev tools may change them live, so any
  // value we didn't write becomes the new base.
  const swellOf = (u: { value: number }) => ({ u, base: u.value, wrote: NaN });
  const swellSize = swellOf(uStarSize);
  const swellGain = swellOf(uStreakGain);
  const writeSwell = (s: ReturnType<typeof swellOf>, factor: number) => {
    if (s.u.value !== s.wrote) s.base = s.u.value;
    s.wrote = s.base * factor;
    s.u.value = s.wrote;
  };

  function enter(p: number) {
    // Measure glass element positions. Only a measurement taken at rest (no
    // zoom/explode/assemble, no dolly) is kept; otherwise re-measure next time.
    if (!passageAtRest) {
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
    // entering from above GLASS_OUT must not mount the glass: cloning meshes
    // while they wear ink would corrupt the clone cache
    if (p <= GLASS_OUT) mountGlass();
    void scene.enableStarfield(true).then((ok) => {
      if (!ok) console.warn("lens fly: starfield failed to start");
    });
    void scene.enableWormholePost(true).then((ok) => {
      if (!ok) console.warn("lens fly: wormhole post pass failed to start");
    });
  }

  /** Pre-compile the dive's pipelines with an off-screen draw. */
  async function warm() {
    if (warmed || active) return;
    warmed = true;
    await scene.warmFly(GLASS_SPANS);
  }

  function mountGlass() {
    if (glassOn) return;
    glassOn = true;
    scene.setGlassTransmissive(true, GLASS_SPANS);
    scene.setGlassFade(1);
  }

  function releaseGlass() {
    if (!glassOn) return;
    glassOn = false;
    // reset per-element fades while the swap is still on (it's a no-op after)
    for (const id of Object.keys(GLASS_SPANS)) fades[id] = 1;
    scene.setGlassElementFade(fades);
    scene.setGlassTransmissive(false);
  }

  function exit() {
    releaseGlass();
    scene.setRoomLight(1);
    scene.setGlassGlint(1);
    scene.setBodyFade(1);
    dollyNow = 0;
    scene.setLensDolly(0);
    scene.setStoryFov(null);
    uStarMix.value = 0;
    uWormhole.value = 0;
    uStarStreak.value = 0;
    uStarRing.value = 0;
    writeSwell(swellGain, 1);
    writeSwell(swellSize, 1);
    // clear the dim before unmounting (setSkyDim does nothing once unmounted)
    scene.setSkyDim(0, rewrapBg);
    void scene.enableStarfield(false);
    void scene.enableWormholePost(false);
  }

  return {
    warm,
    evaluate(p) {
      const pose = flyPoseAt(p);
      // order matters: exit() restores glass materials before the ink is set,
      // and enter() clones them only after the ink is set
      if (active && (p < DIVE_P0 - HYST || p > EXIT_END + HYST)) {
        active = false;
        exit();
      }
      scene.setInkMix(flyInkAt(p));
      scene.setStoryCentre(flyCentreAt(p));
      if (!active && p >= DIVE_P0 && p <= EXIT_END) {
        active = true;
        enter(p);
      }
      if (!active) return;
      if (glassOn && p > GLASS_OUT) releaseGlass();
      else if (!glassOn && p < GLASS_OUT - HYST) mountGlass();
      // set value and target so the driver's earlier iris writes are overridden
      const a = flySpanApertureAt(p);
      scene.state.aperture = a;
      scene.state.apertureTarget = a;
      const f = flySpanFocusAt(p);
      scene.state.focus = f;
      scene.state.focusTarget = f;
      uStarMix.value = flySkyMixAt(p);
      scene.setSkyDim(1 - skyOutAt(p), rewrapBg);
      const dark = flyDarkAt(p);
      scene.setRoomLight(lerp(1, FLY.darkFloor, dark));
      scene.setGlassGlint(lerp(1, FLY.glintFloor, dark));
      const warp = flyWarpAt(p);
      uWormhole.value = warp;
      uStarStreak.value = flyStreakAt(p);
      uStarRing.value = warp;
      const swell = flyThroatSwellAt(p);
      writeSwell(swellGain, 1 + THROAT_SWELL.streak * swell);
      writeSwell(swellSize, 1 + THROAT_SWELL.size * swell);
      dollyNow = flyDollyAt(p);
      scene.setLensDolly(dollyNow);
      // below DIVE_P0 (inside the hysteresis) the story keeps the fov
      scene.setStoryFov(p < DIVE_P0 ? null : flyFovOf(pose), flyFovMixAt(p));
      scene.setBodyFade(flyBodyFadeAt(p));
      // fade each glass element as the camera reaches it (the camera must
      // never be inside visible transmissive glass)
      const camX = poseCamX(pose);
      for (const e of passage)
        fades[e.id] = passageFade(camX, e.x0, FLY.passageLead, FLY.passageFade);
      scene.setGlassElementFade(fades);
    },
  };
}
