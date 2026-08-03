// The DEFORM HOST — the one place the backend-agnostic op pipeline meets three.
// It reads the `_op*` frame attributes ops/frames.ts measured, builds ONE
// `OpCtx` per vertex, folds every ACTIVE recipe through `runPipeline`, and hands
// the summed result to a NodeMaterial as a position graph + a normal graph.
//
// THE FOUR LAWS THIS FILE EXISTS TO KEEP:
//
//  1. ONE ctx evaluation. TSL does not CSE across distinct node objects, so the
//     position and normal graphs must be derived from the SAME `fold()` run —
//     otherwise the whole pipeline is compiled two (or three) times per
//     material. `opsGraph()` is that shared evaluation; `attachOps` /
//     `attachOpsHull` both go through it.
//  2. The delta form. A recipe's contribution is
//     `reconstruct(final) − reconstruct(seated)`, with BOTH sides rebuilt by the
//     same (radius·cos θ, axial, radius·sin θ) formula, so the two cancel
//     term-for-term when the ops are identity.
//  3. The HARD IDLE GATE. `.mul(step(1e-6, channel))` on both the delta and the
//     rotation. At channel = 0 every op is identity only up to float rounding
//     (a bend rebuilds the seated arc through trig); the step force-zeroes the
//     residue so the seated render is bit-exact for any knob values within
//     KNOB_LIMITS, BY CONSTRUCTION rather than by luck. The limits are load-
//     bearing here and not a UI nicety: the step multiplies by ZERO, and
//     NaN · 0 = NaN, so a knob that makes the gate divide 0/0 would push NaN
//     straight through the idle gate into the seated render.
//  4. Rest-normal rotation. The normal graph rotates `normalLocal` about the
//     optical axis by the summed gated `rot` in the SAME +α sense the position
//     build uses, then hands it over view-transformed. No normalize: a rotation
//     preserves unit length, and at rot = 0 the graph is `normalLocal` untouched.
//     `rot` is the ONLY channel a normal has, which is also why the working
//     direction (`aim`) is one ANGLE in the radial plane and not a basis: an
//     out-of-plane aim would give correct silhouettes with wrong shading.
//
// The seeding this file owns, beyond the placement lanes: `v.aim = f.orient =
// t0` (every direction starts on the piece's own meridian) and `v.rem = 0` (no
// bend chain is open until an `anchor` loads the cursor with ctx.d).
//
// This is the ONLY deform host in the repo: every moving surface, edge line and
// normal comes through here, off `_op*` frame attributes and recipes.

import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  uniform,
  positionLocal,
  normalLocal,
  transformNormalToView,
  vec2,
  vec3,
  float,
  atan,
  cos,
  sin,
  max,
  step,
  length,
  cross,
} from "three/tsl";
import type { Sc } from "./algebra";
import { tslAlgebra, type TslNode } from "./algebra-tsl";
import { gate } from "./gate";
import { makeRecipes, type Recipe } from "./recipes";
import {
  runPipeline,
  validatePipeline,
  PART_CLASS,
  type OpCtx,
  type PieceFrame,
  type VertexState,
} from "./ops";
import {
  FRAME_ATTRS,
  SHELL_ADOPT,
  WRAP_ATTRS,
  type DerivedFrames,
} from "./frames";

export type RecipeName = Recipe<TslNode>["name"];

const TAU = 6.283185307179586;
// Seam handedness, shared by every recipe (ops/recipes.ts ASSEMBLE_WRAP_FROM /
// ROLLOUT_FROM) — the HOUSE winding sense the ctx's material coordinate `d` is
// written in, and the sign `swirl` reads off ctx.wrapDir (every other rotation
// takes it at the recipe's call site).
const WRAP_DIR = -1;
const HOUSE_FROM = -1;
// The same radius floor ops/frames.ts applies, for the edge-geometry fallback
// (an unmatched vertex must never hand the algebra R = 0 — R is a divisor).
const R_MIN = 0.5;

// ── The algebra + the recipes, built ONCE ───────────────────────────────────
// One TSL backend instance and one recipe table for the module: the recipes are
// pure builders (they allocate nodes only when `build` runs, per graph), so a
// single table is shared by every material.
const A = tslAlgebra();
const RECIPES = makeRecipes<TslNode>(A);

/** Every recipe name, in table order. The one list to loop when something has to
 *  cover all recipes — core/scene's channel bridge, the knob/channel tables and
 *  `resetRecipeKnobs` all derive from it instead of re-typing the five names. */
