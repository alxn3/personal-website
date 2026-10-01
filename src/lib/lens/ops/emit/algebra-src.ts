// An `Algebra` that writes source text (WGSL, GLSL or JS) instead of computing
// numbers. Each operation becomes one temp; a repeated expression reuses its
// temp. `fork()` opens a nested scope (an `if` branch) that can read its
// parent's temps but not add to them. Literal-only operations and identities
// exact on NUM (x·1, x − 0, x − x, pow(x, 2), and mix(a, b, 0) for a ≠ −0) fold away.

import { NUM, type Algebra, type Sc } from "../algebra";

export type Dialect = "wgsl" | "glsl" | "js";

type Op = Exclude<keyof Algebra<number>, "lit">;

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

/** A literal operand's value; undefined for an expression. */
const valueOf = (x: Sc<string>): number | undefined =>
  typeof x === "number" ? x : /^-?\d/.test(x) ? Number(x) : undefined;

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

  /** NUM's result when every operand is a literal and it prints exactly. */
  const folded = (name: Op, args: Sc<string>[]): string | undefined => {
    const vals = args.map(valueOf);
    if (vals.some((v) => v === undefined)) return undefined;
    const r = (NUM[name] as (...a: number[]) => number)(...(vals as number[]));
    return Number.isFinite(r) && !Object.is(r, -0)
      ? litOf(dialect, r)
      : undefined;
  };

  const bin =
    (op: string, name: Op) =>
    (a: Sc<string>, b: Sc<string>): string =>
      folded(name, [a, b]) ?? emit(`(${lift(a)} ${op} ${lift(b)})`);
  const call =
    (name: Op) =>
    (...args: Sc<string>[]): string =>
      folded(name, args) ??
      emit(`${callee(dialect, name)}(${args.map(lift).join(", ")})`);

  const sub = bin("-", "sub");
  const mul = bin("*", "mul");
  const mix = call("mix");
  const pow = call("pow");

  const A: Algebra<string> = {
    lit: (n) => litOf(dialect, n),
    add: bin("+", "add"),
    sub: (a, b) =>
      valueOf(b) === 0 ? lift(a) : a === b ? litOf(dialect, 0) : sub(a, b),
    mul: (a, b) =>
      valueOf(a) === 1 ? lift(b) : valueOf(b) === 1 ? lift(a) : mul(a, b),
    div: bin("/", "div"),
    neg: (a) => folded("neg", [a]) ?? emit(`(-${lift(a)})`),
    min: call("min"),
    max: call("max"),
    clamp: call("clamp"),
    mix: (a, b, t) => (valueOf(t) === 0 ? lift(a) : mix(a, b, t)),
    step: call("step"),
    smoothstep: call("smoothstep"),
    sin: call("sin"),
    cos: call("cos"),
    atan2: call("atan2"),
    abs: call("abs"),
    pow: (x, e) => (valueOf(e) === 2 ? A.mul(x, x) : pow(x, e)),
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
