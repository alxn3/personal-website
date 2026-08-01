import * as THREE from "three/webgpu";
import { ANIMATIONS, type LensAnimation } from "../animations";
import { isAccessory } from "../core/parts";
import {
  createPositionProbe,
  type PositionProbe,
  type ProbeSample,
} from "./path-probe";
import type { PathVizContext } from "./paths";

// ============================================================================
// PATH ANALYSIS — dev only, the QUERYABLE side of the motion-path instrument
// (dev/paths.ts draws; this module measures and returns JSON).
//
// Two sample populations, one walk:
//   SHELLS — every bloom-carrying mesh (wedges + seated features + decals).
//            Sampled through the GPU probe (dev/path-probe.ts) running the real
//            bloomLocalPosition() graph: outer-wall grid + inner-wall grid +
//            the four (seam/far × front/rear) corners, real vertices only.
//   SOLIDS — every non-bloom mesh (rig posRiders' meshes, glass, iris, screw,
//            loose parts). Solids are rigid, so their rest samples (AABB
//            corners + real extreme vertices) transformed by the SAME per-step
//            matrixWorld snapshot are exact ground truth — no shader mirror.
//
// FRAME: every reported position is in the MODEL frame (the GLB root's local
// frame): optical axis = Y, radial plane = X–Z, units = real millimetres. It is
// the world-composed pose (bloom local × matrixWorld) re-expressed in the one
// frame where cylindrical numbers mean something; distances are identical to
// world distances up to the constant model scale.
//
// HONESTY: every result carries `coverage` ({sampledMeshes, totalMovingMeshes,
// excluded}) and `idleCheck` (the per-mesh version of paths.ts's idle-identity
// check — the seated row of every walk must reproduce the rest geometry). A
// verdict without its sampling universe caused two false all-clears already.
// ============================================================================

const STEPS = 96;
/** A piece is "in flight" while any sample sits further than this off its seat. */
const SEAT_TOL_MM = 1;
/** Curl-corner threshold, on the corner's RELATIVE radial lift: its lift off
 *  the seated radius MINUS the smallest lift among the piece's four corners at
 *  the same step. Two rejected metrics first (both measured as four-way ties):
 *  full-3D distance-to-seat, and absolute radial lift — in the classic, the
 *  piece-UNIFORM terms (dilation + slide, ∝ t through lr 0.95) decay LAST, so
 *  any absolute threshold crossing lands in that uniform tail after the wrap
 *  has already finished. Subtracting the per-step minimum cancels everything
 *  piece-uniform; what remains is exactly the peel-front/roll geometry — the
 *  corner ordering the curl question asks about. */
const CORNER_TOL_MM = 1;
/** Minimum rise of the min-radius series that counts as an outward excursion. */
const REVERSAL_EPS_MM = 0.5;
const IDLE_TOL_MM = 0.01;
/** Movement threshold: a mesh whose samples never leave a 0.01mm ball is static. */
const MOVE_TOL_MM = 0.01;
/** Grid edges shorter than this at rest are excluded from the stretch metric. */
const STRETCH_MIN_EDGE_MM = 1.5;

/** Corner naming: seam = the peel/wrap seam edge. WRAP_DIR = −1 in
 *  materials/bloom.ts and ASSEMBLE_WRAP_FROM = −1 in materials/formation.ts, so
 *  BOTH constructions hinge at θ0 + halfSpan — the wedge-local +φ side. front =
 *  +Y (filter end), rear = −Y (mount end). */
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
 *  value of each step row) so windowed walks (breath) reuse the same engine. */
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
  /** the pair's radial band overlap in the SEATED pose — many adjacent shells
   *  NEST at rest (walls interleave), which is overlap but not a defect */
  seatedOverlapMm: number;
  /** max of (in-flight overlap − seated overlap): how much MORE the bands
   *  interpenetrate in flight than in their natural nesting — the crossing
   *  signal; the sort key */
  maxExcessMm: number;
  ranges: { p0: number; p1: number; maxOverlapMm: number }[];
}

