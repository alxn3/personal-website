// Load-time measurement: every per-piece constant the deform reads is measured
// from the geometry here and written as vertex attributes.
//
// A piece is one mesh, measured in its own local space (the ladder uses root
// space). Bolted hardware and decals copy their host wedge's frame so they move
// with it; SHELL_ADOPT hardware is split into islands so each screw snaps to its
// own wedge. Hardware keeps its own `depth`, a decal takes its host's.

import * as THREE from "three/webgpu";
import { isGraphGroup, isSegWedge, partClassOf } from "../core/parts";
import { PART_CLASS } from "./ops";

/** The per-piece frame attributes (at most 8 vertex buffers on WebGPU, so the
 *  fields are packed into three vec4s):
 *
 *    `_opA` = (t0, R, span, rank)
 *    `_opB` = (phase, class, rung, flags)   flags = axi + 2·adopted
 *    `_opY` = (yMin, yMax, depth, wink)     wink: core/visibility.ts packWink */
export const FRAME_ATTRS = [
  { name: "_opA", size: 4 },
  { name: "_opB", size: 4 },
  { name: "_opY", size: 4 },
] as const;

/** A decal vertex's binding to its host triangle, in the mesh's local space:
 *  position = u·p0 + v·p1 + w·p2 + h·n̂, with w = 1 − u − v.
 *
 *    `_wrapA` = (p0.xyz, u)
 *    `_wrapB` = (p1.xyz, v)
 *    `_wrapC` = (p2.xyz, h) */
export const WRAP_ATTRS = [
  { name: "_wrapA", size: 4 },
  { name: "_wrapB", size: 4 },
  { name: "_wrapC", size: 4 },
] as const;

/** One piece's frame, as read back by `frameOf`. */
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
  /** Widest wall offset from R, as a fraction of R. */
  depth: number;
  /** 1 when the frame was copied from a host wedge. */
  adopted: number;
  /** Packed fade lane (core/visibility.ts `packWink`); WINK_NONE until stamped. */
  wink: number;
}

/** `_opB.w`: the two 0/1 flags packed as axi + 2·adopted. */
export const packFlags = (axi: number, adopted: number): number =>
  axi + 2 * adopted;

export const unpackFlags = (
  flags: number,
): { axi: number; adopted: number } => {
  const adopted = Math.floor(flags * 0.5);
  return { axi: flags - 2 * adopted, adopted };
};

/** The fade lane of a piece no fade controls. */
export const WINK_NONE = -1;

/** Read one vertex's frame off a geometry; `null` if it has none. */
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

/** Hardware bolted to a segmented shell: host part → its features. */
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
  /** Group (or overridden part) name → signed ladder rung in model-mm. Groups
   *  off the ladder (anchor, decals, accessories) are present with 0. */
  ladderRungs: Map<string, number>;
  /** Radius bucket (`rankKeyOf`) → number of pieces in it, adopted ones excluded. */
  layerCount: Map<number, number>;
}

// Minimum radius in mm; R is used as a divisor throughout the ops.
export const R_MIN = 0.5;
// Position bucket (1e-3 mm) that merges seam-duplicated vertices.
const POS_QUANT = 1e3;
// Radius bucket (0.01 mm) for ranks and layers.
const RADIUS_QUANT = 100;
// A piece is axisymmetric if its centroid is within this fraction of R of the
// axis, or its angular span is within AXI_SPAN_EPS of a full turn.
const AXI_CENTROID_FRAC = 0.02;
const AXI_SPAN_EPS = 0.15;
// Ladder reach in mm behind and in front of the anchor.
const REACH_REAR = 70;
const REACH_FRONT = 95;
// The part that holds rung 0 and splits rear from front.
const ANCHOR_PART = "Chassis_Fixed";

/** An angle wrapped into (-π, π]. */
export const wrapPi = (a: number): number =>
  Math.atan2(Math.sin(a), Math.cos(a));

/** The radius bucket a piece falls in. */
export const rankKeyOf = (R: number): number => Math.round(R * RADIUS_QUANT);

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Split a geometry into connected islands (shared triangles or coincident
 *  positions), so a ring of screws in one mesh gives one island per screw. */
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

