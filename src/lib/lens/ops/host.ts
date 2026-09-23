// The deform host: reads the `_op*` frame attributes, folds every ACTIVE
// recipe into one summed position delta + normal rotation, and hands a
// NodeMaterial its position and normal graphs. The only deform host.
//
// INVARIANTS:
//  1. ONE fold() per material — position and normal graphs derive from the
//     same run (TSL does not CSE across nodes).
//  2. A recipe contributes `point(final) − q` against the authored position, so
//     an identity pipeline subtracts to exactly zero.
//  3. Hard idle gate: the emitted chain BRANCHES per recipe on
//     `channel >= IDLE_EPS`, and a skipped branch adds nothing, so the seated
//     render is bit-exact on the plain graph (a shrink-wrapped decal rebuilds
//     its point from barycentrics, seated to rounding). A NaN inside a LIVE
//     branch reaches the render, which is why every knob feeding the gate or a
//     divisor carries a range.
//  4. The normal rotates `normalLocal` about the optical axis by the summed
//     gated `rot` (no normalize); `rot` is a normal's only channel, so `aim` is
//     an angle in the radial plane.
//  5. The chain runs in the vertex stage; anything the fragment reads off
//     fold() crosses on a varying. positionLocal in the fragment stage is the
//     DEFORMED position.

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
  packFlags,
  unpackFlags,
  type DerivedFrames,
} from "./frames";

export type { RecipeName };

const TAU = 6.283185307179586;
/** The idle threshold: the hard idle gate and the skip branch read this SAME
 *  edge. A channel below it contributes an EXACT zero. */
export const IDLE_EPS = 1e-6;
// The radius floor ops/frames.ts applies, for the edge-geometry fallback: an
// unmatched vertex must never hand the algebra R = 0 (R is a divisor).
const R_MIN = 0.5;

/** Every recipe name, in table order — the list to loop over all recipes. */
export const RECIPE_NAMES = LAYOUT.names;

// ── The deform's source ─────────────────────────────────────────────────────
// The chain ships as GENERATED SHADER SOURCE (ops/emit), emitted from the same
// recipe table the CPU spec runs. It is dialect-specific, so the backend must
// be declared before any material is built. Both dialects ship so this stays
// synchronous — an import of the chosen one would make it async.
type DeformBackend = "wgsl" | "glsl";
let deformBackend: DeformBackend | null = null;
let deformFn: ((args: Record<string, TslNode>) => TslNode) | null = null;

/** Declare which dialect the renderer speaks. Idempotent for the same value;
 *  throws on a change, since the built graphs are already baked. */
