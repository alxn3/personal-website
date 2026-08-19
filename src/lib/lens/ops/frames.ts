// The load-time derivation pass: every per-piece constant the op pipeline reads
// is MEASURED from the geometry here, once, and written as vertex attributes.
// Nothing about a piece's frame is authored upstream, so a re-cut model needs
// no table edit anywhere. This file MAY import three (it runs on the CPU at
// load); the ops themselves never do.
//
// THE FRAMING UNIT IS THE AUTHORING UNIT — one set of values per glTF NODE,
// i.e. one Blender object, i.e. one THREE.Mesh (`unitsOf`). Anything finer is
// wrong: a real part is one mesh carrying many islands, and framing those
// separately measures a tiny frame per solder blob and drops the whole piece
// out of the wrap. So per NODE we measure:
//
//   t0    centroid meridian of the WHOLE unit, atan2(centroidZ, centroidX)
//   R     MEDIAN vertex radius, clamped to ≥ R_MIN — the R = 0 NaN guard at the
//         source, so no downstream op ever divides by zero
//   span  true angular extent of the whole unit about t0
//   axi   axisymmetric flag: a body of revolution has an ON-AXIS centroid, so
//         its t0 is atan2 of two near-zeroes — float noise that differs per
//         re-export. Such a unit is PINNED to t0 = 0, span = 2π and flagged, so
//         ops can tell "no meridian" from "points there"
//   yExt  axial extents (yMin, yMax), packed for the ops' `yN`
//   layerN piece count of the piece's own rank layer. Informational: the bucket
//         is too tight to carry a participation decision
//   rank  0.01mm-bucketed radius key, VALUE-normalized over the model's radius
//         span — value, not order, so touching shells rank close together
//   phase index/count of the piece within its LAYER, ordered by t0
//
// The CONNECTED-COMPONENT split exists for ONE job: the SHELL_ADOPT pass, where
// each screw of a `Mount_Screws` mesh must snap to its own host wedge. Only
// adopted feature meshes keep per-component values.
//
// SPACES. Frames are measured in the UNIT's own local space, the space the
// shader's `position` attribute lives in. The ladder alone is measured in ROOT
// space — "which side of the chassis is this on" is a question about the
// assembled model.
//
// TWO ADOPTIONS override the measurement, both so a rigid sub-assembly cannot
// fly apart:
//
//   1. Feature adoption — bolted hardware and every PRINTED MARKING live in
//      their own meshes but are not part of the shell that fans open. Each
//      snaps to the nearest host sector centre and copies that wedge UNIT's
//      frame EXACTLY (t0, R and hence rank/layer, span, yExt, axi), because the
//      ops normalize position over (t0, span, yExt) — an adopter left on its
//      own extents bends over its own arc and peels off the wedge it is bolted
//      to. Hosts come from ONE pass (`adoptJobs`): the AUTHORED `SHELL_ADOPT`
//      table, plus a DERIVED walk for markings, since the nearest ancestor
//      owning `<name>_Seg<n>` wedges IS the shell a decal is printed on.
//   2. Ladder grouping — the explode rung is per GROUP (the topmost named
//      ancestor below the root), so a shell's wedges, its decals and anything
//      parented under it all travel together.
//
// The ladder is DERIVED, not authored: rear/front split by axial centroid
// against the Chassis_Fixed anchor, each side ordered outward and stepped
// uniformly to the two reach anchors. `overrides.tierOrder` and
// `overrides.anchorY` are the escape hatches.

import * as THREE from "three/webgpu";
import { isGraphGroup, isSegWedge, partClassOf } from "../core/parts";
import { PART_CLASS } from "./ops";

/** The generated attributes: Float32 vectors, each field held constant over its
 *  piece. PACKED into three because WebGPU allows at most 8 vertex buffers per
 *  pipeline and one-per-name blew that limit. JS-side consumers read fields
 *  through `frameOf`; the shader unpacks in ops/host.ts's ctx build.
 *
 *    `_opA` = (t0, R, span, rank)
 *    `_opB` = (phase, class, rung, axi)
 *    `_opY` = (yMin, yMax, layerN, adopted) */
export const FRAME_ATTRS = [
  { name: "_opA", size: 4 },
  { name: "_opB", size: 4 },
  { name: "_opY", size: 4 },
] as const;

/** The SHRINK-WRAP BINDING a decal vertex rides, written by `bindDecals`: the
 *  host triangle it sits on, in the mesh's own local space. Only DECAL meshes
 *  carry these. `u·p0 + v·p1 + w·p2 + h·n̂` decomposes the vertex in the
 *  complete basis {p1−p0, p2−p0, n̂}, so it reproduces the authored position
 *  exactly — which is what lets the deformed position be built the same way
 *  from the deformed corners.
 *
 *    `_wrapA` = (p0.xyz, u)
 *    `_wrapB` = (p1.xyz, v)
 *    `_wrapC` = (p2.xyz, h)     w = 1 − u − v, derived in the shader */
export const WRAP_ATTRS = [
  { name: "_wrapA", size: 4 },
  { name: "_wrapB", size: 4 },
  { name: "_wrapC", size: 4 },
] as const;

