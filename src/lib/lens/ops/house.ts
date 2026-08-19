// THE HOUSE LIBRARY — the reusable pieces of the shipped recipes: the three
// participation SELECTORS every teardown-shaped recipe scopes itself with, and
// the two bend CHAINS (the travelling roll step and the fold/accordion spike
// train) as ready-made op sequences. Shared so a user pipeline composes the
// same vocabulary the authored recipes do, with one answer to "which pieces are
// sheets". Everything is S-generic and takes the algebra explicitly, so one
// definition runs on NUM and through ops/emit into the shader alike.

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
 *  pipeline share one evaluation. This is the GPU's only CSE: TSL builds a node
 *  GRAPH, and two calls building the same expression produce two subgraphs the
 *  compiler need not merge. `walk` hands every op in a scope the SAME ctx
 *  object, which is what makes identity the right key. */
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

// Widest span (rad) that still reads as a SECTOR rather than a body of
// revolution: cut shells sit around 1, a full ring at 2π, and 2.5 is the empty
// middle between them.
const SHEET_SPAN_MAX = 2.5;

/** Floor on |β| so the fold spike keeps a finite width. */
const BEND_MIN_TURN = 0.05;

/** `partClass == c` as an exact 0/1 scalar, unwrapped from selClass so it
 *  composes into a bigger predicate instead of only into a pipeline. */
function isClass<S>(A: Algebra<S>, ctx: OpCtx<S>, c: number): S {
  return A.mul(A.step(c - 0.5, ctx.partClass), A.step(ctx.partClass, c + 0.5));
}

// SHEET-LIKE — who participates in the shrink-wrap: a piece participates if it
// IS a segmented shell or it RIDES one, read off its measured SHAPE.
//
//   • narrower than SHEET_SPAN_MAX ⇒ a cut wedge, so it wraps; a full ring was
//     never cut and does not.
//   • ADOPTED pieces and decals always ride: bolted hardware took its host
//     wedge's whole frame, and a printed marking is painted ON a shell.
//   • glass, the iris MECHANISM and accessories never wrap. (`Iris_Housing` is
//     NOT in that class: it is a segmented shell and wraps on its span.)
//   • ctx.axi = 1 means t0 is a pinned 0 rather than a measured meridian, so
//     every coordinate the wrap would use is arbitrary. It gates the SPAN term
//     only — an adopted piece or a decal rides its host regardless.
//
// Every term is a PER-PIECE exact 0/1 constant, so this stays rigid-safe as a
// group selector.
export function selSheet<S>(A: Algebra<S>): OpItem<S> {
  return selFront<S>((ctx) => {
    // ctx carries the HALF span and `step(edge, x)` is x ≥ edge, so this is 1
    // exactly while the measured span is BELOW the cut-off.
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

/** 1 everywhere except the MECHANISM THE WINK KEEPS — the `kept` class plus the
 *  optics, which carry their own classes and would otherwise ride the ladder —
 *  faded in by `scope`. At scope 0 it is exactly 1 on every piece, so a recipe
 *  that wraps itself in this is bit-identical to one that does not. The cards
 *  scene drives scope to 1 so what it reveals never moves. */
export function selNotKept<S>(A: Algebra<S>, scope: Sc<S>): OpItem<S> {
  return selFront<S>((ctx) =>
    A.sub(
      1,
      A.mul(
        scope,
        A.max(
          isClass(A, ctx, PART_CLASS.kept),
          A.max(
            isClass(A, ctx, PART_CLASS.glass),
            isClass(A, ctx, PART_CLASS.iris),
          ),
        ),
      ),
    ),
  );
}

// ── the EXPLODE participation terms ───────────────────────────────────────
// Same idiom as selSheet, split into the teardown's two exemptions:
//
//   • ACCESSORIES never ride the teardown at all. Every accessory is also
//     axisymmetric, and `spread` falls back to a PER-VERTEX dilation there, so
//     an unexcluded hood would inflate radially instead of translating.
//   • GLASS and the iris MECHANISM never dilate RADIALLY — they move along the
//     AXIS only, which keeps the elements reading as one column.
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

// ROLLOUT chain: a travelling κ = 0 | 1/R step at d = flight·L. Anchors on the
// seam (the house winding puts it at φ = +halfSpan), the flat run leaves along
// its tangent, and the unbounded q = 1 remainder is the seated barrel.
//
// Its leading arc is the one exception to "give the first arc the seated
// q = 1": it is q = 0 by construction, so seam overrun leaves the barrel along
// the tangent instead of following it.
export function rollStepOps<S>(A: Algebra<S>): OpItem<S>[] {
  return [
    rot<S>((ctx) => ctx.halfSpan),
    anchor<S>(),
    arc<S>(0, (ctx) => A.mul(ctx.flight, ctx.L)),
    arc<S>(1), // tail (unbounded)
  ];
}

const PI = 3.141592653589793;
const TAU = 6.283185307179586;

/** THE HOUSE SEAM HANDEDNESS — the winding sense the ctx's material coordinate
 *  `d` is written in, shared by every recipe. Three tiers must agree on it:
 *  both hosts (ops/host.ts, ops/cpu.ts) put it on the ctx they build, and
 *  story/peelcards.ts fans its sectors the same way round the barrel. */
export const WRAP_DIR = -1;

/** THE PEEL'S FAN ORDER: where a piece whose seated meridian is `t0` sits in
 *  the peel's departure sequence, 0 → 1 once around the barrel in the house
 *  winding direction. `t0` is atan2's range (−π, π], so the result lands in
 *  [0, 1] whichever way the winding runs. TWO tiers key on it — the `peel`
 *  recipe and story/peelcards.ts — and a second answer would put a strip's
 *  drift on some other sector's clock. */
export function peelOrder<S>(A: Algebra<S>, t0: Sc<S>, wrapDir: number): S {
  return A.div(A.add(A.mul(t0, wrapDir), PI), TAU);
}

// STICKER-PEEL chain — the roll step's sibling; the ONE difference is the freed
// run's curvature. A lifted decal does not flatten, it INVERTS: the film
// relaxes past straight and rolls back on itself. That is a NEGATIVE q on the
// same chain, and |q| > 1 makes the back-roll TIGHTER than the barrel it left,
// which reads as a curl rather than a slack flap. The LEADING arc carries the
// curl, so seam overrun leaves the barrel here too (see `arc`'s note).
export function stickerPeelOps<S>(A: Algebra<S>, curl: Sc<S>): OpItem<S>[] {
  return [
    rot<S>((ctx) => ctx.halfSpan),
    anchor<S>(),
    arc<S>(A.neg(curl), (ctx) => A.mul(ctx.flight, ctx.L)),
    arc<S>(1), // the still-seated remainder (unbounded)
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

// FOLD / ACCORDION chain. A fold is a κ spike: over a width w = ρ·|β| the
// curvature walks from the seated 1/R to 1/R ± flight/ρ. Accordion =
// alternating ± spikes with seated gaps; `spikes` gates 2 and 3 in by LENGTH,
// so a gated-out pair is zero-length arcs that cost nothing. The LEADING arc
// keeps the seated q = 1 so seam overrun stays on the barrel — it is the only
// arc a negative cursor reaches.
export function foldOps<S>(A: Algebra<S>, k: FoldKnobs<S>): OpItem<S>[] {
  // Built ONCE for the whole chain: seven arcs each re-deriving w, dq and the
  // gates would be seven shader subgraphs.
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
