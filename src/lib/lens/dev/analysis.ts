import * as THREE from "three/webgpu";
import { ANIMATIONS, type LensAnimation } from "../animations";
import { isAccessory } from "../core/parts";
import { frameOf, wrapPi } from "../ops/frames";
import { createPositionProbe, type ProbeSample } from "./path-probe";
import type { PathVizContext } from "./paths";

// Dev only, dynamically imported. The measuring half of the motion-path tool
// (paths.ts draws): walks an animation and returns plain JSON.
//
// Shells (meshes with an `_op*` frame) are read back through the GPU probe.
// Solids (no frame) cannot deform in shader, so their rest points moved by each
// step's matrixWorld are exact. Positions are model-frame mm, optical axis Y.

const STEPS = 96;
/** A piece is "in flight" while any sample is further than this off its seat. */
const SEAT_TOL_MM = 1;
/** A corner counts as lifted while it sits this far above the piece's lowest
 *  corner at the same step. */
const CORNER_TOL_MM = 1;
/** Minimum rise of the min-radius series that counts as an outward excursion. */
const REVERSAL_EPS_MM = 0.5;
const IDLE_TOL_MM = 0.01;
/** A mesh whose samples never move further than this is static. */
const MOVE_TOL_MM = 0.01;
/** Grid edges shorter than this at rest are left out of the stretch metric. */
const STRETCH_MIN_EDGE_MM = 1.5;

/** seam = the wedge's +φ edge, where the peel hinges; far = the −φ edge.
 *  front = +Y (filter end), rear = −Y (mount end). */
const CORNER_LABELS = [
  "seam-front",
  "seam-rear",
  "far-front",
  "far-rear",
] as const;
type CornerLabel = (typeof CORNER_LABELS)[number];
const CORNER_SIGNS: Record<CornerLabel, [number, number]> = {
  "seam-front": [1, 1],
  "seam-rear": [1, -1],
  "far-front": [-1, 1],
  "far-rear": [-1, -1],
};

const fractN = (x: number) => x - Math.floor(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** The animation progress p of each walk step. */
const PS: number[] = Array.from({ length: STEPS }, (_, k) => k / (STEPS - 1));

/** Distance between the xyz triples at offsets `i` of `a` and `j` of `b`. */
export const dist3 = (
  a: ArrayLike<number>,
  i: number,
  b: ArrayLike<number>,
  j: number,
) => Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]);

/** [min, max] of `val` over the indices `idx`. */
export function extent(idx: number[], val: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of idx) {
    if (val[i] < lo) lo = val[i];
    if (val[i] > hi) hi = val[i];
  }
  return [lo, hi];
}

/** The first item of `items` with the highest score. */
export function argmax<T>(items: T[], score: (item: T) => number): T {
  let best = items[0];
  let bs = -Infinity;
  for (const it of items) {
    const s = score(it);
    if (s > bs) {
      bs = s;
      best = it;
    }
  }
  return best;
}

// --- result shapes (all plain JSON) -----------------------------------------

export interface Coverage {
  sampledMeshes: number;
  totalMovingMeshes: number;
  excluded: string[];
}

/** How far the probe's rest-pose row lands from the real rest geometry. */
export interface IdleCheck {
  maxErrMm: number;
  overTol: { name: string; errMm: number }[];
}

export interface ReversalStructure {
  count: number;
  /** each outward excursion of the min-radius series: peak p and rise in mm */
  events: { p: number; amplitudeMm: number }[];
}

export interface PieceReport {
  name: string;
  kind: "shell" | "solid";
  /** wedge name without its `_SegN` suffix (solids: own name) */
  shell: string;
  rank: number;
  sampleCount: number;
  /** peak grid-edge stretch ratio (shells only; 1 = no stretch) */
  peakStretch: number | null;
  /** centroid path length, mm */
  pathLengthMm: number;
  /** last p at which any sample is > SEAT_TOL_MM off its seat (0 = never) */
  seatedAtP: number;
  reversals: ReversalStructure;
  timeline?: {
    centroid: [number, number, number][];
    /** centroid as [r, unwrapped theta, y] */
    cyl: [number, number, number][];
    minR: number[];
    maxR: number[];
  };
}

export interface RankReport {
  rank: number;
  shells: string[];
  pieces: number;
  /** per step, min/max radius over the rank's pieces (mm) */
  minR: number[];
  maxR: number[];
  reversals: ReversalStructure;
}

export interface AnalysisResult {
  anim: string;
  steps: number;
  coverage: Coverage;
  idleCheck: IdleCheck;
  pieces: PieceReport[];
  ranks: RankReport[];
}

export interface CompareResult {
  a: string;
  b: string;
  steps: number;
  coverage: Coverage;
  idleCheck: { a: IdleCheck; b: IdleCheck };
  /** sorted by maxDivergenceMm descending */
  pieces: {
    name: string;
    kind: "shell" | "solid";
    rank: number;
    maxDivergenceMm: number;
    atP: number;
    meanDivergenceMm: number;
  }[];
  /** per shell rank, the radial envelope over time in each walk */
  rankEnvelopes: {
    a: { rank: number; minR: number[]; maxR: number[] }[];
    b: { rank: number; minR: number[]; maxR: number[] }[];
  };
}

