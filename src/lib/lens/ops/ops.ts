// The op pipeline: the state a recipe threads through its ops, the `OpItem`
// union, `runPipeline`, and the op library. Written against the scalar algebra,
// so a recipe runs the same on plain numbers and in the generated shader.
//
// Each selector multiplies a 0..1 factor into the active weight. `group` and
// `during` scope the weight and the progress window; all other state carries on
// past the scope's end.

import type { Algebra, Sc } from "./algebra";

/** One vertex: `x`/`z` in the radial plane, `axial` along the optical axis (+Y). */
export interface VertexState<S> {
  x: S;
  z: S;
  axial: S;
  /** Accumulated turn of the normal about the optical axis. */
  rot: S;
  /** Working direction, an absolute radial-plane angle seeded to ctx.t0:
   *  "out" is (cos aim, sin aim), "along" is (sin aim, −cos aim). */
  aim: S;
  /** Material left on the current bend chain, model-mm. */
  rem: S;
}

/** The piece's position and direction. Transforms move it; modifiers don't. */
export interface PieceFrame<S> {
  x: S;
  z: S;
  axial: S;
  /** The piece's working direction (the vertex `aim` can differ per vertex). */
  orient: S;
}

/** A point in the radial plane. */
interface Radial<S> {
  x: S;
  z: S;
}

/** Distance from the optical axis. */
export function radiusOf<S>(A: Algebra<S>, p: Radial<S>): S {
  return A.sqrt(A.add(A.mul(p.x, p.x), A.mul(p.z, p.z)));
}

/** Angle around the optical axis. */
export function thetaOf<S>(A: Algebra<S>, p: Radial<S>): S {
  return A.atan2(p.z, p.x);
}

/** Outward unit vector at `p` (finite even on the axis). */
function outward<S>(A: Algebra<S>, p: Radial<S>): Radial<S> {
  const inv = A.div(1, A.max(radiusOf(A, p), 1e-9));
  return { x: A.mul(p.x, inv), z: A.mul(p.z, inv) };
}

/** Turn a point about the optical axis by the angle with cosine `c`, sine `s`
 *  (same sense as the host's normal rotation). */
function turn<S>(A: Algebra<S>, p: Radial<S>, c: S, s: S): Radial<S> {
  return {
    x: A.sub(A.mul(p.x, c), A.mul(p.z, s)),
    z: A.add(A.mul(p.x, s), A.mul(p.z, c)),
  };
}

/** Move `p` outward from the axis by `d` (d = 0 leaves it exactly as is). */
function pushOut<S>(A: Algebra<S>, p: Radial<S>, d: S): Radial<S> {
  const u = outward(A, p);
  return { x: A.add(p.x, A.mul(u.x, d)), z: A.add(p.z, A.mul(u.z, d)) };
}

/** The read-only per-piece context every op sees: the backend `A`, the piece's
 *  frame constants, and this vertex's material coordinates. */
export interface OpCtx<S> {
  A: Algebra<S>;
  t0: S;
  R: S;
  rank01: S;
  layerPhase: S;
  halfSpan: S;
  partClass: S;
  /** Seated angle from the sector centre (seated θ = t0 + phi). */
  phi: S;
  /** Material distance from the seam at φ = +halfSpan: R·(halfSpan − phi). */
  d: S;
  /** Arc length of the piece. */
  L: S;
  /** Normalized axial position. */
  yN: S;
  /** Wall offset from R. */
  off: S;
  /** Axial extent yMax − yMin, model-mm (above 0). */
  height: S;
  /** Signed ladder rung, model-mm. */
  rung: S;
  /** 0/1: the piece is axisymmetric (see `spread`). */
  axi: S;
  /** Widest wall offset from R, as a fraction of R. */
  depth: S;
  /** 0/1: the piece copies a host wedge's frame. */
  adopted: S;
  /** This recipe's raw 0..1 channel, before the gate. */
  channel: S;
  /** This recipe's gate evaluated at another channel value. */
  gateAt(channel: Sc<S>): { flight: S; stick: S };
  flight: S;
  stick: S;
  wrapDir: number;
}

