import * as THREE from "three/webgpu";
import { ANIMATIONS, type LensAnimation } from "../animations";
import { isAccessory } from "../core/parts";
import { frameOf } from "../ops/frames";
import {
  createPositionProbe,
  type PositionProbe,
  type ProbeSample,
} from "./path-probe";
import type { PathVizContext } from "./paths";

// Dev only — dynamically imported. The queryable side of the motion-path
// instrument: dev/paths.ts draws, this module measures and returns JSON.
//
// Two sample populations, one walk:
//   SHELLS — every mesh carrying the derived `_op*` frame, sampled through the
//            GPU probe running the real opsLocalPosition() graph.
//   SOLIDS — every mesh without one. Such a mesh cannot deform in shader, so
//            its rest samples transformed by the same per-step matrixWorld are
//            ground truth. The op host frames every mesh, so this population is
//            normally empty and the branch inert.
//
// Every reported position is in the model frame — optical axis Y, radial plane
// X–Z, units real millimetres. Every result carries `coverage` and `idleCheck`
// (the per-mesh version of paths.ts's idle-identity check).

const STEPS = 96;
/** A piece is "in flight" while any sample sits further than this off its seat. */
const SEAT_TOL_MM = 1;
/** Curl-corner threshold, on the corner's relative radial lift: its lift off
 *  the seated radius minus the smallest lift among the piece's four corners at
 *  the same step. Subtracting the per-step minimum cancels the piece-uniform
 *  terms, leaving the peel-front/roll geometry. */
const CORNER_TOL_MM = 1;
/** Minimum rise of the min-radius series that counts as an outward excursion. */
const REVERSAL_EPS_MM = 0.5;
const IDLE_TOL_MM = 0.01;
/** Movement threshold: a mesh whose samples never leave a 0.01mm ball is static. */
const MOVE_TOL_MM = 0.01;
/** Grid edges shorter than this at rest are excluded from the stretch metric. */
const STRETCH_MIN_EDGE_MM = 1.5;

/** Corner naming: seam = the peel/wrap seam edge. The house winding sense is
 *  −1, so every construction hinges at θ0 + halfSpan — the wedge-local +φ side.
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

type Channel = string;

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const fractN = (x: number) => x - Math.floor(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pOf = (k: number) => k / (STEPS - 1);
/** The default full-scrub walk grid. Every walk carries its own `ps` (the p
 *  value of each step row) so a windowed walk can reuse the same engine. */
const DEFAULT_PS: number[] = Array.from({ length: STEPS }, (_, k) => pOf(k));

// --- result shapes (all plain JSON) -----------------------------------------

export interface Coverage {
  sampledMeshes: number;
  totalMovingMeshes: number;
  excluded: string[];
}

export interface IdleCheck {
  maxErrMm: number;
  /** meshes whose seated-row probe error exceeds the idle tolerance */
  overTol: { name: string; errMm: number }[];
}

export interface ReversalStructure {
  count: number;
  /** each outward excursion of the min-radius series: where it peaked (p) and
   *  how far it rose off the preceding trough (mm) */
  events: { p: number; amplitudeMm: number }[];
}

export interface PieceReport {
  name: string;
  kind: "shell" | "solid";
  /** shell group (wedge prefix) for shells; own name for solids */
  shell: string;
  rank: number;
  sampleCount: number;
  /** peak grid-edge stretch ratio over the walk (shells only; 1 = no stretch) */
  peakStretch: number | null;
  /** centroid path length over the walk, mm */
  pathLengthMm: number;
  /** last p at which any sample is > SEAT_TOL_MM off its seat (0 = never) */
  seatedAtP: number;
  reversals: ReversalStructure;
  timeline?: {
    /** per step: centroid in model frame, mm */
    centroid: [number, number, number][];
    /** per step: centroid cylindrical [r, unwrapped theta, y] */
    cyl: [number, number, number][];
    minR: number[];
    maxR: number[];
  };
}

export interface RankReport {
  rank: number;
  shells: string[];
  pieces: number;
  /** min over the rank's pieces of min-radius, per step (mm) */
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
    /** p at which the max divergence occurs */
    atP: number;
    meanDivergenceMm: number;
  }[];
  /** shell ranks only: per-rank radial envelope timeline for both walks */
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
  /** the pair's radial band overlap in the seated pose — many adjacent shells
   *  nest at rest (walls interleave), which is overlap but not a defect */
  seatedOverlapMm: number;
  /** max of (in-flight overlap − seated overlap): how much more the bands
   *  interpenetrate in flight than in their natural nesting — the sort key */
  maxExcessMm: number;
  ranges: { p0: number; p1: number; maxOverlapMm: number }[];
}

