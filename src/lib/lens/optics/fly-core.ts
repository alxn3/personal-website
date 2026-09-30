// The fly-through's pure math: knobs, camera path, travel remap, passage fades.
// It ships in the homepage's initial chunk, so it must not import three or any
// renderer code.
import { lerp, smoothstep } from "../core/math";
import { PRESCRIPTION } from "./prescription";
import type { CameraPose, GlassSpanMm, ShadingMode } from "../core/scene";

interface Pose {
  az?: number;
  el?: number;
  fov?: number;
  /** slides the look-at point (and the whole rig) along world X */
  targetX?: number;
  targetY?: number;
  /** framing size: dist = frame / tan(fov/2), holding subject size as fov changes */
  frame?: number;
  /** explicit distance; wins over frame */
  dist?: number;
}
interface PoseKey {
  p: number;
  /** omitted fields carry forward from the previous key; setting `dist` or
   *  `frame` drops the other */
  pose?: Pose;
  /** ease for the segment ending at this key (default linear) */
  ease?: (t: number) => number;
}

const distOf = (pose: Pose, fov: number) =>
  pose.dist ?? (pose.frame ?? 0) / Math.tan((fov * Math.PI) / 360);

/** Pose sampler over ascending keys, clamped outside the key range. */
function posePath(keys: PoseKey[], bootFov = 45): (p: number) => CameraPose {
  // resolve carry-forward once
  const resolved: { p: number; pose: Pose; ease?: (t: number) => number }[] =
    [];
  let carry: Pose = {};
  for (const k of keys) {
    const pose: Pose = { ...carry, ...k.pose };
    if (k.pose?.dist !== undefined) delete pose.frame;
    if (k.pose?.frame !== undefined) delete pose.dist;
    carry = pose;
    resolved.push({ p: k.p, pose, ease: k.ease });
  }
  return (p) => {
    let i = 0;
    while (i < resolved.length - 1 && p > resolved[i + 1].p) i++;
    const a = resolved[i];
    const b = resolved[Math.min(i + 1, resolved.length - 1)];
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

const ss01 = (t: number) => smoothstep(0, 1, t);

/** Fly-through knobs. `passageLead` must exceed the near plane, and `pInside`
 *  must lie inside the barrel run. */
export const FLY = {
  /** a shading mode with no depth fade */
  shading: "realistic" as ShadingMode,
  /** world units; the starting distance, whole lens in view */
  distFar: 9.0,
  /** world units the look-at point leads the camera in flight; must be > 0 */
  distIn: 0.34,
  /** heading for the whole flight: looking down +X into the mount */
  azRear: -Math.PI / 2,
  /** starting elevation; levelled to 0 by pEnter */
  elFar: 0,
  fovFar: 42,
  fovIn: 70,
  /** exit fov; starfield.ts's disc sizes are tuned for it */
  fovOut: 70,
  /** camera world X at each beat; the lens spans x ≈ −1.95…+1.95 */
  xEnter: -2.8,
  xOut: 2.2,
  xClear: 8.0,
  xEnd: 16.0,
  /** p at the mount, past the front element, and with the lens out of frame */
  pEnter: 0.22,
  pOut: 0.72,
  pClear: 0.85,
  /** star fade-in [start, end] */
  pSkyIn: [0.18, 0.36] as [number, number],
  /** [start, end] of the iris opening from `apertureShut` to 0; ends before pEnter */
  pAperture: [0.1, 0.2] as [number, number],
  /** starting aperture channel value; 1 = f/22 */
  apertureShut: 1,
  /** [start, end] over which the environment and lights dim to `darkFloor` */
  pDark: [0.04, 0.3] as [number, number],
  /** lighting level after dimming */
  darkFloor: 0.08,
  /** glass reflection multiplier after dimming (same pDark window) */
  glintFloor: 0,
  pFocus: [0.72, 1] as [number, number],
  /** uWormhole ramp [start, peak, end]; exactly 0 outside */
  pWormhole: [0, 0.44, 0.84] as [number, number, number],
  /** star streak ramp [start, peak, end] */
  pStreak: [0.03, 0.42, 0.78] as [number, number, number],
  /** Each glass element fades out as the camera reaches it (world units):
   *  finishing `passageLead` before its rear face, over `passageFade`. */
  passageLead: 0.3,
  passageFade: 0.55,
  /** [start, end] inside the element stack, in remapped p (see `travelRemap`) */
  pInside: [0.3, 0.68] as [number, number],
  /** speed-up while inside the stack; 1 = no remap */
  insideRate: 2,
};

/** Piecewise-linear p remap crossing [a, b] `rate` times faster; fixed at 0 and 1. */
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

/** 1 ahead of an element, reaching 0 `lead` before camera X meets its rear face `x0`. */
export function passageFade(
  camX: number,
  x0: number,
  lead: number,
  fade: number,
): number {
  return 1 - smoothstep(x0 - lead - fade, x0 - lead, camX);
}

/** Camera world X for a pose. */
export function poseCamX(pose: CameraPose): number {
  return (
    (pose.targetX ?? 0) +
    pose.distance * Math.cos(pose.elevation) * Math.sin(pose.azimuth)
  );
}

/** Elements sorted rear to front (ascending world X). */
export function passageOrder(
  spansWorld: Record<string, { x0: number; x1: number }>,
): { id: string; x0: number }[] {
  return Object.entries(spansWorld)
    .map(([id, s]) => ({ id, x0: s.x0 }))
    .sort((p, q) => p.x0 - q.x0);
}

/** Glass elements' axial spans in glTF mm, for SceneHandle.setGlassTransmissive. */
export const GLASS_SPANS: Record<string, GlassSpanMm> = Object.fromEntries(
  PRESCRIPTION.map((e) => [
    e.id,
    { frontYmm: e.front.yMm, rearYmm: e.rear.yMm },
  ]),
);

/** The fly-through camera path, sampled at remapped p. */
/* prettier-ignore */
export const flyPose = posePath([
  { p: 0,           pose: { az: FLY.azRear, el: FLY.elFar, fov: FLY.fovFar, dist: FLY.distFar, targetX: 0                     } },
  { p: FLY.pEnter,  pose: {                 el: 0,         fov: FLY.fovIn,  dist: FLY.distIn,  targetX: FLY.xEnter + FLY.distIn }, ease: ss01 },
  { p: FLY.pOut,    pose: {                                                                    targetX: FLY.xOut   + FLY.distIn } },
  { p: FLY.pClear,  pose: {                                 fov: FLY.fovOut,                   targetX: FLY.xClear + FLY.distIn } },
  { p: 1,           pose: {                                                                    targetX: FLY.xEnd   + FLY.distIn }, ease: ss01 },
]);
