// The DEFORM HOST — the one place the backend-agnostic op pipeline meets three.
// It reads the `_op*` frame attributes ops/frames.ts measured, builds ONE
// `OpCtx` per vertex, folds every ACTIVE recipe through `runPipeline`, and hands
// the summed result to a NodeMaterial as a position graph + a normal graph.
//
// THE FIVE LAWS THIS FILE EXISTS TO KEEP:
//
//  1. ONE ctx evaluation. TSL does not CSE across distinct node objects, so the
//     position and normal graphs must be derived from the SAME `fold()` run —
//     otherwise the whole pipeline is compiled two (or three) times per
//     material. `opsGraph()` is that shared evaluation; `attachOps` /
//     `attachOpsHull` both go through it.
//  2. The delta form. A recipe's contribution is `point(final) − q`, measured
//     against the AUTHORED position itself: the op state carries the point in
//     cartesian, so an identity pipeline returns the very components it was
//     seeded with and the subtraction is exactly zero.
//  3. The HARD IDLE GATE. `.mul(step(IDLE_EPS, channel))` on both the delta and
//     the rotation. At channel = 0 every op is identity only up to float
//     rounding, and the step force-zeroes that residue so the seated render is
//     bit-exact by construction. KNOB_LIMITS is load-bearing here: the step
//     multiplies by ZERO and NaN · 0 = NaN, so a knob that makes the gate
//     divide 0/0 pushes NaN straight through into the seated render. The
//     emitted chain also BRANCHES on the same threshold to skip the work, but
//     the multiply stays — it, not the branch, is what the exactness rests on.
//  4. Rest-normal rotation. The normal graph rotates `normalLocal` about the
//     optical axis by the summed gated `rot`, in the SAME +α sense the position
//     build uses, then hands it over view-transformed. No normalize: a rotation
//     preserves unit length. `rot` is the ONLY channel a normal has, which is
//     why the working direction (`aim`) is one ANGLE in the radial plane and
//     not a basis — an out-of-plane aim would shade wrong.
//  5. The chain runs in the VERTEX stage only. Everything the fragment reads
//     off `fold()` — the normal's `rot`, the wrap's deformed triad,
//     materials/depthfade.ts's viewZ — crosses on a VARYING; a fragment-stage
//     read of any of them re-emits the entire recipe chain per pixel. Trap:
//     NodeMaterial assigns positionNode INTO the positionLocal varying, so a
//     fragment-stage read of positionLocal is the DEFORMED position — feeding
//     it back through the chain computes rot(deform(x)), not rot(x).
//
// The seeding this file owns beyond the placement lanes: `v.aim = f.orient =
// t0`, and `v.rem = 0` (no chain is open until an `anchor` loads the cursor).
//
// This is the ONLY deform host in the repo: every moving surface, edge line and
// normal comes through here.

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
  type DerivedFrames,
} from "./frames";

export type { RecipeName };

const TAU = 6.283185307179586;
/** THE IDLE THRESHOLD, written ONCE so the hard idle gate (law 3) and the
 *  uniform branch that skips a recipe's work read the SAME edge. EXPORTED as a
 *  READING: a channel below it contributes an EXACT zero, which is how
 *  materials/unified.ts concludes the model is standing in its rest pose before
 *  trusting a mesh's rest-pose bounds. */
export const IDLE_EPS = 1e-6;
// The same radius floor ops/frames.ts applies, for the edge-geometry fallback
// (an unmatched vertex must never hand the algebra R = 0 — R is a divisor).
const R_MIN = 0.5;

/** Every recipe name, in table order — the one list to loop when something has
 *  to cover all recipes, instead of re-typing the names. The recipes reach this
 *  file only through ops/emit: the chain is generated source now, so nothing
 *  here builds a recipe table. */
export const RECIPE_NAMES = LAYOUT.names;