/** One piece's raw measurements, in its mesh's local space. */
interface LocalPiece {
  mesh: THREE.Mesh;
  /** The vertices of `mesh` this piece owns. */
  verts: number[];
  t0: number;
  R: number;
  span: number;
  /** Axisymmetric: t0 is 0 and span is exactly 2π. */
  axi: boolean;
  yMin: number;
  yMax: number;
  /** max |r − R| / R over the vertices. */
  depth: number;
  cx: number;
  cy: number;
  cz: number;
}

/** Measure a set of vertices of one mesh as a single frame. */
function measureVerts(mesh: THREE.Mesh, verts: number[]): LocalPiece {
  const pos = mesh.geometry.getAttribute("position");
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let yMin = Infinity;
  let yMax = -Infinity;
  const radii: number[] = [];
  for (const i of verts) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    sx += x;
    sy += y;
    sz += z;
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
    radii.push(Math.hypot(x, z));
  }
  const count = Math.max(verts.length, 1);
  const cx = sx / count;
  const cy = sy / count;
  const cz = sz / count;
  const R = Math.max(medianOf(radii), R_MIN);
  let depth = 0;
  for (const r of radii) depth = Math.max(depth, Math.abs(r - R) / R);
  let t0 = Math.atan2(cz, cx);
  let aMin = Infinity;
  let aMax = -Infinity;
  for (const i of verts) {
    const a = wrapPi(Math.atan2(pos.getZ(i), pos.getX(i)) - t0);
    aMin = Math.min(aMin, a);
    aMax = Math.max(aMax, a);
  }
  let span = Math.max(aMax - aMin, 0);
  const axi =
    Math.hypot(cx, cz) < AXI_CENTROID_FRAC * R ||
    span >= Math.PI * 2 - AXI_SPAN_EPS;
  if (axi) {
    t0 = 0;
    span = Math.PI * 2;
  }
  return { mesh, verts, t0, R, span, axi, yMin, yMax, depth, cx, cy, cz };
}

/** max |r − R| / R over every vertex under `node`, about the given R. */
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

/** Names from a node up to (not including) the root, skipping `Grp_*` empties. */
function nameChain(obj: THREE.Object3D, root: THREE.Object3D): string[] {
  const names: string[] = [];
  for (let o: THREE.Object3D | null = obj; o && o !== root; o = o.parent)
    if (o.name && !isGraphGroup(o.name)) names.push(o.name);
  return names;
}

/** A mesh's part class: from its own name, else its nearest classed ancestor
 *  (so a `<Part>_SegN` wedge takes its part's class). The root itself is only
 *  read when the mesh is the root. */
function classOf(mesh: THREE.Object3D, root: THREE.Object3D): number {
  const chain = nameChain(mesh, root);
  for (const name of chain) {
    const cls = partClassOf(name);
    if (cls !== PART_CLASS.structure) return cls;
  }
  return chain.length === 0 ? partClassOf(root.name) : PART_CLASS.structure;
}

/** A mesh's ladder group: its topmost named ancestor below the root, so nested
 *  sub-assemblies share one rung. */
function groupOf(mesh: THREE.Object3D, root: THREE.Object3D): string {
  const chain = nameChain(mesh, root);
  return chain.length > 0 ? chain[chain.length - 1] : "";
}

/** A piece's final frame. Starts as a copy of `local`; adoption overwrites it. */
interface Piece extends Pick<
  LocalPiece,
  "t0" | "R" | "span" | "axi" | "yMin" | "yMax" | "depth"
> {
  node: THREE.Mesh;
  local: LocalPiece;
  /** Centroid height in root space; only orders the ladder. */
  axialRoot: number;
  group: string;
  cls: number;
  rank: number;
  phase: number;
  rung: number;
  /** The host shell's group name (`ladderRungs` is keyed by group). */
  hostGroup?: string;
  adoptFrom?: Piece;
}

function isUnder(obj: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent)
    if (o === ancestor) return true;
  return false;
}

/** One adoption: every piece under `features` copies a host piece's frame. */
interface AdoptJob {
  shell: THREE.Object3D;
  /** A SHELL_ADOPT feature node, or a decal mesh. */
  features: THREE.Object3D[];
  /** The shell's `_Seg` wedge nodes, or `null` to accept any non-feature piece
   *  under `shell`. */
  wedges: THREE.Object3D[] | null;
}

