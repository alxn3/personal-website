// fly-core: the fly-through's pure math — knob table, pose path, travel remap,
// passage fades and the glass spans. FLY below is the one set of fly knobs,
// read by both story/fly.ts and the /lens demo.
//
// Homepage-chunk law: with optics/prescription.ts this is the only optics/ file
// allowed in the initial chunk, so it may import only `lerp`/`smoothstep`,
// PRESCRIPTION, and types from core/scene — no three, no renderer, no explore/.
import { lerp, smoothstep } from "../core/math";
import { PRESCRIPTION } from "./prescription";
import type { CameraPose, GlassSpanMm, ShadingMode } from "../core/scene";

// --- posePath: camera keyframes → (p) => CameraPose -------------------------
export interface Pose {
  az?: number;
  el?: number;
  fov?: number;
  /** slides the look-at point (and with it the whole rig) along world X — a
   *  translation the spherical rig has no other way to express. */
  targetX?: number;
  targetY?: number;
  /** on-screen framing size — dist = frame/tan(fov/2), recomputed from the
   *  interpolated fov each frame (holds the subject size as fov drifts). */
  frame?: number;
  /** explicit distance — wins over frame. */
  dist?: number;
}
export interface PoseKey {
  p: number;
  /** Omitted fields carry forward from the previous key; `dist`/`frame` are
   *  mutually exclusive (setting one drops the carried other). Omit `pose`
   *  entirely to hold. The first key must give az/el (and fov unless the boot
   *  fov is intended). */
  pose?: Pose;
  /** shapes the segment ending at this key (default linear). */
  ease?: (t: number) => number;
}

const distOf = (pose: Pose, fov: number) =>
  pose.dist ?? (pose.frame ?? 0) / Math.tan((fov * Math.PI) / 360);

/** Build a pose sampler from ascending keys. Every field lerps under the
 *  destination key's ease; `dist` lerps between each end's distOf() at the
 *  current fov, so a frame-locked end tracks the drifting fov. Clamps outside
 *  the key range. */
export function posePath(
  keys: PoseKey[],
  bootFov = 45,
): (p: number) => CameraPose {
  // resolve carry-forward once: each key inherits the prior key's resolved pose
  const R: { p: number; pose: Pose; ease?: (t: number) => number }[] = [];
  let carry: Pose = {};
  for (const k of keys) {
    const pose: Pose = { ...carry, ...k.pose };
    if (k.pose?.dist !== undefined) delete pose.frame;
    if (k.pose?.frame !== undefined) delete pose.dist;
    carry = pose;
    R.push({ p: k.p, pose, ease: k.ease });
  }
  return (p) => {
    let i = 0;
    while (i < R.length - 1 && p > R[i + 1].p) i++;
    const a = R[i];
    const b = R[Math.min(i + 1, R.length - 1)];
    const span = b.p - a.p;
    const u = span > 1e-6 ? Math.min(1, Math.max(0, (p - a.p) / span)) : 0;
    const e = b.ease ? b.ease(u) : u;
    const fov = lerp(a.pose.fov ?? bootFov, b.pose.fov ?? bootFov, e);
    return {
      azimuth: lerp(a.pose.az ?? 0, b.pose.az ?? 0, e),
      elevation: lerp(a.pose.el ?? 0, b.pose.el ?? 0, e),
      distance: lerp(distOf(a.pose, fov), distOf(b.pose, fov), e),
      fov,
      targetX: lerp(a.pose.targetX ?? 0, b.pose.targetX ?? 0, e),
      targetY: lerp(a.pose.targetY ?? 0, b.pose.targetY ?? 0, e),
    };
  };
}

// smoothstep(0,1,·) as a pose-path segment ease (the demos' standard in/out).
export const ss01 = (t: number) => smoothstep(0, 1, t);

/** The fly knobs. Two laws hold over them: the passage fade must finish outside
 *  the camera's near plane, and the interior remap's window must lie inside the
 *  barrel run. */
