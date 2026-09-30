// The deform host: wires the generated deform into NodeMaterials. It sums every
// active recipe's position delta and normal rotation, and owns the channel and
// knob uniforms.
//
// - One fold() per material: position and normal come from the same run
//   (TSL does not share work across separate nodes).
// - A recipe whose channel is below IDLE_EPS is skipped, so the seated render
//   is exact. Knobs that feed the gate or a divisor are range-clamped.
// - The deform runs in the vertex stage; anything the fragment reads from it
//   must cross on a varying (pinned by stage-placement.test.ts).

import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  uniform,
  positionLocal,
  normalLocal,
  transformNormalToView,
  vec3,
  float,
  cos,
  sin,
  max,
  length,
  cross,
  varying,
  uniformArray,
  wgslFn,
  glslFn,
} from "three/tsl";
import type { TslNode } from "./tsl-types";
import type { RecipeName } from "./recipes";
import { LAYOUT } from "./emit/layout";
import { DEFORM_WGSL } from "./emit/deform.wgsl";
import { DEFORM_GLSL } from "./emit/deform.glsl";
import { PART_CLASS } from "./ops";
import {
  FRAME_ATTRS,
  SHELL_ADOPT,
  WRAP_ATTRS,
  R_MIN,
  packFlags,
  unpackFlags,
  type DerivedFrames,
} from "./frames";

const TAU = 6.283185307179586;
/** A channel below this contributes exactly nothing. Must match emit.ts. */
export const IDLE_EPS = 1e-6;

/** Every recipe name, in table order. */
export const RECIPE_NAMES = LAYOUT.names;

// ── The deform's source ─────────────────────────────────────────────────────
// The deform is generated shader source (ops/emit) in WGSL and GLSL. Pick the
// dialect before building any material.
type DeformBackend = "wgsl" | "glsl";
let deformBackend: DeformBackend | null = null;
let deformFn: ((args: Record<string, TslNode>) => TslNode) | null = null;

/** Set the shader dialect. Repeating the same value is fine; changing it throws. */
export function setDeformBackend(backend: DeformBackend): void {
  if (deformBackend === backend) return;
  if (deformBackend !== null)
    throw new Error(
      `lens ops: deform backend already set to "${deformBackend}" — the graphs are baked`,
    );
  deformBackend = backend;
  const src = backend === "wgsl" ? DEFORM_WGSL : DEFORM_GLSL;
  deformFn = (backend === "wgsl" ? wgslFn(src) : glslFn(src)) as never;
  // Dev only: warn if the checked-in source no longer matches the recipes.
  if (import.meta.env.DEV)
    void import("./emit/emit").then(({ emitDeform }) => {
      if (emitDeform(backend) !== src)
        console.error(
          `lens ops: ${backend.toUpperCase()} deform source is STALE — the recipes have moved. ` +
            "Regenerate: LENS_OPS_EMIT=1 npx vitest run src/lib/lens/ops/emit/__tests__/emit.test.ts",
        );
    });
}

// ── Channels + knobs ────────────────────────────────────────────────────────
// One channel per recipe (0 = seated) packed in a vec4, and the knobs packed in
// a vec4 array; ops/emit/layout.ts assigns the lanes. Global: one set per page.
// Zeroed explicitly, since Vector4 defaults w to 1.
const uChannels = uniform(new THREE.Vector4(0, 0, 0, 0));
const uKnobs = uniformArray(
  Array.from({ length: LAYOUT.vec4Count }, () => new THREE.Vector4(0, 0, 0, 0)),
);

const COMP = ["x", "y", "z", "w"] as const;

/** A `{ value }` box onto one lane of a packed uniform. */
function laneBox(v: THREE.Vector4, lane: number): { value: number } {
  const c = COMP[lane];
  return {
    get value() {
      return v[c];
    },
    set value(x: number) {
      v[c] = x;
    },
  };
}

/** The live packed uniform values, for ops/cpu.ts. */
export const packedUniforms = {
  channels: uChannels.value as THREE.Vector4,
  knobs: uKnobs.array as THREE.Vector4[],
};

/** Clamp writes to [lo, hi]; a non-finite write becomes `lo`. */
function clamped(
  box: { value: number },
  lo: number,
  hi: number,
): { value: number } {
  return {
    get value() {
      return box.value;
    },
    set value(v: number) {
      box.value = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
    },
  };
}