/** `<shell>_Seg<n>` wedge nodes under `shell`. */
function wedgesOf(shell: THREE.Object3D): THREE.Object3D[] {
  const wedges: THREE.Object3D[] = [];
  shell.traverse((o) => {
    if (isSegWedge(o.name) && o.name.startsWith(`${shell.name}_Seg`))
      wedges.push(o);
  });
  return wedges;
}

/** The nearest named ancestor below the root that has its own `_Seg` wedges. */
function segmentedHostOf(
  mesh: THREE.Object3D,
  root: THREE.Object3D,
): { host: THREE.Object3D; wedges: THREE.Object3D[] } | null {
  for (let a = mesh.parent; a && a !== root; a = a.parent) {
    if (!a.name) continue;
    const wedges = wedgesOf(a);
    if (wedges.length > 0) return { host: a, wedges };
  }
  return null;
}

/** Every adoption: SHELL_ADOPT jobs first (a decal job may rewrite pieces in
 *  their host pool), then one job per segmented shell that carries decals. */
function adoptJobs(root: THREE.Object3D): AdoptJob[] {
  const jobs: AdoptJob[] = [];
  for (const [shellName, features] of Object.entries(SHELL_ADOPT)) {
    const shell = root.getObjectByName(shellName);
    if (!shell) continue;
    const objs = features
      .map((n) => root.getObjectByName(n))
      .filter((o): o is THREE.Object3D => o != null);
    if (objs.length === 0) continue;
    const segs = wedgesOf(shell);
    jobs.push({
      shell,
      features: objs,
      wedges: segs.length > 0 ? segs : null,
    });
  }
  // Decals: the host is found from the segmentation. A decal with no
  // segmented ancestor keeps its own frame.
  const byHost = new Map<
    THREE.Object3D,
    { wedges: THREE.Object3D[]; features: THREE.Object3D[] }
  >();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || classOf(o, root) !== PART_CLASS.decal)
      return;
    const found = segmentedHostOf(o, root);
    if (!found) return;
    const entry = byHost.get(found.host) ?? {
      wedges: found.wedges,
      features: [],
    };
    if (!entry.features.includes(o)) entry.features.push(o);
    byHost.set(found.host, entry);
  });
  for (const [shell, { wedges, features }] of byHost)
    jobs.push({ shell, features, wedges });
  return jobs;
}

// ── Decal shrink-wrap ────────────────────────────────────────────────────────
// Each decal vertex is bound to a host triangle, and the shader rebuilds it from
// the deformed corners so it follows the host's faceted surface. Assumes no node
// transforms below a part, so decal and host share one local space.

interface Binding {
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  u: number;
  v: number;
  h: number;
  /** Distance to the closest point on the triangle; picks the winner. */
  dist: number;
}

/** Barycentrics of `p` projected onto the triangle's plane, plus its signed
 *  height. Unclamped, so a vertex past a facet edge still rebuilds exactly. */
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
  if (!(Math.abs(denom) > 1e-12)) return null; // degenerate triangle
  const d20 = rel.dot(e1);
  const d21 = rel.dot(e2);
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
  return { u: 1 - v - w, v, h: rel.dot(n) };
}

interface HostTris {
  tris: THREE.Triangle[];
  /** Bounding sphere per triangle: (cx, cy, cz, r). */
  spheres: Float64Array;
}

/** Every triangle of a mesh, with a bounding sphere each. */
function trianglesOf(mesh: THREE.Mesh): HostTris {
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position");
  const idx = geo.getIndex();
  const count = pos ? (idx ? idx.count : pos.count) : 0;
  const tris: THREE.Triangle[] = [];
  const spheres = new Float64Array(Math.floor(count / 3) * 4);
  for (let i = 0; i + 2 < count; i += 3) {
    const t = new THREE.Triangle().setFromAttributeAndIndices(
      pos,
      idx ? idx.getX(i) : i,
      idx ? idx.getX(i + 1) : i + 1,
      idx ? idx.getX(i + 2) : i + 2,
    );
    const cen = new THREE.Vector3()
      .addVectors(t.a, t.b)
      .add(t.c)
      .multiplyScalar(1 / 3);
    const s = tris.length * 4;
    spheres[s] = cen.x;
    spheres[s + 1] = cen.y;
    spheres[s + 2] = cen.z;
    spheres[s + 3] = Math.max(
      cen.distanceTo(t.a),
      cen.distanceTo(t.b),
      cen.distanceTo(t.c),
    );
    tris.push(t);
  }
  return { tris, spheres };
}

