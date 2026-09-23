// THE EMITTER: assembles `opsFold` — the deform chain as one shader function —
// by running the REAL recipes, gate and pipeline on the source backend: the
// preamble that derives the ctx from the packed lanes, one uniform-branched
// block per recipe, the delta form and the hard idle gate. The emitter IS the
// deform; ops/host.ts binds its WGSL/GLSL output and ops/cpu.ts runs its JS.
//
// The `js` dialect is the CPU evaluator (deform.js.ts, run by ops/cpu.ts) and
// the equivalence gate: it executes, so an emit is checked against NUM over the
// goldens' own grid. Its ops route to `__`, the NUM backend the host binds.

import { gate } from "../gate";
import { makeRecipes } from "../recipes";
import {
  runPipeline,
  validatePipeline,
  type OpCtx,
  type PieceFrame,
  type VertexState,
} from "../ops";
import { srcAlgebra, litOf, type Dialect } from "./algebra-src";
import { LAYOUT } from "./layout";
import { WRAP_DIR } from "../house";

/** host.ts's idle edge, kept as a literal rather than imported (host.ts pulls
 *  in three, the emit step must not); `emit.test.ts` (d) pins the two copies. */
export const IDLE_EPS = 1e-6;
const HOUSE_FROM = -1;
const TAU = 6.283185307179586;

/** How each dialect spells the things the algebra does not cover: the input
 *  reads, the mutable accumulators, and the wrapper. */
interface Shape {
  /** `p.x` / `p[0]` */
  comp(v: string, i: number): string;
  /** `k[2].z` / `k[2][2]` */
  lane(vec4: number, lane: number): string;
  header(knobVec4s: number): string;
  accum(name: string): string;
  addTo(name: string, expr: string): string;
  branch(cond: string): string;
  ret(x: string, y: string, z: string, w: string): string;
}

const XYZW = ["x", "y", "z", "w"];

const SHAPES: Record<Dialect, Shape> = {
  wgsl: {
    comp: (v, i) => `${v}.${XYZW[i]}`,
    lane: (q, l) => `k[${q}].${XYZW[l]}`,
    header: (n) =>
      `fn opsFold( p: vec3<f32>, a: vec4<f32>, b: vec4<f32>, y: vec4<f32>, ch: vec4<f32>, k: array<vec4<f32>, ${n}> ) -> vec4<f32> {`,
    accum: (n) => `var ${n} = 0.0;`,
    addTo: (n, e) => `${n} = ${n} + ${e};`,
    branch: (c) => `if ( ${c} ) {`,
    ret: (x, y, z, w) => `return vec4<f32>( ${x}, ${y}, ${z}, ${w} );`,
  },
  glsl: {
    comp: (v, i) => `${v}.${XYZW[i]}`,
    lane: (q, l) => `k[${q}].${XYZW[l]}`,
    // `vec4[N] k`, not `vec4 k[N]`: three's GLSLNodeFunction tokenizes a
    // parameter as `type [count] name`, so the trailing-bracket form makes it
    // read the size as the NEXT parameter's type and walk off the list.
    header: (n) =>
      `vec4 opsFold( vec3 p, vec4 a, vec4 b, vec4 y, vec4 ch, vec4[${n}] k ) {`,
    accum: (n) => `float ${n} = 0.0;`,
    addTo: (n, e) => `${n} = ${n} + ${e};`,
    branch: (c) => `if ( ${c} ) {`,
    ret: (x, y, z, w) => `return vec4( ${x}, ${y}, ${z}, ${w} );`,
  },
  // Reads `.xyzw` like the shaders, so a three Vector3/Vector4 is an input as
  // it stands; writes into an out-param, so a frame allocates nothing.
  js: {
    comp: (v, i) => `${v}.${XYZW[i]}`,
    lane: (q, l) => `k[${q}].${XYZW[l]}`,
    header: () => `(function opsFold( p, a, b, y, ch, k, out ) {`,
    accum: (n) => `let ${n} = 0;`,
    addTo: (n, e) => `${n} = ${n} + ${e};`,
    branch: (c) => `if ( ${c} ) {`,
    ret: (x, y, z, w) =>
      `out[0] = ${x};\n  out[1] = ${y};\n  out[2] = ${z};\n  out[3] = ${w};\n  return out;`,
  },
};