/** A constant, or a function of the ctx evaluated when the op runs. */
export type Live<S> = Sc<S> | ((ctx: OpCtx<S>) => Sc<S>);

function liveOf<S>(x: Live<S>, ctx: OpCtx<S>): Sc<S> {
  return typeof x === "function" ? (x as (c: OpCtx<S>) => Sc<S>)(ctx) : x;
}

// A transform moves the vertex and the frame, a modifier only the vertex, an
// orient op only sets the working direction, a selector returns a 0..1 weight
// (spatial ones read the frame), and a group scopes its items.
export type OpItem<S> =
  | {
      kind: "transform";
      name: string;
      run(
        v: VertexState<S>,
        f: PieceFrame<S>,
        w: S,
        ctx: OpCtx<S>,
      ): { v: VertexState<S>; f: PieceFrame<S> };
    }
  | {
      kind: "modifier";
      name: string;
      /** `ctx` already has the active weight folded in (see `effCtx`). */
      run(v: VertexState<S>, ctx: OpCtx<S>): VertexState<S>;
    }
  | {
      kind: "orient";
      name: string;
      /** The new absolute working direction. Not scaled by the weight, but
       *  `ctx` has the weight folded in. */
      aim(v: VertexState<S>, f: PieceFrame<S>, ctx: OpCtx<S>): S;
    }
  | {
      kind: "selector";
      name: string;
      spatial: boolean;
      weight(f: PieceFrame<S>, ctx: OpCtx<S>): S;
    }
  | { kind: "group"; items: OpItem<S>[]; progress?: Progress<S> };

/** A sub-window of the channel: clamp((c − from)/(to − from), 0, 1). Needs
 *  from ≥ 0 and to > from (`validatePipeline` warns on bad literals). */
export interface Progress<S> {
  from?: Sc<S>; // default 0
  to?: Sc<S>; // default 1
}

/** Scope a sub-pipeline: selectors inside do not affect ops after the group. */
export function group<S>(items: OpItem<S>[]): OpItem<S> {
  return { kind: "group", items };
}

/** Run a sub-pipeline over a window of the channel: seated at channel ≤ from,
 *  fully played at ≥ to. `during({}, items)` is `group(items)`. */
export function during<S>(p: Progress<S>, items: OpItem<S>[]): OpItem<S> {
  return { kind: "group", items, progress: p };
}

/** The ctx a `during` scope runs under: the remapped channel and its gate. */
function progressCtx<S>(ctx: OpCtx<S>, p: Progress<S>): OpCtx<S> {
  const A = ctx.A;
  // Same object back, so `during({}, …)` builds exactly the graph `group` does.
  if (p.from === undefined && p.to === undefined) return ctx;
  const q = A.clamp(
    A.div(A.sub(ctx.channel, p.from ?? 0), A.sub(p.to ?? 1, p.from ?? 0)),
    0,
    1,
  );
  const g = ctx.gateAt(q);
  return { ...ctx, channel: q, flight: g.flight, stick: g.stick };
}

