// THE HOUSE LIBRARY — the reusable pieces of the shipped recipes: the three
// participation SELECTORS every teardown-shaped recipe scopes itself with, and
// the two bend CHAINS (the travelling roll step and the fold/accordion spike
// train) as ready-made op sequences. They lived inside `makeRecipes`'s closure
// until the user recipe builder needed them: a user pipeline composes the SAME
// vocabulary the authored recipes do, and a second copy of "which pieces are
// sheets" would be a second answer to the same question.
//
// Everything here is S-generic and takes the algebra explicitly, so one
// definition runs on the CPU (NUM) and the GPU (tslAlgebra) exactly as the ops
// do. No behaviour is defined here that was not already defined in recipes.ts —
// this file is a MOVE, and the recipes import it back.

import type { Algebra, Sc } from "./algebra";
import {
  anchor,
  arc,
  rot,
  selFront,
  PART_CLASS,
  type OpCtx,
  type OpItem,
} from "./ops";

/** Memoize a ctx → T derivation on the ctx OBJECT, so several ops in one
 *  pipeline that need the same intermediate terms share one evaluation.
 *
 *  This is not a micro-optimization, it is the GPU's only CSE: TSL builds a node
 *  GRAPH, and two calls that construct the same expression from the same inputs
 *  produce two independent subgraphs that the shader compiler is under no
 *  obligation to merge (host law 1). A recipe whose ops each rebuild the same
 *  derived terms therefore pays for them each time, in the shader as well as
 *  here. `walk` hands every op in a scope the SAME effective ctx object, which
 *  is what makes identity the right key. */
export function memoCtx<S, T>(f: (ctx: OpCtx<S>) => T): (ctx: OpCtx<S>) => T {
  const seen = new WeakMap<OpCtx<S>, T>();
  return (ctx) => {
    const hit = seen.get(ctx);
    if (hit !== undefined) return hit;
    const built = f(ctx);
    seen.set(ctx, built);
    return built;
  };
}

// Widest measured span (rad) that still reads as a SECTOR rather than a body of
// revolution. The cut shells measure 2π/7 ≈ 0.90 to 2π/5 ≈ 1.26; a full ring
// measures 2π ≈ 6.28. 2.5 sits in the empty middle — well clear of a 2-cut shell
// (π ≈ 3.14 would NOT wrap, and nothing in the model is cut two ways) and far
// from any sector.
const SHEET_SPAN_MAX = 2.5;

/** Floor on |β| so the fold spike keeps a finite width. */
const BEND_MIN_TURN = 0.05;

/** `partClass == c` as an exact 0/1 scalar — selClass's own algebra, unwrapped
 *  so it composes into a bigger predicate instead of only into a pipeline. */
function isClass<S>(A: Algebra<S>, ctx: OpCtx<S>, c: number): S {
  return A.mul(A.step(c - 0.5, ctx.partClass), A.step(ctx.partClass, c + 0.5));
}

// SHEET-LIKE — WHO PARTICIPATES IN THE SHRINK-WRAP.
//
// The rule: a piece participates if it IS a segmented shell or it RIDES one.
// frames.ts frames per MESH, so the rule reads the piece's measured SHAPE:
//
//   • a SECTOR is a wedge of something — a cut shell measures span ≈ 2π/5 or
//     2π/7 (0.90-1.26 rad), so anything narrower than SHEET_SPAN_MAX wraps.
//     A full ring measures 2π and does not: it was never cut, so there is no
//     sheet to unroll.
//   • an ADOPTED piece always rides — bolted hardware (mount screws, contacts,
//     the focus motor) took its host wedge's whole frame, so it must take the
//     host's motion too. This is the measured half of the baked flag.
//   • decals always ride — printed markings are painted ON a shell and must
//     fly with it; a decal is its own little patch, and while its span is
//     narrow enough to pass the sector test anyway, the class term says so
//     outright (the classic flew them 140-190mm).
//   • glass, the iris MECHANISM and accessories never wrap — the glass column
//     stays optical, the blades/cam plate/gear are driven by aperture, and
//     accessories come off. (`Iris_Housing` is NOT in this class: it is a
//     segmented shell and wraps on its span like any other.)
//   • an axisymmetric body never wraps — ctx.axi = 1 means t0 is the pinned 0
//     rather than a measured meridian, so every coordinate the wrap would use
//     is arbitrary. It gates the SPAN term only: an adopted piece or a decal
//     rides its host regardless of what its own meridian is worth.
//
// Every term is a PER-PIECE constant and exact 0/1, so this stays rigid-safe as
// a group selector: the weight is uniform across the piece's vertices, exactly
// like the classic system's per-piece participation flag.
export function selSheet<S>(A: Algebra<S>): OpItem<S> {
  return selFront<S>((ctx) => {
    // ctx carries the HALF span, and `step(edge, x)` is x ≥ edge — so
    // `1 − step(SHEET_SPAN_MAX, 2·halfSpan)` is 1 exactly while the measured
    // span is BELOW the cut-off (a piece landing on it to the bit falls out;
    // the real spans sit at ~1.2 and ~6.28, nowhere near).
    const sector = A.mul(
      A.sub(1, A.step(SHEET_SPAN_MAX, A.mul(ctx.halfSpan, 2))),
      A.sub(1, ctx.axi),
    );
    const rides = A.max(ctx.adopted, isClass(A, ctx, PART_CLASS.decal));
    const barred = A.max(
      A.max(
        isClass(A, ctx, PART_CLASS.glass),
        isClass(A, ctx, PART_CLASS.iris),
      ),
      isClass(A, ctx, PART_CLASS.accessory),
    );
    return A.mul(A.max(rides, sector), A.sub(1, barred));
  });
}