export function setDeformBackend(backend: DeformBackend): void {
  if (deformBackend === backend) return;
  if (deformBackend !== null)
    throw new Error(
      `lens ops: deform backend already set to "${deformBackend}" — the graphs are baked`,
    );
  deformBackend = backend;
  const src = backend === "wgsl" ? DEFORM_WGSL : DEFORM_GLSL;
  deformFn = (backend === "wgsl" ? wgslFn(src) : glslFn(src)) as never;
  // DEV: warn when the checked-in generated source no longer matches the
  // recipe table. The emitter is import()ed, so it never reaches production.
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
// One channel per recipe (0 = seated, bit-exact) and one lane per knob, booted
// at the recipes' PHYSICAL defaults. PROCESS-GLOBAL: one set per document,
// which is why core/scene's `initScene` is one-scene-per-document.
//
// Packed as the emitted deform takes them: channels are one vec4 (one lane per
// recipe, table order), knobs a vec4 array of per-recipe blocks.
// ops/emit/layout.ts derives the lane assignment from the recipe table, so the
// shader and the setters below cannot disagree.
// Explicitly ZEROED: Vector4's own default is (0, 0, 0, 1), which would boot
// the fourth lane — rose's channel — fully played.
const uChannels = uniform(new THREE.Vector4(0, 0, 0, 0));
const uKnobs = uniformArray(
  Array.from({ length: LAYOUT.vec4Count }, () => new THREE.Vector4(0, 0, 0, 0)),
);

const COMP = ["x", "y", "z", "w"] as const;

/** A `{ value }` box onto ONE LANE of a packed uniform; the clamping views
 *  below compose on top of it. */
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

/** The scalar boxes the setters write — the lane behind each channel/knob. */
const channelLane = Object.fromEntries(
  RECIPE_NAMES.map((n, i) => [n, laneBox(uChannels.value as THREE.Vector4, i)]),
) as Record<RecipeName, { value: number }>;

const knobLane = Object.fromEntries(
  RECIPE_NAMES.map((n) => [
    n,
    Object.fromEntries(
      LAYOUT.knobNames[n].map((k) => {
        const l = LAYOUT.knob[n][k];
        return [k, laneBox(uKnobs.array[l.vec4] as THREE.Vector4, l.lane)];
      }),
    ) as Record<string, { value: number }>,
  ]),
) as Record<RecipeName, Record<string, { value: number }>>;

for (const n of RECIPE_NAMES)
  for (const [k, row] of Object.entries(LAYOUT.spec[n]))
    knobLane[n][k].value = row.default;

/** The packed uniform VALUES the emitted deform reads, for ops/cpu.ts: the
 *  same objects the boxes above write, so a read is always this frame's. */
export const packedUniforms = {
  channels: uChannels.value as THREE.Vector4,
  knobs: uKnobs.array as THREE.Vector4[],
};

/** A clamping VIEW of a uniform box: every write lands inside [lo, hi], and a
 *  non-finite write lands on `lo` rather than propagating into the graph. */
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

/** A finite-guarding VIEW of an UNLIMITED uniform box: a non-finite write is
 *  dropped and the box keeps its last value. No range clamp — an unlimited
 *  knob feeds op amplitudes only — but a NaN reaches the render while live. */
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

// The channel boxes, wrapped ONCE. A channel is a 0..1 scrub the idle branch
// reads directly, so the clamp closes out-of-range and NaN writes.
const channelBoxes = Object.fromEntries(
  RECIPE_NAMES.map((n) => [n, clamped(channelLane[n], 0, 1)]),
) as Record<RecipeName, { value: number }>;

/** The channel uniform for one recipe: `.value` 0 (seated) .. 1 (fully played),
 *  clamped to that range on write. */
export function recipeChannel(name: RecipeName): { value: number } {
  return channelBoxes[name];
}

/** The write VIEW for one knob: the clamping wrapper for a ranged knob, a
 *  plain finite guard for the rest. */
function makeKnobBox(name: RecipeName, knob: string): { value: number } {
  const u = knobLane[name][knob];
  const range = LAYOUT.spec[name][knob].range;
  return range ? clamped(u, range[0], range[1]) : guarded(u);
}

// Every knob box, wrapped ONCE at module load — the same object for the
// process's life, so a caller may key on box IDENTITY.
const knobBoxes = Object.fromEntries(
  RECIPE_NAMES.map((n) => [
    n,
    Object.fromEntries(LAYOUT.knobNames[n].map((k) => [k, makeKnobBox(n, k)])),
  ]),
) as Record<RecipeName, Record<string, { value: number }>>;

/** One recipe knob's uniform (physical units — see the recipe's knobSpec),
 *  as the same guarded box every call. THROWS on an unknown recipe/knob. */
export function recipeKnob(name: RecipeName, knob: string): { value: number } {
  const box = knobBoxes[name]?.[knob];
  if (!box) throw new Error(`lens ops: no knob "${knob}" on recipe "${name}"`);
  return box;
}

/** Restore EVERY knob to its recipe's default. */
export function resetRecipeKnobs(): void {
  for (const name of RECIPE_NAMES)
    for (const [knob, row] of Object.entries(LAYOUT.spec[name]))
      knobBoxes[name][knob].value = row.default;
}

/** Every channel uniform, keyed by recipe — for dev probes and bulk resets.
 *  The same clamping views `recipeChannel` hands out. */
export function recipeChannels(): Record<RecipeName, { value: number }> {
  return channelBoxes;
}

/** Every knob, keyed by recipe then knob — for dev probes. The SAME guarded
 *  boxes `recipeKnob` hands out; a bypass would be a NaN hole into the gate. */
export function recipeKnobs(): Record<
  RecipeName,
  Record<string, { value: number }>
> {
  return knobBoxes;
}

// ── The per-vertex graph ────────────────────────────────────────────────────

// Rotate a vector about the optical axis by +rad in the ops' `rot` convention.
// That is three's R_y(−rad), so handing it a pivot's own `rotation.y` UN-spins.
const rotateAboutAxis = (n: TslNode, rad: TslNode): TslNode => {
  const c = cos(rad);
  const s = sin(rad);
  return vec3(n.x.mul(c).sub(n.z.mul(s)), n.y, n.x.mul(s).add(n.z.mul(c)));
};

// ── Mechanism spin pivots ───────────────────────────────────────────────────
// A mesh under one of ops/mechanism.ts's SPIN PIVOTS gets its op delta added
// INSIDE that rotation: world = c + R_y(θ)q + R_y(θ)Δ, which for an off-axis
// pivot orbits the piece around its seated position instead of spinning it.
// So the POSITION delta is counter-rotated by −θ for such meshes; NORMALS ARE
// NOT (normal transformation ignores translation). Exact for the
// rigid-translation part of Δ, approximate if Δ varies per vertex.
//
// A tag is per MESH and baked into the graph, so a tagged mesh cannot share a
// material with an untagged one — see `opsSpinKey`, carried in every material
// cache key.
const OPS_SPIN_KEY = "opsSpin";
interface SpinTag {
  /** Cache discriminator — distinct per tagged group, so two pivots never share
   *  a material graph. */
  id: string;
  u: TslNode;
}
let spinTagCount = 0;

/**
 * Mark the whole subtree at `node` as living inside a spin pivot about the
 * optical axis, and hand back the box the driver writes the pivot's own
 * `rotation.y` (radians) into each frame. Must run BEFORE the subtree's
 * materials are built — the counter-rotation is a baked node.
 */
export function tagOpsSpin(node: THREE.Object3D): { value: number } {
  const u = uniform(0);
  const tag: SpinTag = { id: `spin${++spinTagCount}`, u: u as TslNode };
  node.traverse((o) => {
    o.userData[OPS_SPIN_KEY] = tag;
  });
  return u as unknown as { value: number };
}

/** The spin box tagged on a node, or null — the uniform a pivot writes. */
export function opsSpinBox(node: THREE.Object3D): { value: number } | null {
  const tag = node.userData[OPS_SPIN_KEY] as SpinTag | undefined;
  return tag ? (tag.u as unknown as { value: number }) : null;
}

/** A mesh's spin tag id, "" when untagged. */
function opsSpinKey(mesh: THREE.Object3D): string {
  return (mesh.userData[OPS_SPIN_KEY] as SpinTag | undefined)?.id ?? "";
}

/** True when this mesh carries a shrink-wrap binding (ops/frames.ts bindDecals),
 *  i.e. it is a decal that rides its host's facets. */
function needsWrap(mesh?: THREE.Object3D | null): boolean {
  return (
    mesh instanceof THREE.Mesh &&
    mesh.geometry.getAttribute(WRAP_ATTRS[0].name) != null
  );
}

/** A mesh's GRAPH VARIANT as a material-cache key fragment ("" for the common
 *  graph): a spin pivot's counter-rotation and a decal's shrink-wrap binding.
 *  Every material cache must carry this in its key, or a variant graph leaks
 *  onto a mesh that does not want it. */
export function opsVariantKey(mesh: THREE.Object3D): string {
  const spin = opsSpinKey(mesh);
  const wrap = needsWrap(mesh) ? "wrap" : "";
  return spin || wrap ? `${spin}|${wrap}` : "";
}

const spinNodeOf = (mesh?: THREE.Object3D | null): TslNode | null =>
  (mesh?.userData[OPS_SPIN_KEY] as SpinTag | undefined)?.u ?? null;

// Unit vector with a length FLOOR: a collapsed facet yields the zero vector
// rather than a NaN.
const safeUnit = (v: TslNode): TslNode =>
  v.div(max(length(v), 1e-9)) as TslNode;

/** Fold every active recipe over this vertex: the summed position delta and
 *  the object-space normal graph, each hard-gated per recipe. A null `spin`
 *  builds the plain graph, so an untagged mesh pays nothing. */
function fold(
  spin: TslNode | null,
  wrap: boolean,
): {
  delta: TslNode;
  normal: (n: TslNode) => TslNode;
} {
  const p = positionLocal as TslNode;
  // The packed per-piece frame lanes — see ops/frames.ts FRAME_ATTRS.
  const frameA = attribute("_opA", "vec4") as TslNode; // t0, R, span, rank
  const frameB = attribute("_opB", "vec4") as TslNode; // phase, class, rung, flags
  // yMin, yMax, depth, wink (the wink lane is the materials', not the deform's)
  const frameY = attribute("_opY", "vec4") as TslNode;

  /** THE FOLD AT ONE POINT, as `vec4(delta.xyz, rot)` — the emitted function
   *  (ops/emit/deform.*.ts) over the packed uniforms and frame attributes. */
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
    // THE SHRINK-WRAP BINDING — see ops/frames.ts WRAP_ATTRS. The deform is
    // evaluated at the three seated CORNERS of the host triangle this vertex
    // was bound to, and the vertex rebuilt from those deformed corners.
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
    // Facet frames, seated and deformed, built from the SAME winding — which
    // is what keeps the two consistently oriented.
    const eS = p1.sub(p0);
    const eF = P1.sub(P0);
    const nS = safeUnit(cross(eS, p2.sub(p0)));
    const nF = safeUnit(cross(eF, P2.sub(P0)));
    const bound = P0.mul(u).add(P1.mul(v)).add(P2.mul(w)).add(nF.mul(h));
    // The host adds this to `positionLocal`, and at rest the corners are
    // seated, so it reduces to the vertex's own authored position.
    const wrapDelta = bound.sub(p);
    const tS = safeUnit(eS);
    const tF = safeUnit(eF);
    const bS = cross(nS, tS);
    const bF = cross(nF, tF);
    return {
      delta: spin ? rotateAboutAxis(wrapDelta, spin) : wrapDelta,
      // The shading normal rides the facet's own rotation: components read in
      // the seated triad, recombined in the deformed one. The deformed triad
      // crosses on varyings, so normalLocal is unit in the vertex stage only —
      // transformNormalToView's normalize() covers normalView consumers.
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
    // Inside a spin pivot the delta lands in the ROTATED local frame; un-spin
    // it so the piece spins about its own displaced axis. Position only.
    delta: spin ? rotateAboutAxis(delta, spin) : delta,
    // The normal turns about the optical axis by the summed gated rot, carried
    // to the fragment on a varying.
    normal: (n: TslNode) => rotateAboutAxis(n, varying(rot) as TslNode),
  };
}

/** ONE fold() evaluation; position, view normal and object-space normal all
 *  derived from it (invariant 1). */
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
    // normalNode is consumed as a VIEW-space vector, so hand the object-space
    // graph over transformed.
    normal: transformNormalToView(nLocal),
    normalLocal: nLocal,
  };
}