// ── The deform's source ─────────────────────────────────────────────────────
// The chain ships as GENERATED SHADER SOURCE (ops/emit), emitted from the same
// recipe table the CPU spec runs. It is dialect-specific, so the backend has to
// be declared before any material is built — core/scene.ts does that the moment
// the renderer exists, which is before `prepareModelMaterials`.
// BOTH DIALECTS SHIP, and the unused one costs ~8 KB gzipped in the chunk. The
// alternative is importing the chosen one, which makes this function async —
// and its whole value is the SYNCHRONOUS guarantee that no material can be
// built before the dialect is known (the throw below). A boot-time await is
// exactly the serial hop this work exists to remove, so the kilobytes are the
// price of the contract, paid deliberately.
type DeformBackend = "wgsl" | "glsl";
let deformBackend: DeformBackend | null = null;
let deformFn: ((args: Record<string, TslNode>) => TslNode) | null = null;

/** Declare which dialect the renderer speaks. Idempotent for the same value;
 *  a CHANGE after materials exist would leave the built graphs on the old
 *  dialect, so it throws rather than silently half-swapping. */
export function setDeformBackend(backend: DeformBackend): void {
  if (deformBackend === backend) return;
  if (deformBackend !== null)
    throw new Error(
      `lens ops: deform backend already set to "${deformBackend}" — the graphs are baked`,
    );
  deformBackend = backend;
  const src = backend === "wgsl" ? DEFORM_WGSL : DEFORM_GLSL;
  deformFn = (backend === "wgsl" ? wgslFn(src) : glslFn(src)) as never;
  // DEV: the checked-in source is generated, so an edited recipe with no
  // regenerate would run the OLD chain with no other symptom. The emitter has
  // no three dependency and is import()ed, so none of this reaches production.
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
// One channel uniform per recipe (0 = seated, bit-exact) and one uniform per
// knob, initialized to the recipe's PHYSICAL defaults.
//
// PROCESS-GLOBAL, deliberately: the channels, the knobs, `activeRecipes` below
// and the shading uniforms are one set for the document, which is why
// core/scene's `initScene` is a ONE-SCENE-PER-DOCUMENT call.

// PACKED, because the emitted deform (ops/emit) takes them as two function
// parameters rather than reading forty separate bindings: the channels are one
// vec4 (one lane per recipe, table order) and the knobs a vec4 array of
// per-recipe blocks. ops/emit/layout.ts derives which lane is which from the
// recipe table itself, so the shader and the setters below cannot disagree.
//
// THE TWO-ARRAY SPLIT IS NOT AN UPLOAD OPTIMISATION. UniformArrayNode rebuilds
// its buffer every render regardless, and three gates the GPU write on its own
// value comparison — so a per-frame channel write costs the same whether the
// knobs sit beside it or not. The split is for the shader signature: two
// parameters that mean different things.
// …explicitly ZEROED: Vector4's own default is (0, 0, 0, 1), which would boot
// the fourth lane — rose's channel — fully played.
const uChannels = uniform(new THREE.Vector4(0, 0, 0, 0));
const uKnobs = uniformArray(
  Array.from({ length: LAYOUT.vec4Count }, () => new THREE.Vector4(0, 0, 0, 0)),
);

const COMP = ["x", "y", "z", "w"] as const;

/** A `{ value }` box onto ONE LANE of a packed uniform. The clamping views
 *  below compose on top of it exactly as they did over a scalar uniform. */
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

// The knob lanes boot at the recipes' PHYSICAL defaults, as the per-knob
// uniforms did.
for (const n of RECIPE_NAMES)
  for (const [k, v] of Object.entries(LAYOUT.knobDefaults[n]))
    knobLane[n][k].value = v as number;

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

/** `clamped` plus a JOINT ceiling: the write must also leave `max − partner`
 *  headroom, read at WRITE time — a view lives for the process, so a ceiling
 *  captured at construction would freeze the partner's module-load value. The
 *  partner is never moved; see JOINT_SUMS. */
function jointClamped(
  box: { value: number },
  lo: number,
  hi: number,
  partner: { value: number },
  max: number,
): { value: number } {
  return {
    get value() {
      return box.value;
    },
    set value(v: number) {
      const ceil = Math.max(lo, Math.min(hi, max - partner.value));
      box.value = Number.isFinite(v) ? Math.min(ceil, Math.max(lo, v)) : lo;
    },
  };
}

/** A finite-guarding VIEW of an UNLIMITED uniform box: a non-finite write is
 *  dropped and the box keeps its last value. No range clamp, because an
 *  unlimited knob feeds op amplitudes only — but NaN is never a pose, and one
 *  NaN write would kill the seated render until reload (NaN · 0 = NaN). */
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

// The channel boxes, wrapped ONCE (not per call — scene.ts writes these every
// frame). A channel is a 0..1 scrub by contract and the idle gate's step reads
// it directly, so an out-of-range or NaN write is the hole the clamps close.
const channelBoxes = Object.fromEntries(
  RECIPE_NAMES.map((n) => [n, clamped(channelLane[n], 0, 1)]),
) as Record<RecipeName, { value: number }>;

/** The channel uniform for one recipe: `.value` 0 (seated) .. 1 (fully played),
 *  clamped to that range on write. */
export function recipeChannel(name: RecipeName): { value: number } {
  return channelBoxes[name];
}

/**
 * The reachable range of every knob that could break the deform, as [min, max]:
 * the GATE-FEEDING knobs, plus any knob that can zero a DENOMINATOR.
 *
 * The hard idle gate multiplies by zero at channel 0 and NaN · 0 is NaN, so the
 * one thing that can break the seated render's bit-exactness is a knob setting
 * that makes ops/gate.ts (or an op below it) divide by zero. Three gate
 * denominators have to stay positive:
 *
 *   windowFrac                            ≥ 0.05
 *   split − flightStart                   > 0
 *   rollEnd − split + min(overlap, split) > 0
 *
 * `stagger + partStagger ≤ 0.9` is a JOINT constraint no per-knob limit can
 * express; it lives in JOINT_SUMS below.
 *
 * MEMBERSHIP IS BY ENUMERATION: every gate input (stagger, partStagger, split,
 * overlap, snap), every knob reaching an `A.div` denominator in ops/recipes.ts
 * or ops/ops.ts, and — since a `Progress` window adds a divisor and a pow
 * exponent AHEAD of the gate that no static pass can check on a uniform — ANY
 * knob wired into a `during` field. Knobs absent from the table neither feed
 * the gate nor divide.
 */
export const KNOB_LIMITS: Partial<
  Record<RecipeName, Record<string, readonly [number, number]>>
> = {
  assemble: {
    stagger: [0, 0.9],
    partStagger: [0, 0.9],
    split: [0.15, 0.95],
    overlap: [0.1, 2],
    snap: [0, 1],
    curl: [0, 1],
    // a FLOOR, not a taste limit: 0.05 still flattens the arc 20× (q = R/rf),
    // which reads as flat, and the ceiling only keeps a silly write finite.
    flatten: [0.05, 30],
    // a selector weight: outside [0, 1] it would invert or over-scale the scope
    keepScope: [0, 1],
  },
  // peel's knob is a `during` width, not a gate window: 1 − stagger is how much
  // of the channel each piece gets, so the ceiling guards a denominator.
  peel: { stagger: [0, 0.85] },
  // rose keys the same `during` idiom on the whorl key, so its stagger carries
  // the identical bound for the identical reason. `creasePos` is a SHAPE bound,
  // not a gate one: either end of its range starves a panel below the crease
  // band's own width. `band` IS the crease width, which ops.ts crease() divides
  // by — so that floor is load-bearing, not taste.
  rose: { stagger: [0, 0.85], creasePos: [0.05, 0.95], band: [0.6, 6.6] },
};

/**
 * The JOINT knob constraints no per-knob box can express: a PAIR whose SUM has
 * to stay under `max`. assemble's gate window is DERIVED as
 * `1 − stagger − partStagger` (ops/recipes assemble.gateSpec), so the pair must
 * sum to ≤ 0.9 for windowFrac to clear the 0.05 floor the identity anchor needs.
 *
 * ENFORCED IN THE KNOB VIEW, ORDER-DEPENDENTLY: a write clamps against the
 * partner's CURRENT value and never moves it, so a caller wanting a big
 * partStagger writes the SMALL knob first, and a restore path reaches the
 * defaults from (0, 0) — which is what `resetRecipeKnobs` does.
 */
export const JOINT_SUMS: Partial<
  Record<RecipeName, { pair: readonly [string, string]; max: number }>
> = {
  assemble: { pair: ["stagger", "partStagger"], max: 0.9 },
};

/** The partner knob + sum cap for one knob, if it is half of a joint pair. */
function jointPartner(
  name: RecipeName,
  knob: string,
): { partner: string; max: number } | null {
  const j = JOINT_SUMS[name];
  if (!j) return null;
  const [a, b] = j.pair;
  if (knob === a) return { partner: b, max: j.max };
  if (knob === b) return { partner: a, max: j.max };
  return null;
}

/** The write VIEW for one knob: the clamping wrapper for a knob in KNOB_LIMITS
 *  (joint half included), a plain finite guard for the rest. The limit belongs
 *  at the uniform boundary because every path into the shader goes through
 *  here, and the gate's identity has to survive all of them. */
function makeKnobBox(name: RecipeName, knob: string): { value: number } {
  const u = knobLane[name][knob];
  const limit = KNOB_LIMITS[name]?.[knob];
  if (!limit) return guarded(u);
  const joint = jointPartner(name, knob);
  if (!joint) return clamped(u, limit[0], limit[1]);
  return jointClamped(
    u,
    limit[0],
    limit[1],
    knobLane[name][joint.partner],
    joint.max,
  );
}

// Every knob box, wrapped ONCE at module load — the same object for the
// process's life, so a caller may key on box IDENTITY (explore/scene-kit keys
// its first-write undo snapshot on it).
const knobBoxes = Object.fromEntries(
  RECIPE_NAMES.map((n) => [
    n,
    Object.fromEntries(LAYOUT.knobNames[n].map((k) => [k, makeKnobBox(n, k)])),
  ]),
) as Record<RecipeName, Record<string, { value: number }>>;

/** One recipe knob's uniform (physical units — see the recipe's knobDefaults),
 *  as the same guarded box every call. THROWS on an unknown recipe/knob so a
 *  typo fails at import instead of handing back a detached uniform. */
export function recipeKnob(name: RecipeName, knob: string): { value: number } {
  const box = knobBoxes[name]?.[knob];
  if (!box) throw new Error(`lens ops: no knob "${knob}" on recipe "${name}"`);
  return box;
}

/** Restore EVERY knob to its recipe's `knobDefaults`, so a knob one animation's
 *  slider moved does not follow the selection out. ORDER: the joint pair is
 *  zeroed FIRST, or a plain defaults sweep could cap the first restore against
 *  a partner still holding a big preset value (JOINT_SUMS). */
export function resetRecipeKnobs(): void {
  for (const name of RECIPE_NAMES) {
    for (const knob of JOINT_SUMS[name]?.pair ?? [])
      knobBoxes[name][knob].value = 0;
    for (const [knob, v] of Object.entries(LAYOUT.knobDefaults[name]))
      knobBoxes[name][knob].value = v;
  }
}

/** Every channel uniform, keyed by recipe — for dev probes and bulk resets.
 *  Same clamping views `recipeChannel` hands out, for the same reason. */
export function recipeChannels(): Record<RecipeName, { value: number }> {
  return channelBoxes;
}

/** Every knob, keyed by recipe then knob — for dev probes. The SAME boxes
 *  `recipeKnob` hands out, so a write through this table is guarded exactly as
 *  a page's is; a bypass would be a NaN hole straight into the idle gate. */
export function recipeKnobs(): Record<
  RecipeName,
  Record<string, { value: number }>
> {
  return knobBoxes;
}

// ── The per-vertex graph ────────────────────────────────────────────────────

// Rotate a vector about the optical axis by +rad: (x·cosα − z·sinα, x·sinα +
// z·cosα) — the house convention the ops' cumulative `rot` is written in.
const rotateAboutAxis = (n: TslNode, rad: TslNode): TslNode => {
  const c = cos(rad);
  const s = sin(rad);
  return vec3(n.x.mul(c).sub(n.z.mul(s)), n.y, n.x.mul(s).add(n.z.mul(c)));
};

// ── Mechanism spin pivots ───────────────────────────────────────────────────
// A mesh under one of ops/mechanism.ts's SPIN PIVOTS gets its op delta added
// INSIDE that rotation: world = c + R_y(θ)q + R_y(θ)Δ. For a pivot ON the
// optical axis that is right — seat and displacement turn together. For a pivot
// OFF the axis it is not: R_y(θ)Δ swings the exploded piece in a CIRCLE around
// its seated position instead of spinning it in place.
//
// THE LAW: counter-rotate the POSITION delta by −θ for meshes under such a
// pivot, giving the same spin about the piece's own DISPLACED axis. NORMALS ARE
// NOT counter-rotated — normal transformation ignores translation, so the
// rest-normal path above is already correct. It is EXACT for the
// rigid-translation part of Δ and deliberately APPROXIMATE if a bending
// modifier is folded onto the same piece, since Δ then varies per vertex.
//
// A tag is per MESH and baked into the graph, so a tagged mesh cannot share a
// material with an untagged one — see `opsSpinKey`, which every material cache
// carries in its key.
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
 * `rotation.y` (radians) into each frame. The WHOLE subtree, because
 * `opsSpinBox` must find the tag on the node the caller names.
 *
 * ORDERING CONSTRAINT: the tag must exist BEFORE the mesh's materials are built
 * — the counter-rotation is a baked node, not a runtime branch.
 */
export function tagOpsSpin(node: THREE.Object3D): { value: number } {
  const u = uniform(0);
  const tag: SpinTag = { id: `spin${++spinTagCount}`, u: u as TslNode };
  node.traverse((o) => {
    o.userData[OPS_SPIN_KEY] = tag;
  });
  return u as unknown as { value: number };
}

/** The spin box tagged on a node, or null — how ops/mechanism.ts gets back the
 *  uniform its pivot has to write. */
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
 *  graph). Two things vary the deform per mesh — a spin pivot's
 *  counter-rotation and a decal's shrink-wrap binding — and a material built
 *  with either must never reach a mesh that does not want it, so every material
 *  cache carries this in its key. */