export const RECIPE_NAMES = Object.keys(RECIPES) as RecipeName[];

// ── Channels + knobs ────────────────────────────────────────────────────────
// One channel uniform per recipe (0 = seated, bit-exact) and one uniform per
// knob, initialized to the recipe's PHYSICAL defaults. Uniforms are module
// state: every material scrubs the same numbers, so a page writes them once and
// the whole model follows.
//
// PROCESS-GLOBAL, and deliberately so: the channels, the knobs, `activeRecipes`
// below and the shading uniforms are one set for the document, which is why
// core/scene's `initScene` is a ONE-SCENE-PER-DOCUMENT call. A second live scene
// would scrub the same numbers as the first.

const channels = Object.fromEntries(
  RECIPE_NAMES.map((n) => [n, uniform(0)]),
) as Record<RecipeName, TslNode>;

const knobs = Object.fromEntries(
  RECIPE_NAMES.map((n) => [
    n,
    Object.fromEntries(
      Object.entries(RECIPES[n].knobDefaults).map(([k, v]) => [k, uniform(v)]),
    ) as Record<string, TslNode>,
  ]),
) as Record<RecipeName, Record<string, TslNode>>;

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

/** `clamped` plus a JOINT ceiling: the write also has to leave `max − partner`
 *  headroom, read at WRITE time (a view is built once and kept for the process's
 *  life — a ceiling captured at construction would freeze the partner's
 *  module-load value). The partner is never moved; see JOINT_SUMS. */
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
 *  dropped and the box keeps its last value. No range clamp — an unlimited knob
 *  feeds op amplitudes only, where a silly value is a silly POSE — but NaN is
 *  never a pose: the hard idle gate multiplies by zero and NaN · 0 = NaN, so one
 *  NaN write would kill the seated render until reload. */
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
// frame): a channel is a 0..1 scrub by contract, and the idle gate's step reads
// it directly, so a NaN or out-of-range write from the dev console is exactly
// the hole the knob clamps exist to close.
const channelBoxes = Object.fromEntries(
  RECIPE_NAMES.map((n) => [n, clamped(channels[n] as { value: number }, 0, 1)]),
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
 * Why the gate knobs: the hard idle gate multiplies by
 * `step(1e-6, channel)` = 0 at channel 0, and NaN · 0 is NaN — so the one thing
 * that can break the seated render's bit-exactness is a knob setting that makes
 * ops/gate.ts divide by zero. Three denominators have to stay positive:
 *
 *   windowFrac                  ≥ 0.05   (assemble: 1 − stagger − partStagger;
 *                                         rollout: 1 − stagger)
 *   split − flightStart         > 0      (only assemble has flightStart ≠ 0)
 *   rollEnd − split + min(overlap, split) > 0
 *
 * `stagger + partStagger ≤ 0.9` is a JOINT constraint and a per-knob limit
 * cannot express it, so it lives in JOINT_SUMS below and the knob VIEWS enforce
 * it — each knob keeps a box that is safe on its own (0.9 with the other at 0
 * still leaves windowFrac 0.1) and the pair is clamped against each other on
 * write. Without the joint form the conservative halves (0.85 + 0.1) made the
 * sector-dominant presets — meridian's classic partStagger 0.78 — unreachable.
 * Likewise assemble runs
 * rollEnd = 0.9 with a house split of 0.95 — the split legitimately sits PAST
 * the roll deadline and the overlap is what buys the stick ramp its width, so
 * `overlap` carries a 0.1 FLOOR (0.9 − 0.95 + 0.1 = 0.05) rather than the 0 the
 * gate's own default implies. assemble's split floor (0.15) clears its
 * flightStart of 0.1 the same way.
 *
 * The DIVISOR guards are the same argument one step downstream — a knob that
 * lands in an op's denominator can push NaN through the gate the same way:
 *
 *   assemble.curl    rollR = R·mix(0.45, 0.18, curl) zeroes at curl = 5/3, and
 *                    the roll segment's q = −R/rollR then goes non-finite.
 *   assemble.flatten the wrap's main arc is q = R/rf with
 *                    rf = Rb·mix(flatten, 1, stick): at flatten = 0 an UNSTUCK
 *                    piece (stick = 0, the whole flight) divides by zero.
 *   helix.coil       coilF = mix(1, coil, flight) and the op opens the wedge
 *                    angle as phi/coilF — at full flight the divisor IS coil.
 *   bend.radius      ρ is the fold sharpness: dq = flight·R/ρ, infinite at ρ = 0.
 *
 * The table is COMPLETE by enumeration, both halves: every gate input
 * (stagger, partStagger, split, overlap, snap — the only knobs any gateSpec
 * reads) and every knob that reaches a DIVISOR in ops/recipes.ts or ops/ops.ts
 * (flatten, curl, radius, coil — the four `A.div` denominators a knob can
 * touch). Recipes/knobs absent from it neither feed the gate nor divide (they
 * feed op amplitudes only, where a silly value is a silly POSE, not a NaN) and
 * are left unclamped. `__tests__/host-knobs.test.ts` walks the limit CORNERS
 * through gateSpec + gate at channel 0 and asserts flight 0 / stick 1, finite —
 * that test is the actual proof these numbers hold, not this comment.
 *
 * THE `during` EXTENSION (ops/ops.ts `Progress`). A progress window adds a new
 * divisor and a new pow exponent AHEAD of the gate: `to − from` is the ramp's
 * denominator (zero ⇒ NaN through the idle gate, exactly as above) and `ease` is
 * a pow exponent (≤ 0 ⇒ pow(0, e) = 1, so the scope starts fully played, plus
 * GLSL undefined behaviour at x = 0). A LITERAL window is caught by
 * `validatePipeline`'s advisory; a KNOB-BOUND one is a uniform no static pass
 * can read, so the rule is: any knob wired into a `Progress` field is a
 * gate-feeding knob and MUST enter this table (from ≥ 0, to ≥ from + ε,
 * ease > 0). None ship today — no recipe carries a `during` yet.
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
  },
  rollout: { stagger: [0, 0.85] },
  helix: { snap: [0, 1], coil: [0.05, 3] },
  bend: { radius: [1, 200] },
};

