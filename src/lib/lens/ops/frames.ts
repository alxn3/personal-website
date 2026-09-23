// Load-time derivation: every per-piece constant the op pipeline reads is
// measured from the geometry here and written as vertex attributes. May import
// three (CPU, at load); the ops never do.
//
// The framing unit is one glTF node (= one Blender object = one THREE.Mesh),
// measured in the unit's own local space; only the ladder is root space.
// Two adoptions override the measurement so a rigid sub-assembly cannot fly
// apart: bolted hardware and decals copy their host wedge's frame (SHELL_ADOPT;
// the component split exists so each screw snaps to its own wedge), and the
// explode rung is per group. Adoption governs the ring, not thinness: bolted
// hardware keeps its own wall extent in `depth` (never shallower than the
// host's), only a decal — a printed skin — takes the host's. The ladder is
// derived about the Chassis_Fixed anchor; `overrides.tierOrder` /
// `overrides.anchorY` override it.

import * as THREE from "three/webgpu";
import { isGraphGroup, isSegWedge, partClassOf } from "../core/parts";
import { PART_CLASS } from "./ops";

/** The generated attributes: Float32 vectors, each field held constant over its
 *  piece, packed into three (WebGPU allows at most 8 vertex buffers per
 *  pipeline, and a decal's three `_wrap*` lanes fill the rest). JS reads them
 *  through `frameOf`; the shader unpacks in host.ts.
 *
 *    `_opA` = (t0, R, span, rank)
 *    `_opB` = (phase, class, rung, flags)   flags = axi + 2·adopted
 *    `_opY` = (yMin, yMax, depth, wink)     wink: core/visibility.ts packWink */
export const FRAME_ATTRS = [
  { name: "_opA", size: 4 },
  { name: "_opB", size: 4 },
  { name: "_opY", size: 4 },
] as const;

/** The SHRINK-WRAP BINDING a decal vertex rides, written by `bindDecals`: the
 *  host triangle it sits on, in the mesh's own local space. Only DECAL meshes
 *  carry these. `u·p0 + v·p1 + w·p2 + h·n̂` decomposes the vertex in the
 *  complete basis {p1−p0, p2−p0, n̂}, reproducing the authored position.
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
  /** Radial depth: the piece's widest wall offset from R, as a fraction of R.
   *  An adopted feature measures it about its HOST's R, floored at the host's. */
  depth: number;
  /** 1 when the frame was adopted from a host shell wedge (SHELL_ADOPT). */
  adopted: number;
  /** the packed wink lane (core/visibility.ts `packWink`); WINK_NONE until
   *  `stampWinkLanes` runs */
  wink: number;
}

/** `_opB.w` carries the two 0/1 flags as one integer: axi + 2·adopted. */
export const packFlags = (axi: number, adopted: number): number =>
  axi + 2 * adopted;

export const unpackFlags = (
  flags: number,
): { axi: number; adopted: number } => {
  const adopted = Math.floor(flags * 0.5);
  return { axi: flags - 2 * adopted, adopted };
};

/** The wink lane's value before `stampWinkLanes`: a piece no fade governs. */
export const WINK_NONE = -1;

/**
 * Read one vertex's frame off a geometry, unpacking the three attributes.
 * `null` when the geometry carries no frame.
 */
export function frameOf(
  geo: THREE.BufferGeometry,
  vertexIndex = 0,
): Frame | null {
  const a = geo.getAttribute("_opA");
  const b = geo.getAttribute("_opB");
  const y = geo.getAttribute("_opY");
  if (!a || !b || !y) return null;
  const { axi, adopted } = unpackFlags(b.getW(vertexIndex));
  return {
    t0: a.getX(vertexIndex),
    R: a.getY(vertexIndex),
    span: a.getZ(vertexIndex),
    rank: a.getW(vertexIndex),
    phase: b.getX(vertexIndex),
    cls: b.getY(vertexIndex),
    rung: b.getZ(vertexIndex),
    axi,
    yMin: y.getX(vertexIndex),
    yMax: y.getY(vertexIndex),
    depth: y.getZ(vertexIndex),
    adopted,
    wink: y.getW(vertexIndex),
  };
}