export interface InterferencePair {
  inner: string;
  outer: string;
  rankInner: number;
  rankOuter: number;
  maxOverlapMm: number;
  /** overlap at rest: adjacent shells often nest, which is not a defect */
  seatedOverlapMm: number;
  /** in-flight overlap beyond the seated overlap (the sort key) */
  maxExcessMm: number;
  ranges: { p0: number; p1: number; maxOverlapMm: number }[];
}

export interface InterferenceResult {
  anim: string;
  steps: number;
  coverage: Coverage;
  idleCheck: IdleCheck;
  /** adjacent-rank pairs whose radial and axial bands overlap while both
   *  are in flight */
  pairs: InterferencePair[];
}

export interface CurlCornerResult {
  a: string;
  b: string;
  steps: number;
  coverage: Coverage;
  wedges: {
    name: string;
    shell: string;
    rank: number;
    hashSign: number;
    a: WedgeCorners;
    b: WedgeCorners;
  }[];
  shells: {
    shell: string;
    rank: number;
    hashSign: number;
    aLeading: CornerLabel | "tie" | "mixed";
    bLeading: CornerLabel | "tie" | "mixed";
    aAxialLead: "front" | "rear" | "tie" | "mixed";
    bAxialLead: "front" | "rear" | "tie" | "mixed";
    /** do the two animations lead from opposite axial ends? */
    axialMirrored: boolean | null;
  }[];
}

interface WedgeCorners {
  /** per corner: the last p at which it is still lifted (interpolated) */
  lastOffP: Partial<Record<CornerLabel, number>>;
  /** the corner that seats first */
  leading: CornerLabel | "tie";
  trailing: CornerLabel | "tie";
  /** which side seats first along the arc */
  arcLead: "seam" | "far" | "tie";
  /** which end seats first along the axis */
  axialLead: "front" | "rear" | "tie";
  /** largest (far-front lift − far-rear lift); positive = front hangs higher */
  farSkew: { mm: number; atP: number } | null;
}

export interface PathAnalysis {
  /** Per-piece and per-rank motion; `{ timeline: false }` drops per-step arrays. */
  analyze(
    animId: string,
    opts?: { timeline?: boolean },
  ): Promise<AnalysisResult>;
  /** Per-piece distance between two animations at equal p. */
  compare(idA: string, idB: string): Promise<CompareResult>;
  /** Adjacent-seat-rank radial band overlaps while both pieces are in flight. */
  interference(animId: string): Promise<InterferenceResult>;
  /** Which wedge corner seats first, per shell, in two animations. */
  curlCorners(idA?: string, idB?: string): Promise<CurlCornerResult>;
  dispose(): void;
}

// --- sampling ----------------------------------------------------------------

interface Piece {
  name: string;
  kind: "shell" | "solid";
  shell: string;
  rank: number;
  mesh: THREE.Mesh;
  /** index of this piece's first sample in the shared sample list */
  base: number;
  count: number;
  /** shells: grid edges as pairs of piece-local sample indices */
  edges: [number, number][];
  /** shells: corner label → piece-local sample index */
  corners: Partial<Record<CornerLabel, number>>;
  /** per sample: counts toward the radial band (false for solids' synthetic
   *  bounding-box corners) */
  radiusEligible: boolean[];
  /** solids: rest local positions, xyz-packed */
  rest: Float32Array | null;
  /** shells: sign(fract(R·5.13) − 0.5), the shear hash the deforms use */
  hashSign: number;
}

interface PickedShell {
  verts: number[];
  edges: [number, number][];
  corners: Partial<Record<CornerLabel, number>>;
}

/** A gu × gv grid over the (phi, y) extent of `cand`, snapped to the nearest
 *  real vertex at each grid point. */
export function gridPick(
  cand: number[],
  phi: number[],
  yy: number[],
  gu: number,
  gv: number,
): number[] {
  const [p0, p1] = extent(cand, phi);
  const [y0, y1] = extent(cand, yy);
  const dp = p1 - p0 || 1;
  const dy = y1 - y0 || 1;
  const out: number[] = [];
  for (let j = 0; j < gv; j++) {
    for (let i = 0; i < gu; i++) {
      const tp = p0 + (dp * i) / Math.max(1, gu - 1);
      const ty = y0 + (dy * j) / Math.max(1, gv - 1);
      out.push(
        argmax(cand, (k) => {
          const a = (phi[k] - tp) / dp;
          const b = (yy[k] - ty) / dy;
          return -(a * a + b * b);
        }),
      );
    }
  }
  return out;
}

/**
 * Pick real vertices to sample on a shell mesh. Grids, edges and corners come
 * from the mesh's most common sector only; other sectors add extremes only.
 *   barrel (tall): outer and inner wall grids over (φ, y), plus four corners.
 *   plate (flat): one grid over (φ, r).
 *   axisymmetric: extremes only, no grid or corners.
 */