/** One piece's frame, as the JS side reads it (`frameOf`). */
export interface Frame {
  t0: number;
  R: number;
  span: number;
  rank: number;
  phase: number;
  cls: number;
  rung: number;
  axi: number;
  yMin: number;
  yMax: number;
  /** Pieces in this piece's rank layer (1 = a lone body). */
  layerN: number;
  /** 1 when the frame was adopted from a host shell wedge (SHELL_ADOPT). */
  adopted: number;
}

/**
 * Read one vertex's frame off a geometry, unpacking the three attributes.
 * `null` when the geometry carries no frame, so callers test presence and read
 * fields in one step without knowing which lane a field lives in.
 */
export function frameOf(
  geo: THREE.BufferGeometry,
  vertexIndex = 0,
): Frame | null {
  const a = geo.getAttribute("_opA");
  const b = geo.getAttribute("_opB");
  const y = geo.getAttribute("_opY");
  if (!a || !b || !y) return null;
  return {
    t0: a.getX(vertexIndex),
    R: a.getY(vertexIndex),
    span: a.getZ(vertexIndex),
    rank: a.getW(vertexIndex),
    phase: b.getX(vertexIndex),
    cls: b.getY(vertexIndex),
    rung: b.getZ(vertexIndex),
    axi: b.getW(vertexIndex),
    yMin: y.getX(vertexIndex),
    yMax: y.getY(vertexIndex),
    layerN: y.getZ(vertexIndex),
    adopted: y.getW(vertexIndex),
  };
}

/** Non-segmented hardware BOLTED to a segmented shell: host → features.
 *  Adoption is DATA, not scene-graph surgery — the adopted frame alone keeps
 *  these meshes seated on their host. */
export const SHELL_ADOPT: Record<string, string[]> = {
  Mount_Bayonet: [
    "Mount_Screws",
    "Mount_FlangeScrews",
    "Mount_ScrewCounterbores",
    "Mount_Notch",
    "Mount_ContactShelf",
    "Mount_Contacts",
  ],
  Chassis_Fixed: ["Focus_Motor", "Focus_GuideRods"],
};

export interface DerivedFrames {
  /** Group (or explicitly overridden part) name → signed ladder rung, model-mm.
   *  Every group carrying geometry appears; the anchor and off-ladder groups
   *  (decals, accessories) are present with 0. */
  ladderRungs: Map<string, number>;
  /** Rank bucket key (`rankKeyOf`) → number of pieces in that layer. Adopted
   *  features are NOT counted — they ride a wedge rather than being one, and
   *  counting them would dilute the layer's phase stagger. */
  layerCount: Map<number, number>;
}

// Reference radius floor, model-mm: an on-axis piece (a flat disc, a rod on the
// optical axis) measures R ≈ 0, and R is a divisor all over the op algebra.
const R_MIN = 0.5;
// Coincident-position bucket, 1/mm ⇒ 1e-3 mm: seam-duplicated vertices share a
// bucket, genuinely separate islands do not.
const POS_QUANT = 1e3;
// Radius rank bucket, 1/mm ⇒ 0.01 mm.
const RADIUS_QUANT = 100;
// Axisymmetry thresholds. The span tolerance is LOOSE because a real mesh's
// angular sampling sets the shortfall — a ring with relief cutouts reaches only
// 2π minus its coarsest gap. Measuring the WHOLE mesh rather than each island
// is what makes a loose span test safe.
const AXI_CENTROID_FRAC = 0.02;
const AXI_SPAN_EPS = 0.15;
// The two authored ladder distances — the ONLY authored numbers in the ladder.
const REACH_REAR = 70; // mm, rearmost extent
const REACH_FRONT = 95; // mm, frontmost extent
// The part whose axial centre splits rear from front (and holds rung 0).
const ANCHOR_PART = "Chassis_Fixed";

const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** The layer key a radius falls in — `DerivedFrames.layerCount`'s key. Exported
 *  so consumers look a layer up by the SAME law that built the map. */
export const rankKeyOf = (R: number): number => Math.round(R * RADIUS_QUANT);

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── Connected components ─────────────────────────────────────────────────────
// Union-find over the triangle indices PLUS coincident positions: a ring of
// screws modelled as one mesh resolves to one island per screw, which is what
// lets each screw adopt the wedge it is actually bolted to. ONLY SHELL_ADOPT
// features are split this way; every other mesh is framed whole.

