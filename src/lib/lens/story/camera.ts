import * as THREE from "three/webgpu";
import { RANGES, rangeOf, type Pose, type Waypoint } from "./story";
import { clamp01, smoothstep, lerp, deg } from "../core/math";

// --- scroll-story camera path -------------------------------------------------
// In the loaded/displayed frame the optical axis is world +X (front element at
// +X), radial plane Y–Z. Each scene keys an orbit position (in units of STORY_R)
// so the camera shoots it from the right angle, with a "transit → hold" pattern.
export const STORY_R = 11;
// Very narrow fov + matching pullback ≈ orthographic elevation. 3° (was 6°): the
// residual perspective parallax on a PARKED lens scales with tan(fov/2), and at 6°
// the off-centre hero showed a visible ~2° side-tilt instead of a flat elevation.
// The pullback grows to ~10× — core/scene's camera.far is sized for it.
const ORTHO_FOV = 3;

export interface StorySample {
  fov: number;
  xs: number;
  ys: number;
}

const ORIGIN: [number, number, number] = [0, 0, 0];

// CHORDAL Catmull-Rom (Hermite with chord-scaled tangents) — multi-waypoint
// transits spline through their vias with this (per component) so the path is C1
// through each waypoint IN THE CHORD-LENGTH PARAMETER the sampler advances by.
// Two dead ends this replaces: per-segment lerp was continuous but the velocity
// DIRECTION snapped at every via; and a UNIFORM Catmull-Rom is only C1 in its
// uniform parameter — mapped onto chord length its speed JUMPS at every knot by
// the ratio of the adjacent leg lengths (~2.6× at the rewrap→capsOn junction),
// which read as stutter right as the finale came together.
interface Chain {
  path: Waypoint[]; // endpoints are full Poses; the interior vias only carry the four splined fields
  chord: number[]; // leg lengths (pos-space)
  cum: number[]; // cumulative, cum[0] = 0
}

function buildChain(path: Waypoint[]): Chain {
  const chord: number[] = [];
  const cum: number[] = [0];
  for (let k = 1; k < path.length; k++) {
    const A = path[k - 1].pos;
    const B = path[k].pos;
    const L = Math.max(1e-6, Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]));
    chord.push(L);
    cum.push(cum[k - 1] + L);
  }
  return { path, chord, cum };
}

// value of `get` at parameter t within segment `seg`, tangents in d/d(chord-length)
function chainAt(
  c: Chain,
  seg: number,
  t: number,
  get: (pose: Waypoint) => number,
): number {
  const n = c.path.length;
  const L = c.chord[seg];
  const v0 = get(c.path[seg]);
  const v1 = get(c.path[seg + 1]);
  const tan = (i: number) =>
    i <= 0
      ? (get(c.path[1]) - get(c.path[0])) / c.chord[0]
      : i >= n - 1
        ? (get(c.path[n - 1]) - get(c.path[n - 2])) / c.chord[n - 2]
        : (get(c.path[i + 1]) - get(c.path[i - 1])) /
          (c.chord[i - 1] + c.chord[i]);
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * v0 +
    (t3 - 2 * t2 + t) * L * tan(seg) +
    (-2 * t3 + 3 * t2) * v1 +
    (t3 - t2) * L * tan(seg + 1)
  );
}