/** Bind every adopted decal vertex to the closest triangle of its host mesh and
 *  write the `_wrap*` attributes. Runs after adoption. */
function bindDecals(pieces: Piece[]): void {
  const trisByHost = new Map<Piece, HostTris>();
  const byMesh = new Map<THREE.Mesh, Map<number, Binding>>();
  const foot = new THREE.Vector3();
  const p = new THREE.Vector3();

  for (const pc of pieces) {
    const host = pc.adoptFrom;
    if (!host || pc.cls !== PART_CLASS.decal) continue;

    let hostTris = trisByHost.get(host);
    if (!hostTris) {
      hostTris = trianglesOf(host.local.mesh);
      trisByHost.set(host, hostTris);
    }
    const { tris, spheres } = hostTris;
    if (tris.length === 0) continue;

    const { mesh, verts } = pc.local;
    const pos = mesh.geometry.getAttribute("position");
    let table = byMesh.get(mesh);
    if (!table) {
      table = new Map();
      byMesh.set(mesh, table);
    }
    // The previous vertex's triangle bounds the search before the first candidate.
    let hint = -1;
    for (const vi of verts) {
      p.fromBufferAttribute(pos, vi);
      let bound = Infinity;
      if (hint >= 0)
        bound = tris[hint].closestPointToPoint(p, foot).distanceTo(p);
      let best: Binding | null = null;
      for (let ti = 0; ti < tris.length; ti++) {
        // Skip triangles whose bounding sphere is farther than the bound.
        const s = ti * 4;
        const dx = p.x - spheres[s];
        const dy = p.y - spheres[s + 1];
        const dz = p.z - spheres[s + 2];
        const lim = (best ? Math.min(bound, best.dist) : bound) + spheres[s + 3]; // prettier-ignore
        if (dx * dx + dy * dy + dz * dz > lim * lim) continue;
        const t = tris[ti];
        const d = t.closestPointToPoint(p, foot).distanceTo(p);
        if (best && d >= best.dist) continue;
        const b = bindTo(p, t.a, t.b, t.c);
        if (!b) continue;
        best = { p0: t.a, p1: t.b, p2: t.c, ...b, dist: d };
        hint = ti;
      }
      if (best) table.set(vi, best);
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
    // Drop unused attributes to stay under WebGPU's 8 vertex buffers.
    for (const dead of ["uv", "uv1", "_bloomtheta0", "_bloomr", "_bloomgroup"])
      if (mesh.geometry.getAttribute(dead)) mesh.geometry.deleteAttribute(dead);
  }
}

/** Give every mesh its own geometry: GLTFLoader shares one between instances,
 *  and each would overwrite the other's frame attributes. */
function unshareGeometries(root: THREE.Object3D): void {
  const seen = new Set<THREE.BufferGeometry>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry) return;
    if (seen.has(o.geometry)) o.geometry = o.geometry.clone();
    else seen.add(o.geometry);
  });
}

/**
 * Measure every mesh under `root`, write the `_op*` frame attributes, and return
 * the ladder and layer counts. Run once at load, before the first material build.
 */
