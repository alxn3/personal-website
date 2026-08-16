// The load-time derivation pass: every per-piece constant the op pipeline reads
// is MEASURED from the geometry here, once, and written as vertex attributes.
// Nothing about a piece's frame is authored upstream — no baked attributes, no
// hand table — so a re-cut model (7 wedges in one layer, 5 in the next) needs no
// table edit anywhere.
//
// THE FRAMING UNIT IS THE AUTHORING UNIT — one set of values per glTF NODE, i.e.
// per Blender object (`unitsOf` below). A node is ONE mesh: the web GLBs carry
// no materials, so the exporter emits a single primitive per mesh and the
// multi-primitive groups that used to split one physical wedge across several
// meshes no longer exist (lens_work MIGRATION §2). One failure still brackets
// the unit rule:
//
//   • too FINE (per island): a real part is one mesh carrying many islands —
//     `PCB_Components_Seg3` is a board sliver plus dozens of soldered
//     components, a shim ring is an annulus plus its relief cutouts — and
//     framing those separately measured a tiny frame per solder blob, which
//     dropped the whole piece out of the wrap the classic gave it as ONE
//     stamped sheet.
//
// So per NODE we measure:
//
//   t0    centroid meridian of the WHOLE unit, atan2(centroidZ, centroidX)
//   R     MEDIAN vertex radius over the whole unit, clamped to ≥ R_MIN (the
//         R = 0 NaN guard, at the source: a median shrugs off the odd vertex
//         dragged onto the axis, and no downstream op ever divides by zero)
//   span  true angular extent of the whole unit about t0 (the old global
//         EVEN_SPAN was simply wrong for the 7-cut layers)
//   axi   axisymmetric flag — a full ring/tube/disc has an ON-AXIS centroid, so
//         its t0 is atan2 of two near-zeroes, i.e. pure float noise that would
//         differ run to run and per re-export. Such a unit is pinned to the
//         DETERMINISTIC frame t0 = 0, span = 2π and flagged, so ops and selectors
//         can tell "this piece has no meridian" from "this piece points there"
//   yExt  axial extents (yMin, yMax), packed for the ops' `yN`
//   layerN the PIECE COUNT of the piece's own rank layer — "is this a lone body
//         or one wedge of a cut shell". Informational: it is a measurement over
//         0.01mm radius buckets, too tight to carry a participation decision
//         (the sheet selector reads the measured SPAN instead)
//   rank  0.01mm-bucketed radius key, VALUE-normalized over the model's radius
//         span (value, not order, so a grip ring 0.3mm off its barrel ranks
//         0.3mm away from it, not a whole slot)
//   phase index/count of the piece within its LAYER (its rank bucket), ordered by
//         t0 — replaces the angle-derived stagger the classic formations used
//
// The CONNECTED-COMPONENT split (union-find over triangle indices PLUS coincident
// positions) exists for ONE job: the
// SHELL_ADOPT pass below, where each screw of a `Mount_Screws` mesh must snap to
// its own host wedge. Adopted feature meshes therefore keep per-component values
// — the ONE place a finer grain than the unit is deliberate; every other node
// carries one uniform set.
//
// SPACES. Frames are measured in the UNIT's own local space, because that is the
// space the shader's `position` attribute lives in. The ladder (below) is
// the one thing measured in ROOT space, because "which side of the chassis is
// this on" is a question about the assembled model, not about one node's origin.
//
// TWO ADOPTIONS override the measurement, both because a rigid sub-assembly must
// not fly apart:
//
//   1. Feature adoption — hardware bolted onto a segmented shell (mount screws,
//      contacts; the focus motor + guide rods) and every PRINTED MARKING live in
//      their own meshes but are not part of the shell that fans open. Each
//      feature component snaps to the nearest host sector centre and copies
//      that wedge UNIT's frame EXACTLY — t0, R (hence rank and layer), span,
//      yMin/yMax and the axisymmetric flag — so it rides that one wedge instead
//      of stretching between two. Exactly, not approximately: the ops normalize
//      position over (t0, span, yExt), so a screw left on its own ~0.08 rad arc
//      and 2mm of height bends over its own material extent and peels off the
//      wedge it is bolted to — and an adopter left on a host-POOL median radius
//      lands in a different rank bucket and a different gate slot from the wedge
//      it is printed on, which is exactly how the decals drifted. After this the
//      adopter and its host present the deform IDENTICAL lanes; `class` and
//      `adopted` are the only two that differ.
//
//      The host comes from two places through ONE pass (`adoptJobs`): the
//      AUTHORED `SHELL_ADOPT` table for bolted hardware, and a DERIVED walk for
//      printed markings — the nearest ancestor owning `<name>_Seg<n>` wedges IS
//      the shell a decal is printed on. Participation is measured, not named:
//      a decal needs no table row, and a re-cut model re-derives its hosts.
//   2. Ladder grouping — the explode rung is per GROUP (the topmost named
//      ancestor below the root), so a shell's wedges, its decals and any part
//      parented under it all travel together, exactly as the authored tier table
//      grouped them by hand.
//
// The ladder is DERIVED, not authored: rear/front split by axial centroid
// against the Chassis_Fixed anchor, each side ordered outward and stepped
// uniformly to the two reach anchors. Ordering and grouping were art direction;
// they are measurements now, so `overrides.tierOrder` exists for the places art
// direction disagrees with the geometry, and `overrides.anchorY` moves the split
// plane itself for A/B-ing anchor strategies.
//
// This file MAY import three (it runs on the CPU at load); the ops themselves
// never do.