// The camera path is DERIVED from the scene table (story/story.ts): each scene eases
// from the previous scene's settle pose, through any `via` waypoints, to its own
// settle pose over the first `transit` of the scene, then holds. A scene marked
// `linkNext` instead FUSES with its successor: one waypoint chain, one ease, from
// the head scene's start to the end of the tail scene's transit — because the
// per-scene pattern necessarily decelerates to a dead stop at every scene boundary
// (an eased transit ends at zero velocity and the next re-accelerates from zero),
// which is right for park-and-hold scenes but a visible hitch when the story wants
// one continuous move across the boundary (rewrap → capsOn). No hand-tuned per-key
// `p` values — the ranges come from the durations. `outPos` is the orbit OFFSET
// from `outTarget` (the scene's look-at, default the lens centre at the origin) —
// the caller places the camera at target + offset and looks at target.
export function sampleStory(
  p: number,
  outPos: THREE.Vector3,
  outUp: THREE.Vector3,
  outTarget: THREE.Vector3,
): StorySample {
  let i = 0;
  while (i < RANGES.length - 1 && p >= RANGES[i].p1) i++;

  // resolve link chains: if the PREVIOUS scene links into this one, this scene's
  // camera is the tail of that chain, not its own transit.
  let head = i;
  if (i > 0 && RANGES[i - 1].scene.linkNext) head = i - 1;
  const linked =
    Boolean(RANGES[head].scene.linkNext) && head + 1 < RANGES.length;

  const r = RANGES[i];
  const sc = r.scene;
  const local = clamp01((p - r.p0) / Math.max(1e-6, r.p1 - r.p0));

  let path: Waypoint[];
  let moveT: number;
  let first: Pose; // pose the move leaves from — start of the xs/ys/target slide
  let last: Pose; // pose the move settles into
  if (linked) {
    const rH = RANGES[head];
    const rT = RANGES[head + 1];
    first = head > 0 ? RANGES[head - 1].scene.cam : rH.scene.cam;
    last = rT.scene.cam;
    path = [
      first,
      ...(rH.scene.via ?? []),
      rH.scene.cam,
      ...(rT.scene.via ?? []),
      last,
    ];
    const pEnd = rT.p0 + rT.scene.transit * (rT.p1 - rT.p0);
    moveT = clamp01((p - rH.p0) / Math.max(1e-6, pEnd - rH.p0));
  } else {
    first = i > 0 ? RANGES[i - 1].scene.cam : sc.cam;
    last = sc.cam;
    path = [first, ...(sc.via ?? []), last];
    moveT = sc.transit > 0 ? clamp01(local / sc.transit) : 1;
  }
  // one eased transit parameter shared by the orbit AND the xs/ys park shifts,
  // so the lateral slide starts/stops with the same velocity profile as the orbit
  const moveS = smoothstep(0, 1, moveT);

  let baseLen: number;
  let fovKey: number;
  let xsKey: number;
  if (path.length === 2) {
    // simple transit — exact endpoint lerp (unchanged fast path for parked scenes)
    const a = path[0];
    const b = path[1];
    outPos.set(
      lerp(a.pos[0], b.pos[0], moveS),
      lerp(a.pos[1], b.pos[1], moveS),
      lerp(a.pos[2], b.pos[2], moveS),
    );
    // arc: keep radius = lerp of the endpoints' radii (orbit, don't chord)
    const ra = Math.hypot(a.pos[0], a.pos[1], a.pos[2]);
    const rb = Math.hypot(b.pos[0], b.pos[1], b.pos[2]);
    baseLen = lerp(ra, rb, moveS) * STORY_R;
    outUp.set(
      lerp(a.up[0], b.up[0], moveS),
      lerp(a.up[1], b.up[1], moveS),
      lerp(a.up[2], b.up[2], moveS),
    );
    fovKey = lerp(a.fov, b.fov, moveS);
    xsKey = lerp(a.xs, b.xs, moveS);
  } else {
    // waypoint chain — chord-length parameterization (constant travel speed along
    // the chain; the old equal-parameter split made speed JUMP wherever adjacent
    // legs differed in length) + a chordal spline through the waypoints.
    const chain = buildChain(path);
    const n = path.length;
    const s = moveS * chain.cum[n - 1];
    let seg = 0;
    while (seg < n - 2 && s > chain.cum[seg + 1]) seg++;
    const st = clamp01((s - chain.cum[seg]) / chain.chord[seg]);
    const q = (get: (pose: Waypoint) => number) => chainAt(chain, seg, st, get);
    outPos.set(
      q((o) => o.pos[0]),
      q((o) => o.pos[1]),
      q((o) => o.pos[2]),
    );
    // orbit, don't chord: the RADIUS is splined separately and re-applied to the
    // splined direction, so wide angular legs (the capsOn spin) don't cut inward
    baseLen = q((o) => Math.hypot(o.pos[0], o.pos[1], o.pos[2])) * STORY_R;
    outUp.set(
      q((o) => o.up[0]),
      q((o) => o.up[1]),
      q((o) => o.up[2]),
    );
    fovKey = q((o) => o.fov);
    // xs is live on splined transits (per-via park shifts ease through the chain)
    xsKey = q((o) => o.xs);
  }

  // "flatten" to an orthographic elevation only while PARKED on the hold — 0 during
  // every transit (perspective while orbiting) and eased back to 0 before the scene
  // ends, so the next scene begins in perspective (continuous across the boundary).
  // The HEAD of a linked chain is in motion for its whole range and never flattens;
  // the TAIL parks after its own transit (the chain ends there by construction) and
  // flattens like any other scene. The LAST scene keeps its flatten to the very
  // end — it hands off to the page below, not to another scene's transit.
  const flattenIn =
    (linked && i === head) || sc.transit >= 1
      ? 0
      : sc.transit > 0
        ? smoothstep(sc.transit, Math.min(1, sc.transit + 0.12), local)
        : 1;
  const endRelease =
    i < RANGES.length - 1 ? 1 - smoothstep(0.9, 1.0, local) : 1;
  const settled = flattenIn * endRelease;
  const ortho = sc.cam.ortho * settled;
  const fov = lerp(fovKey, ORTHO_FOV, ortho);
  const back = Math.tan(deg(fovKey) / 2) / Math.tan(deg(fov) / 2);
  outPos.setLength(baseLen * back);
  outUp.normalize();

  // the orbit centre eases first → last with the same profile as the park
  // shifts (via waypoints don't carry targets — the endpoints define the slide)
  const ta = first.target ?? ORIGIN;
  const tb = last.target ?? ORIGIN;
  outTarget.set(
    lerp(ta[0], tb[0], moveS),
    lerp(ta[1], tb[1], moveS),
    lerp(ta[2], tb[2], moveS),
  );

  return {
    fov,
    xs: xsKey,
    ys: lerp(first.ys ?? 0, last.ys ?? 0, moveS),
  };
}