// Single-graph position builder (evaluates its own fold()): the line attach
// path and the instrument's probe.
const opsPositionFn = Fn(() =>
  (positionLocal as TslNode).add(fold(null, false).delta),
);

/** Position-only graph. The untagged path is the shared `Fn` above; a
 *  spin-tagged or wrapped mesh gets its own instance. */
function opsPositionNode(spin: TslNode | null, wrap: boolean): TslNode {
  if (!spin && !wrap) return opsPositionFn();
  return Fn(() => {
    return (positionLocal as TslNode).add(fold(spin, wrap).delta);
  })();
}

/**
 * Attach the op position+normal graphs to a Node material, from ONE shared
 * evaluation. Returns the position node so the caller can feed the SAME node to
 * depthFadeFactor. Pass `mesh` wherever a material can reach a spin-tagged or
 * wrapped mesh, and key that material's cache by `opsVariantKey`.
 */
export function attachOps(
  material: THREE.NodeMaterial,
  mesh?: THREE.Object3D | null,
): TslNode {
  const g = opsGraph(spinNodeOf(mesh), needsWrap(mesh));
  material.positionNode = g.position;
  material.normalNode = g.normal;
  return g.position;
}

/** Position only — for line materials, which have no normal. Returns the node
 *  so the depth fade can share it. */