export function opsVariantKey(mesh: THREE.Object3D): string {
  const spin = opsSpinKey(mesh);
  const wrap = needsWrap(mesh) ? "wrap" : "";
  return spin || wrap ? `${spin}|${wrap}` : "";
}

const spinNodeOf = (mesh?: THREE.Object3D | null): TslNode | null =>
  (mesh?.userData[OPS_SPIN_KEY] as SpinTag | undefined)?.u ?? null;

/** `R_y(−θ)·v` in the convention `Object3D.rotation.y` rotates by — the exact
 *  inverse of the pivot's own spin. NOT the same sense as `rotateAboutAxis`
 *  above, which is the ops' +α position convention. */
const unspinY = (v: TslNode, theta: TslNode): TslNode => {
  const c = cos(theta);
  const s = sin(theta);
  return vec3(v.x.mul(c).sub(v.z.mul(s)), v.y, v.x.mul(s).add(v.z.mul(c)));
};

/** Fold every active recipe over this vertex: the summed position delta and the
 *  summed normal rotation, each hard-gated per recipe. `null` means NOTHING is
 *  folded, so the caller can emit a literal identity graph rather than an
 *  add-of-zero. A null `spin` builds the plain graph, so an untagged mesh pays
 *  nothing. */
// Unit vector with a length FLOOR: a collapsed facet yields the zero vector
// rather than a NaN, and the terms it scales are then harmless.
const safeUnit = (v: TslNode): TslNode =>
  v.div(max(length(v), 1e-9)) as TslNode;