/**
 * Apply one frame's story-mode framing: place/aim the camera from the pose that
 * sampleStory() just wrote into `storyPos`/`storyUp`/`storyTarget`, then apply
 * the park/lift as a view offset. `storyP` is the same clamped 0..1 progress
 * the pose was sampled at; `parkScale` fades the horizontal park on portrait
 * viewports (computed by core/scene's resize handler).
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
  storyP: number,
): void {
  const { fov, xs, ys } = sample;
  camera.up.copy(storyUp);
  // Camera stays ON-AXIS looking at the scene's orbit target (the lens centre
  // at the origin unless a Pose sets `target`); the park (xs, and ys for
  // detail reframing, both in units of STORY_R; xs park-scaled for portrait)
  // is applied as an OFF-CENTRE PROJECTION WINDOW instead of by shifting the
  // camera + target. Shifting the camera kept the lens off the projection
  // centre, whose perspective parallax read as a slight TILT on the parked
  // "flat" elevations (the hero most visibly). A view offset pans the 2D
  // projection — zero parallax at any park, a true elevation.
  camera.position.copy(storyTarget).add(storyPos);
  camera.lookAt(storyTarget);
  camera.fov = fov;
  // world-space half-extents of the frustum at the origin's distance
  const halfH =
    (Math.tan((fov * Math.PI) / 360) * storyPos.length()) / camera.zoom;
  const halfW = halfH * camera.aspect;
  const sh = xs * STORY_R * parkScale; // + shoves the lens LEFT (as before)
  const sv = ys * STORY_R;
  // Portrait lift: as the horizontal park fades out (parkScale → 0 on narrow
  // screens), shift the lens UP a little instead — the scene content collapses
  // into a bottom band on phones, and this keeps the lens clear of it. NOT in
  // the hero, whose intro type is TOP-anchored on phones (lifting the lens
  // there shoves it into the text) — the lift eases in as the hero ends.
  const heroEnd = rangeOf("hero").p1;
  const lift =
    (1 - parkScale) *
    0.06 *
    canvasH *
    smoothstep(heroEnd * 0.55, heroEnd, storyP);
  camera.setViewOffset(
    canvasW,
    canvasH,
    (canvasW / 2) * (sh / halfW),
    (-canvasH / 2) * (sv / halfH) + lift,
    canvasW,
    canvasH,
  );
  camera.updateProjectionMatrix();
}