/**
 * The JOINT knob constraints no per-knob box can express: a PAIR whose SUM has
 * to stay under `max`. assemble's gate window is DERIVED as
 * `1 − stagger − partStagger` (ops/recipes assemble.gateSpec), so the pair must
 * sum to ≤ 0.9 for windowFrac to clear the 0.05 floor the identity anchor needs.
 *
 * ENFORCED IN THE KNOB VIEW, ORDER-DEPENDENTLY: writing either knob clamps the
 * value being written against the CURRENT value of its partner, and never moves
 * the partner. So a caller that wants a big partStagger writes the SMALL knob
 * first — meridian's `stagger = 0.06` then `partStagger = 0.78` lands exactly,
 * while the reverse order would cap the second write. The corollary for restore
 * paths: reach the defaults from (0, 0), which is what `resetRecipeKnobs` does.
 * Predictable beats clever here — a clamp that silently re-wrote the partner
 * would make a preset's second write undo its first.
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
 *  (joint half included), a plain finite guard for the rest. The limit belongs at
 *  the uniform boundary, because every path into the shader (page, dev panel,
 *  console) goes through here and the gate's identity has to survive all of
 *  them. */
function makeKnobBox(name: RecipeName, knob: string): { value: number } {
  const u = knobs[name][knob] as { value: number };
  const limit = KNOB_LIMITS[name]?.[knob];
  if (!limit) return guarded(u);
  const joint = jointPartner(name, knob);
  if (!joint) return clamped(u, limit[0], limit[1]);
  return jointClamped(
    u,
    limit[0],
    limit[1],
    knobs[name][joint.partner] as { value: number },
    joint.max,
  );
}

// Every knob box, wrapped ONCE at module load — the same object for the process's
// life, so a caller may key on box IDENTITY (explore/scene-kit's `set()` keys its
// first-write undo snapshot on it, and a fresh view per call would record one
// undo per write instead of one per knob).
const knobBoxes = Object.fromEntries(
  RECIPE_NAMES.map((n) => [
    n,
    Object.fromEntries(
      Object.keys(knobs[n]).map((k) => [k, makeKnobBox(n, k)]),
    ),
  ]),
) as Record<RecipeName, Record<string, { value: number }>>;

/** One recipe knob's uniform (physical units — see the recipe's knobDefaults),
 *  as the same guarded box every call. THROWS on an unknown recipe/knob: every
 *  call site is a module-load constant, so a typo fails at import instead of
 *  handing back a detached uniform a slider then drives into nothing. */