import * as THREE from "three/webgpu";
import { isGraphGroup, isSegWedge, partClassOf } from "../core/parts";
import { PART_CLASS } from "./ops";

/** The generated attributes: THREE Float32 vectors, each field held constant
 *  over its piece (the mesh, or a component of an adopted feature mesh). The
 *  twelve frame fields are PACKED into three attributes rather than written
 *  one-per-name because WebGPU allows at most 8 vertex buffers per pipeline —
 *  nine `_op*` attributes plus position/normal/uv blew that limit and the model
 *  rendered INVISIBLE in several material variants.
 *
 *  Lanes:
 *    `_opA` = (t0, R, span, rank)
 *    `_opB` = (phase, class, rung, axi)
 *    `_opY` = (yMin, yMax, layerN, adopted)
 *
 *  `layerN` is the piece count of the piece's own rank layer: 1 for a lone ring
 *  or a solitary body, N for one wedge of an N-cut shell. Informational — the
 *  0.01mm rank bucket is too tight for measured medians to make it a reliable
 *  participation signal.
 *
 *  `adopted` is a 0/1 flag: 1 marks a piece whose frame was taken from a host
 *  shell wedge (SHELL_ADOPT), i.e. bolted hardware that RIDES a segmented shell.
 *  It is the measured half of the classic's baked participation flag — such a
 *  piece goes wherever its host goes.
 *
 *  `axi` is a 0/1 flag: 1 marks an axisymmetric component (full ring, tube or
 *  disc), whose t0 is pinned to 0 and span to 2π because a body of revolution
 *  has no meaningful meridian — read it wherever "fan this open about its sector
 *  centre" would be nonsense for the piece.
 *
 *  JS-side consumers read fields through `frameOf` instead of unpacking lanes at
 *  each call site; the shader unpacks in ops/host.ts's ctx build. */
export const FRAME_ATTRS = [
  { name: "_opA", size: 4 },
  { name: "_opB", size: 4 },
  { name: "_opY", size: 4 },
] as const;

