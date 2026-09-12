// THE HOUSE LIBRARY — what the recipes in ops/recipes.ts share: the
// participation SELECTORS, the sticker-peel bend chain, the seam handedness and
// the peel's fan order. S-generic, so one definition runs on NUM and, through
// ops/emit, in the shader.

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

/** Memoize a ctx → T derivation keyed on the ctx OBJECT, so several ops in one
 *  pipeline share one evaluation — the only CSE the shader graph gets. `walk`
 *  hands every op in a scope the SAME ctx object. */
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
// revolution: cut shells sit near 1, a full ring at 2π.
const SHEET_SPAN_MAX = 2.5;

/** `partClass == c` as an exact 0/1 scalar, composable into a bigger
 *  predicate. */
function isClass<S>(A: Algebra<S>, ctx: OpCtx<S>, c: number): S {
  return A.mul(A.step(c - 0.5, ctx.partClass), A.step(ctx.partClass, c + 0.5));
}

// SHEET-LIKE — who participates in the shrink-wrap: a piece IS a segmented
// shell (span below SHEET_SPAN_MAX) or RIDES one (adopted, or a decal).
// Glass, the iris mechanism and accessories never wrap. `ctx.axi = 1` means t0
// is pinned rather than measured, so it gates the SPAN term only.
// Every term is a PER-PIECE exact 0/1 constant, so this is rigid-safe as a
// group selector.
export function sheetTerm<S>(A: Algebra<S>, ctx: OpCtx<S>): S {
  // ctx carries the HALF span and `step(edge, x)` is x ≥ edge, so this is 1
  // exactly while the measured span is BELOW the cut-off.
  const sector = A.mul(
    A.sub(1, A.step(SHEET_SPAN_MAX, A.mul(ctx.halfSpan, 2))),
    A.sub(1, ctx.axi),
  );
  const rides = A.max(ctx.adopted, isClass(A, ctx, PART_CLASS.decal));
  const barred = A.max(
    A.max(isClass(A, ctx, PART_CLASS.glass), isClass(A, ctx, PART_CLASS.iris)),
    isClass(A, ctx, PART_CLASS.accessory),
  );
  return A.mul(A.max(rides, sector), A.sub(1, barred));
}

export function selSheet<S>(A: Algebra<S>): OpItem<S> {
  return selFront<S>((ctx) => sheetTerm(A, ctx));
}

/** Widest radial depth (|r − R| / R, ops/frames.ts `depth`) that still bends:
 *  a bend strains walls by |off|/R, so a piece deeper than this is a body that
 *  rides and slides but never bends. */
export const DEPTH_THIN = 0.25;

/** THE BEND CAST: sheet pieces that are THIN SHELLS, by measured depth rather
 *  than by class. One term, so every bend op and slide-share agrees piece for
 *  piece. */
export function bendTerm<S>(A: Algebra<S>, ctx: OpCtx<S>): S {
  return A.mul(sheetTerm(A, ctx), A.sub(1, A.step(DEPTH_THIN, ctx.depth)));
}

/** 1 everywhere except the kept mechanism and the optics, faded in by `scope`.
 *  At scope 0 it is exactly 1 on every piece, so wrapping a recipe in this is
 *  bit-identical to not wrapping it. */
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
// The teardown's two exemptions: accessories never ride it at all; glass and
// the iris mechanism never turn round the bore, moving along the AXIS only.
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

const PI = 3.141592653589793;
const TAU = 6.283185307179586;

/** THE HOUSE SEAM HANDEDNESS — the winding sense the ctx's material coordinate
 *  `d` is written in. The one definition: ops/cpu.ts, ops/emit and the tests
 *  import it; story/peelcards.ts must agree with it. */
export const WRAP_DIR = -1;

/** THE PEEL'S FAN ORDER: where a piece of seated meridian `t0` sits in the
 *  departure sequence, 0 → 1 once around the barrel in the house winding
 *  direction. `t0` is atan2's range (−π, π], so the result lands in [0, 1]
 *  whichever way the winding runs. The `peel` recipe and story/peelcards.ts
 *  must both use this. */
export function peelOrder<S>(A: Algebra<S>, t0: Sc<S>, wrapDir: number): S {
  return A.div(A.add(A.mul(t0, wrapDir), PI), TAU);
}

// STICKER-PEEL chain — the roll step with a different freed-run curvature: a
// NEGATIVE q, so the film rolls back on itself, and |q| > 1 makes the back-roll
// tighter than the barrel it left. The LEADING arc carries the curl, so seam
// overrun leaves the barrel here too (see `arc`'s note).
export function stickerPeelOps<S>(A: Algebra<S>, curl: Sc<S>): OpItem<S>[] {
  return [
    rot<S>((ctx) => ctx.halfSpan),
    anchor<S>(),
    arc<S>(A.neg(curl), (ctx) => A.mul(ctx.flight, ctx.L)),
    arc<S>(1), // the still-seated remainder (unbounded)
  ];
}