export function recipeKnob(name: RecipeName, knob: string): { value: number } {
  const box = knobBoxes[name]?.[knob];
  if (!box) throw new Error(`lens ops: no knob "${knob}" on recipe "${name}"`);
  return box;
}

/** Restore EVERY knob to its recipe's `knobDefaults` — the bench's pristine
 *  tuning. /lens calls this between one animation's exit() and the next one's
 *  enter() (pages/lens.astro selectAnimation), which is what keeps a knob an
 *  animation's slider moved from following the selection out.
 *
 *  ORDER: the joint pair is zeroed FIRST. Its halves clamp against each other on
 *  write (JOINT_SUMS), so a plain defaults sweep could cap the first restore
 *  against a partner still holding a big preset value — from (0, 0) every
 *  default is reachable in any order. */
export function resetRecipeKnobs(): void {
  for (const name of RECIPE_NAMES) {
    for (const knob of JOINT_SUMS[name]?.pair ?? [])
      knobBoxes[name][knob].value = 0;
    for (const [knob, v] of Object.entries(RECIPES[name].knobDefaults))
      knobBoxes[name][knob].value = v;
  }
}

/** Every channel uniform, keyed by recipe — for dev probes and bulk resets.
 *  Same clamping views `recipeChannel` hands out, for the same reason. */
export function recipeChannels(): Record<RecipeName, { value: number }> {
  return channelBoxes;
}

/** Every knob, keyed by recipe then knob — for dev probes. The SAME boxes
 *  `recipeKnob` hands out, so a console write through this table is guarded
 *  exactly as a page's write is: a bypass would be a NaN hole straight into the
 *  idle gate. */
export function recipeKnobs(): Record<
  RecipeName,
  Record<string, { value: number }>
> {
  return knobBoxes;
}

// Which recipes the deform folds in, chosen PER SCENE and baked at material
// build (no lazy recompile). A recipe the scene didn't select is not folded at
// all: it contributes a literal nothing, not a multiply-by-zero.
// MODULE state, like the channels above: it belongs to the document's ONE lens
// scene, not to a SceneHandle.
let activeRecipes: RecipeName[] | null = null;

/** Choose which recipes the deform folds in. null = all. Call BEFORE applyOps /
 *  any shading-mode material build.
 *
 *  THROWS on an unknown name or a duplicate rather than filtering: the list comes
 *  from a page's `SceneOptions.recipes`, and a typo silently dropped is a
 *  channel that renders nothing with no other symptom. */
export function setActiveRecipes(names: string[] | null): void {
  if (names === null) {
    activeRecipes = null;
    return;
  }
  const seen = new Set<string>();
  for (const n of names) {
    if (!(RECIPE_NAMES as string[]).includes(n))
      throw new Error(`lens ops: unknown recipe "${n}"`);
    if (seen.has(n)) throw new Error(`lens ops: duplicate recipe "${n}"`);
    seen.add(n);
  }
  // copied, not aliased: the caller's array must not be able to re-pick the
  // folded set after the graphs are baked
  activeRecipes = [...names] as RecipeName[];
}

/** The recipes the deform is currently folding, or null = all of them. */
export function getActiveRecipes(): RecipeName[] | null {
  return activeRecipes;
}

// ── The per-vertex graph ────────────────────────────────────────────────────

// attribute() returns a loosely-typed node whose math methods aren't in the
// .d.ts; `TslNode` (= any) is the repo's escape hatch for the shader graph.
// Wrap into (−π, π].
const wrapPi = (x: TslNode): TslNode =>
  x.sub(float(TAU).mul(x.add(Math.PI).div(TAU).floor()));

// The seated cartesian point of a vertex state (optical axis = Y, radial plane
// = X–Z). BOTH sides of every delta go through this ONE formula, which is what
// makes an identity pipeline cancel exactly.
const reconstruct = (s: VertexState<TslNode>): TslNode =>
  vec3(s.radius.mul(cos(s.theta)), s.axial, s.radius.mul(sin(s.theta)));

// Rotate a vector about the optical axis by +rad. Position builds points as
// (r·cos θ, r·sin θ), so +α is (x·cosα − z·sinα, x·sinα + z·cosα) — the house
// convention, which the ops' cumulative `rot` is written in.
const rotateAboutAxis = (n: TslNode, rad: TslNode): TslNode => {
  const c = cos(rad);
  const s = sin(rad);
  return vec3(n.x.mul(c).sub(n.z.mul(s)), n.y, n.x.mul(s).add(n.z.mul(c)));
};