// Walk one scope. `weight` is local, so a group's selectors don't leak out;
// vertex and frame state carry through `state`. Transforms get the weight as an
// argument; modifiers and orient ops get it folded into the ctx (`effCtx`).
function walk<S>(
  items: OpItem<S>[],
  state: { v: VertexState<S>; f: PieceFrame<S> },
  weightIn: S,
  ctx: OpCtx<S>,
): void {
  const A = ctx.A;
  let weight = weightIn;
  let eff: OpCtx<S> | null = null;
  // One gate re-run per Progress object, shared by sibling scopes.
  let phased: Map<Progress<S>, OpCtx<S>> | null = null;
  for (const item of items) {
    switch (item.kind) {
      case "selector":
        weight = A.mul(weight, item.weight(state.f, ctx));
        eff = null; // weight changed; rebuild at the next modifier
        break;
      case "group": {
        let inner = ctx;
        if (item.progress) {
          phased ??= new Map();
          inner = phased.get(item.progress) ?? progressCtx(ctx, item.progress);
          phased.set(item.progress, inner);
        }
        walk(item.items, state, weight, inner);
        break;
      }
      case "transform": {
        const out = item.run(state.v, state.f, weight, ctx);
        state.v = out.v;
        state.f = out.f;
        break;
      }
      case "modifier":
        eff ??= effCtx(ctx, weight);
        state.v = item.run(state.v, eff);
        break;
      case "orient": {
        // Set both the vertex's and the piece's direction to the same angle.
        eff ??= effCtx(ctx, weight);
        const a = item.aim(state.v, state.f, eff);
        state.v = { ...state.v, aim: a };
        state.f = { ...state.f, orient: a };
        break;
      }
    }
  }
}

/** Run a pipeline over one vertex of a piece, starting at weight 1. */
export function runPipeline<S>(
  items: OpItem<S>[],
  v0: VertexState<S>,
  f0: PieceFrame<S>,
  ctx: OpCtx<S>,
): { v: VertexState<S>; f: PieceFrame<S> } {
  const state = { v: v0, f: f0 };
  walk(items, state, ctx.A.lit(1), ctx);
  return { v: state.v, f: state.f };
}

// ── Authoring checks ────────────────────────────────────────────────────────
// `validatePipeline` warns once per recipe on: a spatial selector after a
// modifier (it reads a stale frame), an invalid literal `during` window, and a
// chain segment with no `anchor` before it.

const warnedRecipes = new Set<string>();

interface ScopeState {
  /** The last modifier seen, "" before any. */
  modifierName: string;
  anchored: boolean;
}

/** Chain ops that need an `anchor` before them. */
const CHAIN_SEGMENTS = new Set(["arc", "crease", "straight"]);

/** A Progress field's value if it is a number literal, else undefined. */
function litOf<S>(x: Sc<S> | undefined): number | undefined {
  return typeof x === "number" ? x : undefined;
}

function validateProgress<S>(
  p: Progress<S>,
  warn: (message: string) => void,
): void {
  const from = litOf(p.from);
  const to = litOf(p.to);
  // Fill in a default only when the other end is a literal.
  const lo = from ?? (to === undefined ? undefined : 0);
  const hi = to ?? (from === undefined ? undefined : 1);
  if (from !== undefined && from < 0) {
    warn(
      `lens ops: during({ from: ${from} }) is negative, so the scope is ` +
        `already moving at channel 0 (the model pops). Use from >= 0.`,
    );
  }
  if (lo !== undefined && hi !== undefined && hi <= lo) {
    warn(
      `lens ops: during({ from: ${lo}, to: ${hi} }) has width ${hi - lo}; ` +
        `the ramp divides by it and the NaN reaches the seated render. Use ` +
        `to > from.`,
    );
  }
  if (to !== undefined && to > 1) {
    warn(
      `lens ops: during({ to: ${to} }) is past the end of the channel, so ` +
        `the scope never finishes (advisory).`,
    );
  }
}

// Walks every item in order, groups included: a modifier or anchor anywhere
// earlier counts, even inside an earlier group.
function validateScope<S>(
  items: OpItem<S>[],
  recipeName: string,
  warn: (message: string) => void,
  s: ScopeState,
): void {
  for (const item of items) {
    if (item.kind === "modifier") {
      if (item.name === "anchor") s.anchored = true;
      if (CHAIN_SEGMENTS.has(item.name) && !s.anchored)
        warn(
          `lens ops: recipe "${recipeName}" runs an ${item.name} with no ` +
            `anchor before it, so it has no material to consume. Start the ` +
            `chain with anchor().`,
        );
      s.modifierName = item.name;
    } else if (item.kind === "selector" && item.spatial && s.modifierName) {
      warn(
        `lens ops: spatial selector "${item.name}" runs after modifier ` +
          `"${s.modifierName}" and reads a stale frame. Move the selector ` +
          `before the modifier.`,
      );
    } else if (item.kind === "group") {
      if (item.progress) validateProgress(item.progress, warn);
      validateScope(item.items, recipeName, warn, s);
    }
  }
}