export interface InterferenceResult {
  anim: string;
  steps: number;
  coverage: Coverage;
  idleCheck: IdleCheck;
  /** adjacent-seat-rank piece pairs whose radial bands overlap while both are
   *  in flight and their axial (y) bands overlap; sorted by maxExcessMm */
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
    /** per animation: each corner's last-off-seat p, plus the leading corner
     *  (seats first ⇒ departs the seat last ⇒ leads the stick) and the
     *  trailing corner (seats last) */
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
    /** do the axial leads sit at opposite ends in the two animations? */
    axialMirrored: boolean | null;
  }[];
}

interface WedgeCorners {
  /** per corner: the last p at which its radial lift exceeds the piece's
   *  most-seated corner by CORNER_TOL_MM, interpolated between steps */
  lastOffP: Partial<Record<CornerLabel, number>>;
  leading: CornerLabel | "tie";
  trailing: CornerLabel | "tie";
  /** arc dimension alone: does the seam side or the far side seat first? */
  arcLead: "seam" | "far" | "tie";
  /** axial dimension alone (the shear question): front or rear end first? */
  axialLead: "front" | "rear" | "tie";
  /** mid-flight shear signature: (far-front lift − far-rear lift) at its
   *  largest magnitude over the walk. Positive = the front end hangs further
   *  off the surface. */
  farSkew: { mm: number; atP: number } | null;
}

export interface PathAnalysis {
  analyze(
    animId: string,
    opts?: { timeline?: boolean },
  ): Promise<AnalysisResult>;
  compare(idA: string, idB: string): Promise<CompareResult>;
  interference(animId: string): Promise<InterferenceResult>;
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
  /** offset of this piece's first sample in the unified sample space */
  base: number;
  count: number;
  /** shells: [a, b] local pairs (offsets within the piece) of grid edges */
  edges: [number, number][];
  /** shells: corner label → local sample offset */
  corners: Partial<Record<CornerLabel, number>>;
  /** per local sample: counts toward the radial band (solids' synthesized AABB
   *  corners overstate the band of a round part, so they are excluded) */
  radiusEligible: boolean[];
  /** solids: rest local positions, xyz-packed */
  rest: Float32Array | null;
  /** shells: sign(fract(R·5.13) − 0.5) — the shear-hash both deforms share */
  hashSign: number;
}

interface PickedShell {
  verts: number[];
  edges: [number, number][];
  corners: Partial<Record<CornerLabel, number>>;
}

/** Nearest-real-vertex parametric grid over (phi, y) — the existing paths.ts
 *  picker generalized to any grid size and candidate set. */
function gridPick(
  cand: number[],
  phi: number[],
  yy: number[],
  gu: number,
  gv: number,
): number[] {
  let p0 = Infinity;
  let p1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const i of cand) {
    if (phi[i] < p0) p0 = phi[i];
    if (phi[i] > p1) p1 = phi[i];
    if (yy[i] < y0) y0 = yy[i];
    if (yy[i] > y1) y1 = yy[i];
  }
  const dp = p1 - p0 || 1;
  const dy = y1 - y0 || 1;
  const out: number[] = [];
  for (let j = 0; j < gv; j++) {
    for (let i = 0; i < gu; i++) {
      const tp = p0 + (dp * i) / Math.max(1, gu - 1);
      const ty = y0 + (dy * j) / Math.max(1, gv - 1);
      let best = cand[0];
      let bd = Infinity;
      for (const k of cand) {
        const a = (phi[k] - tp) / dp;
        const b = (yy[k] - ty) / dy;
        const d = a * a + b * b;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      out.push(best);
    }
  }
  return out;
}

/**
 * Sample a shell mesh. Grids/edges/corners live in the mesh's dominant sector
 * only: an edge across sectors would measure the sectors flying apart rather
 * than the mesh stretching. Modes:
 *   BARREL (axial span dominates): outer- + inner-wall grids over (φ, y), plus
 *     the four (seam/far × front/rear) corner vertices.
 *   PLATE (radial span dominates — PCB discs, baffle plates): one grid over
 *     (φ, r); the (φ, y) grid degenerates to thickness-length edges there.
 *   AXISYMMETRIC (rings, tubes, discs): no grid and no corners, extremes only.
 *     Their (φ, y) box spans the whole ±π turn, so every grid edge is a chord.
 * Non-dominant sectors still contribute edge-less extreme samples. Real
 * vertices only.
 */