// ── Mechanism spin pivots ───────────────────────────────────────────────────
//
// A mesh parented under one of ops/mechanism.ts's SPIN PIVOTS gets its op delta
// added INSIDE that rotation: world = c + R_y(θ)·(q + Δ) = c + R_y(θ)q + R_y(θ)Δ.
// For a pivot ON the optical axis (every ring, the cam barrel, the iris chain)
// that is exactly right — seat and displacement turn together, so the exploded
// ring simply rotates as a whole. For a pivot OFF the axis it is not: the focus
// lead screw spins about its own centre, so R_y(θ)Δ swings the exploded rod in a
// CIRCLE around its seated position instead of spinning it in place.
//
// THE LAW: counter-rotate the POSITION delta by −θ for meshes under such a
// pivot, giving world = c + R_y(θ)q + Δ — the same spin, about the piece's own
// DISPLACED axis.
//
// NORMALS ARE NOT COUNTER-ROTATED. Spinning a piece about its displaced axis
// turns its normals exactly as spinning it about the seated axis does (normal
// transformation ignores translation), so the rest-normal path above is already
// correct; only the position delta is touched.
//
// The counter-rotation is EXACT for the rigid-translation part of Δ (spread,
// ladder, approach — what moves the screw today) and deliberately APPROXIMATE if
// a bending modifier is folded onto the same piece at the same time: Δ then
// varies per vertex, and un-spinning it also un-spins that variation.
//
// A tag is per MESH and baked into the graph, so a tagged mesh cannot share a
// material with an untagged one — see `opsSpinKey`, which every material cache
// (here and in materials/shading.ts) carries in its key.
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
 * `rotation.y` (radians) into each frame.
 *
 * The WHOLE subtree, not just its meshes: `opsSpinBox` has to find the tag on
 * the node the caller names, which may be an empty over the meshes that carry
 * it. Only the meshes' tags reach a material.
 *
 * ORDERING CONSTRAINT: the tag must exist BEFORE the mesh's materials are built
 * (`applyOps`, `createShading`) — the counter-rotation is a baked node, not a
 * runtime branch. core/scene.ts's `prepareModelMaterials` calls the mechanism's
 * tagger for that reason, well before `createMechanism` builds the pivot itself.
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
 *  graph). Two things vary the deform per mesh — a mechanism spin pivot's
 *  counter-rotation and a decal's shrink-wrap binding — and a material built
 *  with either must never be handed to a mesh that does not want it. Every
 *  material cache (here and in materials/shading.ts) carries this in its key. */
export function opsVariantKey(mesh: THREE.Object3D): string {
  const spin = opsSpinKey(mesh);
  const wrap = needsWrap(mesh) ? "wrap" : "";
  return spin || wrap ? `${spin}|${wrap}` : "";
}

const spinNodeOf = (mesh?: THREE.Object3D | null): TslNode | null =>
  (mesh?.userData[OPS_SPIN_KEY] as SpinTag | undefined)?.u ?? null;

/** `R_y(−θ)·v` in the convention `Object3D.rotation.y` rotates by — that is
 *  `R_y(a)·v = (cos a·vx + sin a·vz, vy, −sin a·vx + cos a·vz)` evaluated at
 *  a = −θ — i.e. the exact inverse of the pivot's own spin. (Not the same sense
 *  as `rotateAboutAxis` above, which is the ops' +α position convention.) */
const unspinY = (v: TslNode, theta: TslNode): TslNode => {
  const c = cos(theta);
  const s = sin(theta);
  return vec3(v.x.mul(c).sub(v.z.mul(s)), v.y, v.x.mul(s).add(v.z.mul(c)));
};