export interface InterferenceResult {
  anim: string;
  steps: number;
  coverage: Coverage;
  idleCheck: IdleCheck;
  /** adjacent-seat-rank piece pairs whose radial bands overlap while BOTH are
   *  in flight AND their axial (y) bands overlap; sorted by maxExcessMm (the
   *  overlap beyond the pair's natural seated nesting) */
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
     *  (seats FIRST ⇒ departs the seat LAST in the peel direction ⇒ leads the
     *  stick) and the trailing corner (seats last) */
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
    /** do the axial leads sit at OPPOSITE ends in the two animations? (the
     *  suspicion: same hash, opposite shear sense ⇒ mirrored corners) */
    axialMirrored: boolean | null;
  }[];
}

interface WedgeCorners {
  /** per corner: the last p at which its radial lift exceeds the piece's
   *  most-seated corner by CORNER_TOL_MM (relative lift — piece-uniform terms
   *  cancel), interpolated between steps */
  lastOffP: Partial<Record<CornerLabel, number>>;
  leading: CornerLabel | "tie";
  trailing: CornerLabel | "tie";
  /** arc dimension alone: does the seam side or the far side seat first? */
  arcLead: "seam" | "far" | "tie";
  /** axial dimension alone (the shear question): front or rear end first? */
  axialLead: "front" | "rear" | "tie";
  /** mid-flight shear signature: (far-front lift − far-rear lift), its extreme
   *  of largest magnitude over the walk. Positive = the FRONT end hangs
   *  further off the surface (rear end leads there). A shear can show here yet
   *  wash out of the seating order (the ops roll-shear does — it scales a roll
   *  length that vanishes before seating resolves). */
  farSkew: { mm: number; atP: number } | null;
}

// --- breath (windowed fine-grained) results ---------------------------------

export interface BreathEvent {
  /** p of the trough this outward excursion rises from (breath onset) */
  onsetP: number;
  /** p at which the excursion peaks */
  peakP: number;
  amplitudeMm: number;
  /** max roll remainder (mm) anywhere in the rise. > ~1mm means the piece was
   *  still visibly unwrapped while it moved back outward — the exact defect
   *  the S(0.75,1,q) breath window exists to prevent. */
  maxRollDuringRiseMm: number;
}

export interface BreathPieceReport {
  name: string;
  shell: string;
  rank: number;
  /** seated reference radii, mm: [minR, maxR, centroidR] */
  seatedR: [number, number, number];
  /** outward excursions of the piece's min-radius offset series */
  breathEvents: BreathEvent[];
  /** grid-edge length ratio furthest ABOVE 1 over the window (tangential
   *  stretch), and where; null = no stretch-eligible edges on this piece.
   *  CAUTION: mid-wrap this is dominated by the sheared peel front (both
   *  constructions flex the sheet hard while the tail is still down) — for the
   *  BREATH's own stretch read stuckStretchPeak. */
  stretchPeak: { ratio: number; atP: number } | null;
  /** ratio furthest BELOW 1 (crush) — the classic's chord-cutting compresses too */
  crushPeak: { ratio: number; atP: number } | null;
  /** stretch extremes over only the steps where the roll remainder is under
   *  CORNER_TOL_MM (sheet fully stuck): the breath's own tangential stretch,
   *  uncontaminated by the peel. null = never fully stuck in-window (or no
   *  eligible edges). */
  stuckStretchPeak: { ratio: number; atP: number } | null;
  stuckCrushPeak: { ratio: number; atP: number } | null;
  /** last p at which the roll remainder exceeds CORNER_TOL_MM (interpolated).
   *  null = never unwrapped in-window; the window's p1 = still unwrapped at end */
  rollDoneP: number | null;
  series?: {
    /** per step, offsets from the seated values (mm) */
    minROffMm: number[];
    maxROffMm: number[];
    centroidROffMm: number[];
    /** per step: max / min grid-edge ratio vs seated (null = no eligible edges) */
    stretchMax: number[] | null;
    stretchMin: number[] | null;
    /** per step: ROLL REMAINDER — max corner radial lift minus min corner
     *  radial lift (lift = |r − r_seated| per corner). Piece-uniform terms
     *  (the breath dilation itself, the slide) lift all four corners equally
     *  and cancel; what remains is how far part of the sheet still stands off
     *  its stuck band — an honest "how unwrapped is it still" scalar. */
    rollRemainderMm: number[];
  };
}

