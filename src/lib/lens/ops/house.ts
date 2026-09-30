// Shared building blocks for ops/recipes.ts: which pieces take part, the
// sticker-peel chain, the seam direction and the peel order.

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

/** Memoize a ctx → T function per ctx object, so ops in the same scope share
 *  one evaluation (and one shader subgraph). */
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

// Widest angular span (rad) that counts as a cut shell rather than a full ring.
const SHEET_SPAN_MAX = 2.5;

/** 1 if `partClass == c`, else 0. */
function isClass<S>(A: Algebra<S>, ctx: OpCtx<S>, c: number): S {
  return A.mul(A.step(c - 0.5, ctx.partClass), A.step(ctx.partClass, c + 0.5));
}

/** 1 for sheet pieces: cut shell wedges and anything riding one (adopted
 *  parts, decals). Never glass, iris or accessories. Constant per piece. */
export function sheetTerm<S>(A: Algebra<S>, ctx: OpCtx<S>): S {
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

/** Pieces deeper than this (ops/frames.ts `depth`) move rigidly instead of bending. */
export const DEPTH_THIN = 0.25;

/** 1 for sheet pieces thin enough to bend. */
export function bendTerm<S>(A: Algebra<S>, ctx: OpCtx<S>): S {
  return A.mul(sheetTerm(A, ctx), A.sub(1, A.step(DEPTH_THIN, ctx.depth)));
}

/** Excludes kept parts, glass and iris by `scope` (exactly 1 everywhere at 0). */
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

/** Excludes accessories. */
export function selNotAccessory<S>(A: Algebra<S>): OpItem<S> {
  return selFront<S>((ctx) => A.sub(1, isClass(A, ctx, PART_CLASS.accessory)));
}

/** Excludes glass and iris. */
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

/** Winding direction of the material coordinate `d`. story/peelcards.ts must
 *  agree with it. */
export const WRAP_DIR = -1;

/** A piece's place in the peel order, 0 → 1 once around the barrel in the
 *  winding direction. story/peelcards.ts must match it. */
export function peelOrder<S>(A: Algebra<S>, t0: Sc<S>, wrapDir: number): S {
  return A.div(A.add(A.mul(t0, wrapDir), PI), TAU);
}

/** Peel a shell from its seam like a sticker: the freed part rolls backwards
 *  with curvature −curl while the rest stays seated. */
export function stickerPeelOps<S>(A: Algebra<S>, curl: Sc<S>): OpItem<S>[] {
  return [
    rot<S>((ctx) => ctx.halfSpan),
    anchor<S>(),
    arc<S>(A.neg(curl), (ctx) => A.mul(ctx.flight, ctx.L)),
    arc<S>(1), // the still-seated rest
  ];
}
