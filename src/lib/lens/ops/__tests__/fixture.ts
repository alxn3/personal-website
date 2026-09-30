import { NUM, type Sc } from "../algebra";
import { gate, type GateSpec } from "../gate";
import { WRAP_DIR } from "../house";
import {
  radiusOf,
  runPipeline,
  thetaOf,
  PART_CLASS,
  type OpCtx,
  type OpItem,
  type PieceFrame,
  type VertexState,
} from "../ops";
import type { Recipe, RecipeName } from "../recipes";
import { LAYOUT } from "../emit/layout";

// Shared test fixtures: a hand-built ctx on a fixture gate, polar helpers, and
// the piece/probe grid the recipe tests run.

/** A valid gate: staggers + window = 0.9 ≤ 1, stick ramp width 0.6 > 0. */
export const FIXTURE_GATE_SPEC: GateSpec<number> = {
  layerStagger: 0.2,
  windowFrac: 0.6,
  split: 0.5,
  snap: 0.5,
  snapExp: 2,
  partStagger: 0.1,
  overlap: 0.1,
};

/** The `OpCtx.gateAt` closure for a piece at (rank01, layerPhase). */
export const fixtureGateAt =
  (rank01: number, layerPhase: number) =>
  (channel: Sc<number>): { flight: number; stick: number } =>
    gate(NUM, FIXTURE_GATE_SPEC, channel, { rank01, layerPhase });

/** The radial-plane point at (theta, radius). */
export const atPolar = (theta: number, radius: number) => ({
  x: radius * Math.cos(theta),
  z: radius * Math.sin(theta),
});

/** A state's point as (theta in (−π, π], radius). */
export const polarOf = (p: VertexState<number> | PieceFrame<number>) => ({
  theta: thetaOf(NUM, p),
  radius: radiusOf(NUM, p),
});

/** A vertex state at (theta, radius). */
export const vertexAt = (
  theta: number,
  radius: number,
  rest: Omit<VertexState<number>, "x" | "z">,
): VertexState<number> => ({ ...atPolar(theta, radius), ...rest });

/** A piece frame at (theta, radius). */
export const frameAt = (
  theta: number,
  radius: number,
  rest: Omit<PieceFrame<number>, "x" | "z">,
): PieceFrame<number> => ({ ...atPolar(theta, radius), ...rest });

/** A structure piece's ctx at t0 0.3 on the fixture gate; `over` wins. */
export function makeCtx(over: Partial<OpCtx<number>> = {}): OpCtx<number> {
  const rank01 = over.rank01 ?? 0.5;
  const layerPhase = over.layerPhase ?? 0;
  return {
    A: NUM,
    channel: 1,
    gateAt: fixtureGateAt(rank01, layerPhase),
    t0: 0.3,
    R: 2,
    rank01,
    layerPhase,
    halfSpan: 0.5,
    partClass: PART_CLASS.structure,
    phi: 0,
    d: 0,
    L: 1,
    yN: 0,
    off: 0,
    height: 40,
    rung: 0,
    axi: 0,
    depth: 0,
    adopted: 0,
    flight: 1,
    stick: 1,
    wrapDir: 1,
    ...over,
  };
}

/** A transform probe: records the weight and the ctx it runs under. */
export function probe(
  sink: { w: number; ctx: OpCtx<number> }[],
): OpItem<number> {
  return {
    kind: "transform",
    name: "probe",
    run: (v, f, w, ctx) => {
      sink.push({ w, ctx });
      return { v, f };
    },
  };
}

export const v4 = (x = 0, y = 0, z = 0, w = 0) => ({ x, y, z, w });
export const XYZW = ["x", "y", "z", "w"] as const;

/** The packed knob uniform (ops/emit/layout.ts) with the given knobs on their
 *  lanes and every other lane 0. */
export function knobArray(
  knobs: Partial<Record<RecipeName, Record<string, number>>>,
): ReturnType<typeof v4>[] {
  const k = Array.from({ length: LAYOUT.vec4Count }, () => v4());
  for (const [name, values] of Object.entries(knobs))
    for (const [kn, val] of Object.entries(values)) {
      const lane = LAYOUT.knob[name][kn];
      k[lane.vec4][XYZW[lane.lane]] = val;
    }
  return k;
}

/** Every corner of a recipe's ranged-knob box; unranged knobs at defaults. */
export function knobCorners(recipe: Recipe<number>): Record<string, number>[] {
  const ranged = Object.entries(recipe.knobSpec).filter(([, s]) => s.range);
  return Array.from({ length: 1 << ranged.length }, (_, mask) => {
    const k = { ...recipe.knobDefaults };
    ranged.forEach(([key, s], i) => (k[key] = s.range![(mask >> i) & 1]));
    return k;
  });
}