export interface BreathRankReport {
  rank: number;
  shells: string[];
  pieces: number;
  /** per step: mean over the rank's pieces of centroid-radius offset (mm) —
   *  the breath curve itself */
  centroidROffMm: number[];
  /** per step: min over pieces of the per-piece min-radius offset */
  minROffMm: number[];
  maxROffMm: number[];
  /** per step: worst grid-edge ratio above / below 1 across the rank's pieces */
  stretchMax: number[];
  stretchMin: number[];
  /** per step: max roll remainder across the rank's pieces (mm) */
  rollRemainderMm: number[];
  /** outward excursions of the rank's MIN-RADIUS offset series. Min radius,
   *  not the centroid mean: the stuck band is what rides the breathing barrel,
   *  while the mean still carries the decaying inward flight of not-yet-stuck
   *  material, which cancels the rise (measured — the centroid series showed
   *  0.13mm where the min-radius series showed the 96-step table's 5.2mm). */
  breathEvents: BreathEvent[];
  /** the largest event's peak — THE breath, when the window catches it whole */
  breathPeakP: number | null;
  breathAmplitudeMm: number | null;
  stretchPeak: { ratio: number; atP: number } | null;
  crushPeak: { ratio: number; atP: number } | null;
  /** see BreathPieceReport.stuckStretchPeak — masked by the RANK's own roll
   *  remainder (every piece of the rank fully stuck) */
  stuckStretchPeak: { ratio: number; atP: number } | null;
  stuckCrushPeak: { ratio: number; atP: number } | null;
  rollDoneP: number | null;
  /** breathPeakP − rollDoneP; positive = the curl finished BEFORE the breath
   *  peaked (the classic's ordering, which ops must reproduce) */
  curlLeadP: number | null;
}

export interface BreathResult {
  anim: string;
  p0: number;
  p1: number;
  steps: number;
  coverage: Coverage;
  idleCheck: IdleCheck;
  /** shell ranks, ascending. Ranks whose breath falls outside [p0, p1] show
   *  flat curves and empty event lists — absence of events is "not in this
   *  window", never "no breath". */
  ranks: BreathRankReport[];
  /** SHELL pieces only (solids are rigid — they cannot breathe or stretch) */
  pieces: BreathPieceReport[];
}

export interface PathAnalysis {
  analyze(
    animId: string,
    opts?: { timeline?: boolean },
  ): Promise<AnalysisResult>;
  compare(idA: string, idB: string): Promise<CompareResult>;
  interference(animId: string): Promise<InterferenceResult>;
  curlCorners(idA?: string, idB?: string): Promise<CurlCornerResult>;
  breath(
    animId: string,
    opts?: { p0?: number; p1?: number; steps?: number; series?: boolean },
  ): Promise<BreathResult>;
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
  /** shells: [a, b] LOCAL pairs (offsets within the piece) of grid edges */
  edges: [number, number][];
  /** shells: corner label → LOCAL sample offset */
  corners: Partial<Record<CornerLabel, number>>;
  /** per LOCAL sample: counts toward the radial band (solids' synthesized AABB
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
 * Sample a bloom mesh. Grids/edges/corners live in the mesh's DOMINANT sector
 * only (features seated on a shell carry per-COMPONENT `_bloomtheta0`; islands
 * follow different wedges, so an edge across sectors would measure the sectors
 * flying apart, not the mesh stretching — the 6× "stretch" false alarms this
 * replaces). Geometry modes:
 *   BARREL (axial span dominates): 3×3 outer-wall grid + 3×2 inner-wall grid
 *     (the existing picker's 70% radial cut, run for the inner wall too) over
 *     (φ, y), plus the four (seam/far × front/rear) corner vertices.
 *   PLATE (radial span dominates — PCB discs, baffle plates): one 3×3 grid
 *     over (φ, r) — the (φ, y) grid degenerates to thickness-length edges
 *     there, and a ~1mm rest edge turns millimetre noise into a fake 4× ratio.
 * Non-dominant sectors still contribute edge-less extreme samples so centroid
 * and radial-band numbers cover the whole mesh. Real vertices only.
 */
function pickShellSamples(mesh: THREE.Mesh): PickedShell {
  const pos = mesh.geometry.getAttribute("position");
  const t0Attr = mesh.geometry.getAttribute("_bloomtheta0");
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
    const t0 = t0Attr ? -t0Attr.getX(i) : 0; // stored negated (see bloom.ts)
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
  if (rest.length) {
    const pick = (score: (i: number) => number) => {
      let best = rest[0];
      let bs = -Infinity;
      for (const i of rest) {
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
  }
  return { verts: list, edges, corners };
}

/** Sample a solid: the 8 geometry-AABB corners (synthesized — exact under the
 *  rigid per-step transform, excluded from radial bands) plus real extreme
 *  vertices (±x, ±y, ±z, min/max radius) and a few strided surface picks. */
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
  /** [step][sample] xyz in the MODEL frame (mm) */
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
    if (o.geometry.getAttribute("_bloomr")) shellMeshes.push(o);
    else solidMeshes.push(o);
  });