/** Ignore non-finite writes. */
function guarded(box: { value: number }): { value: number } {
  return {
    get value() {
      return box.value;
    },
    set value(v: number) {
      if (Number.isFinite(v)) box.value = v;
    },
  };
}

// Channel boxes, clamped to 0..1.
const channelBoxes = Object.fromEntries(
  RECIPE_NAMES.map((n, i) => [
    n,
    clamped(laneBox(packedUniforms.channels, i), 0, 1),
  ]),
) as Record<RecipeName, { value: number }>;

/** One recipe's channel: 0 (seated) to 1 (fully played), clamped on write. */
export function recipeChannel(name: RecipeName): { value: number } {
  return channelBoxes[name];
}

// Knob boxes: clamped if the knob has a range, else finite-guarded. Created
// once, so callers may key on box identity.
const knobBoxes = Object.fromEntries(
  RECIPE_NAMES.map((n) => [
    n,
    Object.fromEntries(
      LAYOUT.knobNames[n].map((k) => {
        const l = LAYOUT.knob[n][k];
        const lane = laneBox(packedUniforms.knobs[l.vec4], l.lane);
        const range = LAYOUT.spec[n][k].range;
        return [k, range ? clamped(lane, range[0], range[1]) : guarded(lane)];
      }),
    ),
  ]),
) as Record<RecipeName, Record<string, { value: number }>>;

/** One recipe knob's box, in the knob's physical units. Throws if unknown. */
export function recipeKnob(name: RecipeName, knob: string): { value: number } {
  const box = knobBoxes[name]?.[knob];
  if (!box) throw new Error(`lens ops: no knob "${knob}" on recipe "${name}"`);
  return box;
}

/** Restore every knob to its default. */
export function resetRecipeKnobs(): void {
  for (const name of RECIPE_NAMES)
    for (const [knob, row] of Object.entries(LAYOUT.spec[name]))
      knobBoxes[name][knob].value = row.default;
}
resetRecipeKnobs();

/** Every channel box, keyed by recipe. */
export function recipeChannels(): Record<RecipeName, { value: number }> {
  return channelBoxes;
}

/** Every knob box, keyed by recipe then knob. */
export function recipeKnobs(): Record<
  RecipeName,
  Record<string, { value: number }>
> {
  return knobBoxes;
}

// ── The per-vertex graph ────────────────────────────────────────────────────

// Rotate about the optical axis by +rad in the ops' `rot` sense, which is
// three's R_y(−rad): passing a pivot's `rotation.y` undoes that spin.
const rotateAboutAxis = (n: TslNode, rad: TslNode): TslNode => {
  const c = cos(rad);
  const s = sin(rad);
  return vec3(n.x.mul(c).sub(n.z.mul(s)), n.y, n.x.mul(s).add(n.z.mul(c)));
};

// ── Mechanism spin pivots ───────────────────────────────────────────────────
// A mesh under a spin pivot (ops/mechanism.ts) would have its op delta rotated
// by the pivot too, so the position delta is counter-rotated by the pivot's
// angle (normals are not). The tag is baked into the graph, so it is part of
// the material cache key (`opsVariantKey`).
const OPS_SPIN_KEY = "opsSpin";
interface SpinTag {
  /** Unique per tagged subtree, for the material cache key. */
  id: string;
  u: TslNode;
}
let spinTagCount = 0;

/** Mark the subtree at `node` as inside a spin pivot and return the box to
 *  write the pivot's `rotation.y` into. Call before its materials are built. */
export function tagOpsSpin(node: THREE.Object3D): { value: number } {
  const u = uniform(0);
  const tag: SpinTag = { id: `spin${++spinTagCount}`, u: u as TslNode };
  node.traverse((o) => {
    o.userData[OPS_SPIN_KEY] = tag;
  });
  return u as unknown as { value: number };
}

const spinTagOf = (node?: THREE.Object3D | null): SpinTag | undefined =>
  node?.userData[OPS_SPIN_KEY] as SpinTag | undefined;

/** The spin box tagged on a node, or null. */
export function opsSpinBox(node: THREE.Object3D): { value: number } | null {
  return (spinTagOf(node)?.u as { value: number } | undefined) ?? null;
}