function fold(
  spin: TslNode | null,
  wrap: boolean,
): {
  delta: TslNode;
  rot: TslNode;
  normal?: (n: TslNode) => TslNode;
} {
  const p = positionLocal as TslNode;
  // The packed per-piece frame lanes — see ops/frames.ts FRAME_ATTRS.
  const frameA = attribute("_opA", "vec4") as TslNode; // t0, R, span, rank
  const frameB = attribute("_opB", "vec4") as TslNode; // phase, class, rung, axi
  // yMin, yMax, layerN, adopted
  const frameY = attribute("_opY", "vec4") as TslNode;

  /** THE FOLD AT ONE POINT, as `vec4(delta.xyz, rot)` — the emitted function
   *  (ops/emit/deform.*.ts), or the TSL node fold under `?deform=tsl`. Both read
   *  the SAME packed uniforms and the same three frame attributes, so the switch
   *  compares emission and nothing else. */
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

  const at = sampleAt(p);
  const delta = at.xyz as TslNode;
  const rot = at.w as TslNode;

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
    // is what keeps the two consistently oriented. Deliberately NOT a
    // dot-product sign match against the seated normal, which would flip the
    // text through the surface whenever the wrap turns a facet past 90°.
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
      delta: spin ? unspinY(wrapDelta, spin) : wrapDelta,
      rot,
      // The shading normal rides the facet's own rotation: components read in
      // the seated triad, recombined in the deformed one. Per VERTEX both
      // triads are orthonormal; the deformed one crosses on varyings (law 5),
      // and interpolated frames are neither unit nor orthogonal — the
      // normalize() inside transformNormalToView absorbs that, so consumers
      // of normalView are safe, but normalLocal is unit in the vertex stage
      // only. The seated triad is attribute-only, free to rebuild per fragment.
      normal: (n: TslNode) =>
        (varying(tF) as TslNode)
          .mul(n.dot(tS))
          .add((varying(bF) as TslNode).mul(n.dot(bS)))
          .add((varying(nF) as TslNode).mul(n.dot(nS))),
    };
  }
  // Inside a spin pivot the delta lands in the ROTATED local frame; un-spin it
  // so the piece spins about its own displaced axis instead of orbiting its
  // seated one. Position only — the normal rotation is already correct.
  return { delta: spin ? unspinY(delta, spin) : delta, rot };
}

