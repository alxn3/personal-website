// ============================================================================
// fly-core: the fly-through's PURE math — knob table, pose path, travel remap,
// passage fades and the glass spans. No renderer, no three import, no timeline
// library, nothing from explore/: the module is safe to import STATICALLY from
// the story modules, and with optics/prescription.ts it is the ONLY optics/ file
// allowed in the homepage's initial chunk. It may import exactly `lerp` /
// `smoothstep` from core/math, PRESCRIPTION from optics/prescription, and TYPES
// from core/scene — keep it that way.
//
// The /lens fly-through demo (explore/demos.ts) and story/fly.ts both read this
// table, so the numbers below are the ONE set of fly knobs.
// ============================================================================
import { lerp, smoothstep } from "../core/math";
import { PRESCRIPTION } from "./prescription";
import type { CameraPose, GlassSpanMm, ShadingMode } from "../core/scene";

// ---------------------------------------------------------------------------
// posePath: camera keyframes → (p) => CameraPose.
// ---------------------------------------------------------------------------
export interface Pose {
  az?: number;
  el?: number;
  fov?: number;
  /** slides the look-at point (and with it the whole rig) along world X — a
   *  TRANSLATION the spherical rig has no other way to express. */
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
  /** OMITTED fields carry forward from the previous key, so a key lists only
   *  what CHANGES; `dist`/`frame` are mutually exclusive (setting one drops the
   *  carried other). Omit `pose` entirely to HOLD. The first key must give
   *  az/el (and fov unless the boot fov is intended). */
  pose?: Pose;
  /** shapes the segment ENDING at this key (default linear). */
  ease?: (t: number) => number;
}

const distOf = (pose: Pose, fov: number) =>
  pose.dist ?? (pose.frame ?? 0) / Math.tan((fov * Math.PI) / 360);

/** Build a pose sampler from ascending keys. Between two keys every field is
 *  lerped under the destination key's ease; `dist` is lerped between each end's
 *  distOf() evaluated at the CURRENT fov, so a frame-locked end tracks the
 *  drifting fov while a fixed-dist end holds — the exact ortho→perspective /
 *  frame idiom the hand-stacked lerps encoded. Clamps outside the key range. */
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

/** Exported for the fly-through's knob tripwires (__tests__/flythrough.test.ts),
 *  which hold the two laws the numbers below have to obey: the passage fade must
 *  finish outside the camera's near plane, and the interior remap's window must
 *  lie inside the barrel run. */