function pickShellSamples(mesh: THREE.Mesh, axi: boolean): PickedShell {
  const pos = mesh.geometry.getAttribute("position");
  // `_opA.x` is the vertex's sector meridian t0.
  const t0Attr = mesh.geometry.getAttribute("_opA");
  const all = [...Array(pos.count).keys()];
  const phi: number[] = [];
  const yy: number[] = [];
  const rr: number[] = [];
  const sector: number[] = []; // per-vertex t0, bucketed
  const sectorCounts = new Map<number, number>();
  for (const i of all) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const t0 = t0Attr ? t0Attr.getX(i) : 0;
    phi.push(wrapPi(Math.atan2(z, x) - t0));
    yy.push(pos.getY(i));
    rr.push(Math.hypot(x, z));
    const key = Math.round(t0 * 1000);
    sector.push(key);
    sectorCounts.set(key, (sectorCounts.get(key) ?? 0) + 1);
  }
  const domKey = argmax([...sectorCounts], ([, c]) => c)[0];
  const dom = all.filter((i) => sector[i] === domKey);
  const rest = all.filter((i) => sector[i] !== domKey);
  const [rMin, rMax] = extent(dom, rr);
  const [yMin, yMax] = extent(dom, yy);
  const rSpan = rMax - rMin;
  const plate = rSpan > 2 * (yMax - yMin);

  const list: number[] = [];
  const at = new Map<number, number>();
  const add = (v: number) => {
    if (!at.has(v)) {
      at.set(v, list.length);
      list.push(v);
    }
    return at.get(v)!;
  };

  /** Add the max/min radius, y and phi vertices of `cand`. */
  const addExtremes = (cand: number[]) => {
    for (const val of [rr, yy, phi]) {
      add(argmax(cand, (i) => val[i]));
      add(argmax(cand, (i) => -val[i]));
    }
  };

  if (axi) {
    addExtremes(dom);
    if (rest.length) addExtremes(rest);
    return { verts: list, edges: [], corners: {} };
  }

  const edges: [number, number][] = [];
  const addGrid = (grid: number[], gu: number, gv: number) => {
    const idx = grid.map(add);
    for (let j = 0; j < gv; j++) {
      for (let i = 0; i < gu; i++) {
        const a = idx[j * gu + i];
        if (i + 1 < gu && a !== idx[j * gu + i + 1])
          edges.push([a, idx[j * gu + i + 1]]);
        if (j + 1 < gv && a !== idx[(j + 1) * gu + i])
          edges.push([a, idx[(j + 1) * gu + i]]);
      }
    }
  };

  let cornerDomain = dom;
  if (plate) {
    addGrid(gridPick(dom, phi, rr, 3, 3), 3, 3);
  } else {
    let outer = dom.filter((i) => rr[i] >= rMin + rSpan * 0.7);
    if (outer.length < 9) outer = dom;
    const inner =
      rSpan > 0.05 ? dom.filter((i) => rr[i] <= rMin + rSpan * 0.3) : [];
    addGrid(gridPick(outer, phi, yy, 3, 3), 3, 3);
    if (inner.length >= 4) addGrid(gridPick(inner, phi, yy, 3, 2), 3, 2);
    cornerDomain = outer;
  }

  // Corners: the vertex furthest along each diagonal of the (phi, y) box.
  const [pLo, pHi] = extent(cornerDomain, phi);
  const [yLo, yHi] = extent(cornerDomain, yy);
  const dp = pHi - pLo || 1;
  const dy = yHi - yLo || 1;
  const corners: Partial<Record<CornerLabel, number>> = {};
  for (const label of CORNER_LABELS) {
    const [sPhi, sY] = CORNER_SIGNS[label];
    corners[label] = add(
      argmax(
        cornerDomain,
        (i) =>
          sPhi * ((phi[i] - pLo) / dp - 0.5) + sY * ((yy[i] - yLo) / dy - 0.5),
      ),
    );
  }

  if (rest.length) addExtremes(rest);
  return { verts: list, edges, corners };
}

/** Sample a solid: its 8 bounding-box corners (not radius-eligible), its
 *  extreme vertices on each axis and in radius, and 4 evenly strided vertices. */
function pickSolidSamples(
  mesh: THREE.Mesh,
): { rest: Float32Array; eligible: boolean[] } | null {
  const pos = mesh.geometry.getAttribute("position");
  if (!pos || pos.count === 0) return null;
  const n = pos.count;
  const all = [...Array(n).keys()];
  const xs = all.map((i) => pos.getX(i));
  const ys = all.map((i) => pos.getY(i));
  const zs = all.map((i) => pos.getZ(i));
  const rs = all.map((i) => xs[i] * xs[i] + zs[i] * zs[i]);
  const pts: number[] = [];
  const eligible: boolean[] = [];
  for (const x of extent(all, xs))
    for (const y of extent(all, ys))
      for (const z of extent(all, zs)) {
        pts.push(x, y, z);
        eligible.push(false);
      }
  const seen = new Set<number>();
  const addVert = (i: number) => {
    if (seen.has(i)) return;
    seen.add(i);
    pts.push(xs[i], ys[i], zs[i]);
    eligible.push(true);
  };
  for (const val of [xs, ys, zs, rs]) {
    addVert(argmax(all, (i) => -val[i]));
    addVert(argmax(all, (i) => val[i]));
  }
  for (let k = 1; k <= 4; k++) addVert(Math.floor((n * k) / 5) % n);
  return { rest: new Float32Array(pts), eligible };
}

// --- the engine ---------------------------------------------------------------

interface Walk {
  /** [step][sample] xyz in the model frame (mm) */
  world: Float32Array;
  /** [sample] xyz rest pose, model frame */
  seated: Float32Array;
  /** shells only: probe-local positions, [row][probe column] */
  local: Float32Array;
  moved: boolean[];
  idle: IdleCheck;
}