/** The emitted deform, as source. */
export function emitDeform(dialect: Dialect): string {
  const S = SHAPES[dialect];
  const lit = (n: number) => litOf(dialect, n);
  const top = srcAlgebra(dialect);
  const A = top.A;

  // ── the preamble: the ctx, derived from the packed lanes ───────────────
  const px = S.comp("p", 0);
  const py = S.comp("p", 1);
  const pz = S.comp("p", 2);
  const t0 = S.comp("a", 0);
  const R = S.comp("a", 1);
  const rank01 = S.comp("a", 3);
  const layerPhase = S.comp("b", 0);
  const partClass = S.comp("b", 1);
  const rung = S.comp("b", 2);
  const yMin = S.comp("y", 0);
  const yMax = S.comp("y", 1);
  const depth = S.comp("y", 2);
  // ops/frames.ts packFlags: `b.w` = axi + 2·adopted; `y.w` is the wink lane,
  // which only the materials read.
  const flags = S.comp("b", 3);
  const adopted = A.floor(A.mul(flags, 0.5));
  const axi = A.sub(flags, A.mul(adopted, 2));

  const halfSpan = A.mul(S.comp("a", 2), 0.5);
  const yMid = A.mul(A.add(yMin, yMax), 0.5);
  const theta = A.atan2(pz, px);
  // wrapPi: x − TAU·floor((x + π) / TAU)
  const off0 = A.sub(theta, t0);
  const phi = A.sub(
    off0,
    A.mul(TAU, A.floor(A.div(A.add(off0, Math.PI), TAU))),
  );
  // the algebra has only sqrt: ops.ts's own `radiusOf` spells the radius so
  const radius = A.sqrt(A.add(A.mul(px, px), A.mul(pz, pz)));
  const d = A.mul(R, A.add(A.mul(phi, HOUSE_FROM), halfSpan));
  const L = A.mul(R, A.mul(halfSpan, 2));
  const height = A.max(A.sub(yMax, yMin), 1e-6);
  const yN = A.sub(A.div(A.sub(py, yMin), height), 0.5);
  const off = A.sub(radius, R);

  const seated: VertexState<string> = {
    x: px,
    z: pz,
    axial: py,
    rot: A.lit(0),
    aim: t0,
    rem: A.lit(0),
  };

  const out: string[] = [S.header(LAYOUT.vec4Count)];
  for (const l of top.lines) out.push(`  ${l}`);
  for (const n of ["dX", "dY", "dZ", "dR"]) out.push(`  ${S.accum(n)}`);

  // ── one uniform-branched block per recipe ───────────────────────────────
  LAYOUT.names.forEach((name, i) => {
    const scope = top.fork();
    const B = scope.A;
    const channel = S.comp("ch", i);
    const knobs = Object.fromEntries(
      LAYOUT.knobNames[name].map((kn) => {
        const l = LAYOUT.knob[name][kn];
        return [kn, S.lane(l.vec4, l.lane)];
      }),
    ) as Record<string, string>;

    // THE TABLE IS BUILT PER BRANCH, on the fork's algebra: `makeRecipes` binds
    // `A` into every closure it returns, so a table built on the top emitter
    // would write `gateSpec`'s temps into the preamble — after it was printed.
    const recipe = makeRecipes(B)[name];
    const spec = recipe.gateSpec(knobs);
    const gateAt = (c: string | number) =>
      gate(B, spec, c, { rank01, layerPhase });
    const g = gateAt(channel);
    const ctx: OpCtx<string> = {
      A: B,
      t0,
      R,
      rank01,
      layerPhase,
      halfSpan,
      partClass,
      phi,
      d,
      L,
      yN,
      off,
      height,
      rung,
      axi,
      depth,
      adopted,
      channel,
      gateAt,
      flight: g.flight,
      stick: g.stick,
      wrapDir: WRAP_DIR,
    };
    const frame0: PieceFrame<string> = {
      x: B.mul(R, B.cos(t0)),
      z: B.mul(R, B.sin(t0)),
      axial: yMid,
      orient: t0,
    };
    const items = recipe.build(ctx, knobs);
    validatePipeline(items, name);
    const res = runPipeline(items, seated, frame0, ctx);
    // The delta form, measured against the authored point itself (law 2). The
    // branch below IS the hard idle gate (law 3): a skipped recipe adds nothing.
    const dx = B.sub(res.v.x, px);
    const dy = B.sub(res.v.axial, py);
    const dz = B.sub(res.v.z, pz);
    const dr = res.v.rot;

    out.push("");
    out.push(`  ${S.branch(`${channel} >= ${lit(IDLE_EPS)}`)}`);
    for (const l of scope.lines) out.push(`    ${l}`);
    out.push(`    ${S.addTo("dX", dx)}`);
    out.push(`    ${S.addTo("dY", dy)}`);
    out.push(`    ${S.addTo("dZ", dz)}`);
    out.push(`    ${S.addTo("dR", dr)}`);
    out.push("  }");
  });

  out.push("");
  out.push(`  ${S.ret("dX", "dY", "dZ", "dR")}`);
  out.push(dialect === "js" ? "})" : "}");
  return out.join("\n");
}

/** Statement/temp counts for the emit report — the numbers the pins quote. */
export function emitStats(dialect: Dialect): {
  lines: number;
  transcendentals: Record<string, number>;
  total: number;
} {
  const src = emitDeform(dialect);
  const hist: Record<string, number> = {};
  for (const m of src.matchAll(/\b(sin|cos|atan2?|sqrt|pow)\(/g)) {
    const key = m[1] === "atan" ? "atan2" : m[1];
    hist[key] = (hist[key] ?? 0) + 1;
  }
  return {
    lines: src.split("\n").length,
    transcendentals: hist,
    total: Object.values(hist).reduce((a, b) => a + b, 0),
  };
}