export const FLY = {
  /** shading with NO depth fade. The technical looks (ink/blueprint/flat) fold
   *  depthFadeFactor into their fills and lines (the story's ink in
   *  materials/unified.ts — `mergedMaterial`'s opacityNode and `lineMaterial`;
   *  the bench's in materials/shading-bench.ts's technical branch)
   *  and core/scene rewrites the uFade* planes from the camera distance every
   *  rendered frame (core/scene.ts:1031), so a demo cannot park them — an
   *  interior camera would dissolve the barrel it is flying through. "realistic"
   *  (and outline/ember/paper/riso/bronze) carry no fade at all. */
  shading: "realistic" as ShadingMode,
  /** world units; the parked framing, with the whole lens ahead of the camera */
  distFar: 9.0,
  /** world units; how far AHEAD of the camera the look-at point rides once the
   *  flight is under way. STRICTLY > 0 — a zero radius NaNs the lookAt. 0.34
   *  world = 6.8mm, comfortably outside the 0.1 near plane (= 2mm). Small
   *  enough that camera X ≈ targetX − distIn: the target is a steering handle,
   *  not a subject. */
  distIn: 0.34,
  /** The flight ENTERS THE REAR and leaves by the front, on ONE heading.
   *  azimuth −π/2 puts the camera at (targetX − d, 0, 0) — with targetX = 0 at
   *  world (−d, 0, 0), off the BAYONET MOUNT — looking down +X into the mount,
   *  and it never leaves that heading. VERIFIED VISUALLY, not inferred: at
   *  p = 0 the frame is the mount face (flange screws, brass contacts, rear
   *  baffle) with the barrel behind it; the internals stream past mid-dive; by
   *  p ≈ 0.85 the lens is behind the camera and out of frame; p = 1 is open
   *  starfield, with optics/sky.ts's field at its densest on axis (az ≈ 0). */
  azRear: -Math.PI / 2,
  /** THE PARK IS DEAD-ON: elevation 0, so the flight is a pure axial shot from
   *  frame one — the camera on the optical axis, the mount face square to it,
   *  no tilt to level out. It was 0.1 (a slight high angle at the park, levelled
   *  off before the barrel), and the owner read that opening as "the lens is
   *  slightly tilted, or the camera is slightly above the lens — it's not dead
   *  looking at the lens". The knob stays: raise it for the old high-angle
   *  opening, and the pose path's pEnter key still levels it back to 0 before
   *  the barrel (a no-op at 0 → 0). */
  elFar: 0,
  fovFar: 42,
  fovIn: 70,
  /** THE FINALE'S HELD FRAMING — and it is HELD, which is the whole point of it
   *  being its own number. It used to be 38, reached on the LAST keyframe, so
   *  the fly-through spent everything after the lens left the frame narrowing
   *  70° → 38°: a ~2× telephoto push into a starfield with nothing else in it.
   *  The owner's note is exactly that ("we still continue zooming in after we go
   *  through"), and it was the other half of "the end state is too zoomed in on
   *  the stars" — the discs were oversized AND the frame was closing on them.
   *
   *  Equal to fovIn, so the exit carries NO zoom at all: the camera keeps
   *  flying (targetX still runs to xEnd) and the field opens by parallax alone,
   *  which is the calm the finale wanted. The knob stays, and it is now safe to
   *  tune — the fov ramp finishes at pClear (see the pose path), so a settle set
   *  here is over before the last stretch rather than running into p = 1.
   *
   *  NOTE FOR SIZE TUNING: optics/starfield.ts's disc sizes are calibrated
   *  against THIS fov. Judge them at 70, not at the old 38. */
  fovOut: 70,
  /** CAMERA world X at each beat (targetX = x + distIn; at the park the camera
   *  sits distFar behind targetX = 0). The lens occupies x ≈ −1.95…+1.95 —
   *  20 mm per world unit about the model's recentred axial midpoint — so
   *  xEnter/xOut clear the glass stack at both ends by ~17mm/~9mm and the
   *  passage dissolve fires on every element in between. */
  xEnter: -2.8,
  xOut: 2.2,
  xClear: 8.0,
  xEnd: 16.0,
  /** p at which the camera reaches the mount, clears the front element, and has
   *  left the lens far enough behind that no part of it can be in frame. */
  pEnter: 0.22,
  pOut: 0.72,
  pClear: 0.85,
  /** WHEN THE STARS ARRIVE: [start, end], and NOT at the park. The traced sky
   *  mounts the moment the demo is selected, so a window opening at 0 hung a
   *  full starfield around the lens silhouette before anything had moved — the
   *  dive then had nothing to arrive at. It opens as the camera reaches the
   *  mount (pEnter) and is up by the time the rear element is on the near plane,
   *  so the stars come UP THROUGH the glass rather than being the backdrop the
   *  lens was always sitting on. Either way the window fades the STARS ONLY,
   *  never the ground behind them: on the drawn path it is an opacity ramp over
   *  the flat backdrop the starfield mounts — the right colour for the inside of
   *  a barrel. */
  pSkyIn: [0.18, 0.36] as [number, number],
  /** THE IRIS OPENS ON THE APPROACH: [start, end] over which the aperture
   *  channel runs from `apertureShut` to 0 (f/2.8, wide open). The lens is not a
   *  dead prop being flown past — it stops down and opens up while the camera is
   *  still closing on the mount, which is the only mechanism the dive shows.
   *
   *  IT MUST BE FULLY OPEN BEFORE THE CAMERA REACHES THE GLASS, and that is a
   *  hard ordering, not a taste: pEnter (0.22) is where the camera arrives at the
   *  mount and the passage through the stack begins, and a stop still closing in
   *  there is a shut door in the frame the dive flies through. It should also be
   *  open before the sky is fully up (pSkyIn[1]). Tripwired in
   *  optics/__tests__/flythrough.test.ts. Owner-tuned LATE ("it's opening way too
   *  early"): the open lands just before glass entry, when the iris fills the
   *  frame and the blades actually read. */
  pAperture: [0.1, 0.2] as [number, number],
  /** where the iris STARTS: 1 = f/22, the channel's own closed end. Not a shut
   *  door — the blades' sweep leaves the minimum clear hole (optics/prescription
   *  IRIS.irisMinMm), so the park reads as a stopped-down lens rather than as a
   *  black disc. */
  apertureShut: 1,
  /** THE DIVE GOES DARK: [start, end] over which the room light ramps from the
   *  shipped lighting down to `darkFloor`. Everything the room contributes
   *  (IBL + the three studio lights) goes together — SceneHandle.setRoomLight.
   *  Runs AHEAD of the sky window above so the frame is already a dark tube
   *  when the stars come up in it. */
  pDark: [0.04, 0.3] as [number, number],
  /** what the room ramps DOWN to — not 0, so a rim of the barrel interior still
   *  catches something and the body does not read as a flat silhouette. */
  darkFloor: 0.08,
  /** …and what the GLASS's reflections ramp down to, on the SAME pDark window —
   *  SceneHandle.setGlassGlint, a multiplier on the transmissive clones' shipped
   *  specular. 0, unlike darkFloor: the barrel wants its rim, the glass does not.
   *  At the room's 8% the studio lights were still laying white smudges across
   *  elements that are inside a dark tube with nothing but stars in front of them
   *  ("where is the reflection on the lens coming from? It doesn't feel like it's
   *  from the stars" — it wasn't). At 0 the only thing left in the glass is what
   *  shines THROUGH it, which is the starfield. */
  glintFloor: 0,
  pFocus: [0.72, 1] as [number, number],
  /** THE WORMHOLE RAMP: [start, peak, end]. uWormhole rises start→peak and
   *  unwinds peak→end, and is EXACTLY 0 outside — smoothstep is exactly 0 below
   *  its first edge and exactly 1 above its second, so the product of the rise
   *  and the falling complement leaves no residue at p = 0 or p = 1. The peak
   *  sits mid-barrel, where the camera is deepest inside the stack and there is
   *  nothing left to look at but sky.
   *
   *  STARTS AT THE MOUTH, not at 0.16. It used to open only once the camera was
   *  already INSIDE the mount — and from there the only sky on screen is the
   *  disc through the aperture, because the barrel's own meshes cover the rest.
   *  So the wormhole could not be seen until the aperture framed it, and it
   *  read as arriving late. The whole opening approach — the lens hanging in
   *  open sky, a full frame of stars around it — was spent at pinch 0.
   *
   *  THE 0-AT-p-0 IDENTITY IS UNAFFECTED: smoothstep(0, 0.5, 0) is exactly 0,
   *  so the parked frame is still exactly the undistorted starfield. The pinch
   *  is not visible AT p = 0; it is visible from the first scrub off it, which
   *  is when the dive starts. */
  pWormhole: [0, 0.44, 0.84] as [number, number, number],
  /** the streak window: still a touch behind the pinch at the top (the smear
   *  wants a throat to smear into) and gone before it closes, but now measured
   *  in hundredths, not in the quarter-dive it used to wait. */
  pStreak: [0.03, 0.42, 0.78] as [number, number, number],
  /** THE PASSAGE FADE, world units (20 mm to the unit — the model is at
   *  MODEL_SCALE 0.05). Each element goes down ON ITS OWN as the camera arrives
   *  at it, and the two numbers say when:
   *
   *    lead — how far BEFORE the element's rearmost point the fade has finished.
   *           Strictly greater than the camera's near plane (0.1 world = 2 mm)
   *           or the element would still be drawn when the near plane starts
   *           cutting it open. 0.3 = 6 mm.
   *    fade — the length of the ramp, so the fade RUNS from `lead + fade` before
   *           the element to `lead` before it. At 0.55 world (11 mm) the element
   *           is already filling the frame for the whole dissolve, which is what
   *           makes it read as passing THROUGH rather than as a part vanishing.
   *
   *  WHY AT ALL: three's transmission is screen-space, and from inside an
   *  element the refraction offset is enormous and its separable dual blur
   *  smears the frame into an axis-aligned cross. The camera must never be
   *  inside visible glass. See SceneHandle.setGlassElementFade.
   *
   *  THIS IS NOT THE OLD PER-ELEMENT DISSOLVE that was pulled as jarring: that
   *  one popped elements while they were still distant objects AHEAD of the
   *  camera. Nothing here touches an element until it is one frame-width away. */
  passageLead: 0.3,
  passageFade: 0.55,
  /** THE INTERIOR REMAP: [start, end] of the stretch the camera spends INSIDE
   *  the element stack, measured in POSE p (the output of `travel` below, i.e.
   *  where the beat sits on the flight itself). Measured against the pose path:
   *  the barrel run is linear from x = −2.8 at pEnter to x = +2.2 at pOut, and
   *  the glass occupies world x ≈ −1.97 … +1.79. */
  pInside: [0.3, 0.68] as [number, number],
  /** HOW MUCH FASTER the stack is crossed. The interior takes 1/insideRate of
   *  the p it used to, and the time saved is handed to the approach and the
   *  exit, which slow down by the same amount of p between them. 1 = the old
   *  linear dive, EXACTLY (the remap is the identity there); 2 halves the
   *  interior — the owner's note is that it "is a bit long", and the wormhole
   *  ramps above now cover the crossing rather than following it. */
  insideRate: 2,
};

