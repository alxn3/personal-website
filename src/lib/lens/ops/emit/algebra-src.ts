// The SOURCE backend for `Algebra<S>`: emits shader source text (WGSL, GLSL or
// JS) instead of numbers, so the recipes, gate and pipeline yield the deform
// chain from the same code the CPU spec runs. SSA with a memo: each operation
// allocates one temp, and an expression already emitted in scope returns its
// temp — the CSE TSL cannot do. Scopes are real: `fork()` gives an `if` branch
// its own line list and memo layered over the parent's; a child may read a
// parent temp, never the reverse.

import type { Algebra, Sc } from "../algebra";

export type Dialect = "wgsl" | "glsl" | "js";

interface DialectSpec {
  /** one SSA binding */
  decl(v: string, expr: string): string;
  /** algebra name → emitted callee (JS routes to the NUM shim, `__`) */
  call: Record<string, string>;
}

const SPEC: Record<Dialect, DialectSpec> = {
  wgsl: {
    decl: (v, e) => `let ${v} = ${e};`,
    call: {
      min: "min",
      max: "max",
      clamp: "clamp",
      mix: "mix",
      step: "step",
      smoothstep: "smoothstep",
      sin: "sin",
      cos: "cos",
      atan2: "atan2",
      abs: "abs",
      sign: "sign",
      pow: "pow",
      sqrt: "sqrt",
      floor: "floor",
      fract: "fract",
    },
  },
  glsl: {
    decl: (v, e) => `float ${v} = ${e};`,
    call: {
      min: "min",
      max: "max",
      clamp: "clamp",
      mix: "mix",
      step: "step",
      smoothstep: "smoothstep",
      sin: "sin",
      cos: "cos",
      atan2: "atan", // GLSL's two-arg atan IS atan2
      abs: "abs",
      sign: "sign",
      pow: "pow",
      sqrt: "sqrt",
      floor: "floor",
      fract: "fract",
    },
  },
  // The JS dialect routes every op to the NUM backend itself (`__`), so an
  // executed emit differs from NUM only in STRUCTURE — which is exactly what
  // the equivalence gate is testing.
  js: {
    decl: (v, e) => `const ${v} = ${e};`,
    call: {
      min: "__.min",
      max: "__.max",
      clamp: "__.clamp",
      mix: "__.mix",
      step: "__.step",
      smoothstep: "__.smoothstep",
      sin: "__.sin",
      cos: "__.cos",
      atan2: "__.atan2",
      abs: "__.abs",
      sign: "__.sign",
      pow: "__.pow",
      sqrt: "__.sqrt",
      floor: "__.floor",
      fract: "__.fract",
    },
  },
};

/** A float literal that round-trips exactly. `toString` is the shortest form
 *  that parses back to the same double; shader dialects need the decimal point
 *  on whole numbers, JS does not care and takes the same text. */
export function litOf(dialect: Dialect, n: number): string {
  if (!Number.isFinite(n))
    throw new Error(`lens emit: non-finite literal ${n}`);
  const s = String(n);
  if (dialect === "js") return s;
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

export interface SrcEmitter {
  A: Algebra<string>;
  /** the statements emitted so far, in order */
  lines: string[];
  /** a nested scope: its own lines, reading this scope's temps but not
   *  publishing into it (a shader block's temps die at the brace) */
  fork(): SrcEmitter;
  stats(): { temps: number; hits: number };
}

/** One emitter over `dialect`. `counter` is shared by every fork so temp names
 *  stay globally unique and monotonic — the determinism the byte-pin rests on. */
export function srcAlgebra(
  dialect: Dialect,
  parent?: { memo: Map<string, string>; counter: { n: number }; hits: { n: number } }, // prettier-ignore
): SrcEmitter {
  const spec = SPEC[dialect];
  const lines: string[] = [];
  const memo = new Map<string, string>(parent?.memo);
  const counter = parent?.counter ?? { n: 0 };
  const hits = parent?.hits ?? { n: 0 };

  const lift = (x: Sc<string>): string =>
    typeof x === "number" ? litOf(dialect, x) : x;

  const emit = (expr: string): string => {
    const hit = memo.get(expr);
    if (hit !== undefined) {
      hits.n++;
      return hit;
    }
    const v = `t${counter.n++}`;
    lines.push(spec.decl(v, expr));
    memo.set(expr, v);
    return v;
  };

  const bin =
    (op: string) =>
    (a: Sc<string>, b: Sc<string>): string =>
      emit(`(${lift(a)} ${op} ${lift(b)})`);
  const call =
    (name: string) =>
    (...args: Sc<string>[]): string =>
      emit(`${spec.call[name]}(${args.map(lift).join(", ")})`);

  const A: Algebra<string> = {
    lift,
    lit: (n) => litOf(dialect, n),
    add: bin("+"),
    sub: bin("-"),
    mul: bin("*"),
    div: bin("/"),
    neg: (a) => emit(`(-${lift(a)})`),
    min: call("min"),
    max: call("max"),
    clamp: (x, lo, hi) => call("clamp")(x, lo, hi),
    mix: (a, b, t) => call("mix")(a, b, t),
    step: (edge, x) => call("step")(edge, x),
    smoothstep: (e0, e1, x) => call("smoothstep")(e0, e1, x),
    sin: call("sin"),
    cos: call("cos"),
    atan2: (y, x) => call("atan2")(y, x),
    abs: call("abs"),
    sign: call("sign"),
    pow: (x, e) => call("pow")(x, e),
    sqrt: call("sqrt"),
    floor: call("floor"),
    fract: call("fract"),
  };

  return {
    A,
    lines,
    fork: () => srcAlgebra(dialect, { memo, counter, hits }),
    stats: () => ({ temps: counter.n, hits: hits.n }),
  };
}