export const FLY = {
  /** shading with no depth fade — a fading look would dissolve the barrel the
   *  camera is flying through. */
  shading: "realistic" as ShadingMode,
  /** world units; the parked framing, with the whole lens ahead of camera */
  distFar: 9.0,
  /** world units the look-at point rides ahead of the camera in flight.
   *  Strictly > 0 (a zero radius NaNs the lookAt) and outside the 0.1 near
   *  plane. Small, so camera X ≈ targetX − distIn. */
  distIn: 0.34,
  /** The one heading for the whole flight: azimuth −π/2 puts the camera at
   *  (targetX − d, 0, 0), looking down +X into the bayonet mount. */
  azRear: -Math.PI / 2,
  /** the park's elevation; 0 is a pure axial shot. The pEnter key levels
   *  whatever is set here back to 0 before the barrel. */
  elFar: 0,
  fovFar: 42,
  fovIn: 70,
  /** the finale's framing. Equal to fovIn, so the exit carries no zoom and the
   *  field opens by parallax alone; starfield.ts's disc sizes are calibrated
   *  against this fov. */
  fovOut: 70,
  /** Camera world X at each beat (targetX = x + distIn; at the park the camera
   *  sits distFar behind targetX = 0). The lens occupies x ≈ −1.95…+1.95, so
   *  xEnter/xOut clear the glass stack at both ends. */
  xEnter: -2.8,
  xOut: 2.2,
  xClear: 8.0,
  xEnd: 16.0,
  /** p at which the camera reaches the mount, clears the front element, and has
   *  left the lens far enough behind that no part of it can be in frame. */
  pEnter: 0.22,
  pOut: 0.72,
  pClear: 0.85,
  /** when the stars arrive: [start, end]. Up by the time the rear element is on
   *  the near plane, so the stars come up through the glass. Fades the stars
   *  only, never the backdrop. */
  pSkyIn: [0.18, 0.36] as [number, number],
  /** [start, end] over which the aperture channel runs `apertureShut` → 0
   *  (f/2.8, wide open). Must be fully open before the camera reaches the glass
   *  at pEnter, and ideally before pSkyIn[1]. */
  pAperture: [0.1, 0.2] as [number, number],
  /** where the iris starts: 1 = f/22. The blades still leave IRIS.irisMinMm of
   *  clear hole, so the park reads as stopped down, not shut. */
  apertureShut: 1,
  /** [start, end] over which the whole room (IBL + studio lights) ramps down to
   *  `darkFloor`. Runs ahead of pSkyIn so the frame is a dark tube before the
   *  stars come up in it. */
  pDark: [0.04, 0.3] as [number, number],
  /** what the room ramps down to — not 0, so a rim of the barrel interior still
   *  catches something instead of reading as a flat silhouette. */
  darkFloor: 0.08,
  /** what the glass's reflections ramp down to on the same pDark window (a
   *  multiplier on the clones' shipped specular). */
  glintFloor: 0,
  pFocus: [0.72, 1] as [number, number],
  /** the wormhole ramp: [start, peak, end]. uWormhole rises start→peak, unwinds
   *  peak→end, and is exactly 0 outside. */
  pWormhole: [0, 0.44, 0.84] as [number, number, number],
  /** the streak window: opens a touch behind the pinch and is gone before it
   *  closes. */
  pStreak: [0.03, 0.42, 0.78] as [number, number, number],
  /** The passage fade, world units (20 mm to the unit) — each element goes down
   *  on its own as the camera arrives at it. `lead` is how far before the
   *  element's rearmost point the fade ends, and must exceed the camera's near
   *  plane (0.1 world) or the near plane cuts the element open; `fade` is the
   *  ramp's length. Needed because three's transmission is screen-space: from
   *  inside an element the refraction offset smears the whole frame. */
  passageLead: 0.3,
  passageFade: 0.55,
  /** [start, end] of the stretch the camera spends inside the element stack,
   *  measured in pose p (the output of `travelRemap`, not input p). */
  pInside: [0.3, 0.68] as [number, number],
  /** how much faster the stack is crossed; the p saved is handed to the
   *  approach and the exit. 1 = the linear dive (the remap is the identity). */
  insideRate: 2,
};