/** True for a decal mesh bound to its host's triangles (frames.ts bindDecals). */
function needsWrap(mesh?: THREE.Object3D | null): boolean {
  return (
    mesh instanceof THREE.Mesh &&
    mesh.geometry.getAttribute(WRAP_ATTRS[0].name) != null
  );
}

/** Material-cache key part for a mesh's graph variant (spin pivot, decal wrap);
 *  "" for the common graph. Every op material cache must include it. */
export function opsVariantKey(mesh: THREE.Object3D): string {
  const spin = spinTagOf(mesh)?.id ?? "";
  const wrap = needsWrap(mesh) ? "wrap" : "";
  return spin || wrap ? `${spin}|${wrap}` : "";
}

const spinNodeOf = (mesh?: THREE.Object3D | null): TslNode | null =>
  spinTagOf(mesh)?.u ?? null;

// Normalize, returning zero rather than NaN for a zero-length vector.
const safeUnit = (v: TslNode): TslNode =>
  v.div(max(length(v), 1e-9)) as TslNode;

/** Every active recipe's summed position delta at this vertex, and a function
 *  that turns an object-space normal to match. */
function fold(
  spin: TslNode | null,
  wrap: boolean,
): {
  delta: TslNode;
  normal: (n: TslNode) => TslNode;
} {
  const p = positionLocal as TslNode;
  const frameA = attribute("_opA", "vec4") as TslNode; // t0, R, span, rank
  const frameB = attribute("_opB", "vec4") as TslNode; // phase, class, rung, flags
  const frameY = attribute("_opY", "vec4") as TslNode; // yMin, yMax, depth, wink

  /** The deform at one point, as `vec4(delta.xyz, rot)`. */
  const sampleAt = (q: TslNode): TslNode => {
    if (!deformFn)
      throw new Error(
        "lens ops: setDeformBackend() must run before any op material is built",
      );
    return deformFn({
      p: q,
      a: frameA,
      b: frameB,
      y: frameY,
      ch: uChannels as TslNode,
      k: uKnobs as TslNode,
    });
  };

  if (wrap) {
    // Decal: deform the three corners of its host triangle and rebuild the
    // vertex from them (see ops/frames.ts WRAP_ATTRS).
    const wA = attribute("_wrapA", "vec4") as TslNode; // p0.xyz, u
    const wB = attribute("_wrapB", "vec4") as TslNode; // p1.xyz, v
    const wC = attribute("_wrapC", "vec4") as TslNode; // p2.xyz, h
    const p0 = wA.xyz as TslNode;
    const p1 = wB.xyz as TslNode;
    const p2 = wC.xyz as TslNode;
    const u = wA.w as TslNode;
    const v = wB.w as TslNode;
    const h = wC.w as TslNode;
    const w = float(1).sub(u).sub(v);
    const P0 = p0.add(sampleAt(p0).xyz);
    const P1 = p1.add(sampleAt(p1).xyz);
    const P2 = p2.add(sampleAt(p2).xyz);
    // Facet frames, seated and deformed, from the same winding.
    const eS = p1.sub(p0);
    const eF = P1.sub(P0);
    const nS = safeUnit(cross(eS, p2.sub(p0)));
    const nF = safeUnit(cross(eF, P2.sub(P0)));
    const bound = P0.mul(u).add(P1.mul(v)).add(P2.mul(w)).add(nF.mul(h));
    const wrapDelta = bound.sub(p);
    const tS = safeUnit(eS);
    const tF = safeUnit(eF);
    const bS = cross(nS, tS);
    const bF = cross(nF, tF);
    return {
      delta: spin ? rotateAboutAxis(wrapDelta, spin) : wrapDelta,
      // Re-express the normal from the seated facet frame in the deformed one.
      normal: (n: TslNode) =>
        (varying(tF) as TslNode)
          .mul(n.dot(tS))
          .add((varying(bF) as TslNode).mul(n.dot(bS)))
          .add((varying(nF) as TslNode).mul(n.dot(nS))),
    };
  }
  const at = sampleAt(p);
  const delta = at.xyz as TslNode;
  const rot = at.w as TslNode;
  return {
    delta: spin ? rotateAboutAxis(delta, spin) : delta,
    normal: (n: TslNode) => rotateAboutAxis(n, varying(rot) as TslNode),
  };
}

