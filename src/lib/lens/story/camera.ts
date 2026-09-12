import * as THREE from "three/webgpu";
import { RANGES, STORY_R, type Pose } from "./story";
import { clamp01, smoothstep, lerp, deg } from "../core/math";

// The scroll-story camera path, derived from the STORY table. In the displayed
// frame the optical axis is world +X, radial plane Y–Z; each scene keys an
// orbit position in units of STORY_R, with a "transit → hold" pattern.

// A very narrow fov plus a matching pullback ≈ an orthographic elevation.
// Residual parallax on a parked lens scales with tan(fov/2), so it has to be
// this narrow; the pullback grows ~10×, which core/scene's camera.far allows.
const ORTHO_FOV = 3;

export interface StorySample {
  fov: number;
  xs: number;
  ys: number;
  /** the frame half-width the scene needs, in its own half-heights (Pose.wide) */
  wide: number;
  /** the portrait push-in, applied as lerp(near, 1, parkScale) (Pose.near) */
  near: number;
  /** the portrait lift, in canvas heights (Pose.lift) */
  lift: number;
}

const ORIGIN: [number, number, number] = [0, 0, 0];

/** The dive's framing over the story pose: `centre` scales the park toward
 *  zero, `fov` ramps in by `fovMix`, `far` follows the pull-back distance. */
export interface DiveFraming {
  centre: number;
  fov: number | null;
  fovMix: number;
  far: (dist: number) => number;
}

// Each scene's camera move, RESOLVED ONCE at module load: the poses it leaves
// from and settles into, and the move's p-window. Never re-derived in the
// per-frame sampler.
interface ScenePlan {
  first: Pose; // pose the move leaves from — start of the xs/ys/target slide
  last: Pose; // pose the move settles into
  pStart: number; // the move's window, in absolute p
  pEnd: number;
}

const PLANS: readonly ScenePlan[] = RANGES.map((r, i) => ({
  first: i > 0 ? RANGES[i - 1].scene.cam : r.scene.cam,
  last: r.scene.cam,
  // the scene's own window, in ABSOLUTE p and in `atFrac`'s own arithmetic —
  // a fraction-of-local form rounds differently at the far edge
  pStart: r.p0 + (r.p1 - r.p0) * (r.scene.camHold ?? 0),
  pEnd: r.p0 + (r.p1 - r.p0) * r.scene.transit,
}));

// The camera pose at `p`: each scene eases from the previous scene's settle
// pose to its own over the scene's first `transit`, then holds.
//
// `outPos` is the orbit OFFSET from `outTarget` (the scene's look-at, default
// the origin): the caller places the camera at target + offset and looks at it.
export function sampleStory(
  p: number,
  outPos: THREE.Vector3,
  outUp: THREE.Vector3,
  outTarget: THREE.Vector3,
): StorySample {
  let i = 0;
  while (i < RANGES.length - 1 && p >= RANGES[i].p1) i++;

  const r = RANGES[i];
  const sc = r.scene;
  const plan = PLANS[i];
  const { first: a, last: b } = plan;
  const local = clamp01((p - r.p0) / Math.max(1e-6, r.p1 - r.p0));

  // ONE WINDOW: the move runs [pStart, pEnd] in absolute p. Below pStart moveT
  // is exactly 0, where the lerp evaluates to its FIRST pose bit-for-bit, so a
  // hold IS the previous scene's parked pose. A zero-width window is a scene
  // that never moves: it wears its pose at once.
  const moveT =
    plan.pEnd > plan.pStart
      ? clamp01((p - plan.pStart) / (plan.pEnd - plan.pStart))
      : 1;
  // one eased transit parameter shared by the orbit AND the xs/ys park shifts,
  // so the lateral slide has the orbit's velocity profile
  const moveS = smoothstep(0, 1, moveT);

  outPos.set(
    lerp(a.pos[0], b.pos[0], moveS),
    lerp(a.pos[1], b.pos[1], moveS),
    lerp(a.pos[2], b.pos[2], moveS),
  );
  // arc: keep radius = lerp of the endpoints' radii (orbit, don't chord)
  const ra = Math.hypot(a.pos[0], a.pos[1], a.pos[2]);
  const rb = Math.hypot(b.pos[0], b.pos[1], b.pos[2]);
  const baseLen = lerp(ra, rb, moveS) * STORY_R;
  outUp.set(
    lerp(a.up[0], b.up[0], moveS),
    lerp(a.up[1], b.up[1], moveS),
    lerp(a.up[2], b.up[2], moveS),
  );
  const fovKey = lerp(a.fov, b.fov, moveS);
  const xsKey = lerp(a.xs, b.xs, moveS);

  // "Flatten" to an orthographic elevation. By default only while PARKED: 0
  // during every transit and eased back to 0 before the scene ends; the LAST
  // scene keeps its flatten to the end.
  //
  // A scene may instead author the flatten's own window (story/story.ts
  // `orthoIn`/`orthoOut`); an omitted side holds it open at that end.
  const oIn = sc.orthoIn;
  const oOut = sc.orthoOut;
  let settled: number;
  if (oIn || oOut) {
    settled =
      (oIn ? smoothstep(oIn[0], oIn[1], local) : 1) *
      (oOut ? 1 - smoothstep(oOut[0], oOut[1], local) : 1);
  } else {
    const flattenIn =
      sc.transit >= 1
        ? 0
        : sc.transit > 0
          ? smoothstep(sc.transit, Math.min(1, sc.transit + 0.12), local)
          : 1;
    const endRelease =
      i < RANGES.length - 1 ? 1 - smoothstep(0.9, 1.0, local) : 1;
    settled = flattenIn * endRelease;
  }
  const ortho = sc.cam.ortho * settled;
  const fov = lerp(fovKey, ORTHO_FOV, ortho);
  const back = Math.tan(deg(fovKey) / 2) / Math.tan(deg(fov) / 2);
  outPos.setLength(baseLen * back);
  outUp.normalize();

  // the orbit centre eases first → last on the park shifts' profile
  const ta = a.target ?? ORIGIN;
  const tb = b.target ?? ORIGIN;
  outTarget.set(
    lerp(ta[0], tb[0], moveS),
    lerp(ta[1], tb[1], moveS),
    lerp(ta[2], tb[2], moveS),
  );

  return {
    fov,
    xs: xsKey,
    ys: lerp(a.ys ?? 0, b.ys ?? 0, moveS),
    wide: lerp(a.wide ?? 1, b.wide ?? 1, moveS),
    near: lerp(a.near ?? 1, b.near ?? 1, moveS),
    lift: lerp(a.lift ?? 0.06, b.lift ?? 0.06, moveS),
  };
}

