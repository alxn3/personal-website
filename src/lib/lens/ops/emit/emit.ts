// Generates `opsFold`, the whole deform as one function, by running the real
// recipes on the source-text algebra: a preamble that unpacks the frame, then
// one block per recipe that runs only when its channel is live. Output is
// checked in as deform.{wgsl,glsl,js}.ts; the JS one runs on the CPU (ops/cpu.ts)
// with its math routed to the NUM backend `__`.

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

/** Same value as host.ts IDLE_EPS (not imported: host.ts pulls in three). */
export const IDLE_EPS = 1e-6;
const HOUSE_FROM = -1;
const TAU = 6.283185307179586;

/** How each dialect spells the wrapper, the accumulators and the return. */
interface Shape {
  header(knobVec4s: number): string;
  accum(name: string): string;
  ret(x: string, y: string, z: string, w: string): string;
}

const XYZW = ["x", "y", "z", "w"];
/** `p.x`: every dialect reads inputs through `.xyzw`. */
const comp = (v: string, i: number): string => `${v}.${XYZW[i]}`;

const SHAPES: Record<Dialect, Shape> = {
  wgsl: {
    header: (n) =>
      `fn opsFold( p: vec3<f32>, a: vec4<f32>, b: vec4<f32>, y: vec4<f32>, ch: vec4<f32>, k: array<vec4<f32>, ${n}> ) -> vec4<f32> {`,
    accum: (n) => `var ${n} = 0.0;`,
    ret: (x, y, z, w) => `return vec4<f32>( ${x}, ${y}, ${z}, ${w} );`,
  },
  glsl: {
    // `vec4[N] k`, not `vec4 k[N]`: three's GLSL parser only reads the former.
    header: (n) =>
      `vec4 opsFold( vec3 p, vec4 a, vec4 b, vec4 y, vec4 ch, vec4[${n}] k ) {`,
    accum: (n) => `float ${n} = 0.0;`,
    ret: (x, y, z, w) => `return vec4( ${x}, ${y}, ${z}, ${w} );`,
  },
  // Reads `.xyzw`, so three vectors work as inputs; writes into `out`.
  js: {
    header: () => `(function opsFold( p, a, b, y, ch, k, out ) {`,
    accum: (n) => `let ${n} = 0;`,
    ret: (x, y, z, w) =>
      `out[0] = ${x};\n  out[1] = ${y};\n  out[2] = ${z};\n  out[3] = ${w};\n  return out;`,
  },
};

/** The emitted deform, as source. */
export function emitDeform(dialect: Dialect): string {
  const S = SHAPES[dialect];
  const top = srcAlgebra(dialect);
  const A = top.A;

  // ── Preamble: the ctx, unpacked from the frame attributes ─────────────
  const px = comp("p", 0);
  const py = comp("p", 1);
  const pz = comp("p", 2);
  const t0 = comp("a", 0);
  const R = comp("a", 1);
  const rank01 = comp("a", 3);
  const layerPhase = comp("b", 0);
  const partClass = comp("b", 1);
  const rung = comp("b", 2);
  const yMin = comp("y", 0);
  const yMax = comp("y", 1);
  const depth = comp("y", 2);
  // b.w = axi + 2·adopted (ops/frames.ts packFlags).
  const flags = comp("b", 3);
  const adopted = A.floor(A.mul(flags, 0.5));
  const axi = A.sub(flags, A.mul(adopted, 2));

  const halfSpan = A.mul(comp("a", 2), 0.5);
  const yMid = A.mul(A.add(yMin, yMax), 0.5);
  const theta = A.atan2(pz, px);
  // Wrap to ±π: x − TAU·floor((x + π) / TAU)
  const off0 = A.sub(theta, t0);
  const phi = A.sub(
    off0,
    A.mul(TAU, A.floor(A.div(A.add(off0, Math.PI), TAU))),
  );
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

  // ── One branch per recipe ───────────────────────────────────────────────
  LAYOUT.names.forEach((name, i) => {
    const scope = top.fork();
    const B = scope.A;
    const channel = comp("ch", i);
    const knobs = Object.fromEntries(
      LAYOUT.knobNames[name].map((kn) => {
        const l = LAYOUT.knob[name][kn];
        return [kn, `k[${l.vec4}].${XYZW[l.lane]}`];
      }),
    ) as Record<string, string>;

    // Build the recipes on this branch's algebra so their temps land inside
    // the branch, not in the already-printed preamble.
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
    // Delta from the authored point; a skipped branch adds nothing.
    const dx = B.sub(res.v.x, px);
    const dy = B.sub(res.v.axial, py);
    const dz = B.sub(res.v.z, pz);
    const dr = res.v.rot;

    out.push("");
    out.push(`  if ( ${channel} >= ${litOf(dialect, IDLE_EPS)} ) {`);
    for (const l of scope.lines) out.push(`    ${l}`);
    for (const [acc, e] of [
      ["dX", dx],
      ["dY", dy],
      ["dZ", dz],
      ["dR", dr],
    ])
      out.push(`    ${acc} = ${acc} + ${e};`);
    out.push("  }");
  });

  out.push("");
  out.push(`  ${S.ret("dX", "dY", "dZ", "dR")}`);
  out.push(dialect === "js" ? "})" : "}");
  return out.join("\n");
}