// ── The recipe grid ─────────────────────────────────────────────────────────
// Wedges of half-span 0.4 (L = R·2·halfSpan) at the rank extremes and a spread
// of angles and radii, probed across the sheet (d = frac·L), along its height
// (yN) and off the wall, plus two probes past its edges (real wedges overrun).

export const HALF = 0.4;

export interface Piece {
  t0: number;
  R: number;
  rank01: number;
  layerPhase: number;
  rung: number;
}

export const PIECES: Piece[] = [
  { t0: 0.3, R: 10, rank01: 0, layerPhase: 0, rung: 2.5 },
  { t0: 2.1, R: 14.5, rank01: 0.5, layerPhase: 0.37, rung: -1.5 },
  { t0: -1.2, R: 21, rank01: 1, layerPhase: 0.82, rung: -3.25 },
];

export interface Probe {
  frac: number;
  yN: number;
  off: number;
}

export const PROBES: Probe[] = [
  { frac: 0, yN: -0.5, off: 0 },
  { frac: 0.25, yN: -0.2, off: 0.35 },
  { frac: 0.5, yN: 0, off: 0 },
  { frac: 0.75, yN: 0.3, off: -0.4 },
  { frac: 1, yN: 0.5, off: 0.2 },
  { frac: -0.2, yN: 0.15, off: 0 }, // overrun, seam side
  { frac: 1.2, yN: -0.35, off: 0.25 }, // overrun, far side
];
/** The probes on the sheet itself. */
export const VERTS = PROBES.slice(0, 5);

/** Probe `v` of piece `p` at `channel` on `gateAt`. `lanes` override ctx
 *  fields; a `halfSpan` override is applied before d/L/phi are derived. */
export function pieceCtx(
  p: Piece,
  v: Probe,
  channel: number,
  gateAt: OpCtx<number>["gateAt"],
  lanes: Partial<OpCtx<number>> = {},
): OpCtx<number> {
  const half = lanes.halfSpan ?? HALF;
  const L = p.R * 2 * half;
  const d = v.frac * L;
  const g = gateAt(channel);
  return {
    A: NUM,
    channel,
    gateAt,
    t0: p.t0,
    R: p.R,
    rank01: p.rank01,
    layerPhase: p.layerPhase,
    halfSpan: half,
    partClass: PART_CLASS.structure,
    phi: half - d / p.R, // d = R·(halfSpan − phi)
    d,
    L,
    yN: v.yN,
    off: v.off,
    height: 40,
    rung: p.rung,
    axi: 0,
    depth: 0,
    adopted: 0,
    flight: g.flight,
    stick: g.stick,
    wrapDir: WRAP_DIR,
    ...lanes,
  };
}

/** The seated vertex: on the barrel plus its wall offset, at its seated angle. */
export const seatedAt = (ctx: OpCtx<number>): VertexState<number> =>
  vertexAt(ctx.t0 + ctx.phi, ctx.R + ctx.off, {
    axial: ctx.yN * 40,
    rot: 0,
    aim: ctx.t0,
    rem: 0,
  });

/** The seated piece frame: the sector centre on the barrel, at axial 0. */
export const pieceFrame = (p: Piece): PieceFrame<number> =>
  frameAt(p.t0, p.R, { axial: 0, orient: p.t0 });

/** Run a recipe on probe `v` of piece `p` through its own gate. */
export function runRecipe(
  recipe: Recipe<number>,
  p: Piece,
  v: Probe,
  channel: number,
  lanes: Partial<OpCtx<number>> = {},
  knobsOver: Record<string, number> = {},
): {
  ctx: OpCtx<number>;
  items: OpItem<number>[];
  seated: VertexState<number>;
  out: VertexState<number>;
} {
  const knobs = { ...recipe.knobDefaults, ...knobsOver };
  const gateAt = (c: Sc<number>) =>
    gate(NUM, recipe.gateSpec(knobs), c, {
      rank01: p.rank01,
      layerPhase: p.layerPhase,
    });
  const ctx = pieceCtx(p, v, channel, gateAt, lanes);
  const seated = seatedAt(ctx);
  const items = recipe.build(ctx, knobs);
  const out = runPipeline(items, seated, pieceFrame(p), ctx).v;
  return { ctx, items, seated, out };
}