/** ONE fold() evaluation; position, view normal and object-space normal all
 *  derived from it (law 1 in the header). */
function opsGraph(
  spin: TslNode | null,
  wrap: boolean,
): {
  position: TslNode;
  normal: TslNode;
  normalLocal: TslNode;
} {
  const f = fold(spin, wrap);
  // A shrink-wrapped decal's normal rides its host FACET (fold's `normal`);
  // everything else rotates about the optical axis by the summed gated rot,
  // carried to the fragment on a varying (law 5).
  const nLocal = f.normal
    ? f.normal(normalLocal as TslNode)
    : rotateAboutAxis(normalLocal as TslNode, varying(f.rot) as TslNode);
  return {
    position: (positionLocal as TslNode).add(f.delta),
    // normalNode is consumed as a VIEW-space vector (NodeMaterial.setupNormal
    // returns it untransformed), so hand the object-space graph over
    // transformed.
    normal: transformNormalToView(nLocal),
    normalLocal: nLocal,
  };
}

// Single-graph position builder (evaluates its own fold()): the line attach
// path and the instrument's probe, where sharing a bag buys nothing.
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
 * depthFadeFactor instead of building a second deform. Pass `mesh` wherever a
 * material can reach a spin-tagged or wrapped mesh, and key that material's
 * cache by `opsVariantKey` — or a variant graph leaks onto a mesh without it.
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
 *  hull keeps constant thickness through every recipe. One fold() feeds both
 *  halves, same dedupe as attachOps. */
