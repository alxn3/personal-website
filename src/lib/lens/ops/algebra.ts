// Scalar algebra — the backend-agnostic operation vocabulary that every lens op,
// gate, and recipe is written against. An `Algebra<S>` is a set of scalar
// operations over some scalar type `S`; `Sc<S>` lets callers pass raw numbers
// anywhere a scalar is expected (they are lifted). Two backends implement it:
// `NUM` (this file — plain JS numbers, the executable spec) and `tslAlgebra`
// (algebra-tsl.ts — three/tsl shader nodes). Writing ops against `Algebra<S>`
// means one source of truth runs both on the CPU (tests, tooling) and the GPU.
//
// Semantics here are GLSL's, NOT JS's — so the number backend computes the same
// SEMANTICS as the TSL backend compiles to the GPU, though not bit-identical
// rounding (GLSL's mix is a·(1−t) + b·t against this file's a + (b−a)·t, worth
// ~4e-15 of divergence; the GPU is also free to fuse and reassociate). Notably:
// `step` is edge-inclusive,
// `mix` does not clamp `t`, and `fract` returns x − floor(x) (positive for
// negative inputs). These are pinned in __tests__/algebra.test.ts.

export type Sc<S> = S | number;

export interface Algebra<S> {
  /** Coerce a scalar-or-number into the backend scalar type. */
  lift(x: Sc<S>): S;
  /** A literal number as a backend scalar. */
  lit(n: number): S;

  add(a: Sc<S>, b: Sc<S>): S;
  sub(a: Sc<S>, b: Sc<S>): S;
  mul(a: Sc<S>, b: Sc<S>): S;
  div(a: Sc<S>, b: Sc<S>): S;
  neg(a: Sc<S>): S;

  min(a: Sc<S>, b: Sc<S>): S;
  max(a: Sc<S>, b: Sc<S>): S;
  clamp(x: Sc<S>, lo: Sc<S>, hi: Sc<S>): S;
  mix(a: Sc<S>, b: Sc<S>, t: Sc<S>): S;

  /** GLSL step: 0 iff x < edge, else 1 (edge-inclusive). */
  step(edge: Sc<S>, x: Sc<S>): S;
  /** GLSL smoothstep: clamps t=(x−e0)/(e1−e0) to [0,1], then t·t·(3−2t). */
  smoothstep(e0: Sc<S>, e1: Sc<S>, x: Sc<S>): S;

  sin(a: Sc<S>): S;
  cos(a: Sc<S>): S;
  /** GLSL atan(y, x): the two-arg form (a.k.a. atan2), signed by quadrant. */
  atan2(y: Sc<S>, x: Sc<S>): S;
  abs(a: Sc<S>): S;
  sign(a: Sc<S>): S;
  pow(x: Sc<S>, e: Sc<S>): S;
  sqrt(a: Sc<S>): S;
  floor(a: Sc<S>): S;
  /** GLSL fract: x − floor(x), so fract(−0.25) = 0.75. */
  fract(a: Sc<S>): S;
}

// The number backend. `lift`/`lit` are identity (a number is already the scalar
// type); every other method applies the GLSL-semantic formula.
export const NUM: Algebra<number> = {
  lift: (x) => x,
  lit: (n) => n,

  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  neg: (a) => -a,

  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  mix: (a, b, t) => a + (b - a) * t, // t is NOT clamped, per GLSL

  step: (edge, x) => (x < edge ? 0 : 1), // edge-inclusive
  smoothstep: (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  },

  sin: (a) => Math.sin(a),
  cos: (a) => Math.cos(a),
  atan2: (y, x) => Math.atan2(y, x),
  abs: (a) => Math.abs(a),
  sign: (a) => Math.sign(a),
  pow: (x, e) => Math.pow(x, e),
  sqrt: (a) => Math.sqrt(a),
  floor: (a) => Math.floor(a),
  fract: (a) => a - Math.floor(a),
};