/**
 * Apply one frame's story-mode framing: place/aim the camera from the pose that
 * sampleStory() just wrote into `storyPos`/`storyUp`/`storyTarget`, then apply
 * the park/lift as a view offset. `parkScale` fades the horizontal park on
 * portrait viewports (computed by core/scene's resize handler).
 */
export function applyStoryFraming(
  camera: THREE.PerspectiveCamera,
  sample: StorySample,
  storyPos: THREE.Vector3,
  storyUp: THREE.Vector3,
  storyTarget: THREE.Vector3,
  canvasW: number,
  canvasH: number,
  parkScale: number,
  dive?: DiveFraming,
): void {
  const { fov, xs, ys, wide } = sample;
  camera.up.copy(storyUp);
  // the narrow-viewport reach (story/story.ts `Pose.wide`): it scales the ORBIT
  // OFFSET, so the flatten's pullback and the park offsets scale with it and
  // the projection is untouched
  const frameW = camera.aspect / camera.zoom;
  if (wide > frameW) storyPos.multiplyScalar(wide / frameW);
  // the portrait push-in (Pose.near) scales the same offset, so it is a size
  // change with no projection or parallax change; landscape sees none of it
  const near = lerp(sample.near, 1, parkScale);
  if (near < 1) storyPos.multiplyScalar(near);
  // The camera stays ON-AXIS looking at the scene's orbit target; the park (xs
  // and ys, in units of STORY_R) is an OFF-CENTRE PROJECTION WINDOW, not a
  // camera shift, which would add parallax that reads as a tilt when flat.
  camera.position.copy(storyTarget).add(storyPos);
  camera.lookAt(storyTarget);
  // the dive's fov ramp rides over the story fov; the park below keeps the
  // story's own, so the offsets do not breathe with the ramp
  camera.fov =
    dive && dive.fov !== null && dive.fovMix > 0
      ? lerp(fov, dive.fov, dive.fovMix)
      : fov;
  if (dive) camera.far = dive.far(camera.position.length());
  // world-space half-extents of the frustum at the origin's distance
  const halfH =
    (Math.tan((fov * Math.PI) / 360) * storyPos.length()) / camera.zoom;
  const halfW = halfH * camera.aspect;
  const sh = xs * STORY_R * parkScale; // + shoves the lens LEFT
  const sv = ys * STORY_R;
  // portrait lift (Pose.lift): as the horizontal park fades on narrow screens,
  // the lens shifts up (or down) by a scene's own fraction of the height
  const lift = parkScale < 1 ? (1 - parkScale) * sample.lift * canvasH : 0;
  // the dive scales the whole park toward zero, so the two owners cross on a
  // ramp; setViewOffset builds the projection, once
  const keep = dive ? 1 - dive.centre : 1;
  camera.setViewOffset(
    canvasW,
    canvasH,
    (canvasW / 2) * (sh / halfW) * keep,
    ((-canvasH / 2) * (sv / halfH) + lift) * keep,
    canvasW,
    canvasH,
  );
}