export function attachOpsHull(
  material: THREE.NodeMaterial,
  width: number,
  mesh?: THREE.Object3D | null,
): void {
  const g = opsGraph(spinNodeOf(mesh), needsWrap(mesh));
  material.positionNode = g.position.add(g.normalLocal.mul(width));
}

/** A fresh copy of the deformed LOCAL position graph (the depth-fade probe and
 *  dev instrument). A node can't be shared across materials, so each call
 *  builds a new instance. Deliberately spin-free — this is the RECIPE deform on
 *  its own, so a probe of a spin-tagged mesh drifts from the render while its
 *  pivot is turned. */
export function opsLocalPosition(): TslNode {
  return opsPositionFn();
}

/** True if a mesh carries the derived op frame (ops/frames.ts ran over it). */
export function hasOpFrames(mesh: THREE.Mesh): boolean {
  return mesh.geometry.getAttribute("_opA") != null;
}

// Per-attribute fallback for edge vertices that match no source vertex: a
// SELF-CONSISTENT frame (own radius, own meridian, a full turn of span) so the
// deform there is ~identity and nothing ever divides by R = 0.
const EDGE_FALLBACK: Record<
  string,
  (x: number, y: number, z: number) => number[]
> = {
  // (t0, R, span, rank): own meridian, own radius (R = 0 guarded), a full turn.
  _opA: (x, _y, z) => [
    Math.atan2(z, x),
    Math.max(Math.hypot(x, z), R_MIN),
    TAU,
    0.5,
  ],
  // (phase, class, rung, axi); axi = 1 — no meridian worth trusting here.
  _opB: () => [0, PART_CLASS.structure, 0, 1],
  // (yMin, yMax, layerN, adopted): a lone body riding no host, which with
  // span = 2π and axi = 1 above sits out the sheet selections entirely.
  _opY: (_x, y) => [y - 0.5, y + 0.5, 1, 0],
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
        // Every component, not just x/y: the copy must not silently truncate a
        // frame attribute that grows past a vec2.
        for (let c = 0; c < size; c++)
          out[i * size + c] = sa.getComponent(si, c) as number;
      } else {
        const fb = EDGE_FALLBACK[name](x, y, z);
        for (let c = 0; c < size; c++) out[i * size + c] = fb[c] ?? 0;
      }
    }
    eg.setAttribute(name, new THREE.BufferAttribute(out, size));
  }
  return eg;
}

