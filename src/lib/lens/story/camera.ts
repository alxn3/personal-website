import * as THREE from "three/webgpu";
import { RANGES, STORY_R, rangeOf, type Pose, type Waypoint } from "./story";
import { clamp01, smoothstep, lerp, deg } from "../core/math";

// The scroll-story camera path, derived from the STORY table. In the displayed
// frame the optical axis is world +X, radial plane Y–Z; each scene keys an
// orbit position in units of STORY_R, with a "transit → hold" pattern.

// A very narrow fov plus a matching pullback ≈ an orthographic elevation. It
// has to be this narrow: residual parallax on a PARKED lens scales with
// tan(fov/2), and at 6° the off-centre hero showed a visible side-tilt. The
// pullback grows to ~10×, which core/scene's camera.far is sized for.
const ORTHO_FOV = 3;

export interface StorySample {
  fov: number;
  xs: number;
  ys: number;
}

const ORIGIN: [number, number, number] = [0, 0, 0];

// CHORDAL Catmull-Rom (Hermite with chord-scaled tangents): multi-waypoint
// transits spline through their vias per component, so the path is C1 in THE
// CHORD-LENGTH PARAMETER the sampler advances by. A uniform Catmull-Rom is C1
// only in its uniform parameter — remapped onto chord length its speed jumps at
// every knot by the ratio of the adjacent leg lengths.
interface Chain {
  path: Waypoint[]; // endpoints are full Poses; vias carry only the splined fields
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

// tangent at knot i, in d/d(chord-length) — a plain function rather than a
// per-call closure, so the per-frame chain branch allocates nothing
function knotTan(c: Chain, i: number, get: (pose: Waypoint) => number): number {
  const n = c.path.length;
  return i <= 0
    ? (get(c.path[1]) - get(c.path[0])) / c.chord[0]
    : i >= n - 1
      ? (get(c.path[n - 1]) - get(c.path[n - 2])) / c.chord[n - 2]
      : (get(c.path[i + 1]) - get(c.path[i - 1])) /
        (c.chord[i - 1] + c.chord[i]);
}

// `get` at parameter t within segment `seg`; tangents in d/d(chord-length)
function chainAt(
  c: Chain,
  seg: number,
  t: number,
  get: (pose: Waypoint) => number,
): number {
  const L = c.chord[seg];
  const v0 = get(c.path[seg]);
  const v1 = get(c.path[seg + 1]);
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * v0 +
    (t3 - 2 * t2 + t) * L * knotTan(c, seg, get) +
    (-2 * t3 + 3 * t2) * v1 +
    (t3 - t2) * L * knotTan(c, seg + 1, get)
  );
}

// the chain branch's field readers, hoisted so sampleStory allocates nothing
const GET_PX = (o: Waypoint) => o.pos[0];
const GET_PY = (o: Waypoint) => o.pos[1];
const GET_PZ = (o: Waypoint) => o.pos[2];
const GET_UX = (o: Waypoint) => o.up[0];
const GET_UY = (o: Waypoint) => o.up[1];
const GET_UZ = (o: Waypoint) => o.up[2];
const GET_FOV = (o: Waypoint) => o.fov;
const GET_XS = (o: Waypoint) => o.xs;
const GET_RAD = (o: Waypoint) => Math.hypot(o.pos[0], o.pos[1], o.pos[2]);

// Each scene's camera move, RESOLVED ONCE at module load: which chain it rides,
// the poses it leaves from and settles into, and (fused chains only) the
// p-window of the one shared ease. A pure function of the validated STORY
// table, so it must not be re-derived in sampleStory, which runs every frame.
type ScenePlan = {
  linked: boolean; // this scene rides a fused head→tail chain
  flattenNever: boolean; // a linked HEAD is in motion its whole range
  first: Pose; // pose the move leaves from — start of the xs/ys/target slide
  last: Pose; // pose the move settles into
  pStart: number; // fused chains only: the move's own p-window
  pEnd: number;
} & ( // 2-waypoint transit (exact endpoint lerp) XOR 3+ (chordal spline)
  | { simple: readonly [Waypoint, Waypoint]; chain: null }
  | { simple: null; chain: Chain }
);

const PLANS: readonly ScenePlan[] = RANGES.map((r, i) => {
  // if the PREVIOUS scene links into this one, this scene's camera is the tail
  // of that chain, not its own transit
  const head = i > 0 && RANGES[i - 1].scene.linkNext ? i - 1 : i;
  const linked =
    Boolean(RANGES[head].scene.linkNext) && head + 1 < RANGES.length;
  let first: Pose;
  let last: Pose;
  let path: Waypoint[];
  let pStart = 0;
  let pEnd = 0;
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
    pEnd = rT.p0 + rT.scene.transit * (rT.p1 - rT.p0);
    pStart = rH.p0 + (rH.scene.camHold ?? 0) * (rH.p1 - rH.p0);
  } else {
    first = i > 0 ? RANGES[i - 1].scene.cam : r.scene.cam;
    last = r.scene.cam;
    path = [first, ...(r.scene.via ?? []), last];
  }
  const base = { linked, flattenNever: linked && i === head, first, last };
  if (path.length === 2)
    return {
      ...base,
      pStart,
      pEnd,
      simple: [path[0], path[1]] as const,
      chain: null,
    };
  return { ...base, pStart, pEnd, simple: null, chain: buildChain(path) };
});