function pickShellSamples(mesh: THREE.Mesh, axi: boolean): PickedShell {
  const pos = mesh.geometry.getAttribute("position");
  // The packed frame lane read directly (not via frameOf): this walks every
  // vertex of the mesh and wants exactly one field, `_opA.x` = t0.
  const t0Attr = mesh.geometry.getAttribute("_opA");
  const n = pos.count;
  const phi = new Array<number>(n);
  const yy = new Array<number>(n);
  const rr = new Array<number>(n);
  const sector = new Array<number>(n); // per-vertex t0, bucketed
  const sectorCounts = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Not negated: the frame's t0 is the sector meridian as measured.
    const t0 = t0Attr ? t0Attr.getX(i) : 0;
    phi[i] = wrapPi(Math.atan2(z, x) - t0);
    yy[i] = y;
    rr[i] = Math.hypot(x, z);
    const key = Math.round(t0 * 1000);
    sector[i] = key;
    sectorCounts.set(key, (sectorCounts.get(key) ?? 0) + 1);
  }
  const domKey = [...sectorCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const dom: number[] = [];
  const rest: number[] = [];
  for (let i = 0; i < n; i++) (sector[i] === domKey ? dom : rest).push(i);

  let rMin = Infinity;
  let rMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const i of dom) {
    if (rr[i] < rMin) rMin = rr[i];
    if (rr[i] > rMax) rMax = rr[i];
    if (yy[i] < yMin) yMin = yy[i];
    if (yy[i] > yMax) yMax = yy[i];
  }
  const rSpan = rMax - rMin;
  const ySpan = yMax - yMin;
  const plate = rSpan > 2 * ySpan;

  const list: number[] = [];
  const at = new Map<number, number>();
  const add = (v: number) => {
    let i = at.get(v);
    if (i === undefined) {
      i = list.length;
      list.push(v);
      at.set(v, i);
    }
    return i;
  };

  /** Edge-less extreme samples over a candidate set (the six radial / axial /
   *  arc extremes), appended to the sample list. */
  const addExtremes = (cand: number[]) => {
    const pick = (score: (i: number) => number) => {
      let best = cand[0];
      let bs = -Infinity;
      for (const i of cand) {
        const s = score(i);
        if (s > bs) {
          bs = s;
          best = i;
        }
      }
      add(best);
    };
    pick((i) => rr[i]);
    pick((i) => -rr[i]);
    pick((i) => yy[i]);
    pick((i) => -yy[i]);
    pick((i) => phi[i]);
    pick((i) => -phi[i]);
  };

  // Axisymmetric pieces take that path for the whole mesh: no edges means no
  // stretch ratio and no corners means no roll remainder.
  if (axi) {
    addExtremes(dom);
    if (rest.length) addExtremes(rest);
    return { verts: list, edges: [], corners: {} };
  }

  const edges: [number, number][] = [];
  const gridEdges = (grid: number[], gu: number, gv: number) => {
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

  let cornerDomain: number[];
  if (plate) {
    gridEdges(gridPick(dom, phi, rr, 3, 3), 3, 3);
    cornerDomain = dom;
  } else {
    let outer = dom.filter((i) => rr[i] >= rMin + rSpan * 0.7);
    if (outer.length < 9) outer = dom;
    const inner =
      rSpan > 0.05 ? dom.filter((i) => rr[i] <= rMin + rSpan * 0.3) : [];
    gridEdges(gridPick(outer, phi, yy, 3, 3), 3, 3);
    if (inner.length >= 4) gridEdges(gridPick(inner, phi, yy, 3, 2), 3, 2);
    cornerDomain = outer;
  }

  // corners: extremes of the (phi, y) box, scored on the normalized diagonal
  // so a jagged cut edge still yields the right corner
  let pLo = Infinity;
  let pHi = -Infinity;
  let yLo = Infinity;
  let yHi = -Infinity;
  for (const i of cornerDomain) {
    if (phi[i] < pLo) pLo = phi[i];
    if (phi[i] > pHi) pHi = phi[i];
    if (yy[i] < yLo) yLo = yy[i];
    if (yy[i] > yHi) yHi = yy[i];
  }
  const dp = pHi - pLo || 1;
  const dy = yHi - yLo || 1;
  const corners: Partial<Record<CornerLabel, number>> = {};
  for (const label of CORNER_LABELS) {
    const [sPhi, sY] = CORNER_SIGNS[label];
    let best = cornerDomain[0];
    let bs = -Infinity;
    for (const i of cornerDomain) {
      const score =
        sPhi * ((phi[i] - pLo) / dp - 0.5) + sY * ((yy[i] - yLo) / dy - 0.5);
      if (score > bs) {
        bs = score;
        best = i;
      }
    }
    corners[label] = add(best);
  }

  // other sectors: edge-less extreme samples so bands/centroids see the whole
  // mesh even when islands ride different wedges
  if (rest.length) addExtremes(rest);
  return { verts: list, edges, corners };
}