export function validatePipeline<S>(
  items: OpItem<S>[],
  recipeName: string,
): void {
  const warn = (message: string): void => {
    if (warnedRecipes.has(recipeName)) return;
    warnedRecipes.add(recipeName);
    console.warn(message);
  };
  validateScope(items, recipeName, warn, { modifierName: "", anchored: false });
}

// ── Selectors ───────────────────────────────────────────────────────────────
// Per-piece masks. Each returns exactly 1 when fully open.

// Edge feathers; must be > 0 (smoothstep divides by them).
const SECTOR_FEATHER = 0.3; // radians
const RANK_FEATHER = 0.1;

// A sector at least this wide (radians, just under 2π) selects everything.
const SECTOR_OPEN = 6.2;

/** A band on ctx.rank01; exactly 1 when lo ≤ 0 and hi ≥ 1. */
export function selRank<S>(
  lo: Sc<S>,
  hi: Sc<S>,
  feather: number = RANK_FEATHER,
): OpItem<S> {
  return {
    kind: "selector",
    name: "selRank",
    spatial: false,
    weight: (_f, ctx) => {
      const A = ctx.A;
      const r = ctx.rank01;
      const m0 = A.mul(
        A.smoothstep(A.sub(lo, feather), lo, r),
        A.sub(1, A.smoothstep(hi, A.add(hi, feather), r)),
      );
      const open = A.mul(A.step(lo, 0), A.step(1, hi)); // lo ≤ 0 AND hi ≥ 1
      return A.min(A.add(m0, open), 1);
    },
  };
}

/** An angular band around `center` on the frame's current angle; exactly 1 when
 *  width ≥ SECTOR_OPEN. Compares cosines to avoid angle wrapping, so the outer
 *  edge is capped at π and the width at SECTOR_OPEN to keep the edges ordered. */
export function selSector<S>(
  center: Sc<S>,
  width: Sc<S>,
  feather: number = SECTOR_FEATHER,
): OpItem<S> {
  return {
    kind: "selector",
    name: "selSector",
    spatial: true,
    weight: (f, ctx) => {
      const A = ctx.A;
      const c = A.cos(A.sub(thetaOf(A, f), center));
      const half = A.mul(A.min(width, SECTOR_OPEN), 0.5);
      const inner = A.cos(half);
      const outer = A.cos(A.min(A.add(half, feather), Math.PI));
      const m0 = A.smoothstep(outer, inner, c);
      return A.min(A.add(m0, A.step(SECTOR_OPEN, width)), 1);
    },
  };
}

/** Any ctx → weight function, as a (non-spatial) selector. */
export function selFront<S>(f: (ctx: OpCtx<S>) => S): OpItem<S> {
  return {
    kind: "selector",
    name: "selFront",
    spatial: false,
    weight: (_f, ctx) => f(ctx),
  };
}

/** Part-class ids carried in `ctx.partClass`. */
export const PART_CLASS = {
  structure: 0,
  glass: 1,
  iris: 2,
  decal: 3,
  accessory: 4,
  /** Parts the peel keeps in place (core/parts isPeelKeep). */
  kept: 5,
} as const;

// ── Orientation ───────────────────────────────────────────────────────────────

/** Turn the working direction by `rad`, relative to the piece's direction. Moves
 *  nothing; the new direction persists past the end of a `group`. */
export function rot<S>(rad: Live<S>): OpItem<S> {
  return {
    kind: "orient",
    name: "rot",
    aim: (_v, f, ctx) => ctx.A.add(f.orient, liveOf(rad, ctx)),
  };
}