/** Fold every active recipe over this vertex: the summed position delta and the
 *  summed normal rotation, each hard-gated per recipe. `null` means NOTHING is
 *  folded (no active recipe), so the caller can emit a literal identity graph
 *  rather than an add-of-zero.
 *
 *  `spin` is the mesh's spin-pivot uniform (see the spin-pivot note above), or
 *  null — and null builds EXACTLY the graph this file built before spins
 *  existed, so the ~230 untagged meshes pay nothing. */
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
} | null {
  const names = activeRecipes ?? RECIPE_NAMES;
  if (names.length === 0) return null;

  const p = positionLocal as TslNode;
  // Per-piece frame constants, measured at load by ops/frames.ts and PACKED into
  // three attributes (WebGPU allows only 8 vertex buffers per pipeline; nine
  // scalar `_op*` attributes overflowed it and the model went invisible).
  const frameA = attribute("_opA", "vec4") as TslNode; // t0, R, span, rank
  const frameB = attribute("_opB", "vec4") as TslNode; // phase, class, rung, axi
  const t0 = frameA.x as TslNode;
  const R = frameA.y as TslNode;
  const halfSpan = frameA.z.mul(0.5) as TslNode;
  const rank01 = frameA.w as TslNode;
  const layerPhase = frameB.x as TslNode;
  const partClass = frameB.y as TslNode;
  const rung = frameB.z as TslNode;
  const axi = frameB.w as TslNode;
  // yMin, yMax, layerN, adopted
  const frameY = attribute("_opY", "vec4") as TslNode;
  const layerN = frameY.z as TslNode;
  const adopted = frameY.w as TslNode;

  // The ONE mapping point: optical axis = Y, radial plane = X–Z.
  const yMid = frameY.x.add(frameY.y).mul(0.5);

  /** The summed, hard-gated delta and normal rotation the deform produces AT AN
   *  ARBITRARY POINT of this piece — the preamble is a pure function of the
   *  position and the piece's lanes, so the decal binding can ask for it at its
   *  host triangle's corners as well as at the vertex itself. */
  const sampleAt = (q: TslNode): { delta: TslNode; rot: TslNode } | null => {
    const theta = atan(q.z, q.x); // atan2(z, x)
    const phi = wrapPi(theta.sub(t0)); // wedge-local angle off the sector centre
    const radius = length(vec2(q.x, q.z)) as TslNode;
    // Material coordinates in the HOUSE winding sense (from = −1) — for MATERIAL
    // selectors; `bend` carries its own `from` and re-derives d/L from phi.
    const d = R.mul(phi.mul(HOUSE_FROM).add(halfSpan));
    const L = R.mul(halfSpan.mul(2));
    // Normalized axial position over the PIECE's own extent — so a short piece
    // sees the full −0.5..+0.5 range that twist/shear/stickPress read against.
    const yN = q.y
      .sub(frameY.x)
      .div(max(frameY.y.sub(frameY.x), 1e-6))
      .sub(0.5) as TslNode;
    const off = radius.sub(R); // wall offset off the seated barrel

    const seated: VertexState<TslNode> = {
      theta,
      radius,
      axial: q.y as TslNode,
      rot: float(0),
      aim: t0, // the working direction starts on the piece's own meridian
      rem: float(0),
    };
    const seatedPoint = reconstruct(seated);

    let delta: TslNode | null = null;
    let rot: TslNode | null = null;

    for (const name of names) {
      const recipe = RECIPES[name];
      const channel = channels[name];
      const k = knobs[name];
      // The gate spec is captured ONCE and handed to the ctx as a closure: a
      // `during` scope re-runs THIS recipe's gate at a remapped channel, and
      // routing it through the ctx is what keeps ops.ts free of gate.ts.
      const spec = recipe.gateSpec(k);
      const gateAt = (c: Sc<TslNode>): { flight: TslNode; stick: TslNode } =>
        gate(A, spec, c, { rank01, layerPhase });
      const g = gateAt(channel);
      const ctx: OpCtx<TslNode> = {
        A,
        t0,
        R,
        rank01,
        layerPhase,
        halfSpan,
        partClass,
        phi,
        d,
        L,
        yN,
        off,
        rung,
        axi,
        layerN,
        adopted,
        channel,
        gateAt,
        flight: g.flight,
        stick: g.stick,
        wrapDir: WRAP_DIR,
      };
      // The piece frame spatial selectors track: the piece's own seated centre
      // (sector meridian, shell radius, axial midpoint), unrotated.
      const frame0: PieceFrame<TslNode> = {
        theta: t0,
        radius: R,
        axial: yMid,
        orient: t0,
      };
      const items = recipe.build(ctx, k);
      validatePipeline(items, name);
      const out = runPipeline(items, seated, frame0, ctx);
      // THE HARD IDLE GATE (law 3 in the header). Non-negotiable: the seated
      // render's bit-exactness rests on this step, not on the ops rounding to
      // exactly zero.
      const on = step(1e-6, channel);
      const dRecipe = reconstruct(out.v).sub(seatedPoint).mul(on);
      const rRecipe = out.v.rot.mul(on);
      delta = delta === null ? dRecipe : delta.add(dRecipe);
      rot = rot === null ? rRecipe : rot.add(rRecipe);
    }
    return delta === null || rot === null ? null : { delta, rot };
  };

  const at = sampleAt(p);
  if (!at) return null;
  const { delta, rot } = at;

  if (wrap) {
    // THE SHRINK-WRAP BINDING (ops/frames.ts WRAP_ATTRS). A decal follows the
    // host's RENDERED FACET, not the smooth field: the deform is evaluated at
    // the three seated CORNERS of the host triangle this vertex was bound to,
    // and the vertex is rebuilt from those deformed corners by the barycentric
    // weights and height it recorded. The facet the decal rides is therefore
    // the same flat triangle the host draws, so the chord error that used to
    // swallow the text cancels identically on both.
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
    const s0 = sampleAt(p0);
    const s1 = sampleAt(p1);
    const s2 = sampleAt(p2);
    if (s0 && s1 && s2) {
      const P0 = p0.add(s0.delta);
      const P1 = p1.add(s1.delta);
      const P2 = p2.add(s2.delta);
      // Facet frames, seated and deformed. Built from the SAME winding, which
      // is what keeps the two consistently oriented — deliberately NOT a
      // dot-product sign match against the seated normal, which would flip the
      // text back through the surface exactly when the wrap turns a facet past
      // 90°, which it routinely does.
      const eS = p1.sub(p0);
      const eF = P1.sub(P0);
      const nS = safeUnit(cross(eS, p2.sub(p0)));
      const nF = safeUnit(cross(eF, P2.sub(P0)));
      const bound = P0.mul(u).add(P1.mul(v)).add(P2.mul(w)).add(nF.mul(h));
      // The host adds this to `positionLocal`, and at rest the corners are
      // seated, so this reduces to the vertex's own authored position (to the
      // float error of recomposing it — see the binding's exactness note).
      const wrapDelta = bound.sub(p);
      const tS = safeUnit(eS);
      const tF = safeUnit(eF);
      const bS = cross(nS, tS);
      const bF = cross(nF, tF);
      return {
        delta: spin ? unspinY(wrapDelta, spin) : wrapDelta,
        rot,
        // The shading normal rides the facet's own rotation: components read in
        // the seated triad, recombined in the deformed one. Both triads are
        // orthonormal by construction (the face normal is perpendicular to the
        // edge it was crossed with), so this is a rotation, not a shear.
        normal: (n: TslNode) =>
          tF
            .mul(n.dot(tS))
            .add(bF.mul(n.dot(bS)))
            .add(nF.mul(n.dot(nS))),
      };
    }
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
  if (!f)
    return {
      position: positionLocal,
      normal: transformNormalToView(normalLocal),
      normalLocal,
    };
  // A shrink-wrapped decal's normal rides its host FACET (fold's `normal`);
  // everything else rotates about the optical axis by the summed gated rot.
  const nLocal = f.normal
    ? f.normal(normalLocal as TslNode)
    : rotateAboutAxis(normalLocal as TslNode, f.rot);
  return {
    position: (positionLocal as TslNode).add(f.delta),
    // normalNode is consumed as a VIEW-space vector (NodeMaterial.setupNormal
    // returns it untransformed), so hand the object-space graph over
    // transformed.
    normal: transformNormalToView(nLocal),
    normalLocal: nLocal,
  };
}

// Single-graph position builder (evaluates its own fold()): the line attach path
// and the instrument's probe, where sharing a bag buys nothing.
const opsPositionFn = Fn(() => {
  const f = fold(null, false);
  return f ? (positionLocal as TslNode).add(f.delta) : positionLocal;
});

/** Position-only graph. The untagged path is the shared `Fn` above — the exact
 *  graph it always built; a spin-tagged mesh gets its own instance. */
function opsPositionNode(spin: TslNode | null, wrap: boolean): TslNode {
  if (!spin && !wrap) return opsPositionFn();
  return Fn(() => {
    const f = fold(spin, wrap);
    return f ? (positionLocal as TslNode).add(f.delta) : positionLocal;
  })();
}

/**
 * Attach the op position+normal graphs to a Node material, from ONE shared
 * evaluation. Returns the position node so the caller can feed the SAME node to
 * depthFadeFactor instead of building a second deform.
 *
 * `mesh` is optional and read for the two things that VARY the graph: its
 * spin-pivot tag (`tagOpsSpin`) and its shrink-wrap binding (`bindDecals`). Pass
 * it wherever a material can be handed to such a mesh — and key that material's
 * cache by `opsVariantKey`, or a variant graph leaks onto a mesh without it.
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
 *  dev instrument). A node can't be shared across materials, so each call builds
 *  a new instance. Deliberately spin-free: this is the RECIPE deform on its own,
 *  which is what the instrument measures. The one consequence is that a probe of
 *  a spin-tagged mesh drifts from the render while its pivot is turned (focus
 *  off 0) — one rod, on a dev instrument that walks the motion channels. */
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
  // (t0, R, span, rank): own meridian, own radius (R = 0 guarded), a full turn,
  // the neutral mid rank.
  _opA: (x, _y, z) => [
    Math.atan2(z, x),
    Math.max(Math.hypot(x, z), R_MIN),
    TAU,
    0.5,
  ],
  // (phase, class, rung, axi); axi = 1 — no meridian worth trusting on an
  // unmatched vertex.
  _opB: () => [0, PART_CLASS.structure, 0, 1],
  // (yMin, yMax, layerN, adopted); layerN = 1 and adopted = 0 — an unmatched
  // vertex belongs to no measured layer and rides no host, so it reads as a lone
  // body. With span = 2π and axi = 1 above, it sits out the sheet selections.
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

// One op NodeMaterial per SOURCE material × GRAPH VARIANT (the model shares ~10
// source materials, has one spin pivot and one decal binding, so this keeps the
// program count — and time-to-first-frame — low; every piece scrubs the same
// uniforms anyway).
const cache = new WeakMap<THREE.Material, Map<string, THREE.Material>>();

function makeOpsMaterial(
  src: THREE.Material,
  mesh: THREE.Object3D,
): THREE.Material {
  // The op deform covers every mesh — including the authored transmission
  // glass. Copying a MeshPhysicalMaterial into a
  // MeshStandardNodeMaterial would silently DROP transmission/ior/iridescence
  // (NodeMaterial.copy only copies properties the target already declares), so
  // the target class tracks the source.
  const m = (src as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial
    ? new THREE.MeshPhysicalNodeMaterial()
    : new THREE.MeshStandardNodeMaterial();
  m.copy(src as THREE.MeshStandardMaterial);
  attachOps(m, mesh);
  return m;
}

/**
 * Swap every frame-carrying mesh under `root` to an op NodeMaterial. Returns a
 * disposer for the materials it created.
 */
export function applyOps(root: THREE.Object3D): () => void {
  const created = new Set<THREE.Material>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !hasOpFrames(o)) return;
    // In-shader displacement invalidates the mesh's rest-pose bounds, so
    // stale-bounds frustum culling would pop deformed pieces out.
    o.frustumCulled = false;
    const src = o.material as THREE.Material;
    let bySpin = cache.get(src);
    if (!bySpin) {
      bySpin = new Map();
      cache.set(src, bySpin);
    }
    const variant = opsVariantKey(o);
    let om = bySpin.get(variant);
    if (!om) {
      om = makeOpsMaterial(src, o);
      bySpin.set(variant, om);
      created.add(om);
    }
    o.material = om;
  });
  return () => created.forEach((m) => m.dispose());
}

