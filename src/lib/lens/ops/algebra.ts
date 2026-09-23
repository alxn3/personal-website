// Scalar algebra — the backend-agnostic vocabulary every op, gate and recipe is
// written against. `NUM` is the number backend; `emit/algebra-src.ts` is the
// source backend the shader is generated through.
//
// Semantics are GLSL's, NOT JS's: `step` is edge-inclusive, `mix` does not
// clamp `t`, `fract` is x − floor(x). Backends agree on semantics, not on
// bit-exact rounding.

export type Sc<S> = S | number;

export interface Algebra<S> {
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
  pow(x: Sc<S>, e: Sc<S>): S;
  sqrt(a: Sc<S>): S;
  floor(a: Sc<S>): S;
  /** GLSL fract: x − floor(x), so fract(−0.25) = 0.75. */
  fract(a: Sc<S>): S;
}

// The number backend: `lit` is identity, the rest are GLSL formulas.
export const NUM: Algebra<number> = {
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
  pow: (x, e) => Math.pow(x, e),
  sqrt: (a) => Math.sqrt(a),
  floor: (a) => Math.floor(a),
  fract: (a) => a - Math.floor(a),
};