// ── Transforms ────────────────────────────────────────────────────────────────
// Rigid motions applied to both the vertex and the piece frame, scaled by
// ctx.flight and the weight `w` (identity when either is 0). Only orbit and
// swirl advance `rot`.

/** Slide along the optical axis by `axialMm`. */
export function approach<S>(axialMm: Sc<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "approach",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const delta = A.mul(A.mul(ctx.flight, w), axialMm);
      return {
        v: { ...v, axial: A.add(v.axial, delta) },
        f: { ...f, axial: A.add(f.axial, delta) },
      };
    },
  };
}

/** Revolve the piece, its direction and normals about the optical axis by
 *  flight·rad·w. The caller picks the sign (e.g. multiply in ctx.wrapDir). */
export function orbit<S>(rad: Live<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "orbit",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const a = A.mul(A.mul(ctx.flight, liveOf(rad, ctx)), w);
      const ca = A.cos(a);
      const sa = A.sin(a);
      return {
        v: { ...v, ...turn(A, v, ca, sa), rot: A.add(v.rot, a) },
        f: { ...f, ...turn(A, f, ca, sa), orient: A.add(f.orient, a) },
      };
    },
  };
}

/** `orbit` with extras: `exp` eases as flight^exp, `rankScale` scales the angle
 *  by (rank01 + ½), and the angle always takes ctx.wrapDir's sign. */
export function swirl<S>(
  rad: Sc<S>,
  opts: { exp?: number; rankScale?: boolean } = {},
): OpItem<S> {
  return {
    kind: "transform",
    name: "swirl",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      let a: S =
        opts.exp !== undefined
          ? A.mul(A.pow(ctx.flight, opts.exp), rad)
          : A.mul(ctx.flight, rad);
      if (opts.rankScale) a = A.mul(a, A.add(ctx.rank01, 0.5));
      a = A.mul(a, ctx.wrapDir);
      a = A.mul(a, w);
      const ca = A.cos(a);
      const sa = A.sin(a);
      return {
        v: { ...v, ...turn(A, v, ca, sa), rot: A.add(v.rot, a) },
        f: { ...f, ...turn(A, f, ca, sa), orient: A.add(f.orient, a) },
      };
    },
  };
}

/** Translate the piece by frac·R along its working direction. An axisymmetric
 *  piece (ctx.axi = 1) instead pushes each vertex outward, so the ring dilates
 *  and its frame stays put. */
export function spread<S>(frac: Live<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "spread",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const D = A.mul(A.mul(A.mul(ctx.flight, liveOf(frac, ctx)), ctx.R), w);
      // axi is 0/1, so the mix picks the piece's or the vertex's direction.
      const n = { x: A.cos(f.orient), z: A.sin(f.orient) };
      const u = outward(A, v);
      const dv = {
        x: A.mix(n.x, u.x, ctx.axi),
        z: A.mix(n.z, u.z, ctx.axi),
      };
      const Df = A.mul(D, A.sub(1, ctx.axi));
      return {
        v: {
          ...v,
          x: A.add(v.x, A.mul(D, dv.x)),
          z: A.add(v.z, A.mul(D, dv.z)),
        },
        f: {
          ...f,
          x: A.add(f.x, A.mul(Df, n.x)),
          z: A.add(f.z, A.mul(Df, n.z)),
        },
      };
    },
  };
}

/** Translate along the optical axis by `amount`. */
export function rise<S>(amount: Live<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "rise",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const ey = A.mul(A.mul(ctx.flight, w), liveOf(amount, ctx));
      return {
        v: { ...v, axial: A.add(v.axial, ey) },
        f: { ...f, axial: A.add(f.axial, ey) },
      };
    },
  };
}

/** Hinge the piece outward: each vertex's (radius, axial) turns about (frame
 *  radius, `pivot`) within its own meridian plane, so a wedge keeps its
 *  curvature. `pivot` is axial model-mm (default: the frame's centre); positive
 *  `rad` tips the +Y side outward. Does not advance `rot`. */