// The camera pose at `p`: each scene eases from the previous scene's settle
// pose, through any `via` waypoints, to its own over the scene's first
// `transit`, then holds — unless it is part of a `linkNext` chain, which fuses
// two scenes into one ease so the boundary is not a dead stop. There are no
// hand-tuned per-key p values; the ranges come from the durations.
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
  const { first, last } = plan;
  const local = clamp01((p - r.p0) / Math.max(1e-6, r.p1 - r.p0));

  // A chain can be HELD before it starts (`camHold`): below that point moveT is
  // exactly 0, and a chain at moveS 0 evaluates to its FIRST waypoint
  // bit-for-bit (the Hermite basis at t = 0 is [1,0,0,0] and every lerp
  // collapses to `first`), so the hold IS the previous scene's parked pose
  // rather than an approximation of it.
  const moveT = plan.linked
    ? clamp01((p - plan.pStart) / Math.max(1e-6, plan.pEnd - plan.pStart))
    : sc.transit > 0
      ? clamp01(local / sc.transit)
      : 1;
  // one eased transit parameter shared by the orbit AND the xs/ys park shifts,
  // so the lateral slide has the orbit's velocity profile
  const moveS = smoothstep(0, 1, moveT);

  let baseLen: number;
  let fovKey: number;
  let xsKey: number;
  if (plan.simple) {
    // simple transit — exact endpoint lerp
    const [a, b] = plan.simple;
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
    // waypoint chain — chord-length parameterization (constant travel speed
    // along the chain) plus a chordal spline through the waypoints
    const chain = plan.chain;
    const n = chain.path.length;
    const s = moveS * chain.cum[n - 1];
    let seg = 0;
    while (seg < n - 2 && s > chain.cum[seg + 1]) seg++;
    const st = clamp01((s - chain.cum[seg]) / chain.chord[seg]);
    outPos.set(
      chainAt(chain, seg, st, GET_PX),
      chainAt(chain, seg, st, GET_PY),
      chainAt(chain, seg, st, GET_PZ),
    );
    // orbit, don't chord: the RADIUS is splined separately and re-applied to
    // the splined direction, so wide angular legs don't cut inward
    baseLen = chainAt(chain, seg, st, GET_RAD) * STORY_R;
    outUp.set(
      chainAt(chain, seg, st, GET_UX),
      chainAt(chain, seg, st, GET_UY),
      chainAt(chain, seg, st, GET_UZ),
    );
    fovKey = chainAt(chain, seg, st, GET_FOV);
    // xs is live on splined transits — per-via park shifts ease through
    xsKey = chainAt(chain, seg, st, GET_XS);
  }

  // "Flatten" to an orthographic elevation only while PARKED: 0 during every
  // transit and eased back to 0 before the scene ends, so the next scene begins
  // in perspective. A linked HEAD is in motion its whole range and never
  // flattens; the LAST scene keeps its flatten to the end, since it hands off
  // to the page below rather than to another scene's transit.
  const flattenIn =
    plan.flattenNever || sc.transit >= 1
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

  // the orbit centre eases first → last on the park shifts' profile; via
  // waypoints carry no target, so the endpoints define the slide
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
  // The camera stays ON-AXIS looking at the scene's orbit target; the park (xs
  // and ys, in units of STORY_R) is applied as an OFF-CENTRE PROJECTION WINDOW
  // rather than by shifting the camera and target. Shifting leaves the lens off
  // the projection centre, whose parallax reads as a tilt on a parked "flat"
  // elevation; a view offset pans the 2D projection with zero parallax.
  camera.position.copy(storyTarget).add(storyPos);
  camera.lookAt(storyTarget);
  camera.fov = fov;
  // world-space half-extents of the frustum at the origin's distance
  const halfH =
    (Math.tan((fov * Math.PI) / 360) * storyPos.length()) / camera.zoom;
  const halfW = halfH * camera.aspect;
  const sh = xs * STORY_R * parkScale; // + shoves the lens LEFT
  const sv = ys * STORY_R;
  // Portrait lift: as the horizontal park fades out on narrow screens, shift
  // the lens UP instead, clear of the bottom content band. It must NOT apply in
  // the hero, whose intro type is top-anchored on phones, so it eases in as the
  // hero ends.
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
