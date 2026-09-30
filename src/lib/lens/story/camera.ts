// The story's camera path, from the STORY table: each scene eases from the
// previous scene's pose to its own over its transit, then holds. The optical
// axis is world +X.

import * as THREE from "three/webgpu";
import { RANGES, STORY_R, sceneIndexAt, type Pose } from "./story";
import { clamp01, smoothstep, lerp, deg } from "../core/math";

/** The fov used to fake an orthographic view (with a matching pull-back).
 *  The pull-back is ~10×, which core/scene's camera.far must allow. */
const ORTHO_FOV = 3;

export interface StorySample {
  fov: number;
  xs: number;
  ys: number;
  /** Pose.wide, Pose.near and Pose.lift, interpolated */
  wide: number;
  near: number;
  lift: number;
}

const ORIGIN: [number, number, number] = [0, 0, 0];

/** The dive's overrides: `centre` fades the park out, `fov` blends in by
 *  `fovMix`, `far` sets the far plane from the camera distance. */
export interface DiveFraming {
  centre: number;
  fov: number | null;
  fovMix: number;
  far: (dist: number) => number;
}

// Each scene's camera move, resolved once at load.
interface ScenePlan {
  /** pose the move starts from (the previous scene's) */
  first: Pose;
  /** pose it settles into */
  last: Pose;
  /** the move's window, absolute p */
  pStart: number;
  pEnd: number;
}

const PLANS: readonly ScenePlan[] = RANGES.map((r, i) => ({
  first: i > 0 ? RANGES[i - 1].scene.cam : r.scene.cam,
  last: r.scene.cam,
  // same arithmetic as atFrac, so the edges match it exactly
  pStart: r.p0 + (r.p1 - r.p0) * (r.scene.camHold ?? 0),
  pEnd: r.p0 + (r.p1 - r.p0) * r.scene.transit,
}));

/** The camera pose at `p`. `outPos` is the offset from `outTarget` (the
 *  look-at): the camera sits at target + offset. */
export function sampleStory(
  p: number,
  outPos: THREE.Vector3,
  outUp: THREE.Vector3,
  outTarget: THREE.Vector3,
): StorySample {
  const i = sceneIndexAt(p);
  const r = RANGES[i];
  const sc = r.scene;
  const plan = PLANS[i];
  const { first: a, last: b } = plan;
  const local = clamp01((p - r.p0) / Math.max(1e-6, r.p1 - r.p0));

  // Before pStart the lerp gives the previous pose exactly; a zero-width
  // window jumps straight to the scene's pose.
  const moveT =
    plan.pEnd > plan.pStart
      ? clamp01((p - plan.pStart) / (plan.pEnd - plan.pStart))
      : 1;
  // one eased parameter for the orbit, park shifts and target alike
  const moveS = smoothstep(0, 1, moveT);

  outPos.set(
    lerp(a.pos[0], b.pos[0], moveS),
    lerp(a.pos[1], b.pos[1], moveS),
    lerp(a.pos[2], b.pos[2], moveS),
  );
  // orbit rather than cut across: the radius is lerped separately
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

  // The flatten to orthographic: by default only while parked (off during the
  // transit and eased off before the scene ends, except in the last scene),
  // unless the scene sets its own `orthoIn`/`orthoOut`.
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

/** Place and aim the camera from sampleStory()'s output, then apply the park
 *  and lift as a view offset. `parkScale` (0..1) fades the park on narrow
 *  viewports. */
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
  // Pose.wide: pull back on narrow viewports until the scene fits
  const frameW = camera.aspect / camera.zoom;
  if (wide > frameW) storyPos.multiplyScalar(wide / frameW);
  // Pose.near: push in on portrait viewports
  const near = lerp(sample.near, 1, parkScale);
  if (near < 1) storyPos.multiplyScalar(near);
  // The camera looks straight at the target; the park is an off-centre
  // projection window, not a camera shift (which would add parallax).
  camera.position.copy(storyTarget).add(storyPos);
  camera.lookAt(storyTarget);
  // the dive's fov blends over the story's; the park below keeps the story's
  // fov so it doesn't shift with the blend
  camera.fov =
    dive && dive.fov !== null && dive.fovMix > 0
      ? lerp(fov, dive.fov, dive.fovMix)
      : fov;
  if (dive) camera.far = dive.far(camera.position.length());
  // world-space half-extents of the frustum at the origin's distance
  const halfH =
    (Math.tan((fov * Math.PI) / 360) * storyPos.length()) / camera.zoom;
  const halfW = halfH * camera.aspect;
  const sh = xs * STORY_R * parkScale; // + shoves the lens left
  const sv = ys * STORY_R;
  // Pose.lift: as the park fades on narrow screens, shift the lens vertically
  const lift = parkScale < 1 ? (1 - parkScale) * sample.lift * canvasH : 0;
  // the dive fades the whole park out
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