function componentsOf(geo: THREE.BufferGeometry): number[][] {
  const pos = geo.getAttribute("position");
  const n = pos.count;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const idx = geo.getIndex();
  if (idx) {
    for (let i = 0; i + 2 < idx.count; i += 3) {
      union(idx.getX(i), idx.getX(i + 1));
      union(idx.getX(i + 1), idx.getX(i + 2));
    }
  } else {
    for (let i = 0; i + 2 < n; i += 3) {
      union(i, i + 1);
      union(i + 1, i + 2);
    }
  }
  const posKey = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * POS_QUANT)},${Math.round(pos.getY(i) * POS_QUANT)},${Math.round(pos.getZ(i) * POS_QUANT)}`;
    const first = posKey.get(k);
    if (first === undefined) posKey.set(k, i);
    else union(first, i);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = groups.get(r);
    if (list) list.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()];
}

// ── The FRAMING UNIT ─────────────────────────────────────────────────────────
// One glTF NODE = one Blender object = exactly one THREE.Mesh: the web GLBs
// carry no material slots, so the exporter emits ONE primitive per mesh and no
// node's halves can measure different radii.

/** One authored node and its mesh. A pair because the class/group walks and the
 *  adoption pass address the NODE, while the measured vertices live on the
 *  mesh. */
interface Unit {
  node: THREE.Object3D;
  meshes: THREE.Mesh[];
}

/** Every framing unit under `root`, and the unit each mesh belongs to. */
function unitsOf(root: THREE.Object3D): {
  units: Unit[];
  unitOf: Map<THREE.Mesh, Unit>;
} {
  const units: Unit[] = [];
  const unitOf = new Map<THREE.Mesh, Unit>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (!o.geometry?.getAttribute("position")) return;
    const unit = { node: o, meshes: [o] };
    units.push(unit);
    unitOf.set(o, unit);
  });
  return { units, unitOf };
}

/** The vertices one piece owns inside its mesh. */
interface PiecePart {
  mesh: THREE.Mesh;
  verts: number[];
}

/** One piece's LOCAL measurements (geometry space). */
interface LocalPiece {
  parts: PiecePart[];
  /** Total vertices over every part — the ladder's centroid weight. */
  count: number;
  t0: number;
  R: number;
  span: number;
  /** Body of revolution: t0 pinned to 0, span pinned to exactly 2π. */
  axi: boolean;
  yMin: number;
  yMax: number;
  cx: number;
  cy: number;
  cz: number;
}

/** Measure ONE vertex set as a single frame — the shared body of both framing
 *  granularities (a whole UNIT, or one island of an adopted feature mesh). */
function measureVerts(parts: PiecePart[]): LocalPiece {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let count = 0;
  let yMin = Infinity;
  let yMax = -Infinity;
  const radii: number[] = [];
  for (const { mesh, verts } of parts) {
    const pos = mesh.geometry.getAttribute("position");
    for (const i of verts) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      sx += x;
      sy += y;
      sz += z;
      count++;
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
      radii.push(Math.hypot(x, z));
    }
  }
  const cx = sx / Math.max(count, 1);
  const cy = sy / Math.max(count, 1);
  const cz = sz / Math.max(count, 1);
  const R = Math.max(medianOf(radii), R_MIN);
  let t0 = Math.atan2(cz, cx);
  let aMin = Infinity;
  let aMax = -Infinity;
  for (const { mesh, verts } of parts) {
    const pos = mesh.geometry.getAttribute("position");
    for (const i of verts) {
      const a = wrapPi(Math.atan2(pos.getZ(i), pos.getX(i)) - t0);
      aMin = Math.min(aMin, a);
      aMax = Math.max(aMax, a);
    }
  }
  let span = Math.max(aMax - aMin, 0);
  // Axisymmetry guard, TWO independent tests (see the header's `axi`): the
  // centroid test, and a SPAN test for the pieces whose cutouts or lobes pull
  // the centroid off the axis but which still wrap the full turn.
  const axi =
    Math.hypot(cx, cz) < AXI_CENTROID_FRAC * R ||
    span >= Math.PI * 2 - AXI_SPAN_EPS;
  if (axi) {
    t0 = 0;
    span = Math.PI * 2;
  }
  return {
    parts,
    count,
    t0,
    R,
    span,
    axi,
    yMin,
    yMax,
    cx,
    cy,
    cz,
  };
}

/** All of a mesh's vertices. */
const wholeMesh = (mesh: THREE.Mesh): PiecePart => ({
  mesh,
  verts: Array.from(
    { length: mesh.geometry.getAttribute("position").count },
    (_, i) => i,
  ),
});

/** The DEFAULT granularity: the whole UNIT is one frame. */
function measureWhole(unit: Unit): LocalPiece[] {
  return [measureVerts(unit.meshes.map(wholeMesh))];
}

/** The SHELL_ADOPT granularity: one frame per ISLAND, so each screw snaps to its
 *  own host wedge. */
function measureComponents(unit: Unit): LocalPiece[] {
  return unit.meshes.flatMap((mesh) =>
    componentsOf(mesh.geometry).map((verts) => measureVerts([{ mesh, verts }])),
  );
}

// ── Naming: class and ladder group ───────────────────────────────────────────

/** The name chain from a node up to (not including) the root — every name that
 *  is a PART IDENTITY, so the `Grp_*` graph empties are skipped (core/parts
 *  `isGraphGroup`). They group the node graph without owning a rung, so their
 *  members keep their own separate ladder rungs. */
function nameChain(obj: THREE.Object3D, root: THREE.Object3D): string[] {
  const names: string[] = [];
  for (let o: THREE.Object3D | null = obj; o && o !== root; o = o.parent)
    if (o.name && !isGraphGroup(o.name)) names.push(o.name);
  return names;
}

/** A mesh's part class: its OWN name if that name classifies it, else the
 *  nearest classed ancestor, so a `<Part>_SegN` wedge takes its part's class.
 *
 *  The chain EXCLUDES the root, so it is empty when the mesh IS the root — how
 *  a single-mesh accessory arrives from scene.ts's per-accessory pass. Falling
 *  through to `structure` there would class the whole accessory as chassis, so
 *  an empty chain reads the root's own name. */
function classOf(mesh: THREE.Object3D, root: THREE.Object3D): number {
  const chain = nameChain(mesh, root);
  for (const name of chain) {
    const cls = partClassOf(name);
    if (cls !== PART_CLASS.structure) return cls;
  }
  return chain.length === 0 ? partClassOf(root.name) : PART_CLASS.structure;
}

/** The ladder group a mesh belongs to: the TOPMOST named ancestor below the
 *  root (its own name if it has none). Topmost, not nearest: the model nests
 *  real sub-assemblies that are welded to their parent and must ride ONE rung
 *  with it. A `Grp_` ancestor is invisible here (see nameChain), so only real
 *  re-parents merge groups. */
function groupOf(mesh: THREE.Object3D, root: THREE.Object3D): string {
  const chain = nameChain(mesh, root);
  return chain.length > 0 ? chain[chain.length - 1] : "";
}

// ── The pieces ───────────────────────────────────────────────────────────────

// The frame fields are copied OUT of `local` rather than read through it,
// because adoption rewrites them for this piece while `local` stays the raw
// measurement.
interface Piece {
  /** The authored node this piece frames — its mesh. Naming, class and
   *  containment tests all read the NODE. */
  node: THREE.Object3D;
  local: LocalPiece;
  t0: number;
  R: number;
  span: number;
  axi: boolean;
  yMin: number;
  yMax: number;
  axialRoot: number; // centroid axial in ROOT space (ladder ordering only)
  group: string;
  cls: number;
  rank: number;
  phase: number;
  /** Pieces in this piece's rank layer (an adopted feature takes its host's).
   *  1 until step 3 fills it in. */
  layerN: number;
  rung: number;
  /** The GROUP name (not the mesh name) of the shell this component adopted its
   *  frame from — `ladderRungs` is keyed by group, so the lookup must be too. */
  hostGroup?: string;
  adoptFrom?: Piece;
}

function isUnder(obj: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent)
    if (o === ancestor) return true;
  return false;
}

// ── Adoption jobs ────────────────────────────────────────────────────────────

/** One adoption: every mesh under `features` takes a host piece's whole frame. */
interface AdoptJob {
  /** The host shell — its GROUP is the rung the features ride. */
  shell: THREE.Object3D;
  /** The adopting subtrees: a SHELL_ADOPT feature node, or one decal mesh. */
  features: THREE.Object3D[];
  /** The candidate host NODES when the job already knows them: the derived
   *  decal walk passes the host's own `_Seg` wedge nodes, because a host also
   *  carries descendants that are no sector to snap to (an on-axis t0 = 0 would
   *  win the nearest-meridian search). `null` = every non-feature piece under
   *  `shell`, the authored SHELL_ADOPT rule. */
  wedges: THREE.Object3D[] | null;
}

/** The segmented shell a mesh is printed ON: the NEAREST ancestor below the
 *  root that owns `<its name>_Seg<n>` wedge NODES, with those wedges' framed
 *  meshes. The walk is required — a decal nested two levels down is printed on
 *  the band it sits on, not on the anchor above it. Wedge NODES are returned,
 *  not meshes, and the adoption pass takes every piece framed under one. */
function segmentedHostOf(
  mesh: THREE.Object3D,
  root: THREE.Object3D,
): { host: THREE.Object3D; wedges: THREE.Object3D[] } | null {
  for (let a = mesh.parent; a && a !== root; a = a.parent) {
    const anc = a;
    if (!anc.name) continue;
    const wedges: THREE.Object3D[] = [];
    anc.traverse((o) => {
      if (isSegWedge(o.name) && o.name.startsWith(`${anc.name}_Seg`))
        wedges.push(o);
    });
    if (wedges.length > 0) return { host: anc, wedges };
  }
  return null;
}

/**
 * Every adoption the model asks for, authored and derived, as ONE list — the
 * input to the adoption pass and to the per-ISLAND measurement it needs.
 * AUTHORED JOBS MUST COME FIRST: a derived job rewrites its features' frames,
 * and an authored job's host pool may contain those same meshes.
 */
function adoptJobs(
  root: THREE.Object3D,
  unitOf: Map<THREE.Mesh, Unit>,
): AdoptJob[] {
  const jobs: AdoptJob[] = [];
  for (const [shellName, features] of Object.entries(SHELL_ADOPT)) {
    const shell = root.getObjectByName(shellName);
    if (!shell) continue;
    const objs = features
      .map((n) => root.getObjectByName(n))
      .filter((o): o is THREE.Object3D => o != null);
    if (objs.length === 0) continue;
    // A SEGMENTED shell hosts on its own `_SegN` wedges — the decal walk's
    // rule. An open pool over the whole subtree lets a nearest-meridian search
    // snap a feature onto a nested sub-assembly in a different rank layer, so
    // the pool stays open only for an UNSEGMENTED shell.
    const segs: THREE.Object3D[] = [];
    shell.traverse((o) => {
      if (isSegWedge(o.name) && o.name.startsWith(`${shell.name}_Seg`))
        segs.push(o);
    });
    jobs.push({
      shell,
      features: objs,
      wedges: segs.length > 0 ? segs : null,
    });
  }
  // Printed markings: same adoption, host MEASURED off the segmentation rather
  // than named. A decal with no segmented ancestor keeps its own derived frame,
  // which is how a lone decal or an accessory pass stays framed at all.
  const byHost = new Map<
    THREE.Object3D,
    { wedges: THREE.Object3D[]; features: THREE.Object3D[] }
  >();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || classOf(o, root) !== PART_CLASS.decal)
      return;
    // The adopting FEATURE is the decal's unit node — it adopts once, exactly
    // as it is framed once.
    const feature = unitOf.get(o)?.node ?? o;
    const found = segmentedHostOf(feature, root);
    if (!found) return;
    const entry = byHost.get(found.host) ?? {
      wedges: found.wedges,
      features: [],
    };
    if (!entry.features.includes(feature)) entry.features.push(feature);
    byHost.set(found.host, entry);
  });
  for (const [shell, { wedges, features }] of byHost)
    jobs.push({ shell, features, wedges });
  return jobs;
}

// ── The shrink-wrap binding ──────────────────────────────────────────────────
// A decal must follow its host's RENDERED, FACETED surface, not the ideal
// deformation curve: the op field at a facet-interior point is the smooth
// curve, the host renders the chord across the facet, and that L²/8R gap is the
// "text consumed by the part" artifact. So each decal vertex is BOUND to a host
// triangle, and the shader evaluates the deform at the three CORNERS and
// rebuilds the vertex from them.
//
// The binding is measured in the DECAL's local space, which works because the
// model has no node transforms below a part, so a host triangle and its decal
// share one frame. An export that moved a decal relative to its host would need
// this pass and the shader to agree on which space the corners live in.

/** The closest point on a triangle, its plane-projection barycentrics and the
 *  signed height, for one decal vertex. */
interface Binding {
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  u: number;
  v: number;
  h: number;
  /** Distance to the CLAMPED closest point — how the winning triangle is chosen. */
  dist: number;
}

/** Barycentric weights of `p`'s projection onto the triangle's plane, plus its
 *  signed height above it. Deliberately UNCLAMPED: for a vertex overhanging a
 *  facet edge the weights fall outside [0, 1], and that affine extension is
 *  what makes the recomposition exact where a clamped foot point would move
 *  the vertex. */
function bindTo(
  p: THREE.Vector3,
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
): { u: number; v: number; h: number } | null {
  const e1 = new THREE.Vector3().subVectors(p1, p0);
  const e2 = new THREE.Vector3().subVectors(p2, p0);
  const rel = new THREE.Vector3().subVectors(p, p0);
  const d00 = e1.dot(e1);
  const d01 = e1.dot(e2);
  const d11 = e2.dot(e2);
  const denom = d00 * d11 - d01 * d01;
  if (!(Math.abs(denom) > 1e-12)) return null; // degenerate sliver
  // `rel`'s out-of-plane part contributes nothing to either dot, so these are
  // the projection's weights without projecting first.
  const d20 = rel.dot(e1);
  const d21 = rel.dot(e2);
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
  return { u: 1 - v - w, v, h: rel.dot(n) };
}

/**
 * Bind every DECAL vertex to the closest triangle of its adopted host, and write
 * the `_wrap*` attributes. Runs after adoption (it rides the host mapping that
 * pass already resolved) and before the attributes are written.
 */
function bindDecals(pieces: Piece[]): void {
  // Host unit → its triangles, resolved once per host (several decals share one).
  const cache = new Map<
    Piece,
    {
      p0: THREE.Vector3;
      p1: THREE.Vector3;
      p2: THREE.Vector3;
      c: THREE.Vector3;
      r: number;
    }[]
  >();
  const byMesh = new Map<THREE.Mesh, Map<number, Binding>>();

  for (const pc of pieces) {
    const host = pc.adoptFrom;
    if (!host || pc.cls !== PART_CLASS.decal) continue;

    let tris = cache.get(host);
    if (!tris) {
      tris = [];
      const seen = new Set<THREE.Mesh>();
      for (const part of host.local.parts) {
        if (seen.has(part.mesh)) continue;
        seen.add(part.mesh);
        const geo = part.mesh.geometry;
        const pos = geo.getAttribute("position");
        if (!pos) continue;
        const idx = geo.getIndex();
        const count = idx ? idx.count : pos.count;
        for (let i = 0; i + 2 < count; i += 3) {
          const a = idx ? idx.getX(i) : i;
          const b = idx ? idx.getX(i + 1) : i + 1;
          const c = idx ? idx.getX(i + 2) : i + 2;
          const p0 = new THREE.Vector3().fromBufferAttribute(pos, a);
          const p1 = new THREE.Vector3().fromBufferAttribute(pos, b);
          const p2 = new THREE.Vector3().fromBufferAttribute(pos, c);
          const cen = new THREE.Vector3()
            .addVectors(p0, p1)
            .add(p2)
            .multiplyScalar(1 / 3);
          const r = Math.max(
            cen.distanceTo(p0),
            cen.distanceTo(p1),
            cen.distanceTo(p2),
          );
          tris.push({ p0, p1, p2, c: cen, r });
        }
      }
      cache.set(host, tris);
    }
    if (tris.length === 0) continue;

    const tri = new THREE.Triangle();
    const foot = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const part of pc.local.parts) {
      const pos = part.mesh.geometry.getAttribute("position");
      let table = byMesh.get(part.mesh);
      if (!table) {
        table = new Map();
        byMesh.set(part.mesh, table);
      }
      for (const vi of part.verts) {
        p.fromBufferAttribute(pos, vi);
        let best: Binding | null = null;
        for (const t of tris) {
          // Cheap admissibility bound: a triangle cannot be closer than the gap
          // to its bounding sphere, so most are rejected without the exact test.
          if (best && p.distanceTo(t.c) - t.r > best.dist) continue;
          tri.set(t.p0, t.p1, t.p2);
          tri.closestPointToPoint(p, foot);
          const d = foot.distanceTo(p);
          if (best && d >= best.dist) continue;
          const b = bindTo(p, t.p0, t.p1, t.p2);
          if (!b) continue;
          best = { p0: t.p0, p1: t.p1, p2: t.p2, ...b, dist: d };
        }
        if (best) table.set(vi, best);
      }
    }
  }

  for (const [mesh, table] of byMesh) {
    const n = mesh.geometry.getAttribute("position").count;
    const a = new Float32Array(n * 4);
    const b = new Float32Array(n * 4);
    const c = new Float32Array(n * 4);
    for (const [i, bind] of table) {
      a.set([bind.p0.x, bind.p0.y, bind.p0.z, bind.u], i * 4);
      b.set([bind.p1.x, bind.p1.y, bind.p1.z, bind.v], i * 4);
      c.set([bind.p2.x, bind.p2.y, bind.p2.z, bind.h], i * 4);
    }
    mesh.geometry.setAttribute("_wrapA", new THREE.BufferAttribute(a, 4));
    mesh.geometry.setAttribute("_wrapB", new THREE.BufferAttribute(b, 4));
    mesh.geometry.setAttribute("_wrapC", new THREE.BufferAttribute(c, 4));
    // Dead lanes: dropping them keeps the BOUND attribute count off the WebGPU
    // 8-vertex-buffer ceiling the three `_wrap*` buffers bring it up to.
    for (const dead of ["uv", "uv1", "_bloomtheta0", "_bloomr", "_bloomgroup"])
      if (mesh.geometry.getAttribute(dead)) mesh.geometry.deleteAttribute(dead);
  }
}

/**
 * Give every mesh under `root` a BufferGeometry of its own. This pass writes
 * per-piece results as attributes ON THE GEOMETRY, and GLTFLoader hands
 * instanced nodes the SAME BufferGeometry, so sharing would let each instance's
 * `_op*` write clobber the last. Runs before ANY measurement, so nothing
 * downstream has to know about instancing.
 */
function unshareGeometries(root: THREE.Object3D): void {
  const seen = new Set<THREE.BufferGeometry>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry) return;
    if (seen.has(o.geometry)) o.geometry = o.geometry.clone();
    else seen.add(o.geometry);
  });
}

/**
 * Measure every mesh under `root` and write the `_op*` frame attributes,
 * returning the derived ladder (group → signed rung, model-mm) and each layer's
 * piece count. Run once at load, after the model is assembled and BEFORE the
 * first material build — the deform graph reads these attributes.
 */
export function deriveFrames(
  root: THREE.Object3D,
  overrides?: {
    tierOrder?: Record<string, number>;
    /** Root-space Y of the rear/front split plane, replacing the derived
     *  `Chassis_Fixed` bounds midpoint — so an anchor strategy can be A/B'd from
     *  the caller instead of by editing this file. */
    anchorY?: number;
  },
): DerivedFrames {
  // Instanced meshes must not share the geometry the frames are written onto.
  unshareGeometries(root);
  root.updateWorldMatrix(true, true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  // 1. measure every UNIT (its own local space), plus its root-space axial
  //    centroid for the ladder. ONE frame per authored node, except a
  //    SHELL_ADOPT feature, which is split into islands.
  const { units, unitOf } = unitsOf(root);
  const adoptions = adoptJobs(root, unitOf);
  const featureRoots = adoptions.flatMap((a) => a.features);
  const pieces: Piece[] = [];
  const byMesh = new Map<THREE.Mesh, Piece[]>();
  const toRoot = new THREE.Matrix4();
  const p = new THREE.Vector3();
  for (const unit of units) {
    // Accessories NEVER join this pass — scene.ts gives each its own. They load
    // in the BACKGROUND, so without this skip the rank normalization span
    // depends on a race: an accessory's larger radii rescale EVERY body rank
    // and the calibrated rank bands select a different cast per load. The
    // `!== root` guard keeps the scoped accessory pass itself framing.
    if (unit.node !== root && classOf(unit.node, root) === PART_CLASS.accessory)
      continue;
    const perIsland = featureRoots.some((f) => isUnder(unit.node, f));
    const locals = perIsland ? measureComponents(unit) : measureWhole(unit);
    // ONE matrix takes every measurement of this unit to root space.
    toRoot.multiplyMatrices(rootInv, unit.node.matrixWorld);
    const group = groupOf(unit.node, root);
    const cls = classOf(unit.node, root);
    const mine = locals.map((local) => {
      p.set(local.cx, local.cy, local.cz).applyMatrix4(toRoot);
      return {
        node: unit.node,
        local,
        t0: local.t0,
        R: local.R,
        span: local.span,
        axi: local.axi,
        yMin: local.yMin,
        yMax: local.yMax,
        axialRoot: p.y,
        group,
        cls,
        rank: 0,
        phase: 0,
        layerN: 1,
        rung: 0,
      } satisfies Piece;
    });
    // A piece writes to every mesh it owns vertices in.
    for (const pc of mine)
      for (const part of pc.local.parts) {
        const list = byMesh.get(part.mesh);
        if (list) list.push(pc);
        else byMesh.set(part.mesh, [pc]);
      }
    pieces.push(...mine);
  }

  // 2. feature adoption — a bolted feature or a printed marking takes its host
  //    shell's R (hence its rank and layer), snaps t0 to the nearest host
  //    sector centre, and inherits that WEDGE's span/yExt/axi so it normalizes
  //    over the wedge's extent rather than its own (see the header).
  for (const { shell, features: featureObjs, wedges } of adoptions) {
    const hostGroup = groupOf(shell, root) || shell.name;
    const hostPieces = pieces.filter((pc) =>
      wedges
        ? wedges.some((w) => isUnder(pc.node, w))
        : isUnder(pc.node, shell) &&
          !featureObjs.some((f) => isUnder(pc.node, f)),
    );
    if (hostPieces.length === 0) continue;
    for (const fo of featureObjs) {
      for (const pc of pieces) {
        if (!isUnder(pc.node, fo)) continue;
        let best = hostPieces[0];
        let bd = Infinity;
        for (const hp of hostPieces) {
          const d = Math.abs(wrapPi(pc.t0 - hp.t0));
          if (d < bd) {
            bd = d;
            best = hp;
          }
        }
        // The snapped host UNIT's frame, copied EXACTLY — R included. Anything
        // approximate puts the adopter in a different rank bucket and gate
        // slot, and it drifts off the wedge it is printed on. Every lane below
        // ends byte-identical to the host's, `cls` and `adopted` excepted.
        //
        // THAT IDENTITY IS THE WHOLE MECHANISM: do not reintroduce a
        // special-case chart for any adopter without first checking that its
        // lanes really are identical to its host's.
        pc.t0 = best.t0;
        pc.R = best.R;
        pc.span = best.span;
        pc.axi = best.axi;
        pc.yMin = best.yMin;
        pc.yMax = best.yMax;
        pc.hostGroup = hostGroup;
        pc.adoptFrom = best;
      }
    }
  }

  // 2b. SHRINK-WRAP: bind every decal vertex to a host triangle, so it rides the
  //     faceted surface its host actually draws rather than the smooth field.
  bindDecals(pieces);

  // 3. rank + layer phase. The rank law: 0.01mm radius buckets, normalized
  //    across the model's radius SPAN by VALUE — the sorted ORDER would space
  //    shells equally and interleave them mid-flight. Phase orders each layer's
  //    own pieces by meridian.
  const rKeyOf = (pc: Piece): number => rankKeyOf(pc.R);
  const keys = [...new Set(pieces.map(rKeyOf))].sort((a, b) => a - b);
  const lo = keys[0];
  const hi = keys[keys.length - 1];
  const rankOfKey = (key: number): number =>
    keys.length < 2
      ? 0.5
      : Math.min(1, Math.max(0, (key - lo) / Math.max(1, hi - lo)));
  for (const pc of pieces) pc.rank = rankOfKey(rKeyOf(pc));

  const layers = new Map<number, Piece[]>();
  for (const pc of pieces) {
    if (pc.adoptFrom) continue; // rides a wedge; not a piece OF the layer
    const key = rKeyOf(pc);
    const list = layers.get(key);
    if (list) list.push(pc);
    else layers.set(key, [pc]);
  }
  const layerCount = new Map<number, number>();
  for (const [key, list] of layers) {
    list.sort((a, b) => a.t0 - b.t0);
    list.forEach((pc, i) => (pc.phase = i / list.length));
    layerCount.set(key, list.length);
  }
  // An adopted feature takes the phase of the wedge it snapped to — it must fly
  // on that wedge's timeline, which is the whole point of adopting its frame.
  for (const pc of pieces) if (pc.adoptFrom) pc.phase = pc.adoptFrom.phase;
  // Layer POPULATION: how many pieces share this piece's rank layer, an adopted
  // feature reading its HOST wedge's. Informational only. The `?? 1` is
  // defensive — every non-adopted piece is in `layers` by construction.
  for (const pc of pieces)
    pc.layerN = layerCount.get(rankKeyOf((pc.adoptFrom ?? pc).R)) ?? 1;

  // 4. the derived ladder. Rear/front split against the anchor's axial centre,
  //    each side ordered outward, uniform steps landing the outermost group
  //    exactly on the authored reach.
  const anchorObj = root.getObjectByName(ANCHOR_PART);
  let anchorY = 0;
  if (anchorObj && overrides?.anchorY === undefined) {
    const bounds = new THREE.Box3();
    const m = new THREE.Matrix4();
    anchorObj.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.geometry?.getAttribute("position"))
        return;
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      if (!bb) return;
      bounds.union(
        bb.clone().applyMatrix4(m.multiplyMatrices(rootInv, o.matrixWorld)),
      );
    });
    if (!bounds.isEmpty()) anchorY = (bounds.min.y + bounds.max.y) / 2;
  }
  if (overrides?.anchorY !== undefined) anchorY = overrides.anchorY;

  interface GroupAgg {
    name: string;
    axial: number;
    weight: number;
    onLadder: boolean;
  }
  const groups = new Map<string, GroupAgg>();
  for (const pc of pieces) {
    if (!pc.group) continue;
    let g = groups.get(pc.group);
    if (!g) {
      g = { name: pc.group, axial: 0, weight: 0, onLadder: false };
      groups.set(pc.group, g);
    }
    const w = pc.local.count;
    g.axial += pc.axialRoot * w;
    g.weight += w;
    // Off the ladder: adopted hardware (rides its host), the anchor itself
    // (rung 0 by definition), printed markings and removable accessories (they
    // ride whatever they are parented to, or stay home).
    if (
      !pc.adoptFrom &&
      pc.group !== ANCHOR_PART &&
      pc.cls !== PART_CLASS.decal &&
      pc.cls !== PART_CLASS.accessory
    )
      g.onLadder = true;
  }
  const ladderRungs = new Map<string, number>();
  for (const g of groups.values()) ladderRungs.set(g.name, 0);
  const candidates = [...groups.values()].filter(
    (g) => g.onLadder && g.weight > 0,
  );
  const sides: [GroupAgg[], number, number][] = [
    [candidates.filter((g) => g.axial / g.weight < anchorY), -1, REACH_REAR],
    [candidates.filter((g) => g.axial / g.weight >= anchorY), 1, REACH_FRONT],
  ];
  for (const [side, direction, reach] of sides) {
    side.sort(
      (a, b) =>
        Math.abs(a.axial / a.weight - anchorY) -
        Math.abs(b.axial / b.weight - anchorY),
    );
    side.forEach((g, i) =>
      ladderRungs.set(g.name, (direction * reach * (i + 1)) / side.length),
    );
  }
  // Authored overrides win over the derived ordering, by group name...
  const tierOrder = new Map(Object.entries(overrides?.tierOrder ?? {}));
  for (const [name, rung] of tierOrder) ladderRungs.set(name, rung);
  // ...and an adopted feature rides its (possibly overridden) host's rung.
  for (const pc of pieces) {
    if (!pc.hostGroup || !pc.group || tierOrder.has(pc.group)) continue;
    ladderRungs.set(pc.group, ladderRungs.get(pc.hostGroup) ?? 0);
  }
  for (const pc of pieces)
    pc.rung =
      tierOrder.get(pc.node.name) ??
      tierOrder.get(pc.group) ??
      ladderRungs.get(pc.hostGroup ?? pc.group) ??
      0;

  // 5. write the attributes — one constant per piece, per vertex. Attributes
  //    live on the GEOMETRY, so this is only well-defined because
  //    `unshareGeometries` above gave every mesh its own.
  for (const [mesh, mine] of byMesh) {
    const n = mesh.geometry.getAttribute("position").count;
    // Packed lanes, see FRAME_ATTRS: A = (t0, R, span, rank),
    // B = (phase, class, rung, axi), Y = (yMin, yMax, layerN, adopted).
    const a = new Float32Array(n * 4);
    const b = new Float32Array(n * 4);
    const y = new Float32Array(n * 4);
    for (const pc of mine) {
      // Only the vertices this piece owns IN THIS MESH.
      const part = pc.local.parts.find((pt) => pt.mesh === mesh);
      if (!part) continue;
      for (const i of part.verts) {
        a[i * 4] = pc.t0;
        a[i * 4 + 1] = pc.R;
        a[i * 4 + 2] = pc.span;
        a[i * 4 + 3] = pc.rank;
        b[i * 4] = pc.phase;
        b[i * 4 + 1] = pc.cls;
        b[i * 4 + 2] = pc.rung;
        b[i * 4 + 3] = pc.axi ? 1 : 0;
        y[i * 4] = pc.yMin;
        y[i * 4 + 1] = pc.yMax;
        y[i * 4 + 2] = pc.layerN;
        y[i * 4 + 3] = pc.adoptFrom ? 1 : 0;
      }
    }
    const set = (name: string, data: Float32Array, itemSize: number): void => {
      mesh.geometry.setAttribute(
        name,
        new THREE.BufferAttribute(data, itemSize),
      );
    };
    set("_opA", a, 4);
    set("_opB", b, 4);
    set("_opY", y, 4);
  }

  return { ladderRungs, layerCount };
}
