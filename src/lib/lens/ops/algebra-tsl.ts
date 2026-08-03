// The TSL backend for `Algebra<S>` — maps each scalar operation onto its
// `three/tsl` node builder, so ops written against the algebra compile straight
// into the shader graph. This is the ONLY algebra file that imports from
// three/tsl; algebra.ts stays dependency-free.
//
// It is a thin, mechanical mirror of the NUM backend: same call shapes, same
// argument order. There is no vitest suite here (TSL needs a GPU context) — its
// correctness rides on sharing call-shape with NUM, which the tests pin. Keep
// this mapping literal; do not fold in cleverness that would let the two
// backends drift.
import {
  float,
  mix,
  clamp,
  min,
  max,
  step,
  smoothstep,
  sin,
  cos,
  atan,
  abs,
  sign,
  pow,
  sqrt,
  floor,
  fract,
} from "three/tsl";
import type { Algebra, Sc } from "./algebra";

// TSL nodes carry math methods (`.add`, `.negate`, …) the .d.ts doesn't
// declare, and the imported builders are loosely typed; `any` is the repo's
// escape hatch for the shader-graph surface.
export type TslNode = any;

export function tslAlgebra(): Algebra<TslNode> {
  // Lift a scalar-or-number into a TSL node; numbers become `float()` uniformly
  // so downstream `.add`/`.mul`/… method chains always have a node receiver.
  const lift = (x: Sc<TslNode>): TslNode => float(x);

  return {
    lift,
    lit: (n) => float(n),

    add: (a, b) => lift(a).add(lift(b)),
    sub: (a, b) => lift(a).sub(lift(b)),
    mul: (a, b) => lift(a).mul(lift(b)),
    div: (a, b) => lift(a).div(lift(b)),
    neg: (a) => lift(a).negate(),

    min: (a, b) => min(a, b),
    max: (a, b) => max(a, b),
    clamp: (x, lo, hi) => clamp(x, lo, hi),
    mix: (a, b, t) => mix(a, b, t),

    step: (edge, x) => step(edge, x),
    smoothstep: (e0, e1, x) => smoothstep(e0, e1, x),

    sin: (a) => sin(a),
    cos: (a) => cos(a),
    atan2: (y, x) => atan(y, x), // two-arg atan == atan2, per the old code
    abs: (a) => abs(a),
    sign: (a) => sign(a),
    pow: (x, e) => pow(x, e),
    sqrt: (a) => sqrt(a),
    floor: (a) => floor(a),
    fract: (a) => fract(a),
  };
}
