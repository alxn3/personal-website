// An `Algebra` that writes source text (WGSL, GLSL or JS) instead of computing
// numbers. Each operation becomes one temp; a repeated expression reuses its
// temp. `fork()` opens a nested scope (an `if` branch) that can read its
// parent's temps but not add to them.

import type { Algebra, Sc } from "../algebra";

export type Dialect = "wgsl" | "glsl" | "js";

/** One SSA binding per dialect. */
const DECL: Record<Dialect, (v: string, expr: string) => string> = {
  wgsl: (v, e) => `let ${v} = ${e};`,
  glsl: (v, e) => `float ${v} = ${e};`,
  js: (v, e) => `const ${v} = ${e};`,
};

/** The emitted callee for an algebra function: GLSL spells atan2 `atan`, and
 *  JS routes every call to the NUM backend `__`. */
function callee(dialect: Dialect, name: string): string {
  if (dialect === "js") return `__.${name}`;
  return dialect === "glsl" && name === "atan2" ? "atan" : name;
}

/** A float literal that round-trips exactly (shaders need `.0` on integers). */
export function litOf(dialect: Dialect, n: number): string {
  if (!Number.isFinite(n))
    throw new Error(`lens emit: non-finite literal ${n}`);
  const s = String(n);
  if (dialect === "js") return s;
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

export interface SrcEmitter {
  A: Algebra<string>;
  /** statements emitted so far */
  lines: string[];
  /** a nested scope that can read this scope's temps */
  fork(): SrcEmitter;
}

/** An emitter for `dialect`. Forks share one counter so temp names are unique
 *  and deterministic. */
export function srcAlgebra(
  dialect: Dialect,
  parent?: { memo: Map<string, string>; counter: { n: number } },
): SrcEmitter {
  const lines: string[] = [];
  const memo = new Map<string, string>(parent?.memo);
  const counter = parent?.counter ?? { n: 0 };

  const lift = (x: Sc<string>): string =>
    typeof x === "number" ? litOf(dialect, x) : x;

  const emit = (expr: string): string => {
    const hit = memo.get(expr);
    if (hit !== undefined) return hit;
    const v = `t${counter.n++}`;
    lines.push(DECL[dialect](v, expr));
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
      emit(`${callee(dialect, name)}(${args.map(lift).join(", ")})`);

  const A: Algebra<string> = {
    lit: (n) => litOf(dialect, n),
    add: bin("+"),
    sub: bin("-"),
    mul: bin("*"),
    div: bin("/"),
    neg: (a) => emit(`(-${lift(a)})`),
    min: call("min"),
    max: call("max"),
    clamp: call("clamp"),
    mix: call("mix"),
    step: call("step"),
    smoothstep: call("smoothstep"),
    sin: call("sin"),
    cos: call("cos"),
    atan2: call("atan2"),
    abs: call("abs"),
    pow: call("pow"),
    sqrt: call("sqrt"),
    floor: call("floor"),
    fract: call("fract"),
  };

  return {
    A,
    lines,
    fork: () => srcAlgebra(dialect, { memo, counter }),
  };
}