// ── the EXPLODE participation terms ───────────────────────────────────────
// Same idiom as selSheet (a selFront over exact 0/1 class terms, uniform
// across a piece's vertices ⇒ rigid-safe), split into the two exemptions the
// classic teardown drew:
//
//   • ACCESSORIES never ride the teardown AT ALL — they are removable
//     attachments (hood, UV filter, front/rear caps) that the page toggles on
//     and off, and the classic rig exempted them wholesale. They matter more
//     here than anywhere else: every accessory is axisymmetric, and `spread`
//     falls back to a PER-VERTEX dilation for an axisymmetric piece, so an
//     unexcluded hood inflates radially (~118mm at the house dilate) instead
//     of translating.
//   • GLASS and the iris MECHANISM never dilated RADIALLY — the classic moved
//     the optical column and the blade pack along the AXIS only (the rig
//     ladder), which is what keeps the elements reading as one column while
//     the shells fly outward.
export function selNotAccessory<S>(A: Algebra<S>): OpItem<S> {
  return selFront<S>((ctx) => A.sub(1, isClass(A, ctx, PART_CLASS.accessory)));
}

export function selNotOptical<S>(A: Algebra<S>): OpItem<S> {
  return selFront<S>((ctx) =>
    A.sub(
      1,
      A.max(
        isClass(A, ctx, PART_CLASS.glass),
        isClass(A, ctx, PART_CLASS.iris),
      ),
    ),
  );
}

// ROLLOUT chain (formation.ts:833-838): a travelling κ = 0 | 1/R step at
// d = flight·L. The chain anchors on the seam (rot(halfSpan) — the house
// winding puts it at φ = +halfSpan), the flat run leaves it along its tangent,
// and the unbounded q = 1 remainder is a circle of radius R centred at t̂·s —
// the sheet rolls along its own tangent plane like a carpet.
//
// The leading arc is the one exception to "give the first arc the seated q = 1":
// it is q = 0 by construction, a verbatim port of the classic, so seam overrun
// here leaves the barrel along the tangent instead of following it.
export function rollStepOps<S>(A: Algebra<S>): OpItem<S>[] {
  return [
    rot<S>((ctx) => ctx.halfSpan),
    anchor<S>(),
    arc<S>(0, (ctx) => A.mul(ctx.flight, ctx.L)),
    arc<S>(1), // tail (unbounded)
  ];
}

/** The fold profile's four shape knobs, in the recipes' own physical units. */
export interface FoldKnobs<S> {
  /** crease centre as a fraction of the sheet's material length */
  pos: Sc<S>;
  /** ρ — the fold SHARPNESS (model-mm); a hard crease is the ρ → 0 limit */
  radius: Sc<S>;
  /** β — the turn across the spike (rad), signed */
  angle: Sc<S>;
  /** 1..3 — how many alternating spikes are gated in */
  spikes: Sc<S>;
}

// FOLD / ACCORDION chain (formation.ts:808-826). A fold is a κ spike: over a
// width w = ρ·|β| the curvature walks from the seated 1/R to 1/R ± flight/ρ, so
// the turn across the spike is the fold ANGLE β and ρ is its SHARPNESS (a hard
// crease is the ρ → 0 limit). Accordion = alternating ± spikes with seated gaps;
// `spikes` gates 2 and 3 in by LENGTH, so a gated-out pair is a pair of
// zero-length arcs that costs nothing. The LEADING arc keeps the seated q = 1 so
// seam overrun stays on the barrel (it is the only arc a negative cursor
// reaches, and a q ≠ 1 there leaves the barrel to FIRST order).
export function foldOps<S>(A: Algebra<S>, k: FoldKnobs<S>): OpItem<S>[] {
  // The spike train's shape terms, built ONCE for the whole chain rather than
  // per arc — the reason memoCtx exists (above): seven arcs each re-deriving w,
  // dq and the gates would be seven subgraphs in the shader.
  const terms = memoCtx<
    S,
    { lead: S; w: S; qUp: S; qDown: S; gap1: S; gap2: S }
  >((ctx) => {
    const rho = k.radius;
    const beta = k.angle;
    const w = A.mul(rho, A.max(A.abs(beta), BEND_MIN_TURN));
    const dq = A.mul(A.mul(ctx.flight, A.div(ctx.R, rho)), A.sign(beta));
    const on = (i: number): S => A.step(i + 0.5, k.spikes);
    return {
      lead: A.max(A.sub(A.mul(k.pos, ctx.L), A.mul(w, 0.5)), 0),
      w,
      qUp: A.add(1, dq),
      qDown: A.sub(1, dq),
      gap1: A.mul(w, on(1)),
      gap2: A.mul(w, on(2)),
    };
  });
  return [
    rot<S>((ctx) => ctx.halfSpan),
    anchor<S>(),
    arc<S>(1, (c) => terms(c).lead),
    arc<S>(
      (c) => terms(c).qUp,
      (c) => terms(c).w,
    ), // spike 1
    arc<S>(1, (c) => terms(c).gap1), // gap
    arc<S>(
      (c) => terms(c).qDown,
      (c) => terms(c).gap1,
    ), // spike 2 (reversed)
    arc<S>(1, (c) => terms(c).gap2), // gap
    arc<S>(
      (c) => terms(c).qUp,
      (c) => terms(c).gap2,
    ), // spike 3
    arc<S>(1), // tail (unbounded)
  ];
}