/** Position, view normal and object-space normal from one fold(). */
function opsGraph(
  spin: TslNode | null,
  wrap: boolean,
): {
  position: TslNode;
  normal: TslNode;
  normalLocal: TslNode;
} {
  const f = fold(spin, wrap);
  const nLocal = f.normal(normalLocal as TslNode);
  return {
    position: (positionLocal as TslNode).add(f.delta),
    // normalNode expects a view-space vector.
    normal: transformNormalToView(nLocal),
    normalLocal: nLocal,
  };
}

// Position-only graph for the common (untagged, unwrapped) case.
const opsPositionFn = Fn(() =>
  (positionLocal as TslNode).add(fold(null, false).delta),
);

/** Attach the deformed position and normal to a material; returns the position
 *  node for reuse (e.g. depth fade). Pass `mesh` for spin-tagged or decal
 *  meshes, and key the material cache by `opsVariantKey`. */
export function attachOps(
  material: THREE.NodeMaterial,
  mesh?: THREE.Object3D | null,
): TslNode {
  const g = opsGraph(spinNodeOf(mesh), needsWrap(mesh));
  material.positionNode = g.position;
  material.normalNode = g.normal;
  return g.position;
}

/** Attach the deformed position only (line materials); returns the node. */
export function attachOpsLine(
  material: THREE.NodeMaterial,
  mesh?: THREE.Object3D | null,
): TslNode {
  const spin = spinNodeOf(mesh);
  const wrap = needsWrap(mesh);
  const position =
    !spin && !wrap
      ? opsPositionFn()
      : Fn(() => (positionLocal as TslNode).add(fold(spin, wrap).delta))();
  material.positionNode = position;
  return position;
}

/** Outline hull: the deformed position pushed out along the deformed normal by
 *  `width` model-mm. */
export function attachOpsHull(
  material: THREE.NodeMaterial,
  width: number,
  mesh?: THREE.Object3D | null,
): void {
  const g = opsGraph(spinNodeOf(mesh), needsWrap(mesh));
  material.positionNode = g.position.add(g.normalLocal.mul(width));
}

/** A fresh deformed local-position node (ignores spin pivots). */
export function opsLocalPosition(): TslNode {
  return opsPositionFn();
}

/** True if ops/frames.ts has written frames onto this mesh. */
export function hasOpFrames(mesh: THREE.Mesh): boolean {
  return mesh.geometry.getAttribute("_opA") != null;
}

// Frame values for an edge vertex that matches no source vertex: its own radius
// and angle, a full turn of span, axisymmetric, so the deform barely moves it.
// `src` supplies the lanes that are constant over the mesh.
const EDGE_FALLBACK: Record<
  (typeof FRAME_ATTRS)[number]["name"],
  (x: number, y: number, z: number, src: THREE.BufferAttribute) => number[]
> = {
  // (t0, R, span, rank)
  _opA: (x, _y, z) => [
    Math.atan2(z, x),
    Math.max(Math.hypot(x, z), R_MIN),
    TAU,
    0.5,
  ],
  // (phase, class, rung, flags), axi = 1
  _opB: () => [0, PART_CLASS.structure, 0, packFlags(1, 0)],
  // (yMin, yMax, depth, wink)
  _opY: (_x, y, _z, src) => [y - 0.5, y + 0.5, 0, src.getW(0)],
};

/** EdgesGeometry with the `_op*` frame attributes copied over, matching each
 *  edge vertex to a source vertex by position (1e-3 mm buckets). */