/** Non-segmented hardware BOLTED to a segmented shell: host → features. */
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
   *  features are NOT counted; they ride a wedge rather than being one. */
  layerCount: Map<number, number>;
}

// Radius floor, model-mm: an on-axis piece measures R ≈ 0, and R is a divisor
// all over the op algebra.
const R_MIN = 0.5;
// Coincident-position bucket, 1/mm ⇒ 1e-3 mm: seam-duplicated vertices share a
// bucket, genuinely separate islands do not.
const POS_QUANT = 1e3;
// Radius rank bucket, 1/mm ⇒ 0.01 mm.
const RADIUS_QUANT = 100;
// Axisymmetry thresholds: centroid offset as a fraction of R, and how far short
// of 2π a full-turn span may fall.
const AXI_CENTROID_FRAC = 0.02;
const AXI_SPAN_EPS = 0.15;
// The two authored ladder distances.
const REACH_REAR = 70; // mm, rearmost extent
const REACH_FRONT = 95; // mm, frontmost extent
// The part whose axial centre splits rear from front (and holds rung 0).
const ANCHOR_PART = "Chassis_Fixed";

const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** The layer key a radius falls in — `DerivedFrames.layerCount`'s key. */
export const rankKeyOf = (R: number): number => Math.round(R * RADIUS_QUANT);

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── Connected components ─────────────────────────────────────────────────────
// Union-find over triangle indices PLUS coincident positions, so a ring of
// screws modelled as one mesh resolves to one island per screw. ONLY
// SHELL_ADOPT features are split this way; every other mesh is framed whole.

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
// carry no material slots, so the exporter emits ONE primitive per mesh.

/** One authored node and its mesh: the class/group walks and the adoption pass
 *  address the NODE, while the measured vertices live on the mesh. */
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
  /** max |r − R| / R over the vertices — a sheet is thin, a body is deep. */
  depth: number;
  cx: number;
  cy: number;
  cz: number;
}

/** Measure ONE vertex set as a single frame — the shared body of both framing
 *  granularities (a whole UNIT, or one island of an adopted feature). */
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
  let depth = 0;
  for (const r of radii) depth = Math.max(depth, Math.abs(r - R) / R);
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
  // Axisymmetry: an on-axis centroid, or a span that still wraps the full turn
  // (cutouts and lobes can pull the centroid off the axis).
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
    depth,
    cx,
    cy,
    cz,
  };
}

/** max |r − R| / R over every vertex under `node` about a GIVEN R — the wall
 *  extent a bend about that radius strains. */
function wallDepthOf(node: THREE.Object3D, R: number): number {
  let depth = 0;
  node.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++)
      depth = Math.max(
        depth,
        Math.abs(Math.hypot(pos.getX(i), pos.getZ(i)) - R) / R,
      );
  });
  return depth;
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

/** The SHELL_ADOPT granularity: one frame per ISLAND, so each screw snaps to
 *  its own host wedge. */
function measureComponents(unit: Unit): LocalPiece[] {
  return unit.meshes.flatMap((mesh) =>
    componentsOf(mesh.geometry).map((verts) => measureVerts([{ mesh, verts }])),
  );
}

// ── Naming: class and ladder group ───────────────────────────────────────────

/** The name chain from a node up to (not including) the root, keeping only PART
 *  IDENTITY names — `Grp_*` graph empties are skipped (`isGraphGroup`), so
 *  their members keep their own separate ladder rungs. */
function nameChain(obj: THREE.Object3D, root: THREE.Object3D): string[] {
  const names: string[] = [];
  for (let o: THREE.Object3D | null = obj; o && o !== root; o = o.parent)
    if (o.name && !isGraphGroup(o.name)) names.push(o.name);
  return names;
}

/** A mesh's part class: its OWN name if that name classifies it, else the
 *  nearest classed ancestor, so a `<Part>_SegN` wedge takes its part's class.
 *  The chain excludes the root, so an empty chain (the mesh IS the root, as in
 *  scene.ts's per-accessory pass) reads the root's own name. */