// ── DEV diagnostics ─────────────────────────────────────────────────────────

/** One structured console line summarizing what ops/frames.ts measured — the
 *  numbers the visual gate needs to tell "the derivation is wrong" from "the
 *  tuning is wrong". DEV only (the caller gates it). */
export function reportOpsFrames(
  root: THREE.Object3D,
  frames: DerivedFrames,
): void {
  // Components are recovered from the written attributes: every vertex of one
  // component carries the identical frame, so the frame tuple IS the component
  // id (two components of one mesh measuring identically would merge — harmless
  // for a count).
  //
  // COUNTED PER MESH, which is the framing UNIT (ops/frames.ts `unitsOf`): one
  // node, one mesh, one frame. `components` therefore runs ahead of the piece
  // count only where a mesh was measured per ISLAND (the SHELL_ADOPT grain).
  const perMesh = new Map<string, number>();
  const histogram = new Map<number, number>();
  const spans: number[] = [];
  let components = 0;
  let axiCount = 0;

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !hasOpFrames(o)) return;
    const g = o.geometry;
    // Packed lanes read directly (not via frameOf): this walks every vertex of
    // every mesh, and only four of the twelve packed fields are wanted — t0/R/
    // span as the component signature, plus axi.
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
  // derivation shows two span clusters (the classic used ONE global 2π/5).
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