/** The SHRINK-WRAP BINDING a decal vertex rides, written by `bindDecals`:
 *  the host triangle it sits on, in the mesh's own local space.
 *
 *    `_wrapA` = (p0.xyz, u)
 *    `_wrapB` = (p1.xyz, v)
 *    `_wrapC` = (p2.xyz, h)     w = 1 − u − v, derived in the shader
 *
 *  Twelve floats: the triangle's three SEATED corners, the barycentric weights
 *  of this vertex's projection onto that triangle's plane, and its signed height
 *  above the plane. Together they REPRODUCE the authored position exactly —
 *  `u·p0 + v·p1 + w·p2 + h·n̂` decomposes the vertex in the complete basis
 *  {p1−p0, p2−p0, n̂} — which is what lets the deformed position be built the
 *  same way from the deformed corners. Only DECAL meshes carry these. */
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
 * `null` when the geometry carries no frame (deriveFrames never ran over it),
 * so callers test presence and read fields in one step — and no consumer has to
 * know which lane a field lives in.
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

/** Non-segmented hardware that is BOLTED to a segmented shell: host → features.
 *  Adoption is DATA, not scene-graph surgery — no re-parenting is needed, the
 *  adopted frame alone keeps these meshes seated on their host. */
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
  /** Rank bucket key (round(R·100), i.e. 0.01mm) → number of pieces in that
   *  layer. Adopted features are NOT counted: they ride a wedge rather than
   *  being one, and counting them would dilute the layer's phase stagger. */
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
// Axisymmetry thresholds: a centroid this close to the axis (as a fraction of the
// piece's own R) makes atan2 pure noise, and a measured span this close to a full
// turn means the piece wraps anyway. The span tolerance is LOOSE (0.15 rad ≈ 8.6°)
// because a real mesh's angular sampling is what sets the shortfall: a ring with
// relief cutouts, or one whose centroid is pulled off the axis by a lobe, reaches
// only 2π minus its coarsest angular gap. At the old 0.01 rad the span branch
// never fired and the centroid test carried the whole guard; measuring the WHOLE
// mesh (rather than each island) is what makes a loose span test safe — an island
// of a cut shell spans ~1.2 rad, nowhere near this.
const AXI_CENTROID_FRAC = 0.02;
const AXI_SPAN_EPS = 0.15;
// The two authored ladder distances — the ONLY authored numbers in the ladder.
const REACH_REAR = 70; // mm, approved rearmost extent
const REACH_FRONT = 95; // mm, approved frontmost extent
// The part whose axial centre splits rear from front (and holds rung 0).
const ANCHOR_PART = "Chassis_Fixed";

const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** The layer key a radius falls in: 0.01mm buckets, the `DerivedFrames.layerCount`
 *  map's key. Exported so consumers look a piece's layer up by the SAME law that
 *  built the map instead of re-deriving `round(R·100)` at each call site. */
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
// lets each screw adopt the wedge it is actually bolted to. ONLY the SHELL_ADOPT
// features are split this way — every other mesh is framed whole (see the
// header: islands of an ordinary mesh are solder blobs and relief cutouts, not
// pieces that move independently).

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
//
// THE FRAMING UNIT IS THE AUTHORING UNIT — one glTF NODE, i.e. one Blender
// object, i.e. (since the web GLBs went material-less) exactly one THREE.Mesh.
// The GROUP-of-primitives shape this file used to unify is gone by construction:
// with no material slots the exporter emits ONE primitive per mesh, so there is
// no `X`, `X_1`, … uniquifier run and no node whose halves could measure
// different radii (lens_work MIGRATION §2).

/** One authored node and its mesh. Kept as a pair because the node is what the
 *  class/group name walks and the adoption pass address, while the vertices
 *  being measured live on the mesh. */
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
  // Axisymmetry guard, TWO independent tests. Most solid parts of a lens are
  // bodies of revolution and their centroid sits ON the axis: atan2(≈0, ≈0) is
  // float noise, so t0 would be an arbitrary meridian that changes with a
  // re-export. The SPAN test catches the rest — a ring whose cutouts or relief
  // lobes pull the centroid off the axis still wraps the full turn, so its
  // meridian is just as meaningless. Either way pin both to the canonical values:
  // deterministic, and the flag says the meridian carries no information.
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
 *  `isGraphGroup`). They group the node graph without owning a rung: their
 *  members keep their own, which is what makes `groupOf` below give
 *  `Focus_Motor` and the six rear-mount parts their nine separate ladder rungs
 *  instead of collapsing them onto two. `classOf` reaches the same answer either
 *  way (a `Grp_` name classes as nothing), but the skip is here, once, rather
 *  than left implicit in a regex that could widen. */