function classOf(mesh: THREE.Object3D, root: THREE.Object3D): number {
  const chain = nameChain(mesh, root);
  for (const name of chain) {
    const cls = partClassOf(name);
    if (cls !== PART_CLASS.structure) return cls;
  }
  return chain.length === 0 ? partClassOf(root.name) : PART_CLASS.structure;
}

/** The ladder group a mesh belongs to: the TOPMOST named ancestor below the
 *  root (its own name if it has none), so nested sub-assemblies ride ONE rung
 *  with their parent. `Grp_` ancestors are invisible here (see nameChain). */
function groupOf(mesh: THREE.Object3D, root: THREE.Object3D): string {
  const chain = nameChain(mesh, root);
  return chain.length > 0 ? chain[chain.length - 1] : "";
}

// ── The pieces ───────────────────────────────────────────────────────────────

// The frame fields are copied OUT of `local`: adoption rewrites them for this
// piece while `local` stays the raw measurement.
interface Piece {
  /** The authored node this piece frames. Naming, class and containment tests
   *  all read the NODE. */
  node: THREE.Object3D;
  local: LocalPiece;
  t0: number;
  R: number;
  span: number;
  axi: boolean;
  yMin: number;
  yMax: number;
  depth: number;
  axialRoot: number; // centroid axial in ROOT space (ladder ordering only)
  group: string;
  cls: number;
  rank: number;
  phase: number;
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
  /** The candidate host NODES when the job already knows them — the host's own
   *  `_Seg` wedge nodes, so non-sector descendants cannot win the
   *  nearest-meridian search. `null` = any non-feature piece under `shell`. */
  wedges: THREE.Object3D[] | null;
}

/** The segmented shell a mesh is printed ON: the NEAREST ancestor below the
 *  root that owns `<its name>_Seg<n>` wedge NODES, plus those wedge nodes. The
 *  adoption pass takes every piece framed under one. */
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
 * Every adoption the model asks for, authored and derived, as ONE list.
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
    // A SEGMENTED shell hosts on its own `_SegN` wedges; the pool stays open
    // over the whole subtree only for an UNSEGMENTED shell.
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
  // than named. A decal with no segmented ancestor keeps its own derived frame.
  const byHost = new Map<
    THREE.Object3D,
    { wedges: THREE.Object3D[]; features: THREE.Object3D[] }
  >();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || classOf(o, root) !== PART_CLASS.decal)
      return;
    // The adopting FEATURE is the decal's unit node: it adopts once, as it is
    // framed once.
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
// Each decal vertex is BOUND to a host triangle so it follows the host's
// RENDERED, FACETED surface rather than the smooth op field; the shader
// evaluates the deform at the three CORNERS and rebuilds the vertex from them.
// Bindings are measured in the DECAL's local space, valid only because the
// model has no node transforms below a part — a host triangle and its decal
// share one frame.

/** The closest point on a triangle, its plane-projection barycentrics and the
 *  signed height, for one decal vertex. */
interface Binding {
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  u: number;
  v: number;
  h: number;
  /** Distance to the CLAMPED closest point — how the winning triangle is
   *  chosen. */
  dist: number;
}

/** Barycentric weights of `p`'s projection onto the triangle's plane, plus its
 *  signed height above it. Deliberately UNCLAMPED: a vertex overhanging a facet
 *  edge gets weights outside [0, 1], and that affine extension is what keeps
 *  the recomposition exact. */
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
 * Bind every DECAL vertex to the closest triangle of its adopted host and write
 * the `_wrap*` attributes. Must run after adoption (it rides that pass's host
 * mapping) and before the frame attributes are written.
 */
function bindDecals(pieces: Piece[]): void {
  // Host unit → its triangles, resolved once per host.
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
          // Admissibility bound: a triangle cannot be closer than the gap to
          // its bounding sphere.
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
    // Drop dead lanes: the three `_wrap*` buffers would otherwise push the
    // bound attribute count past the WebGPU 8-vertex-buffer ceiling.
    for (const dead of ["uv", "uv1", "_bloomtheta0", "_bloomr", "_bloomgroup"])
      if (mesh.geometry.getAttribute(dead)) mesh.geometry.deleteAttribute(dead);
  }
}