/** Sample a solid: the 8 geometry-AABB corners (synthesized, excluded from
 *  radial bands) plus real extreme vertices (±x, ±y, ±z, min/max radius) and a
 *  few strided surface picks. */
function pickSolidSamples(
  mesh: THREE.Mesh,
): { rest: Float32Array; eligible: boolean[] } | null {
  const pos = mesh.geometry.getAttribute("position");
  if (!pos || pos.count === 0) return null;
  const n = pos.count;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  const arg = {
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0,
    minZ: 0,
    maxZ: 0,
    minR: 0,
    maxR: 0,
  };
  let minR = Infinity;
  let maxR = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (x < minX) ((minX = x), (arg.minX = i));
    if (x > maxX) ((maxX = x), (arg.maxX = i));
    if (y < minY) ((minY = y), (arg.minY = i));
    if (y > maxY) ((maxY = y), (arg.maxY = i));
    if (z < minZ) ((minZ = z), (arg.minZ = i));
    if (z > maxZ) ((maxZ = z), (arg.maxZ = i));
    const r = x * x + z * z;
    if (r < minR) ((minR = r), (arg.minR = i));
    if (r > maxR) ((maxR = r), (arg.maxR = i));
  }
  const pts: number[] = [];
  const eligible: boolean[] = [];
  for (const x of [minX, maxX])
    for (const y of [minY, maxY])
      for (const z of [minZ, maxZ]) {
        pts.push(x, y, z);
        eligible.push(false);
      }
  const seen = new Set<number>();
  const addVert = (i: number) => {
    if (seen.has(i)) return;
    seen.add(i);
    pts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    eligible.push(true);
  };
  for (const i of Object.values(arg)) addVert(i);
  for (let k = 1; k <= 4; k++) addVert(Math.floor((n * k) / 5) % n);
  return { rest: new Float32Array(pts), eligible };
}

// --- the engine ---------------------------------------------------------------

interface Walk {
  anim: LensAnimation;
  /** the p value of each step row (DEFAULT_PS for full-scrub walks) */
  ps: number[];
  /** [step][sample] xyz in the model frame (mm) */
  world: Float32Array;
  /** [sample] xyz seated pose, model frame */
  seated: Float32Array;
  /** shells only: probe-local positions, [row][probe column] (for stretch) */
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