function nameChain(obj: THREE.Object3D, root: THREE.Object3D): string[] {
  const names: string[] = [];
  for (let o: THREE.Object3D | null = obj; o && o !== root; o = o.parent)
    if (o.name && !isGraphGroup(o.name)) names.push(o.name);
  return names;
}

/** A mesh's part class: its OWN name if that name classifies it, else the
 *  nearest classed ancestor — a `<Part>_SegN` wedge inherits its part's class
 *  exactly as the isolate's ancestor-chain checks do.
 *
 *  The chain STOPS at the root and excludes it, so it is EMPTY when the mesh IS
 *  the root — which is exactly how an accessory arrives (scene.ts derives
 *  frames per accessory root, and `Acc_CapRear` is one leaf mesh, so it IS the
 *  root). Falling through to `structure` there would class the whole accessory
 *  as chassis, so an empty chain reads the root's own name instead. */
function classOf(mesh: THREE.Object3D, root: THREE.Object3D): number {
  const chain = nameChain(mesh, root);
  for (const name of chain) {
    const cls = partClassOf(name);
    if (cls !== PART_CLASS.structure) return cls;
  }
  return chain.length === 0 ? partClassOf(root.name) : PART_CLASS.structure;
}

/** The ladder group a mesh belongs to: the TOPMOST named ancestor below the root
 *  (its own name if it has no named ancestor). Topmost, not nearest: the model
 *  nests real sub-assemblies (Band_Mid and Barrel_Base under Chassis_Fixed,
 *  Element_01/02 — through the `Optics_G1` empty — and the front baffle under
 *  Barrel_Inner) that are welded to their parent and must ride ONE rung with
 *  it — which is exactly the grouping the authored tier table did by listing
 *  only top-level parts.
 *
 *  `Optics_G1` is the model's first NESTED group empty and it is deliberately
 *  NOT a `Grp_`: topmost-wins therefore lands its two elements on
 *  `Barrel_Inner`'s rung, exactly as the un-nested pair did (26 groups, not 27).
 *  A `Grp_` ancestor is invisible here — see nameChain — so the five real
 *  re-parents of lens_work MIGRATION STEP 5 are the only merges this derivation
 *  sees: PCB_Components onto PCB_Rear, Mount_Contacts onto Mount_ContactShelf,
 *  and the three screw sets onto Mount_Bayonet. */
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
  /** The candidate host NODES, when the job already knows them — the derived
   *  decal walk passes the host's own `_Seg` wedge nodes, because a decal's host
   *  carries descendants that are no sector to snap to (`Barrel_Inner` holds
   *  glass elements and a baffle, whose on-axis t0 = 0 would win the nearest-
   *  meridian search). `null` = every non-feature piece under `shell`, which is
   *  the authored SHELL_ADOPT rule, unchanged. */
  wedges: THREE.Object3D[] | null;
}