export function tilt<S>(rad: Sc<S>, opts: { pivot?: Sc<S> } = {}): OpItem<S> {
  return {
    kind: "transform",
    name: "tilt",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const a = A.mul(A.mul(ctx.flight, rad), w);
      const pivot: Sc<S> = opts.pivot === undefined ? f.axial : opts.pivot;
      const ca = A.cos(a);
      const sa = A.sin(a);
      const rV = radiusOf(A, v);
      const rF = radiusOf(A, f);
      const dr = A.sub(rV, rF);
      const dy = A.sub(v.axial, pivot);
      const dyF = A.sub(f.axial, pivot);
      const outV = A.sub(A.add(rF, A.add(A.mul(dr, ca), A.mul(dy, sa))), rV);
      return {
        v: {
          ...v,
          ...pushOut(A, v, outV),
          axial: A.add(pivot, A.sub(A.mul(dy, ca), A.mul(dr, sa))),
        },
        f: {
          ...f,
          ...pushOut(A, f, A.mul(dyF, sa)),
          axial: A.add(pivot, A.mul(dyF, ca)),
        },
      };
    },
  };
}

/** Slide along the optical axis by the piece's ladder rung × `gain`. */
export function ladder<S>(gain: Sc<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "ladder",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const delta = A.mul(A.mul(A.mul(ctx.rung, gain), ctx.flight), w);
      return {
        v: { ...v, axial: A.add(v.axial, delta) },
        f: { ...f, axial: A.add(f.axial, delta) },
      };
    },
  };
}

// ── Modifiers ─────────────────────────────────────────────────────────────────
// Shape changes (the bend chain and coil). They move the vertex but not the
// piece frame.

/** Fold weight `w` into the gate: flight·w and mix(1, stick, w). At w = 0 this
 *  is the identity pair (flight 0, stick 1), i.e. exactly seated. */
function effCtx<S>(ctx: OpCtx<S>, w: S): OpCtx<S> {
  const A = ctx.A;
  return {
    ...ctx,
    flight: A.mul(ctx.flight, w),
    stick: A.mix(1, ctx.stick, w),
  };
}

/** sin(x)/x, safe at 0. */
function sinc<S>(A: Algebra<S>, x: S): S {
  const ax = A.max(A.abs(x), 1e-5);
  return A.div(A.sin(ax), ax);
}

// ── The bend chain ────────────────────────────────────────────────────────────
// A sheet bent as a sequence of constant-curvature segments. `anchor` loads
// `v.rem` with the vertex's material distance `ctx.d` (can be negative, which
// walks the first segment backwards); each segment consumes min(rem, len).
// The vertex position includes its wall offset: v = chain point + off·out(aim).

/** Start a bend chain along the working direction at `radius` (default R),
 *  replacing the vertex position. */
export function anchor<S>(radius?: Live<S>): OpItem<S> {
  return {
    kind: "modifier",
    name: "anchor",
    run: (v, ctx) => {
      const A = ctx.A;
      const n = v.aim;
      const anchorR: Sc<S> = radius === undefined ? ctx.R : liveOf(radius, ctx);
      const out = A.add(anchorR, ctx.off);
      return {
        ...v,
        x: A.mul(out, A.cos(n)),
        z: A.mul(out, A.sin(n)),
        rot: A.sub(n, A.add(ctx.t0, ctx.phi)),
        rem: ctx.d,
      };
    },
  };
}

/** Consume `len` mm (default: all that's left) at curvature q = R·κ: 1 is the
 *  seated barrel, 0 straight, > 1 tighter, < 0 rolls outward. The first arc
 *  should use q = 1 so a negative remainder stays on the barrel.
 *  `participation` (default 1) is the fraction that bends; the rest runs
 *  straight along the exit tangent. */