// THE MODEL'S OWN MATERIALS are built by materials/unified.ts, which mounts the
// three attach points above ONE op NodeMaterial per source material × graph
// variant — every piece scrubs the same uniforms, so the program count and the
// time-to-first-frame stay low.

// ── DEV diagnostics ─────────────────────────────────────────────────────────

/** One structured console line summarizing what ops/frames.ts measured — the
 *  numbers needed to tell "the derivation is wrong" from "the tuning is wrong".
 *  DEV only (the caller gates it). */
export function reportOpsFrames(
  root: THREE.Object3D,
  frames: DerivedFrames,
): void {
  // Components are recovered from the written attributes: every vertex of one
  // component carries the identical frame, so the frame tuple IS the component
  // id. Counted PER MESH, the framing unit, so `components` runs ahead of the
  // mesh count only where a mesh was measured per ISLAND.
  const perMesh = new Map<string, number>();
  const histogram = new Map<number, number>();
  const spans: number[] = [];
  let components = 0;
  let axiCount = 0;

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !hasOpFrames(o)) return;
    const g = o.geometry;
    // Packed lanes read directly (not via frameOf): this walks every vertex of
    // every mesh and only four of the twelve fields are wanted.
    const fa = g.getAttribute("_opA"); // t0, R, span, rank
    const fb = g.getAttribute("_opB"); // phase, class, rung, axi
    const seen = new Map<string, boolean>();
    for (let i = 0; i < fa.count; i++) {
      const sig = `${fa.getX(i)}|${fa.getY(i)}|${fa.getZ(i)}`;
      if (seen.has(sig)) continue;
      seen.set(sig, true);
      spans.push(fa.getZ(i));
      if (fb.getW(i) > 0.5) axiCount++;
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
  // host's nearest sector centre — the error is how far that snap moved it.
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