/** The segmented shell a mesh is printed ON: the nearest ancestor below the root
 *  that owns `<its name>_Seg<n>` wedge NODES, with the framed meshes of those
 *  wedges. The WALK is required — `DecalT_BadgeC` sits under `Band_Mid` under
 *  `Chassis_Fixed`, and it is printed on the BAND, not on the anchor two levels
 *  up.
 *
 *  Every `_SegN` node is a MESH now that the GLBs are material-less, but the
 *  walk deliberately does not require it: the wedge NODES are what is returned,
 *  and the adoption pass takes every piece framed under one. */
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
 * input to the single adoption pass (deriveFrames step 2) and to the per-ISLAND
 * measurement that pass needs (step 1).
 *
 * AUTHORED JOBS COME FIRST, and that ordering is load-bearing: a derived job
 * rewrites its features' frames, and the authored jobs' host pools are allowed
 * to contain those meshes (`Chassis_Fixed` holds the band's decals), so reading
 * them first is what keeps the authored records behaving exactly as they did
 * when they were the only adoption in the pass.
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
    // A SEGMENTED shell hosts on its own `_SegN` wedges — the decal walk's rule.
    // The open pool ("every non-feature piece under the shell") predates the
    // nested sub-assemblies: `Chassis_Fixed` holds `Band_Mid` and its ring
    // neighbours, so a nearest-meridian search over the whole subtree snapped
    // the focus motor to an OUTER-skin piece — a different rank layer, so the
    // motor rode the peel band its real host sits outside of (owner-caught,
    // twice). The pool stays open only for an unsegmented shell.
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
  // Printed markings: same adoption, host MEASURED off the segmentation instead
  // of named. A decal with no segmented ancestor keeps its own derived frame —
  // defensive, and it is how a lone decal (or an accessory root's own pass)
  // stays framed at all.
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
//
// A decal must follow its host's RENDERED, FACETED surface — not the ideal
// deformation curve. The op field evaluated at a facet-interior point is the
// smooth curve; the host renders the chord across the facet, and that gap is
// exactly the "text consumed by the part" artifact (L²/8R — ~5mm facets at the
// wrap's ~13mm roll radius bow ~0.25mm, more than the decal's own relief).
//
// So each decal vertex is BOUND to a host triangle: it records the triangle's
// three seated corners, its own barycentric weights on that triangle's plane,
// and its signed height above it. The shader then evaluates the deform at the
// three CORNERS and rebuilds the vertex from them, so a decal rides the same
// flat facet its host draws — by construction, at any depth, for free.
//
// The binding is measured in the DECAL's local space. The model has no node
// transforms below a part (verified in the shipped GLB), so a host triangle and
// the decal share one frame; the host corners are transformed anyway, and the
// shader-side evaluation of the op field at those corners assumes that shared
// frame — a future export that moves a decal relative to its host would need
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
 *  signed height above that plane. Deliberately UNCLAMPED: the weights may fall
 *  slightly outside [0, 1] for a vertex overhanging a facet edge, which is what
 *  makes the recomposition exact (an affine extension of the facet) where a
 *  clamped foot point would silently move the vertex. */
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
    // A decal's material samples no texture and nothing reads the authoring
    // `_bloom*` lanes, so these are dead weight — and dropping them keeps the
    // BOUND attribute count off the WebGPU 8-vertex-buffer ceiling that the
    // three `_wrap*` buffers bring it up to.
    for (const dead of ["uv", "uv1", "_bloomtheta0", "_bloomr", "_bloomgroup"])
      if (mesh.geometry.getAttribute(dead)) mesh.geometry.deleteAttribute(dead);
  }
}