export function deriveFrames(
  root: THREE.Object3D,
  overrides?: {
    tierOrder?: Record<string, number>;
    /** Root-space Y of the rear/front split, instead of the anchor's midpoint. */
    anchorY?: number;
  },
): DerivedFrames {
  unshareGeometries(root);
  root.updateWorldMatrix(true, true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  // 1. Measure every mesh in its own space; SHELL_ADOPT features per island.
  const adoptions = adoptJobs(root);
  const featureRoots = adoptions.flatMap((a) => a.features);
  const pieces: Piece[] = [];
  const toRoot = new THREE.Matrix4();
  const p = new THREE.Vector3();
  root.traverse((mesh) => {
    if (!(mesh instanceof THREE.Mesh)) return;
    if (!mesh.geometry?.getAttribute("position")) return;
    // Accessories are framed in their own pass (scene.ts), unless this is it.
    if (mesh !== root && classOf(mesh, root) === PART_CLASS.accessory) return;
    const perIsland = featureRoots.some((f) => isUnder(mesh, f));
    const locals = perIsland
      ? componentsOf(mesh.geometry).map((verts) => measureVerts(mesh, verts))
      : [
          measureVerts(
            mesh,
            Array.from(
              { length: mesh.geometry.getAttribute("position").count },
              (_, i) => i,
            ),
          ),
        ];
    toRoot.multiplyMatrices(rootInv, mesh.matrixWorld);
    const group = groupOf(mesh, root);
    const cls = classOf(mesh, root);
    for (const local of locals) {
      p.set(local.cx, local.cy, local.cz).applyMatrix4(toRoot);
      const { t0, R, span, axi, yMin, yMax, depth } = local;
      pieces.push({
        node: mesh,
        local,
        t0,
        R,
        span,
        axi,
        yMin,
        yMax,
        depth,
        axialRoot: p.y,
        group,
        cls,
        rank: 0,
        phase: 0,
        rung: 0,
      });
    }
  });

  // 2. Adoption: each feature piece copies the frame of the host wedge nearest
  //    in angle. The copy must be exact so it lands in the same rank bucket.
  for (const { shell, features, wedges } of adoptions) {
    const hostGroup = groupOf(shell, root) || shell.name;
    const hostPieces = pieces.filter((pc) =>
      wedges
        ? wedges.some((w) => isUnder(pc.node, w))
        : isUnder(pc.node, shell) && !features.some((f) => isUnder(pc.node, f)),
    );
    if (hostPieces.length === 0) continue;
    for (const feature of features) {
      for (const pc of pieces) {
        if (!isUnder(pc.node, feature)) continue;
        let best = hostPieces[0];
        let bestDist = Infinity;
        for (const hp of hostPieces) {
          const d = Math.abs(wrapPi(pc.t0 - hp.t0));
          if (d < bestDist) {
            bestDist = d;
            best = hp;
          }
        }
        pc.t0 = best.t0;
        pc.R = best.R;
        pc.span = best.span;
        pc.axi = best.axi;
        pc.yMin = best.yMin;
        pc.yMax = best.yMax;
        // A decal bends exactly like its host. Hardware's depth covers the whole
        // feature about the host's R, so its islands bend together or not at all.
        pc.depth =
          pc.cls === PART_CLASS.decal
            ? best.depth
            : Math.max(best.depth, wallDepthOf(pc.node, best.R));
        pc.hostGroup = hostGroup;
        pc.adoptFrom = best;
      }
    }
  }

  bindDecals(pieces);

  // 3. Rank: the radius bucket normalized across the model's radius range (by
  //    value, not order). Phase: a piece's angular order within its layer.
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
    if (pc.adoptFrom) continue;
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
  for (const pc of pieces) if (pc.adoptFrom) pc.phase = pc.adoptFrom.phase;

  // 4. Ladder: groups split rear/front of the anchor, each side ordered outward
  //    in even steps so the outermost group lands on the reach.
  let anchorY = 0;
  const anchorObj = root.getObjectByName(ANCHOR_PART);
  if (overrides?.anchorY !== undefined) anchorY = overrides.anchorY;
  else if (anchorObj) {
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
    const w = pc.local.verts.length;
    g.axial += pc.axialRoot * w;
    g.weight += w;
    // Adopted hardware, the anchor, decals and accessories stay off the ladder.
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
  // Overrides win by group name; a group of only adopted pieces reports its
  // host's rung.
  const tierOrder = new Map(Object.entries(overrides?.tierOrder ?? {}));
  for (const [name, rung] of tierOrder) ladderRungs.set(name, rung);
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

  // 5. Write the attributes: each piece's constants on the vertices it owns.
  const byMesh = new Map<THREE.Mesh, Piece[]>();
  for (const pc of pieces) {
    const list = byMesh.get(pc.local.mesh);
    if (list) list.push(pc);
    else byMesh.set(pc.local.mesh, [pc]);
  }
  for (const [mesh, mine] of byMesh) {
    const n = mesh.geometry.getAttribute("position").count;
    const a = new Float32Array(n * 4);
    const b = new Float32Array(n * 4);
    const y = new Float32Array(n * 4);
    for (const pc of mine) {
      for (const i of pc.local.verts) {
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
    mesh.geometry.setAttribute("_opA", new THREE.BufferAttribute(a, 4));
    mesh.geometry.setAttribute("_opB", new THREE.BufferAttribute(b, 4));
    mesh.geometry.setAttribute("_opY", new THREE.BufferAttribute(y, 4));
  }

  return { ladderRungs, layerCount };
}