export function arc<S>(
  q: Live<S>,
  len?: Live<S>,
  opts: { participation?: Live<S> } = {},
): OpItem<S> {
  return {
    kind: "modifier",
    name: "arc",
    run: (v, ctx) => {
      const A = ctx.A;
      const s = len === undefined ? v.rem : A.min(v.rem, liveOf(len, ctx));
      const c: Sc<S> =
        opts.participation === undefined ? 1 : liveOf(opts.participation, ctx);
      return chainStep(v, ctx, s, liveOf(q, ctx), c);
    },
  };
}

/** One chain segment: consume `s` at curvature `q`, bending the fraction `c`
 *  and running the rest straight along the exit tangent. */
function chainStep<S>(
  v: VertexState<S>,
  ctx: OpCtx<S>,
  s: S,
  q: Sc<S>,
  c: Sc<S>,
): VertexState<S> {
  const A = ctx.A;
  const bent = A.mul(s, c);
  const psi = A.div(A.mul(q, bent), ctx.R);
  const half = A.mul(psi, 0.5);
  const chord = A.mul(bent, sinc(A, half));
  const n0 = v.aim;
  const nMid = A.sub(n0, half);
  const n1 = A.sub(n0, psi); // exit direction
  const slip = A.sub(s, bent);
  // Remove the wall offset, walk the chain, re-apply the offset.
  const px = A.sub(v.x, A.mul(ctx.off, A.cos(n0)));
  const pz = A.sub(v.z, A.mul(ctx.off, A.sin(n0)));
  const wx = A.add(
    px,
    A.add(A.mul(chord, A.sin(nMid)), A.mul(slip, A.sin(n1))),
  );
  const wz = A.sub(
    pz,
    A.add(A.mul(chord, A.cos(nMid)), A.mul(slip, A.cos(n1))),
  );
  return {
    ...v,
    x: A.add(wx, A.mul(ctx.off, A.cos(n1))),
    z: A.add(wz, A.mul(ctx.off, A.sin(n1))),
    rot: A.sub(v.rot, psi),
    aim: n1,
    rem: A.sub(v.rem, s),
  };
}

/** Consume `len` mm (default: all that's left) as a flat run. */
export function straight<S>(len?: Live<S>): OpItem<S> {
  return {
    kind: "modifier",
    name: "straight",
    run: (v, ctx) => {
      const A = ctx.A;
      const s = len === undefined ? v.rem : A.min(v.rem, liveOf(len, ctx));
      const n = v.aim;
      return {
        ...v,
        x: A.add(v.x, A.mul(s, A.sin(n))),
        z: A.sub(v.z, A.mul(s, A.cos(n))),
        rem: A.sub(v.rem, s),
      };
    },
  };
}

/** A sharp fold: over `width` mm (must be > 0), turn `rad` more than the seated
 *  barrel would (rad = 0 is exactly seated; positive folds the barrel's way). */
export function crease<S>(rad: Live<S>, width: Live<S>): OpItem<S> {
  return {
    kind: "modifier",
    name: "crease",
    run: (v, ctx) => {
      const A = ctx.A;
      const w = liveOf(width, ctx);
      const s = A.min(v.rem, w);
      const q = A.add(1, A.div(A.mul(liveOf(rad, ctx), ctx.R), w));
      return chainStep(v, ctx, s, q, 1);
    },
  };
}

/** Scale the radius toward R·factor keeping arc length, so the piece's angle
 *  opens by 1/factor. Identity at flight = 0. */
export function coil<S>(factor: Live<S>): OpItem<S> {
  return {
    kind: "modifier",
    name: "coil",
    run: (v, ctx) => {
      const A = ctx.A;
      const coilF = A.mix(1, liveOf(factor, ctx), ctx.flight);
      const open = A.sub(A.div(ctx.phi, coilF), ctx.phi);
      const grown = pushOut(A, v, A.mul(ctx.R, A.sub(coilF, 1)));
      return {
        ...v,
        ...turn(A, grown, A.cos(open), A.sin(open)),
        rot: A.add(v.rot, open),
      };
    },
  };
}