/**
 * Give every mesh under `root` a BufferGeometry of its own: GLTFLoader hands
 * instanced nodes the SAME geometry, and each instance's `_op*` write would
 * clobber the last. Must run before ANY measurement.
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
     *  `Chassis_Fixed` bounds midpoint. */
    anchorY?: number;
  },
): DerivedFrames {
  // Instanced meshes must not share the geometry the frames are written onto.
  unshareGeometries(root);
  root.updateWorldMatrix(true, true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  // 1. measure every UNIT in its own local space, plus its root-space axial
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
    // Accessories NEVER join this pass — scene.ts gives each its own, so their
    // radii cannot rescale the model's rank normalization. The `!== root` guard
    // keeps that scoped accessory pass itself framing.
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
        depth: local.depth,
        axialRoot: p.y,
        group,
        cls,
        rank: 0,
        phase: 0,
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
  //    sector centre, and inherits that WEDGE's span/yExt/axi.
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
        // The snapped host UNIT's frame, copied EXACTLY — R included. Every
        // lane below must end byte-identical to the host's, `cls`, `adopted`
        // and hardware's `depth` excepted, or the adopter lands in a different
        // rank bucket.
        pc.t0 = best.t0;
        pc.R = best.R;
        pc.span = best.span;
        pc.axi = best.axi;
        pc.yMin = best.yMin;
        pc.yMax = best.yMax;
        // A decal is a skin on the host's surface and must deform with the
        // host's facets bit for bit; bolted hardware bends only if the WHOLE
        // feature (every island of its node) is a thin wall about the host's R
        // AND the host bends, so a solid's islands never part.
        pc.depth =
          pc.cls === PART_CLASS.decal
            ? best.depth
            : Math.max(best.depth, wallDepthOf(pc.node, best.R));
        pc.hostGroup = hostGroup;
        pc.adoptFrom = best;
      }
    }
  }

  // 2b. SHRINK-WRAP: bind every decal vertex to a host triangle, so it rides
  //     the faceted surface its host draws rather than the smooth field.
  bindDecals(pieces);

  // 3. rank + layer phase. Rank: 0.01mm radius buckets, normalized across the
  //    model's radius SPAN by VALUE, not sorted order. Phase orders each
  //    layer's own pieces by meridian.
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
  // An adopted feature takes the phase of the wedge it snapped to, so it flies
  // on that wedge's timeline.
  for (const pc of pieces) if (pc.adoptFrom) pc.phase = pc.adoptFrom.phase;

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
    // (rung 0 by definition), printed markings and removable accessories.
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
  // ...and a group made only of adopted features reports its host's rung. A
  // group that also holds own-framed pieces keeps its derived rung; every
  // adopted piece reads its host's below regardless.
  for (const pc of pieces) {
    if (!pc.hostGroup || !pc.group || tierOrder.has(pc.group)) continue;
    if (groups.get(pc.group)?.onLadder) continue;
    ladderRungs.set(pc.group, ladderRungs.get(pc.hostGroup) ?? 0);
  }
  for (const pc of pieces)
    pc.rung =
      tierOrder.get(pc.node.name) ??
      tierOrder.get(pc.group) ??
      ladderRungs.get(pc.hostGroup ?? pc.group) ??
      0;

  // 5. write the attributes — one constant per piece, per vertex, onto the
  //    per-mesh geometries `unshareGeometries` created above.
  for (const [mesh, mine] of byMesh) {
    const n = mesh.geometry.getAttribute("position").count;
    // Packed lanes, see FRAME_ATTRS: A = (t0, R, span, rank),
    // B = (phase, class, rung, flags), Y = (yMin, yMax, depth, wink).
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
        b[i * 4 + 3] = packFlags(pc.axi ? 1 : 0, pc.adoptFrom ? 1 : 0);
        y[i * 4] = pc.yMin;
        y[i * 4 + 1] = pc.yMax;
        y[i * 4 + 2] = pc.depth;
        y[i * 4 + 3] = WINK_NONE;
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