  // shells first so unified sample offsets coincide with probe columns
  for (const mesh of shellMeshes) {
    // Non-null by construction: shellMeshes is exactly the frame-carrying set.
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
      // Filled in on the first walk, in the model frame: a world-space box
      // read into a table keyed in model millimetres would clamp every solid
      // to rank 0.
      rank: NaN,
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

  // Solid seat ranks, on the shader's own law but computed in the model frame.
  // The radius comes from the first walk's seated pose, so this is deferred
  // until one exists.
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

  // One probe per row count. All probes share the sample list, so their
  // CPU-built `seated` arrays are identical and the default `probe` stays the
  // single rest-geometry reference.
  interface ProbeEntry {
    probe: PositionProbe;
    compiled: boolean;
  }
  const probes = new Map<number, ProbeEntry>();
  const probeFor = (rows: number): ProbeEntry => {
    let e = probes.get(rows);
    if (!e) {
      e = {
        probe: createPositionProbe(ctx.renderer, probeSamples, rows),
        compiled: false,
      };
      probes.set(rows, e);
    }
    return e;
  };
  const probe = probeFor(STEPS + 1).probe;

  const channels = Object.keys(ctx.state).filter(
    (k) => !k.endsWith("Target"),
  ) as Channel[];
  const state = ctx.state as unknown as Record<string, number>;

  const rootInv = new THREE.Matrix4();
  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();

  /** Drive the whole rig to the walk's neutral base (registry defaults), then
   *  let `mutate` set targets before values are committed. */
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

  /** Compose one row of model-frame positions from probe locals / solid rests. */
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
        if (piece.kind === "shell") {
          const o = (localRow * probeCount + piece.base + i) * 3;
          tmpV.set(local[o], local[o + 1], local[o + 2]);
        } else {
          tmpV.set(
            piece.rest![i * 3],
            piece.rest![i * 3 + 1],
            piece.rest![i * 3 + 2],
          );
        }
        tmpV.applyMatrix4(tmpM);
        const w = outOff + (piece.base + i) * 3;
        out[w] = tmpV.x;
        out[w + 1] = tmpV.y;
        out[w + 2] = tmpV.z;
      }
    });
  }

  async function walk(
    anim: LensAnimation,
    ps: number[] = DEFAULT_PS,
  ): Promise<Walk> {
    // No caching: live param sliders retune the uniforms under the same anim
    // id, and a stale walk presented as fresh is this tool's failure mode.
    const steps = ps.length;
    const idleRow = steps;
    const entry = probeFor(steps + 1);
    const snap: Record<string, number> = {};
    for (const c of channels) {
      snap[c] = state[c];
      snap[`${c}Target`] = state[`${c}Target`];
    }
    const matrices: Float32Array[] = [];
    let local: Float32Array;
    try {
      if (!entry.compiled) {
        await entry.probe.compile();
        entry.compiled = true;
      }
      entry.probe.begin();
      for (let k = 0; k < steps; k++) {
        drive(ps[k], anim);
        matrices.push(captureMatrices());
        entry.probe.renderRow(k);
      }
      // seated row: every channel at its registry default = the rest pose;
      // doubles as the per-mesh idle-identity check
      drive(null, null);
      matrices.push(captureMatrices());
      entry.probe.renderRow(idleRow);
      entry.probe.end();
      local = await entry.probe.read(steps + 1);
    } finally {
      for (const c of channels) {
        state[c] = snap[c];
        state[`${c}Target`] = snap[`${c}Target`];
      }
      ctx.driveChannels();
      ctx.invalidate();
    }

    // per-mesh idle check: the seated probe row must reproduce the rest attrs
    const idlePerMesh = new Map<string, number>();
    let idleMax = 0;
    for (const piece of pieces) {
      if (piece.kind !== "shell") continue;
      let m = 0;
      for (let i = 0; i < piece.count; i++) {
        const o = (idleRow * probeCount + piece.base + i) * 3;
        const s = (piece.base + i) * 3;
        const d = Math.hypot(
          local[o] - probe.seated[s],
          local[o + 1] - probe.seated[s + 1],
          local[o + 2] - probe.seated[s + 2],
        );
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

    const world = new Float32Array(steps * totalSamples * 3);
    for (let k = 0; k < steps; k++)
      composeRow(world, k * totalSamples * 3, matrices[k], local, k);
    const seated = new Float32Array(totalSamples * 3);
    composeRow(seated, 0, matrices[steps], local, idleRow);

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
      for (let k = 1; k < steps; k++) {
        for (let i = 0; i < piece.count; i++) {
          const a = (piece.base + i) * 3;
          const o0 = a;
          const ok = k * totalSamples * 3 + a;
          if (
            Math.hypot(
              world[ok] - world[o0],
              world[ok + 1] - world[o0 + 1],
              world[ok + 2] - world[o0 + 2],
            ) > MOVE_TOL_MM
          )
            return true;
        }
      }
      return false;
    });

    return {
      anim,
      ps,
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

  const sampleAt = (
    w: Walk,
    k: number,
    s: number,
  ): [number, number, number] => {
    const o = (k * totalSamples + s) * 3;
    return [w.world[o], w.world[o + 1], w.world[o + 2]];
  };

  interface PieceSeries {
    centroid: [number, number, number][];
    cyl: [number, number, number][];
    minR: number[];
    maxR: number[];
    yMin: number[];
    yMax: number[];
    /** per step: max sample distance from the seated pose (mm) */
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
    for (let k = 0; k < w.ps.length; k++) {
      let cx = 0,
        cy = 0,
        cz = 0,
        rLo = Infinity,
        rHi = -Infinity,
        yLo = Infinity,
        yHi = -Infinity,
        fl = 0;
      for (let i = 0; i < piece.count; i++) {
        const [x, y, z] = sampleAt(w, k, piece.base + i);
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
        const s = (piece.base + i) * 3;
        const d = Math.hypot(
          x - w.seated[s],
          y - w.seated[s + 1],
          z - w.seated[s + 2],
        );
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

  /** Outward excursions of a series: rises > eps off the preceding trough that
   *  come back down. A rise the series ends inside is not an excursion yet. */
  interface Excursion {
    troughIdx: number;
    peakIdx: number;
    amplitude: number;
  }
  function scanExcursions(
    series: number[],
    eps = REVERSAL_EPS_MM,
  ): Excursion[] {
    const out: Excursion[] = [];
    let trough = series[0];
    let troughIdx = 0;
    let peak = -Infinity;
    let peakIdx = 0;
    let rising = false;
    for (let k = 1; k < series.length; k++) {
      const v = series[k];
      if (!rising) {
        if (v < trough) {
          trough = v;
          troughIdx = k;
        }
        if (v > trough + eps) {
          rising = true;
          peak = v;
          peakIdx = k;
        }
      } else {
        if (v > peak) {
          peak = v;
          peakIdx = k;
        }
        if (v < peak - eps) {
          out.push({ troughIdx, peakIdx, amplitude: peak - trough });
          rising = false;
          trough = v;
          troughIdx = k;
        }
      }
    }
    return out;
  }

  function reversalsOf(
    series: number[],
    ps: number[] = DEFAULT_PS,
    eps = REVERSAL_EPS_MM,
  ): ReversalStructure {
    const events = scanExcursions(series, eps).map((e) => ({
      p: r3(ps[e.peakIdx]),
      amplitudeMm: r2(e.amplitude),
    }));
    return { count: events.length, events };
  }

  function peakStretchOf(w: Walk, piece: Piece): number | null {
    if (piece.kind !== "shell" || piece.edges.length === 0) return null;
    const rest = piece.edges.map(([a, b]) => {
      const oa = (piece.base + a) * 3;
      const ob = (piece.base + b) * 3;
      return Math.hypot(
        probe.seated[oa] - probe.seated[ob],
        probe.seated[oa + 1] - probe.seated[ob + 1],
        probe.seated[oa + 2] - probe.seated[ob + 2],
      );
    });
    let peak = 1;
    for (let k = 0; k < w.ps.length; k++) {
      piece.edges.forEach(([a, b], e) => {
        // Sub-STRETCH_MIN_EDGE rest edges (a jagged cut can put two grid slots
        // on near-coincident vertices) turn millimetre-scale deviations into
        // outlandish ratios.
        if (rest[e] < STRETCH_MIN_EDGE_MM) return;
        const oa = (k * probeCount + piece.base + a) * 3;
        const ob = (k * probeCount + piece.base + b) * 3;
        const ratio =
          Math.hypot(
            w.local[oa] - w.local[ob],
            w.local[oa + 1] - w.local[ob + 1],
            w.local[oa + 2] - w.local[ob + 2],
          ) / rest[e];
        if (Math.abs(ratio - 1) > Math.abs(peak - 1)) peak = ratio;
      });
    }
    return r3(peak);
  }

  function seatedAtPOf(flight: number[], ps: number[]): number {
    const last = flight.length - 1;
    for (let k = last; k >= 0; k--) {
      if (flight[k] > SEAT_TOL_MM) return r3(ps[Math.min(k + 1, last)]);
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
      seatedAtP: seatedAtPOf(series.flight, w.ps),
      reversals: reversalsOf(series.minR, w.ps),
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

  const rankKey = (rank: number) => rank.toFixed(3);

  function rankTable(
    seriesByPiece: Map<Piece, PieceSeries>,
    ps: number[],
  ): RankReport[] {
    const groups = new Map<string, { rank: number; pieces: Piece[] }>();
    for (const piece of pieces) {
      if (piece.kind !== "shell") continue;
      const key = rankKey(piece.rank);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { rank: piece.rank, pieces: [] }));
      g.pieces.push(piece);
    }
    return [...groups.values()]
      .sort((a, b) => a.rank - b.rank)
      .map((g) => {
        const minR: number[] = [];
        const maxR: number[] = [];
        for (let k = 0; k < ps.length; k++) {
          let lo = Infinity;
          let hi = -Infinity;
          for (const piece of g.pieces) {
            const s = seriesByPiece.get(piece)!;
            if (s.minR[k] < lo) lo = s.minR[k];
            if (s.maxR[k] > hi) hi = s.maxR[k];
          }
          minR.push(lo);
          maxR.push(hi);
        }
        return {
          rank: r3(g.rank),
          shells: [...new Set(g.pieces.map((p) => p.shell))],
          pieces: g.pieces.length,
          minR: minR.map(r2),
          maxR: maxR.map(r2),
          reversals: reversalsOf(minR, ps),
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
    const seriesByPiece = new Map<Piece, PieceSeries>();
    for (const piece of pieces) seriesByPiece.set(piece, pieceSeries(w, piece));
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
      ranks: rankTable(seriesByPiece, w.ps),
    };
  }

  async function compare(idA: string, idB: string): Promise<CompareResult> {
    const wA = await walk(findAnim(idA));
    const wB = await walk(findAnim(idB));
    const perPiece = pieces.map((piece) => {
      let maxD = 0;
      let atK = 0;
      let sum = 0;
      for (let k = 0; k < wA.ps.length; k++) {
        let stepMax = 0;
        for (let i = 0; i < piece.count; i++) {
          const o = (k * totalSamples + piece.base + i) * 3;
          const d = Math.hypot(
            wA.world[o] - wB.world[o],
            wA.world[o + 1] - wB.world[o + 1],
            wA.world[o + 2] - wB.world[o + 2],
          );
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
        atP: r3(wA.ps[atK]),
        meanDivergenceMm: r2(sum / wA.ps.length),
      };
    });
    perPiece.sort((a, b) => b.maxDivergenceMm - a.maxDivergenceMm);
    const envelope = (w: Walk) => {
      const seriesByPiece = new Map<Piece, PieceSeries>();
      for (const piece of pieces)
        if (piece.kind === "shell")
          seriesByPiece.set(piece, pieceSeries(w, piece));
      return rankTable(seriesByPiece, w.ps).map(({ rank, minR, maxR }) => ({
        rank,
        minR,
        maxR,
      }));
    };
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
    const seriesByPiece = new Map<Piece, PieceSeries>();
    for (const piece of pieces) seriesByPiece.set(piece, pieceSeries(w, piece));

    // rank groups over all pieces (shells + solids), ascending
    const groups = new Map<string, Piece[]>();
    for (const piece of pieces) {
      const key = rankKey(piece.rank);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(piece);
    }
    const ordered = [...groups.entries()]
      .map(([key, list]) => ({ rank: list[0].rank, key, list }))
      .sort((a, b) => a.rank - b.rank);

    const pairs = new Map<
      string,
      {
        inner: Piece;
        outer: Piece;
        overlap: number[]; // per step; NaN where the condition doesn't hold
      }
    >();
    for (let g = 0; g + 1 < ordered.length; g++) {
      for (const inner of ordered[g].list) {
        const si = seriesByPiece.get(inner)!;
        for (const outer of ordered[g + 1].list) {
          const so = seriesByPiece.get(outer)!;
          let entry: { inner: Piece; outer: Piece; overlap: number[] } | null =
            null;
          for (let k = 0; k < w.ps.length; k++) {
            const radial = si.maxR[k] - so.minR[k];
            const inFlight =
              si.flight[k] > SEAT_TOL_MM && so.flight[k] > SEAT_TOL_MM;
            const yOverlap =
              Math.min(si.yMax[k], so.yMax[k]) -
              Math.max(si.yMin[k], so.yMin[k]);
            if (radial > 0 && inFlight && yOverlap > 0) {
              if (!entry) {
                entry = {
                  inner,
                  outer,
                  overlap: new Array<number>(w.ps.length).fill(NaN),
                };
                pairs.set(`${inner.name}|${outer.name}`, entry);
              }
              entry.overlap[k] = radial;
            }
          }
        }
      }
    }

    // Seated radial band per piece — adjacent shells often nest at rest (their
    // wall bands interleave), which is band overlap but not a crossing. The
    // crossing signal is the excess over that seated overlap.
    const seatedBand = new Map<Piece, { minR: number; maxR: number }>();
    for (const piece of pieces) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < piece.count; i++) {
        if (!piece.radiusEligible[i]) continue;
        const o = (piece.base + i) * 3;
        const r = Math.hypot(w.seated[o], w.seated[o + 2]);
        if (r < lo) lo = r;
        if (r > hi) hi = r;
      }
      seatedBand.set(piece, { minR: lo, maxR: hi });
    }

    const result: InterferencePair[] = [...pairs.values()].map(
      ({ inner, outer, overlap }) => {
        const seatedOverlap =
          seatedBand.get(inner)!.maxR - seatedBand.get(outer)!.minR;
        const ranges: { p0: number; p1: number; maxOverlapMm: number }[] = [];
        let start = -1;
        let runMax = 0;
        let allMax = 0;
        for (let k = 0; k <= w.ps.length; k++) {
          const v = k < w.ps.length ? overlap[k] : NaN;
          if (!Number.isNaN(v)) {
            if (start < 0) {
              start = k;
              runMax = 0;
            }
            if (v > runMax) runMax = v;
            if (v > allMax) allMax = v;
          } else if (start >= 0) {
            ranges.push({
              p0: r3(w.ps[start]),
              p1: r3(w.ps[k - 1]),
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
    // The two sheet constructions worth comparing by default; any two
    // animation ids work.
    idA = "assemble",
    idB = "x-rose",
  ): Promise<CurlCornerResult> {
    const wA = await walk(findAnim(idA));
    const wB = await walk(findAnim(idB));

    const cornersOf = (w: Walk, piece: Piece): WedgeCorners => {
      const steps = w.ps.length;
      const lastOffP: Partial<Record<CornerLabel, number>> = {};
      const exact: Partial<Record<CornerLabel, number>> = {};
      const present = CORNER_LABELS.filter(
        (l) => piece.corners[l] !== undefined,
      );
      // absolute radial lift per corner per step
      const lift = new Map<CornerLabel, Float64Array>();
      for (const label of present) {
        const i = piece.corners[label]!;
        const s = (piece.base + i) * 3;
        const rSeat = Math.hypot(w.seated[s], w.seated[s + 2]);
        const arr = new Float64Array(steps);
        for (let k = 0; k < steps; k++) {
          const o = (k * totalSamples + piece.base + i) * 3;
          arr[k] = Math.abs(Math.hypot(w.world[o], w.world[o + 2]) - rSeat);
        }
        lift.set(label, arr);
      }
      // relative lift: subtract the per-step minimum across the corners
      const floor = new Float64Array(steps).fill(Infinity);
      for (const arr of lift.values())
        for (let k = 0; k < steps; k++)
          if (arr[k] < floor[k]) floor[k] = arr[k];
      for (const label of present) {
        const arr = lift.get(label)!;
        const excess = (k: number) => arr[k] - floor[k];
        // last step still lifted, then the crossing interpolated between
        // steps: corner differences within one wedge are often finer than the
        // step grid
        let p = 0;
        for (let k = steps - 1; k >= 0; k--) {
          const d = excess(k);
          if (d > CORNER_TOL_MM) {
            if (k === steps - 1) p = w.ps[k];
            else {
              const dNext = excess(k + 1);
              const f = (d - CORNER_TOL_MM) / Math.max(1e-9, d - dNext);
              p = w.ps[k] + f * (w.ps[k + 1] - w.ps[k]);
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
      // Per-dimension leads: mean the two corners on each side so the arc
      // progression and the axial shear are read independently — the arc
      // effect is much larger and buries the axial one in a single argmin.
      const mean = (labels: CornerLabel[]) => {
        const vals = labels
          .map((l) => exact[l])
          .filter((v): v is number => v !== undefined);
        return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
      };
      const TIE = 0.0005;
      const lead = (
        lo: number,
        hi: number,
        loName: string,
        hiName: string,
      ): string =>
        Math.abs(lo - hi) < TIE ? "tie" : lo < hi ? loName : hiName;
      // mid-flight far-corner skew (see the interface comment)
      let farSkew: { mm: number; atP: number } | null = null;
      const ff = lift.get("far-front");
      const fr = lift.get("far-rear");
      if (ff && fr) {
        let best = 0;
        let atK = 0;
        for (let k = 0; k < steps; k++) {
          const d = ff[k] - fr[k];
          if (Math.abs(d) > Math.abs(best)) {
            best = d;
            atK = k;
          }
        }
        farSkew = { mm: r2(best), atP: r3(w.ps[atK]) };
      }
      return {
        lastOffP,
        farSkew,
        // seats first ⇒ departs the seat last ⇒ the corner the stick front
        // grows from
        leading: spread < TIE ? "tie" : entries[0][0],
        trailing: spread < TIE ? "tie" : entries[entries.length - 1][0],
        arcLead: lead(
          mean(["seam-front", "seam-rear"]),
          mean(["far-front", "far-rear"]),
          "seam",
          "far",
        ) as WedgeCorners["arcLead"],
        axialLead: lead(
          mean(["seam-front", "far-front"]),
          mean(["seam-rear", "far-rear"]),
          "front",
          "rear",
        ) as WedgeCorners["axialLead"],
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

    const shells = new Map<string, typeof wedges>();
    for (const wd of wedges) {
      (shells.get(wd.shell) ?? shells.set(wd.shell, []).get(wd.shell)!).push(
        wd,
      );
    }
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
    dispose() {
      for (const e of probes.values()) e.probe.dispose();
    },
  };
}