export function attachOpsLine(
  material: THREE.NodeMaterial,
  mesh?: THREE.Object3D | null,
): TslNode {
  const position = opsPositionNode(spinNodeOf(mesh), needsWrap(mesh));
  material.positionNode = position;
  return position;
}

/** Inverted-hull attach (the outline look): the deformed position pushed OUT
 *  along the deformed OBJECT-space normal by `width` (model mm), so a BackSide
 *  hull keeps constant thickness through every recipe. */
export function attachOpsHull(
  material: THREE.NodeMaterial,
  width: number,
  mesh?: THREE.Object3D | null,
): void {
  const g = opsGraph(spinNodeOf(mesh), needsWrap(mesh));
  material.positionNode = g.position.add(g.normalLocal.mul(width));
}

/** A fresh copy of the deformed LOCAL position graph (the depth-fade probe and
 *  dev instrument); a node can't be shared across materials. Spin-free, so a
 *  probe of a spin-tagged mesh drifts from the render while its pivot turns. */
export function opsLocalPosition(): TslNode {
  return opsPositionFn();
}

/** True if a mesh carries the derived op frame (ops/frames.ts ran over it). */
export function hasOpFrames(mesh: THREE.Mesh): boolean {
  return mesh.geometry.getAttribute("_opA") != null;
}