/**
 * Give every mesh under `root` a BufferGeometry of its own.
 *
 * The seven iris blades are ONE Blender mesh instanced across seven nodes
 * (`Iris_Blade_01..07` all point at `Iris_Blade_geo`), so GLTFLoader hands all
 * seven the SAME BufferGeometry — and this whole pass writes its per-piece
 * results as vertex attributes ON THE GEOMETRY. Sharing one would mean each
 * blade's `_op*` (and `_wrap*`) write clobbered the last, leaving all seven
 * flying on blade 7's seat angle, radius and gate slot. Cloning up front is what
 * makes "one frame per mesh" true; it costs one extra copy of the blade
 * geometry per blade, which is the smallest mesh in the model.
 *
 * Runs before ANY measurement so nothing downstream — the frame write, the
 * decal binding, the edge-line geometry — has to know about instancing.
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
 * Measure every mesh under `root` and write the `_op*` frame attributes. Returns
 * the two lookup tables the host needs alongside the attributes: the derived
 * ladder (group → signed rung, model-mm) and each layer's piece count.
 *
 * Run once at load, after the model is assembled and BEFORE the first material
 * build (the deform graph reads these attributes).
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
  //    centroid for the ladder. ONE frame per authored node — except an adopted
  //    SHELL_ADOPT feature, which is split into islands so each screw can snap to
  //    its own host wedge.
  const { units, unitOf } = unitsOf(root);
  const adoptions = adoptJobs(root, unitOf);
  const featureRoots = adoptions.flatMap((a) => a.features);
  const pieces: Piece[] = [];
  const byMesh = new Map<THREE.Mesh, Piece[]>();
  const toRoot = new THREE.Matrix4();
  const p = new THREE.Vector3();
  for (const unit of units) {
    // Accessories NEVER join this pass (they get their own scoped pass, root =
    // the accessory — scene.ts). They load in the BACKGROUND and merge whenever
    // their fetch lands, so without this skip the body census depended on a
    // race: a load where the hood/filter merged first stretched the rank
    // normalization span by their larger radii and rescaled EVERY body rank —
    // the calibrated rank bands then selected a different cast per load (and
    // per backend, since the WebGPU adapter wait shifts the timing). The
    // `!== root` guard keeps the scoped accessory pass itself framing: there
    // the root IS the accessory, and classOf reads the root's own name.
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
  //    shell's R (hence its rank and layer), snaps t0 to the nearest host sector
  //    centre, and inherits that WEDGE's span/yExt/axi so it normalizes over the
  //    wedge's extent rather than its own (see the header: a screw on its own
  //    0.08 rad arc would bend right off the wedge it is bolted to, and a numeral
  //    with its own median radius and rank drifted off the ring it is printed on).
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
        // The snapped host UNIT's frame, copied EXACTLY — R included. A pool
        // median (what this used to take) put the adopter a few hundredths of a
        // millimetre off its host, which is a different rank bucket, a different
        // gate slot and a visibly different radial throw: the decal drifted off
        // the wedge it is printed on. Every lane below is now byte-identical to
        // the host's; `cls` and `adopted` are the only two that differ, and both
        // are read by the participation terms alone.
        //
        // THAT IDENTITY IS THE WHOLE MECHANISM, and it was learned the hard way:
        // decals printed on a rim FACE were special-cased through three
        // successive designs (a rigid rider scoped out of the modifiers, a
        // flange-unfold chart with rim-anchored transport, a full rim-frame
        // attachment) before it turned out that plain adopted coordinates
        // suffice — the host wedge is a thick solid whose own recessed shelf
        // occupies the same coordinate band and deforms correctly, so a decal
        // sharing its lanes gets the identical delta. What had looked like the
        // text being swallowed was schedule divergence from a mismatched frame.
        // Do not reintroduce a chart for any adopter without first checking that
        // its lanes really are identical to its host's.
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

  // 3. rank + layer phase. The rank law: 0.01mm radius buckets,
  //    normalized across the model's radius SPAN by VALUE (touching shells rank
  //    close together; the sorted ORDER would space them equally and interleave
  //    them mid-flight). Phase orders each layer's own pieces by meridian.
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
  // Layer POPULATION: how many pieces share this piece's rank layer. An adopted
  // feature reads its HOST wedge's layer (it rides that wedge and adopted its
  // rank). Informational only — the 0.01mm bucket is too tight for measured
  // medians to decide participation. The `?? 1` is defensive: every non-adopted
  // piece is in `layers` by construction.
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
    // (rung 0 by definition), printed markings and removable accessories (never
    // tier members in the art direction — they ride whatever they are parented
    // to, or stay home).
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
  //    `unshareGeometries` above gave every mesh its own (the seven iris blades
  //    arrive sharing one).
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