export function opsEdgeGeometry(
  src: THREE.BufferGeometry,
  thresholdDeg = 24,
): THREE.BufferGeometry {
  const eg = new THREE.EdgesGeometry(src, thresholdDeg);
  const sp = src.getAttribute("position");
  if (!sp || !src.getAttribute("_opA")) return eg;

  const key = (x: number, y: number, z: number) =>
    `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;
  const map = new Map<string, number>();
  for (let i = 0; i < sp.count; i++)
    map.set(key(sp.getX(i), sp.getY(i), sp.getZ(i)), i);

  const ep = eg.getAttribute("position");
  const n = ep.count;
  for (const { name } of FRAME_ATTRS) {
    const sa = src.getAttribute(name);
    if (!sa) continue;
    const size = sa.itemSize;
    const out = new Float32Array(n * size);
    for (let i = 0; i < n; i++) {
      const x = ep.getX(i);
      const y = ep.getY(i);
      const z = ep.getZ(i);
      const si = map.get(key(x, y, z));
      if (si != null) {
        for (let c = 0; c < size; c++)
          out[i * size + c] = sa.getComponent(si, c) as number;
      } else {
        const fb = EDGE_FALLBACK[name](x, y, z, sa as THREE.BufferAttribute);
        for (let c = 0; c < size; c++) out[i * size + c] = fb[c] ?? 0;
      }
    }
    eg.setAttribute(name, new THREE.BufferAttribute(out, size));
  }
  return eg;
}

// ── DEV diagnostics ─────────────────────────────────────────────────────────

/** Log a summary of what ops/frames.ts measured (dev only). */
export function reportOpsFrames(
  root: THREE.Object3D,
  frames: DerivedFrames,
): void {
  // Count pieces per mesh by their distinct (t0, R, span).
  const perMesh = new Map<string, number>();
  const histogram = new Map<number, number>();
  const spans: number[] = [];
  let components = 0;
  let axiCount = 0;

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !hasOpFrames(o)) return;
    const g = o.geometry;
    const fa = g.getAttribute("_opA"); // t0, R, span, rank
    const fb = g.getAttribute("_opB"); // phase, class, rung, flags
    const seen = new Set<string>();
    for (let i = 0; i < fa.count; i++) {
      const sig = `${fa.getX(i)}|${fa.getY(i)}|${fa.getZ(i)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      spans.push(fa.getZ(i));
      if (unpackFlags(fb.getW(i)).axi > 0.5) axiCount++;
    }
    components += seen.size;
    perMesh.set(o.name || "(unnamed)", seen.size);
    histogram.set(seen.size, (histogram.get(seen.size) ?? 0) + 1);
  });

  // Segmented shells are cut 5 and 7 ways; count the spans near each.
  const cluster = (target: number) => {
    const hits = spans.filter((s) => Math.abs(s - target) < 0.08);
    return hits.length === 0
      ? { count: 0 }
      : {
          count: hits.length,
          min: +Math.min(...hits).toFixed(4),
          max: +Math.max(...hits).toFixed(4),
        };
  };

  // How far each SHELL_ADOPT piece's t0 was snapped from its own centroid angle.
  let adopted = 0;
  let adoptErr = 0;
  for (const features of Object.values(SHELL_ADOPT)) {
    for (const fname of features) {
      const fo = root.getObjectByName(fname);
      if (!fo) continue;
      fo.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || !hasOpFrames(o)) return;
        const pos = o.geometry.getAttribute("position");
        const fa = o.geometry.getAttribute("_opA"); // .x is t0
        const sums = new Map<number, { x: number; z: number; n: number }>();
        for (let i = 0; i < pos.count; i++) {
          const k = fa.getX(i);
          const s = sums.get(k) ?? { x: 0, z: 0, n: 0 };
          s.x += pos.getX(i);
          s.z += pos.getZ(i);
          s.n++;
          sums.set(k, s);
        }
        for (const [k, s] of sums) {
          adopted++;
          const err = Math.atan2(s.z / s.n, s.x / s.n) - k;
          adoptErr = Math.max(
            adoptErr,
            Math.abs(Math.atan2(Math.sin(err), Math.cos(err))),
          );
        }
      });
    }
  }

  const rankKeys = [...frames.layerCount.keys()].sort((a, b) => a - b);
  console.info("[lens] ops frames:", {
    components,
    meshes: perMesh.size,
    componentsPerMesh: Object.fromEntries(
      [...histogram.entries()].sort((a, b) => a[0] - b[0]),
    ),
    span5cut: cluster(TAU / 5),
    span7cut: cluster(TAU / 7),
    rankKey: { lo: rankKeys[0], hi: rankKeys[rankKeys.length - 1] },
    layers: frames.layerCount.size,
    adopted,
    adoptMaxAngleErr: +adoptErr.toFixed(4),
    axisymmetric: axiCount,
    ladderGroups: frames.ladderRungs.size,
  });
}