// Per-attribute fallback for edge vertices that match no source vertex: a
// SELF-CONSISTENT frame (own radius, own meridian, a full turn of span) so the
// deform there is ~identity and nothing divides by R = 0. `src` is the source
// attribute, for the lanes that are constant over the whole mesh. Keyed on
// FRAME_ATTRS' names, so a new lane cannot ship without a fallback.
const EDGE_FALLBACK: Record<
  (typeof FRAME_ATTRS)[number]["name"],
  (x: number, y: number, z: number, src: THREE.BufferAttribute) => number[]
> = {
  // (t0, R, span, rank): own meridian, own radius (R = 0 guarded), a full turn.
  _opA: (x, _y, z) => [
    Math.atan2(z, x),
    Math.max(Math.hypot(x, z), R_MIN),
    TAU,
    0.5,
  ],
  // (phase, class, rung, flags); axi = 1 — no meridian worth trusting here.
  _opB: () => [0, PART_CLASS.structure, 0, packFlags(1, 0)],
  // (yMin, yMax, depth, wink): a lone body riding no host, which with
  // span = 2π and axi = 1 above sits out the sheet selections entirely; the
  // wink is the mesh's own.
  _opY: (_x, y, _z, src) => [y - 0.5, y + 0.5, 0, src.getW(0)],
};

/**
 * EdgesGeometry that carries the `_op*` frame attributes, so its line material
 * runs the same deform as the surface. EdgesGeometry drops custom attributes, so
 * they are copied back by matching each edge vertex to its source vertex by
 * position (1e-3 mm buckets — the seam-duplication quantum, see ops/frames.ts).
 */
export function opsEdgeGeometry(
  src: THREE.BufferGeometry,
  thresholdDeg = 24,
): THREE.BufferGeometry {
  const eg = new THREE.EdgesGeometry(src, thresholdDeg);
  const sp = src.getAttribute("position");
  if (!sp || !src.getAttribute("_opA")) return eg; // no frame to carry

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

// The model's own materials are built by materials/unified.ts, which mounts the
// three attach points above ONE op NodeMaterial per source material × graph
// variant.

// ── DEV diagnostics ─────────────────────────────────────────────────────────

/** One structured console line summarizing what ops/frames.ts measured.
 *  DEV only (the caller gates it). */
export function reportOpsFrames(
  root: THREE.Object3D,
  frames: DerivedFrames,
): void {
  // Components are recovered from the written attributes: every vertex of one
  // component carries the identical frame, so the frame tuple IS the component
  // id. Counted per mesh, the framing unit.
  const perMesh = new Map<string, number>();
  const histogram = new Map<number, number>();
  const spans: number[] = [];
  let components = 0;
  let axiCount = 0;

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !hasOpFrames(o)) return;
    const g = o.geometry;
    // Packed lanes read directly: only four of the twelve fields are wanted.
    const fa = g.getAttribute("_opA"); // t0, R, span, rank
    const fb = g.getAttribute("_opB"); // phase, class, rung, flags
    const seen = new Map<string, boolean>();
    for (let i = 0; i < fa.count; i++) {
      const sig = `${fa.getX(i)}|${fa.getY(i)}|${fa.getZ(i)}`;
      if (seen.has(sig)) continue;
      seen.set(sig, true);
      spans.push(fa.getZ(i));
      if (unpackFlags(fb.getW(i)).axi > 0.5) axiCount++;
    }
    components += seen.size;
    perMesh.set(o.name || "(unnamed)", seen.size);
    histogram.set(seen.size, (histogram.get(seen.size) ?? 0) + 1);
  });

  // Cut widths: the segmented shells are cut 5-up and 7-up, so a healthy
  // derivation shows two span clusters.
  const near = (target: number) =>
    spans.filter((s) => Math.abs(s - target) < 0.08);
  const cluster = (target: number) => {
    const hits = near(target);
    return hits.length === 0
      ? { count: 0 }
      : {
          count: hits.length,
          min: +Math.min(...hits).toFixed(4),
          max: +Math.max(...hits).toFixed(4),
        };
  };

  // Adoption: every component under a SHELL_ADOPT feature snapped its t0 to the
  // host's nearest sector centre; the error is how far that snap moved it.
  const wrapPiNum = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
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
        // centroid meridian per written-t0 group = the piece's OWN meridian
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
          adoptErr = Math.max(
            adoptErr,
            Math.abs(wrapPiNum(Math.atan2(s.z / s.n, s.x / s.n) - k)),
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