/** The travel remap, p → pose p: three linear segments through (0, 0), (a′, a),
 *  (b′, b), (1, 1), where [a, b] is the interior in pose p and [a′, b′] the
 *  shorter stretch of input p covering it (same midpoint, `rate` narrower).
 *  Monotone, continuous, fixed at both ends; rate = 1 returns `p` itself. */
export function travelRemap(
  p: number,
  [a, b]: [number, number],
  rate: number,
): number {
  if (rate === 1) return p;
  const half = (b - a) / 2;
  const mid = (a + b) / 2;
  const r = Math.max(rate, 1e-3);
  const a2 = mid - half / r;
  const b2 = mid + half / r;
  if (p <= a2) return a2 > 0 ? (p / a2) * a : p;
  if (p >= b2) return b2 < 1 ? b + ((p - b2) / (1 - b2)) * (1 - b) : p;
  return a + ((p - a2) / (b2 - a2)) * (b - a);
}

/** One element's passage fade: 1 while it is ahead of the camera, reaching 0
 *  `lead` world units before the camera's X meets its rearmost point `x0` over
 *  a `fade`-long ramp. A pure function of camera X, so a backwards scrub brings
 *  the element back. */
export function passageFade(
  camX: number,
  x0: number,
  lead: number,
  fade: number,
): number {
  return 1 - smoothstep(x0 - lead - fade, x0 - lead, camX);
}

/** World X of the camera under a spherical pose — the same expression a
 *  CameraPose puts into camera.position.x. */
export function poseCamX(pose: CameraPose): number {
  return (
    (pose.targetX ?? 0) +
    pose.distance * Math.cos(pose.elevation) * Math.sin(pose.azimuth)
  );
}

/** The elements ordered rear to front (ascending world X) — the order the dive
 *  meets them in; `worldAxialSpans` hands back an unordered record. */
export function passageOrder(
  spansWorld: Record<string, { x0: number; x1: number }>,
): { id: string; x0: number }[] {
  return Object.entries(spansWorld)
    .map(([id, s]) => ({ id, x0: s.x0 }))
    .sort((p, q) => p.x0 - q.x0);
}

/** [start, peak, end] → a 0-at-both-ends ramp. Both halves are smoothsteps, so
 *  the value is exactly 0 outside [start, end] and exactly 1 at the peak. */
export const arc = ([a, peak, b]: [number, number, number], p: number) =>
  smoothstep(a, peak, p) * (1 - smoothstep(peak, b, p));

/** The elements' axial spans, gltf mm, for SceneHandle.setGlassTransmissive —
 *  derived here because core/scene.ts must not import the prescription. */
export const GLASS_SPANS: Record<string, GlassSpanMm> = Object.fromEntries(
  PRESCRIPTION.map((e) => [
    e.id,
    { frontYmm: e.front.yMm, rearYmm: e.rear.yMm },
  ]),
);

/** az is written once and carried by every later key: one heading for the whole
 *  flight. The barrel run stays linear — pacing is FLY.insideRate's job, which
 *  reshapes p before it reaches this path. `fovOut` sits on the pClear key so
 *  the fov is reached as the lens leaves frame, then carried to p = 1. */
/* prettier-ignore */
export const flyPose = posePath([
  { p: 0,           pose: { az: FLY.azRear, el: FLY.elFar, fov: FLY.fovFar, dist: FLY.distFar, targetX: 0                     } },
  { p: FLY.pEnter,  pose: {                 el: 0,         fov: FLY.fovIn,  dist: FLY.distIn,  targetX: FLY.xEnter + FLY.distIn }, ease: ss01 },
  { p: FLY.pOut,    pose: {                                                                    targetX: FLY.xOut   + FLY.distIn } },
  { p: FLY.pClear,  pose: {                                 fov: FLY.fovOut,                   targetX: FLY.xClear + FLY.distIn } },
  { p: 1,           pose: {                                                                    targetX: FLY.xEnd   + FLY.distIn }, ease: ss01 },
]);