  const names = new Set<string>();
  const uniqueName = (base: string) => {
    let name = base || "(unnamed)";
    for (let k = 2; names.has(name); k++) name = `${base}#${k}`;
    names.add(name);
    return name;
  };

  // shells FIRST so unified sample offsets coincide with probe columns
  for (const mesh of shellMeshes) {
    const picked = pickShellSamples(mesh);
    const rate = mesh.geometry.getAttribute("_bloomrate");
    const R = mesh.geometry.getAttribute("_bloomr").getX(0);
    pieces.push({
      name: uniqueName(mesh.name),
      kind: "shell",
      shell: mesh.name.replace(/_Seg\d+.*$/, "") || mesh.name,
      rank: rate ? rate.getX(0) : 0.5,
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
      // Filled in on the first walk (from the seated pose) — NOT bloom's
      // seatRankOf: its non-bloom branch reads a WORLD-space box (scene units,
      // model scale applied) into a table keyed in model millimetres, so at
      // runtime every solid clamps to rank 0 (measured 2026-07-27: all 36
      // solids). This module must rank solids correctly for interference
      // adjacency, and it may not touch rig behaviour — so it applies the same
      // law (0.01mm bucket into the shell-radius span) in the model frame.
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

  // Solid seat ranks, on the shader's own law (bloom.ts rankOfKey: 0.01mm
  // radius buckets normalized across the shell-radius span) but computed in
  // the MODEL frame — see the rank comment above. The radius comes from the
  // first walk's seated pose, so the flag defers it until one exists.
  const shellKeys = shellMeshes.map((m) =>
    Math.round(m.geometry.getAttribute("_bloomr").getX(0) * 100),
  );
  const keyLo = shellKeys.length ? Math.min(...shellKeys) : 0;
  const keyHi = shellKeys.length ? Math.max(...shellKeys) : 1;
  const rankOfRadius = (rMm: number) =>
    Math.min(
      1,
      Math.max(0, (Math.round(rMm * 100) - keyLo) / Math.max(1, keyHi - keyLo)),
    );
  let solidsRanked = false;

  // One probe per row count: the default walk needs STEPS+1 rows, a windowed
  // breath walk needs its own steps+1. All probes share the sample list, so
  // their CPU-built `seated` arrays are identical — `probe` (the default one,
  // created eagerly as before) stays the single rest-geometry reference.
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
    ctx.driveRig();
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
      ctx.driveRig();
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
   *  come back down (a rise the series ends inside is not an excursion yet —
   *  windowed callers must widen the window to see it whole). Same algorithm
   *  reversalsOf always used, now also reporting WHERE each rise started. */
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
        // outlandish ratios — too short to say anything about the sheet.
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

    // rank groups over ALL pieces (shells + solids), ascending
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

    // Seated radial band per piece — adjacent shells often NEST at rest (their
    // wall bands interleave), which is band overlap but not a crossing. The
    // crossing signal is the EXCESS over that seated overlap.
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
    idA = "reassemble",
    idB = "reassemble-ops",
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
      // RELATIVE lift: subtract the per-step minimum across the corners — see
      // CORNER_TOL_MM for why absolute metrics tie
      const floor = new Float64Array(steps).fill(Infinity);
      for (const arr of lift.values())
        for (let k = 0; k < steps; k++)
          if (arr[k] < floor[k]) floor[k] = arr[k];
      for (const label of present) {
        const arr = lift.get(label)!;
        const excess = (k: number) => arr[k] - floor[k];
        // last step still lifted, then the crossing INTERPOLATED between
        // steps — corner differences within one wedge are often finer than
        // the step grid, and an un-interpolated threshold reads as a tie
        // broken by insertion order (measured before this fix)
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
      // progression (seam→far) and the axial shear tilt (front↔rear) are read
      // INDEPENDENTLY — the arc effect is much larger and buries the axial
      // one in a single argmin.
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
        // seats FIRST ⇒ departs the seat LAST in the peel direction ⇒ the
        // corner the stick front grows from
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

  // --- breath — windowed, fine-grained ---------------------------------------
  // A dedicated dense walk over [p0, p1] (NOT a subsample of the 96-step scrub):
  // the same engine drives the rig at `steps` p-values inside the window, so
  // per-step resolution there is (p1−p0)/steps instead of 1/96. Everything is
  // reported per shell rank and per SHELL piece — solids are rigid by
  // construction (exact matrixWorld transforms), so they cannot breathe,
  // stretch, or roll, and are left out of the piece list (the walk itself still
  // drives and checks every mesh; see coverage).
  async function breath(
    animId: string,
    opts: { p0?: number; p1?: number; steps?: number; series?: boolean } = {},
  ): Promise<BreathResult> {
    const p0 = opts.p0 ?? 0.45;
    const p1 = opts.p1 ?? 0.7;
    const steps = Math.max(8, Math.min(512, Math.round(opts.steps ?? 128)));
    const withSeries = opts.series !== false;
    if (!(p1 > p0)) throw new Error(`breath: need p1 > p0 (got ${p0}..${p1})`);
    const ps = Array.from(
      { length: steps },
      (_, k) => p0 + ((p1 - p0) * k) / (steps - 1),
    );
    const w = await walk(findAnim(animId), ps);

    /** Last p at which the roll remainder exceeds CORNER_TOL_MM, interpolated
     *  between steps (the curlCorners crossing convention). */
    const rollDonePOf = (roll: number[]): number | null => {
      for (let k = steps - 1; k >= 0; k--) {
        if (roll[k] > CORNER_TOL_MM) {
          if (k === steps - 1) return r3(ps[k]);
          const f =
            (roll[k] - CORNER_TOL_MM) / Math.max(1e-9, roll[k] - roll[k + 1]);
          return r3(ps[k] + f * (ps[k + 1] - ps[k]));
        }
      }
      return null;
    };

    const eventsOf = (series: number[], roll: number[]): BreathEvent[] =>
      scanExcursions(series).map((e) => {
        let maxRoll = 0;
        for (let k = e.troughIdx; k <= e.peakIdx; k++)
          if (roll[k] > maxRoll) maxRoll = roll[k];
        return {
          onsetP: r3(ps[e.troughIdx]),
          peakP: r3(ps[e.peakIdx]),
          amplitudeMm: r2(e.amplitude),
          maxRollDuringRiseMm: r2(maxRoll),
        };
      });

    const maxPeakOf = (
      series: number[] | null,
    ): { ratio: number; atP: number } | null => {
      if (!series) return null;
      let atK = 0;
      for (let k = 1; k < steps; k++) if (series[k] > series[atK]) atK = k;
      return { ratio: r3(series[atK]), atP: r3(ps[atK]) };
    };
    const minPeakOf = (
      series: number[] | null,
    ): { ratio: number; atP: number } | null => {
      if (!series) return null;
      let atK = 0;
      for (let k = 1; k < steps; k++) if (series[k] < series[atK]) atK = k;
      return { ratio: r3(series[atK]), atP: r3(ps[atK]) };
    };
    /** Peak over only the steps where `roll` is under CORNER_TOL_MM. */
    const maskedPeakOf = (
      series: number[] | null,
      roll: number[],
      wantMax: boolean,
    ): { ratio: number; atP: number } | null => {
      if (!series) return null;
      let atK = -1;
      for (let k = 0; k < steps; k++) {
        if (roll[k] >= CORNER_TOL_MM) continue;
        if (
          atK < 0 ||
          (wantMax ? series[k] > series[atK] : series[k] < series[atK])
        )
          atK = k;
      }
      return atK < 0 ? null : { ratio: r3(series[atK]), atP: r3(ps[atK]) };
    };

    interface PieceBreath {
      piece: Piece;
      report: BreathPieceReport;
      centroidOff: number[];
      minOff: number[];
      maxOff: number[];
      stretchMax: number[] | null;
      stretchMin: number[] | null;
      roll: number[];
    }

    const perPiece: PieceBreath[] = [];
    for (const piece of pieces) {
      if (piece.kind !== "shell") continue;
      const s = pieceSeries(w, piece);

      // seated radius references (same sample eligibility as the live series)
      let sMin = Infinity;
      let sMax = -Infinity;
      let cx = 0;
      let cz = 0;
      for (let i = 0; i < piece.count; i++) {
        const o = (piece.base + i) * 3;
        if (piece.radiusEligible[i]) {
          const r = Math.hypot(w.seated[o], w.seated[o + 2]);
          if (r < sMin) sMin = r;
          if (r > sMax) sMax = r;
        }
        cx += w.seated[o];
        cz += w.seated[o + 2];
      }
      const sCen = Math.hypot(cx / piece.count, cz / piece.count);
      if (sMin === Infinity) {
        sMin = sCen;
        sMax = sCen;
      }
      const centroidOff = s.cyl.map(([r]) => r - sCen);
      const minOff = s.minR.map((v) => v - sMin);
      const maxOff = s.maxR.map((v) => v - sMax);

      // STRETCH TIMELINE: per step, the grid-edge length ratio furthest above /
      // below 1 (peakStretchOf's metric, resolved per step instead of collapsed
      // to one walk-wide scalar). Same sub-edge exclusion as peakStretchOf.
      const eligible: [number, number, number][] = [];
      for (const [a, b] of piece.edges) {
        const oa = (piece.base + a) * 3;
        const ob = (piece.base + b) * 3;
        const rest = Math.hypot(
          probe.seated[oa] - probe.seated[ob],
          probe.seated[oa + 1] - probe.seated[ob + 1],
          probe.seated[oa + 2] - probe.seated[ob + 2],
        );
        if (rest >= STRETCH_MIN_EDGE_MM) eligible.push([a, b, rest]);
      }
      let stretchMax: number[] | null = null;
      let stretchMin: number[] | null = null;
      if (eligible.length) {
        stretchMax = [];
        stretchMin = [];
        for (let k = 0; k < steps; k++) {
          let hi = -Infinity;
          let lo = Infinity;
          for (const [a, b, rest] of eligible) {
            const oa = (k * probeCount + piece.base + a) * 3;
            const ob = (k * probeCount + piece.base + b) * 3;
            const ratio =
              Math.hypot(
                w.local[oa] - w.local[ob],
                w.local[oa + 1] - w.local[ob + 1],
                w.local[oa + 2] - w.local[ob + 2],
              ) / rest;
            if (ratio > hi) hi = ratio;
            if (ratio < lo) lo = ratio;
          }
          stretchMax.push(hi);
          stretchMin.push(lo);
        }
      }

      // ROLL REMAINDER: corner radial-lift spread (see the series doc comment)
      const present = CORNER_LABELS.filter(
        (l) => piece.corners[l] !== undefined,
      );
      const roll = new Array<number>(steps).fill(0);
      if (present.length >= 2) {
        const seatR = present.map((l) => {
          const o = (piece.base + piece.corners[l]!) * 3;
          return Math.hypot(w.seated[o], w.seated[o + 2]);
        });
        for (let k = 0; k < steps; k++) {
          let hi = -Infinity;
          let lo = Infinity;
          present.forEach((l, ci) => {
            const o = (k * totalSamples + piece.base + piece.corners[l]!) * 3;
            const lift = Math.abs(
              Math.hypot(w.world[o], w.world[o + 2]) - seatR[ci],
            );
            if (lift > hi) hi = lift;
            if (lift < lo) lo = lift;
          });
          roll[k] = hi - lo;
        }
      }

      const report: BreathPieceReport = {
        name: piece.name,
        shell: piece.shell,
        rank: r3(piece.rank),
        seatedR: [r2(sMin), r2(sMax), r2(sCen)],
        breathEvents: eventsOf(minOff, roll),
        stretchPeak: maxPeakOf(stretchMax),
        crushPeak: minPeakOf(stretchMin),
        stuckStretchPeak: maskedPeakOf(stretchMax, roll, true),
        stuckCrushPeak: maskedPeakOf(stretchMin, roll, false),
        rollDoneP: rollDonePOf(roll),
      };
      if (withSeries) {
        report.series = {
          minROffMm: minOff.map(r2),
          maxROffMm: maxOff.map(r2),
          centroidROffMm: centroidOff.map(r2),
          stretchMax: stretchMax ? stretchMax.map(r3) : null,
          stretchMin: stretchMin ? stretchMin.map(r3) : null,
          rollRemainderMm: roll.map(r2),
        };
      }
      perPiece.push({
        piece,
        report,
        centroidOff,
        minOff,
        maxOff,
        stretchMax,
        stretchMin,
        roll,
      });
    }

    // rank aggregation
    const groups = new Map<string, PieceBreath[]>();
    for (const pb of perPiece) {
      const key = rankKey(pb.piece.rank);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(pb);
    }
    const ranks: BreathRankReport[] = [...groups.values()]
      .sort((a, b) => a[0].piece.rank - b[0].piece.rank)
      .map((list) => {
        const cen: number[] = [];
        const mn: number[] = [];
        const mx: number[] = [];
        const sHi: number[] = [];
        const sLo: number[] = [];
        const roll: number[] = [];
        for (let k = 0; k < steps; k++) {
          let cSum = 0;
          let lo = Infinity;
          let hi = -Infinity;
          let shi = -Infinity;
          let slo = Infinity;
          let anyStretch = false;
          let rl = 0;
          for (const pb of list) {
            cSum += pb.centroidOff[k];
            if (pb.minOff[k] < lo) lo = pb.minOff[k];
            if (pb.maxOff[k] > hi) hi = pb.maxOff[k];
            if (pb.stretchMax && pb.stretchMin) {
              anyStretch = true;
              if (pb.stretchMax[k] > shi) shi = pb.stretchMax[k];
              if (pb.stretchMin[k] < slo) slo = pb.stretchMin[k];
            }
            if (pb.roll[k] > rl) rl = pb.roll[k];
          }
          cen.push(cSum / list.length);
          mn.push(lo);
          mx.push(hi);
          sHi.push(anyStretch ? shi : 1);
          sLo.push(anyStretch ? slo : 1);
          roll.push(rl);
        }
        const events = eventsOf(mn, roll);
        let main: BreathEvent | null = null;
        for (const e of events)
          if (!main || e.amplitudeMm > main.amplitudeMm) main = e;
        const rollDoneP = rollDonePOf(roll);
        return {
          rank: r3(list[0].piece.rank),
          shells: [...new Set(list.map((pb) => pb.piece.shell))],
          pieces: list.length,
          centroidROffMm: cen.map(r2),
          minROffMm: mn.map(r2),
          maxROffMm: mx.map(r2),
          stretchMax: sHi.map(r3),
          stretchMin: sLo.map(r3),
          rollRemainderMm: roll.map(r2),
          breathEvents: events,
          breathPeakP: main ? main.peakP : null,
          breathAmplitudeMm: main ? main.amplitudeMm : null,
          stretchPeak: maxPeakOf(sHi),
          crushPeak: minPeakOf(sLo),
          stuckStretchPeak: maskedPeakOf(sHi, roll, true),
          stuckCrushPeak: maskedPeakOf(sLo, roll, false),
          rollDoneP,
          curlLeadP:
            main && rollDoneP != null ? r3(main.peakP - rollDoneP) : null,
        };
      });

    return {
      anim: animId,
      p0,
      p1,
      steps,
      coverage: coverageOf(w),
      idleCheck: w.idle,
      ranks,
      pieces: perPiece.map((pb) => pb.report),
    };
  }

  return {
    analyze,
    compare,
    interference,
    curlCorners,
    breath,
    dispose() {
      for (const e of probes.values()) e.probe.dispose();
    },
  };
}