/**
 * THE TRAVEL REMAP, p → pose p: three linear segments through (0, 0),
 * (a′, a), (b′, b), (1, 1), where [a, b] = `inside` is the interior in POSE p
 * and [a′, b′] is the shorter stretch of INPUT p that now covers it (same
 * midpoint, `rate` times narrower).
 *
 * Monotone, continuous and fixed at both ends. At rate = 1 it is the identity —
 * a′ = a and b′ = b, so every segment has slope 1 — and returns `p` itself, so
 * the knob restores the old linear dive to the bit rather than to 1e-17.
 */
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

/**
 * One element's passage fade: 1 while it is ahead of the camera, ramping to 0
 * over `fade` world units and reaching 0 `lead` units before the camera's own X
 * meets the element's rearmost point `x0`. Stays 0 once past — the ramp is a
 * pure function of camera X, so a backwards scrub brings the element back.
 */
export function passageFade(
  camX: number,
  x0: number,
  lead: number,
  fade: number,
): number {
  return 1 - smoothstep(x0 - lead - fade, x0 - lead, camX);
}

/** World X of the camera under a spherical pose — the same expression
 *  a CameraPose puts into camera.position.x, and the only way
 *  the dive knows where it is. */
export function poseCamX(pose: CameraPose): number {
  return (
    (pose.targetX ?? 0) +
    pose.distance * Math.cos(pose.elevation) * Math.sin(pose.azimuth)
  );
}