export function createPathAnalysis(ctx: PathVizContext): PathAnalysis {
  const pieces: Piece[] = [];
  const excluded: string[] = [];
  const probeSamples: ProbeSample[] = [];

  ctx.model.updateWorldMatrix(true, true);
  const shellMeshes: THREE.Mesh[] = [];
  const solidMeshes: THREE.Mesh[] = [];
  ctx.model.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (let a: THREE.Object3D | null = o; a; a = a.parent) {
      if (isAccessory(a.name) || a.visible === false) {
        excluded.push(o.name || "(unnamed)");
        return;
      }
      if (a === ctx.model) break;
    }
    if (frameOf(o.geometry)) shellMeshes.push(o);
    else solidMeshes.push(o);
  });

  const names = new Set<string>();
  const uniqueName = (base: string) => {
    let name = base || "(unnamed)";
    for (let k = 2; names.has(name); k++) name = `${base}#${k}`;
    names.add(name);
    return name;
  };

  // Shells first, so a shell's sample index is also its probe column.
  for (const mesh of shellMeshes) {
    const frame = frameOf(mesh.geometry);
    const picked = pickShellSamples(mesh, frame?.axi === 1);
    const R = frame?.R ?? 0;
    pieces.push({
      name: uniqueName(mesh.name),
      kind: "shell",
      shell: mesh.name.replace(/_Seg\d+.*$/, "") || mesh.name,
      rank: frame ? frame.rank : 0.5,
      mesh,
      base: probeSamples.length,
      count: picked.verts.length,
      edges: picked.edges,
      corners: picked.corners,
      radiusEligible: picked.verts.map(() => true),
      rest: null,
      hashSign: Math.sign(fractN(R * 5.13) - 0.5) || 1,
    });
    for (const v of picked.verts) probeSamples.push({ mesh, vertex: v });
  }
  const probeCount = probeSamples.length;

  let base = probeCount;
  for (const mesh of solidMeshes) {
    const s = pickSolidSamples(mesh);
    if (!s) {
      excluded.push(`${mesh.name} (no geometry)`);
      continue;
    }
    pieces.push({
      name: uniqueName(mesh.name),
      kind: "solid",
      shell: mesh.name,
      rank: NaN, // set from the rest pose on the first walk
      mesh,
      base,
      count: s.eligible.length,
      edges: [],
      corners: {},
      radiusEligible: s.eligible,
      rest: s.rest,
      hashSign: 1,
    });
    base += s.eligible.length;
  }
  const totalSamples = base;

  // A solid's rank: its rest radius placed on the shells' radius range.
  const shellKeys = shellMeshes.map((m) =>
    Math.round((frameOf(m.geometry)?.R ?? 0) * 100),
  );
  const keyLo = shellKeys.length ? Math.min(...shellKeys) : 0;
  const keyHi = shellKeys.length ? Math.max(...shellKeys) : 1;
  const rankOfRadius = (rMm: number) =>
    Math.min(
      1,
      Math.max(0, (Math.round(rMm * 100) - keyLo) / Math.max(1, keyHi - keyLo)),
    );
  let solidsRanked = false;

  // One row per step plus a final rest-pose row.
  const IDLE_ROW = STEPS;
  const probe = createPositionProbe(ctx.renderer, probeSamples, STEPS + 1);
  let compiled = false;

  const channels = Object.keys(ctx.state).filter((k) => !k.endsWith("Target"));
  const state = ctx.state as unknown as Record<string, number>;

  const rootInv = new THREE.Matrix4();
  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();

  /** Reset every channel to its default, apply `anim` at p, and snap the
   *  channels to their targets. */
  function drive(p: number | null, anim: LensAnimation | null) {
    for (const c of channels) {
      const d = ctx.channelDefaults[c] ?? 0;
      state[c] = d;
      state[`${c}Target`] = d;
    }
    if (anim && p != null) anim.apply(p, ctx.state);
    for (const c of channels) state[c] = state[`${c}Target`];
    ctx.driveChannels();
    ctx.model.updateWorldMatrix(true, true);
  }

  function captureMatrices(): Float32Array {
    rootInv.copy(ctx.model.matrixWorld).invert();
    const out = new Float32Array(pieces.length * 16);
    pieces.forEach((piece, i) => {
      tmpM.multiplyMatrices(rootInv, piece.mesh.matrixWorld);
      tmpM.toArray(out, i * 16);
    });
    return out;
  }

  /** Write one row of model-frame positions from probe output / solid rests. */
  function composeRow(
    out: Float32Array,
    outOff: number,
    matrices: Float32Array,
    local: Float32Array,
    localRow: number,
  ) {
    pieces.forEach((piece, pi) => {
      tmpM.fromArray(matrices, pi * 16);
      for (let i = 0; i < piece.count; i++) {
        if (piece.kind === "shell")
          tmpV.fromArray(local, (localRow * probeCount + piece.base + i) * 3);
        else tmpV.fromArray(piece.rest!, i * 3);
        tmpV.applyMatrix4(tmpM).toArray(out, outOff + (piece.base + i) * 3);
      }
    });
  }

  // Never cached: the param sliders can retune an animation between calls.
  async function walk(anim: LensAnimation): Promise<Walk> {
    const snap = { ...state };
    const matrices: Float32Array[] = [];
    let local: Float32Array;
    try {
      if (!compiled) {
        await probe.compile();
        compiled = true;
      }
      probe.begin();
      for (let k = 0; k < STEPS; k++) {
        drive(PS[k], anim);
        matrices.push(captureMatrices());
        probe.renderRow(k);
      }
      // Rest pose: every channel at its default.
      drive(null, null);
      matrices.push(captureMatrices());
      probe.renderRow(IDLE_ROW);
      probe.end();
      local = await probe.read(STEPS + 1);
    } finally {
      Object.assign(state, snap);
      ctx.driveChannels();
      ctx.invalidate();
    }

    // Idle check: the probe's rest row must reproduce the rest geometry.
    const idlePerMesh = new Map<string, number>();
    let idleMax = 0;
    for (const piece of pieces) {
      if (piece.kind !== "shell") continue;
      let m = 0;
      for (let i = 0; i < piece.count; i++) {
        const o = (IDLE_ROW * probeCount + piece.base + i) * 3;
        const d = dist3(local, o, probe.seated, (piece.base + i) * 3);
        if (d > m) m = d;
      }
      idlePerMesh.set(piece.name, m);
      if (m > idleMax) idleMax = m;
    }
    const overTol = [...idlePerMesh.entries()]
      .filter(([, e]) => e > IDLE_TOL_MM)
      .map(([name, e]) => ({ name, errMm: r3(e) }));
    if (overTol.length) {
      console.error(
        `lens analysis: IDLE CHECK FAILED for ${overTol.length} mesh(es) — the probe does not ` +
          `reproduce the seated geometry where the graph is contractually an identity. ` +
          `Do not trust this walk's numbers.`,
        overTol,
      );
    }

    const world = new Float32Array(STEPS * totalSamples * 3);
    for (let k = 0; k < STEPS; k++)
      composeRow(world, k * totalSamples * 3, matrices[k], local, k);
    const seated = new Float32Array(totalSamples * 3);
    composeRow(seated, 0, matrices[STEPS], local, IDLE_ROW);

    if (!solidsRanked) {
      for (const piece of pieces) {
        if (piece.kind !== "solid") continue;
        let rMax = 0;
        for (let i = 0; i < piece.count; i++) {
          const o = (piece.base + i) * 3;
          const r = Math.hypot(seated[o], seated[o + 2]);
          if (r > rMax) rMax = r;
        }
        piece.rank = rankOfRadius(rMax);
      }
      solidsRanked = true;
    }

    const moved = pieces.map((piece) => {
      for (let k = 1; k < STEPS; k++) {
        for (let i = 0; i < piece.count; i++) {
          const o0 = (piece.base + i) * 3;
          if (dist3(world, k * totalSamples * 3 + o0, world, o0) > MOVE_TOL_MM)
            return true;
        }
      }
      return false;
    });

    return {
      world,
      seated,
      local,
      moved,
      idle: { maxErrMm: r3(idleMax), overTol },
    };
  }

  const coverageOf = (w: Walk): Coverage => ({
    sampledMeshes: pieces.length,
    totalMovingMeshes: w.moved.filter(Boolean).length,
    excluded: [...new Set(excluded)],
  });

  // --- per-piece math ---------------------------------------------------------

  interface PieceSeries {
    centroid: [number, number, number][];
    cyl: [number, number, number][];
    minR: number[];
    maxR: number[];
    yMin: number[];
    yMax: number[];
    /** per step: furthest sample distance from its rest position (mm) */
    flight: number[];
  }

  function pieceSeries(w: Walk, piece: Piece): PieceSeries {
    const centroid: [number, number, number][] = [];
    const cyl: [number, number, number][] = [];
    const minR: number[] = [];
    const maxR: number[] = [];
    const yMin: number[] = [];
    const yMax: number[] = [];
    const flight: number[] = [];
    let prevTheta: number | null = null;
    for (let k = 0; k < STEPS; k++) {
      let cx = 0,
        cy = 0,
        cz = 0,
        rLo = Infinity,
        rHi = -Infinity,
        yLo = Infinity,
        yHi = -Infinity,
        fl = 0;
      for (let i = 0; i < piece.count; i++) {
        const s = (piece.base + i) * 3;
        const o = k * totalSamples * 3 + s;
        const [x, y, z] = w.world.subarray(o, o + 3);
        cx += x;
        cy += y;
        cz += z;
        if (piece.radiusEligible[i]) {
          const r = Math.hypot(x, z);
          if (r < rLo) rLo = r;
          if (r > rHi) rHi = r;
        }
        if (y < yLo) yLo = y;
        if (y > yHi) yHi = y;
        const d = dist3(w.world, o, w.seated, s);
        if (d > fl) fl = d;
      }
      cx /= piece.count;
      cy /= piece.count;
      cz /= piece.count;
      centroid.push([cx, cy, cz]);
      const rC = Math.hypot(cx, cz);
      let th = Math.atan2(cz, cx);
      if (prevTheta != null) {
        while (th - prevTheta > Math.PI) th -= 2 * Math.PI;
        while (th - prevTheta < -Math.PI) th += 2 * Math.PI;
      }
      prevTheta = th;
      cyl.push([rC, th, cy]);
      minR.push(rLo === Infinity ? rC : rLo);
      maxR.push(rHi === -Infinity ? rC : rHi);
      yMin.push(yLo);
      yMax.push(yHi);
      flight.push(fl);
    }
    return { centroid, cyl, minR, maxR, yMin, yMax, flight };
  }

  /** Outward excursions: rises of more than REVERSAL_EPS_MM off the last
   *  trough that fall back by as much. A rise still open at the end is not
   *  counted. */
  function reversalsOf(series: number[]): ReversalStructure {
    const events: ReversalStructure["events"] = [];
    let trough = series[0];
    let peak = -Infinity;
    let peakIdx = 0;
    let rising = false;
    for (let k = 1; k < series.length; k++) {
      const v = series[k];
      if (!rising) {
        if (v < trough) trough = v;
        if (v > trough + REVERSAL_EPS_MM) {
          rising = true;
          peak = v;
          peakIdx = k;
        }
      } else {
        if (v > peak) {
          peak = v;
          peakIdx = k;
        }
        if (v < peak - REVERSAL_EPS_MM) {
          events.push({ p: r3(PS[peakIdx]), amplitudeMm: r2(peak - trough) });
          rising = false;
          trough = v;
        }
      }
    }
    return { count: events.length, events };
  }

  function peakStretchOf(w: Walk, piece: Piece): number | null {
    if (piece.kind !== "shell" || piece.edges.length === 0) return null;
    const rest = piece.edges.map(([a, b]) =>
      dist3(
        probe.seated,
        (piece.base + a) * 3,
        probe.seated,
        (piece.base + b) * 3,
      ),
    );
    let peak = 1;
    for (let k = 0; k < STEPS; k++) {
      piece.edges.forEach(([a, b], e) => {
        if (rest[e] < STRETCH_MIN_EDGE_MM) return;
        const row = k * probeCount + piece.base;
        const ratio =
          dist3(w.local, (row + a) * 3, w.local, (row + b) * 3) / rest[e];
        if (Math.abs(ratio - 1) > Math.abs(peak - 1)) peak = ratio;
      });
    }
    return r3(peak);
  }

  /** The first p after the piece's last step off its seat (0 = never moved). */
  function seatedAtPOf(flight: number[]): number {
    const last = flight.length - 1;
    for (let k = last; k >= 0; k--) {
      if (flight[k] > SEAT_TOL_MM) return r3(PS[Math.min(k + 1, last)]);
    }
    return 0;
  }

  function pieceReport(
    w: Walk,
    piece: Piece,
    series: PieceSeries,
    withTimeline: boolean,
  ): PieceReport {
    let len = 0;
    for (let k = 1; k < series.centroid.length; k++) {
      const [ax, ay, az] = series.centroid[k - 1];
      const [bx, by, bz] = series.centroid[k];
      len += Math.hypot(bx - ax, by - ay, bz - az);
    }
    const rep: PieceReport = {
      name: piece.name,
      kind: piece.kind,
      shell: piece.shell,
      rank: r3(piece.rank),
      sampleCount: piece.count,
      peakStretch: peakStretchOf(w, piece),
      pathLengthMm: r2(len),
      seatedAtP: seatedAtPOf(series.flight),
      reversals: reversalsOf(series.minR),
    };
    if (withTimeline) {
      rep.timeline = {
        centroid: series.centroid.map(
          ([x, y, z]) => [r2(x), r2(y), r2(z)] as [number, number, number],
        ),
        cyl: series.cyl.map(
          ([r, th, y]) => [r2(r), r3(th), r2(y)] as [number, number, number],
        ),
        minR: series.minR.map(r2),
        maxR: series.maxR.map(r2),
      };
    }
    return rep;
  }

  const seriesOf = (w: Walk) =>
    new Map(pieces.map((piece) => [piece, pieceSeries(w, piece)]));

  /** `list` grouped by rank (to 3 decimals), inner to outer. */
  function byRank(list: Piece[]): Piece[][] {
    const groups = Map.groupBy(list, (piece) => piece.rank.toFixed(3));
    return [...groups.values()].sort((a, b) => a[0].rank - b[0].rank);
  }

  /** Shell pieces grouped by rank, with each group's radial envelope. */
  function rankTable(seriesByPiece: Map<Piece, PieceSeries>): RankReport[] {
    return byRank(pieces.filter((p) => p.kind === "shell")).map((group) => {
      const minR: number[] = [];
      const maxR: number[] = [];
      for (let k = 0; k < STEPS; k++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const piece of group) {
          const s = seriesByPiece.get(piece)!;
          if (s.minR[k] < lo) lo = s.minR[k];
          if (s.maxR[k] > hi) hi = s.maxR[k];
        }
        minR.push(lo);
        maxR.push(hi);
      }
      return {
        rank: r3(group[0].rank),
        shells: [...new Set(group.map((p) => p.shell))],
        pieces: group.length,
        minR: minR.map(r2),
        maxR: maxR.map(r2),
        reversals: reversalsOf(minR),
      };
    });
  }

  function findAnim(id: string): LensAnimation {
    const anim = ANIMATIONS.find((a) => a.id === id);
    if (!anim)
      throw new Error(
        `no animation "${id}" — have: ${ANIMATIONS.map((a) => a.id).join(", ")}`,
      );
    return anim;
  }

  // --- API --------------------------------------------------------------------

  async function analyze(
    animId: string,
    opts: { timeline?: boolean } = {},
  ): Promise<AnalysisResult> {
    const w = await walk(findAnim(animId));
    const seriesByPiece = seriesOf(w);
    return {
      anim: animId,
      steps: STEPS,
      coverage: coverageOf(w),
      idleCheck: w.idle,
      pieces: pieces.map((piece) =>
        pieceReport(
          w,
          piece,
          seriesByPiece.get(piece)!,
          opts.timeline !== false,
        ),
      ),
      ranks: rankTable(seriesByPiece),
    };
  }

  async function compare(idA: string, idB: string): Promise<CompareResult> {
    const wA = await walk(findAnim(idA));
    const wB = await walk(findAnim(idB));
    const perPiece = pieces.map((piece) => {
      let maxD = 0;
      let atK = 0;
      let sum = 0;
      for (let k = 0; k < STEPS; k++) {
        let stepMax = 0;
        for (let i = 0; i < piece.count; i++) {
          const o = (k * totalSamples + piece.base + i) * 3;
          const d = dist3(wA.world, o, wB.world, o);
          if (d > stepMax) stepMax = d;
        }
        if (stepMax > maxD) {
          maxD = stepMax;
          atK = k;
        }
        sum += stepMax;
      }
      return {
        name: piece.name,
        kind: piece.kind,
        rank: r3(piece.rank),
        maxDivergenceMm: r2(maxD),
        atP: r3(PS[atK]),
        meanDivergenceMm: r2(sum / STEPS),
      };
    });
    perPiece.sort((a, b) => b.maxDivergenceMm - a.maxDivergenceMm);
    const envelope = (w: Walk) =>
      rankTable(seriesOf(w)).map(({ rank, minR, maxR }) => ({
        rank,
        minR,
        maxR,
      }));
    return {
      a: idA,
      b: idB,
      steps: STEPS,
      coverage: coverageOf(wA),
      idleCheck: { a: wA.idle, b: wB.idle },
      pieces: perPiece,
      rankEnvelopes: { a: envelope(wA), b: envelope(wB) },
    };
  }

  async function interference(animId: string): Promise<InterferenceResult> {
    const w = await walk(findAnim(animId));
    const seriesByPiece = seriesOf(w);
    const ordered = byRank(pieces);

    // Per step, the radial overlap of each adjacent-rank pair (NaN = none).
    const pairs: { inner: Piece; outer: Piece; overlap: number[] }[] = [];
    for (let g = 0; g + 1 < ordered.length; g++) {
      for (const inner of ordered[g]) {
        const si = seriesByPiece.get(inner)!;
        for (const outer of ordered[g + 1]) {
          const so = seriesByPiece.get(outer)!;
          const overlap = PS.map((_, k) => {
            const radial = si.maxR[k] - so.minR[k];
            const inFlight =
              si.flight[k] > SEAT_TOL_MM && so.flight[k] > SEAT_TOL_MM;
            const yOverlap =
              Math.min(si.yMax[k], so.yMax[k]) -
              Math.max(si.yMin[k], so.yMin[k]);
            return radial > 0 && inFlight && yOverlap > 0 ? radial : NaN;
          });
          if (overlap.some((v) => !Number.isNaN(v)))
            pairs.push({ inner, outer, overlap });
        }
      }
    }

    /** A piece's [min, max] radius at rest. */
    const seatedBand = (piece: Piece) => {
      const r = Array.from({ length: piece.count }, (_, i) =>
        Math.hypot(
          w.seated[(piece.base + i) * 3],
          w.seated[(piece.base + i) * 3 + 2],
        ),
      );
      return extent(
        r.flatMap((_, i) => (piece.radiusEligible[i] ? [i] : [])),
        r,
      );
    };

    const result: InterferencePair[] = pairs.map(
      ({ inner, outer, overlap }) => {
        const seatedOverlap = seatedBand(inner)[1] - seatedBand(outer)[0];
        const ranges: { p0: number; p1: number; maxOverlapMm: number }[] = [];
        let start = -1;
        let runMax = 0;
        let allMax = 0;
        for (let k = 0; k <= STEPS; k++) {
          const v = k < STEPS ? overlap[k] : NaN;
          if (!Number.isNaN(v)) {
            if (start < 0) {
              start = k;
              runMax = 0;
            }
            if (v > runMax) runMax = v;
            if (v > allMax) allMax = v;
          } else if (start >= 0) {
            ranges.push({
              p0: r3(PS[start]),
              p1: r3(PS[k - 1]),
              maxOverlapMm: r2(runMax),
            });
            start = -1;
          }
        }
        return {
          inner: inner.name,
          outer: outer.name,
          rankInner: r3(inner.rank),
          rankOuter: r3(outer.rank),
          maxOverlapMm: r2(allMax),
          seatedOverlapMm: r2(seatedOverlap),
          maxExcessMm: r2(allMax - Math.max(0, seatedOverlap)),
          ranges,
        };
      },
    );
    result.sort((a, b) => b.maxExcessMm - a.maxExcessMm);
    return {
      anim: animId,
      steps: STEPS,
      coverage: coverageOf(w),
      idleCheck: w.idle,
      pairs: result,
    };
  }

  async function curlCorners(
    idA = "assemble",
    idB = "x-rose",
  ): Promise<CurlCornerResult> {
    const wA = await walk(findAnim(idA));
    const wB = await walk(findAnim(idB));

    const cornersOf = (w: Walk, piece: Piece): WedgeCorners => {
      const lastOffP: Partial<Record<CornerLabel, number>> = {};
      const exact: Partial<Record<CornerLabel, number>> = {};
      const present = CORNER_LABELS.filter(
        (l) => piece.corners[l] !== undefined,
      );
      // Each corner's radial distance off its rest radius, per step.
      const lift = new Map<CornerLabel, Float64Array>();
      for (const label of present) {
        const i = piece.corners[label]!;
        const s = (piece.base + i) * 3;
        const rSeat = Math.hypot(w.seated[s], w.seated[s + 2]);
        const arr = new Float64Array(STEPS);
        for (let k = 0; k < STEPS; k++) {
          const o = (k * totalSamples + piece.base + i) * 3;
          arr[k] = Math.abs(Math.hypot(w.world[o], w.world[o + 2]) - rSeat);
        }
        lift.set(label, arr);
      }
      // Lift relative to the lowest corner at the same step.
      const floor = new Float64Array(STEPS).fill(Infinity);
      for (const arr of lift.values())
        for (let k = 0; k < STEPS; k++)
          if (arr[k] < floor[k]) floor[k] = arr[k];
      for (const label of present) {
        const arr = lift.get(label)!;
        const excess = (k: number) => arr[k] - floor[k];
        // The last lifted step, interpolated to where it crosses the threshold.
        let p = 0;
        for (let k = STEPS - 1; k >= 0; k--) {
          const d = excess(k);
          if (d > CORNER_TOL_MM) {
            if (k === STEPS - 1) p = PS[k];
            else {
              const dNext = excess(k + 1);
              const f = (d - CORNER_TOL_MM) / Math.max(1e-9, d - dNext);
              p = PS[k] + f * (PS[k + 1] - PS[k]);
            }
            break;
          }
        }
        exact[label] = p;
        lastOffP[label] = Math.round(p * 10000) / 10000;
      }
      const entries = Object.entries(exact) as [CornerLabel, number][];
      entries.sort((a, b) => a[1] - b[1]);
      const spread = entries[entries.length - 1][1] - entries[0][1];
      // Average the two corners on each side so the arc and axial leads are
      // read separately.
      const mean = (labels: CornerLabel[]) => {
        const vals = labels
          .map((l) => exact[l])
          .filter((v): v is number => v !== undefined);
        return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
      };
      const TIE = 0.0005;
      const lead = <A, B>(lo: number, hi: number, loName: A, hiName: B) =>
        Math.abs(lo - hi) < TIE ? "tie" : lo < hi ? loName : hiName;
      let farSkew: { mm: number; atP: number } | null = null;
      const ff = lift.get("far-front");
      const fr = lift.get("far-rear");
      if (ff && fr) {
        let best = 0;
        let atK = 0;
        for (let k = 0; k < STEPS; k++) {
          const d = ff[k] - fr[k];
          if (Math.abs(d) > Math.abs(best)) {
            best = d;
            atK = k;
          }
        }
        farSkew = { mm: r2(best), atP: r3(PS[atK]) };
      }
      return {
        lastOffP,
        farSkew,
        leading: spread < TIE ? "tie" : entries[0][0],
        trailing: spread < TIE ? "tie" : entries[entries.length - 1][0],
        arcLead: lead(
          mean(["seam-front", "seam-rear"]),
          mean(["far-front", "far-rear"]),
          "seam",
          "far",
        ),
        axialLead: lead(
          mean(["seam-front", "far-front"]),
          mean(["seam-rear", "far-rear"]),
          "front",
          "rear",
        ),
      };
    };

    const wedges = pieces
      .filter((p) => p.kind === "shell" && /_Seg\d+/.test(p.name))
      .map((piece) => ({
        name: piece.name,
        shell: piece.shell,
        rank: r3(piece.rank),
        hashSign: piece.hashSign,
        a: cornersOf(wA, piece),
        b: cornersOf(wB, piece),
      }));

    const shells = Map.groupBy(wedges, (wd) => wd.shell);
    const majority = <T extends string>(labels: T[]): T | "mixed" => {
      const counts = new Map<T, number>();
      for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return best[1] > labels.length / 2 ? best[0] : "mixed";
    };
    const shellRows = [...shells.entries()]
      .map(([shell, list]) => {
        const aAxialLead = majority(list.map((w) => w.a.axialLead));
        const bAxialLead = majority(list.map((w) => w.b.axialLead));
        const decisive = (l: string) => l === "front" || l === "rear";
        return {
          shell,
          rank: list[0].rank,
          hashSign: list[0].hashSign,
          aLeading: majority(list.map((w) => w.a.leading)),
          bLeading: majority(list.map((w) => w.b.leading)),
          aAxialLead,
          bAxialLead,
          axialMirrored:
            decisive(aAxialLead) && decisive(bAxialLead)
              ? aAxialLead !== bAxialLead
              : null,
        };
      })
      .sort((a, b) => a.rank - b.rank);

    return {
      a: idA,
      b: idB,
      steps: STEPS,
      coverage: coverageOf(wA),
      wedges,
      shells: shellRows,
    };
  }

  return {
    analyze,
    compare,
    interference,
    curlCorners,
    dispose: () => probe.dispose(),
  };
}