/** The elements ordered REAR TO FRONT (ascending world X), which is the order
 *  the dive meets them in — `worldAxialSpans` hands back an unordered record. */
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
 *  which needs the prescription but must not IMPORT it (core/scene.ts is in the
 *  homepage chunk; see GlassSpanMm). Derived here because this module is already
 *  an optics/ consumer, and it is a pure function of the authored table, so it is
 *  built once at module scope rather than per enter(). */
export const GLASS_SPANS: Record<string, GlassSpanMm> = Object.fromEntries(
  PRESCRIPTION.map((e) => [
    e.id,
    { frontYmm: e.front.yMm, rearYmm: e.rear.yMm },
  ]),
);

/** az is written once and carried by every later key: ONE heading for the whole
 *  flight. Only targetX (and, on the approach, dist/el/fov) ever changes.
 *  The barrel run is deliberately LINEAR — an ease at each interior key would
 *  stall the camera mid-glass, and the interior's PACE is FLY.insideRate's job
 *  (see travelRemap), which reshapes p before it ever reaches this path.
 *
 *  THE FOV SETTLES BY pClear AND IS HELD. `fovOut` sits on the pClear key, not
 *  on the last one, so whatever it is set to is REACHED as the lens leaves the
 *  frame and then carried, unchanged, to p = 1 (posePath carries every field a
 *  key does not restate). The finale is a hold, never a push — see FLY.fovOut. */
/* prettier-ignore */
export const flyPose = posePath([
  { p: 0,           pose: { az: FLY.azRear, el: FLY.elFar, fov: FLY.fovFar, dist: FLY.distFar, targetX: 0                     } },
  { p: FLY.pEnter,  pose: {                 el: 0,         fov: FLY.fovIn,  dist: FLY.distIn,  targetX: FLY.xEnter + FLY.distIn }, ease: ss01 },
  { p: FLY.pOut,    pose: {                                                                    targetX: FLY.xOut   + FLY.distIn } },
  { p: FLY.pClear,  pose: {                                 fov: FLY.fovOut,                   targetX: FLY.xClear + FLY.distIn } },
  { p: 1,           pose: {                                                                    targetX: FLY.xEnd   + FLY.distIn }, ease: ss01 },
]);
