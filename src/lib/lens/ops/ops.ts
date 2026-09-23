// The op pipeline: the vertex/frame state a recipe threads, the `OpItem` union
// every op is expressed as, and `runPipeline`, which walks items in order.
// Written against the scalar algebra, so a recipe runs identically on NUM and
// in the shader ops/emit generates from it. An active weight starts at 1 and
// each selector multiplies its 0..1 factor into it; `group` scopes WEIGHT and
// PROGRESS, restoring both on exit, while all other state threads across the
// boundary in both directions. A selector weight is for motion that must UNDO;
// `during` progress is for motion that must WAIT or COMPRESS.

import type { Algebra, Sc } from "./algebra";

/** CARTESIAN in the radial plane: `x`/`z` are the point itself, `axial` is the
 *  optical axis (+Y). Angle and radius are DERIVED where an op wants them
 *  (`thetaOf`/`radiusOf`); nothing carries a second copy of the position. */
export interface VertexState<S> {
  x: S;
  z: S;
  axial: S;
  rot: S;
  /** THE WORKING DIRECTION: an ABSOLUTE angle in the radial plane, seeded to
   *  ctx.t0. n̂ = (cos aim, sin aim) is "out", t̂ = (sin aim, −cos aim) is
   *  "along"; axial is always +Y. */
  aim: S;
  /** Unspent material on the current bend chain, model-mm. */
  rem: S;
}

// The per-piece frame a recipe advances. Spatial selectors read it; a modifier
// leaves it untouched.
export interface PieceFrame<S> {
  x: S;
  z: S;
  axial: S;
  /** The PIECE's working direction — absolute, seeded to ctx.t0: a chain
   *  advances the VERTEX's aim per vertex while this one stays put. */
  orient: S;
}

/** A point in the radial plane — the shape `thetaOf`/`radiusOf`/`turn` read. */
interface Radial<S> {
  x: S;
  z: S;
}

/** Distance from the optical axis. */
export function radiusOf<S>(A: Algebra<S>, p: Radial<S>): S {
  return A.sqrt(A.add(A.mul(p.x, p.x), A.mul(p.z, p.z)));
}

/** Meridian angle. Only for the ops that want an ANGLE; a motion op works on
 *  the vector instead. */
export function thetaOf<S>(A: Algebra<S>, p: Radial<S>): S {
  return A.atan2(p.z, p.x);
}

/** The outward unit vector at `p`, with a length FLOOR so the optical axis
 *  itself yields a finite direction instead of 0/0. */
function outward<S>(A: Algebra<S>, p: Radial<S>): Radial<S> {
  const inv = A.div(1, A.max(radiusOf(A, p), 1e-9));
  return { x: A.mul(p.x, inv), z: A.mul(p.z, inv) };
}

/** Turn a radial-plane point about the optical axis, in the same +α sense the
 *  host's normal rotation uses. Takes the cos/sin PAIR, not the angle, so a
 *  transform turns its vertex and its frame through the same one. */
function turn<S>(A: Algebra<S>, p: Radial<S>, c: S, s: S): Radial<S> {
  return {
    x: A.sub(A.mul(p.x, c), A.mul(p.z, s)),
    z: A.add(A.mul(p.x, s), A.mul(p.z, c)),
  };
}

/** Slide `p` out along its own meridian by `d`. A DISPLACEMENT rather than a
 *  rescale, so d = 0 returns the very components it was given. */
function pushOut<S>(A: Algebra<S>, p: Radial<S>, d: S): Radial<S> {
  const u = outward(A, p);
  return { x: A.add(p.x, A.mul(u.x, d)), z: A.add(p.z, A.mul(u.z, d)) };
}

// The immutable per-piece context every op sees. `A` is the backend; the rest
// are seated constants and material coordinates. `d`/`L` follow the HOUSE
// winding convention (seam at φ = +halfSpan, d = R·(halfSpan − phi)); `anchor`
// loads the chain cursor with `d`.
export interface OpCtx<S> {
  A: Algebra<S>;
  t0: S;
  R: S;
  rank01: S;
  layerPhase: S;
  halfSpan: S;
  partClass: S;
  phi: S; // seated wedge-local angle off the sector centre (θ_seated = t0 + phi)
  d: S;
  L: S;
  yN: S;
  off: S; // material arc coord, arc length, norm axial, wall offset
  /** The piece's axial extent yMax − yMin, model-mm (floored above 0). */
  height: S;
  rung: S; // per-piece signed ladder rung, model-mm
  /** 0/1 axisymmetry flag (ops/frames.ts `axi`): the piece has no meridian of
   *  its own, so ops that read it fall back to a per-VERTEX law (see
   *  `spread`). */
  axi: S;
  /** Radial depth (ops/frames.ts `depth`): the piece's widest wall offset from
   *  R as a fraction of R. The bend cast reads it (house.ts `bendTerm`). */
  depth: S;
  /** 0/1 flag (ops/frames.ts `adopted`): this piece's frame came from a host
   *  shell wedge, so whatever the host does, this piece does. */
  adopted: S;
  /** This recipe's RAW 0..1 channel for this piece, PRE-gate. A `during` scope
   *  narrows it, and nesting composes as function composition. */
  channel: S;
  /** Re-run THIS recipe's gate at a remapped channel — same GateSpec, same
   *  rank01/layerPhase. The ONE way a scope gets a (flight, stick) pair. */
  gateAt(channel: Sc<S>): { flight: S; stick: S };
  flight: S;
  stick: S;
  wrapDir: number;
}

/** A value an op reads when it RUNS: a constant or a function of the effective
 *  ctx, so an op reads a per-piece quantity without `build` doing so. */
export type Live<S> = Sc<S> | ((ctx: OpCtx<S>) => Sc<S>);

function liveOf<S>(x: Live<S>, ctx: OpCtx<S>): Sc<S> {
  return typeof x === "function" ? (x as (c: OpCtx<S>) => Sc<S>)(ctx) : x;
}

// One of five kinds: a transform returns new vertex state AND frame, a modifier
// only vertex state, an orient op only the new working direction, a selector a
// 0..1 weight from the frame (spatial) or ctx (intrinsic), a group scopes.
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
      /** `ctx` is ALREADY EFFECTIVE — `walk` folded the active weight into the
       *  gate pair before the call (the modifier weight law, below). */
      run(v: VertexState<S>, ctx: OpCtx<S>): VertexState<S>;
    }
  | {
      kind: "orient";
      name: string;
      /** The NEW working direction, absolute — an orient op cannot move
       *  geometry or turn a normal. The angle itself is not scaled by the
       *  active weight (a faded re-aim would drift a chain's anchor off the
       *  seam); `ctx` is the EFFECTIVE one, so only its gate-driven part fades. */
      aim(v: VertexState<S>, f: PieceFrame<S>, ctx: OpCtx<S>): S;
    }
  | {
      kind: "selector";
      name: string;
      spatial: boolean;
      weight(f: PieceFrame<S>, ctx: OpCtx<S>): S;
    }
  | { kind: "group"; items: OpItem<S>[]; progress?: Progress<S> };

/** A sub-window of the recipe's channel, as a clamped ramp:
 *  m(c) = clamp((c − from)/(to − from), 0, 1). Every field is a per-PIECE
 *  constant. Invariants (`validatePipeline` warns on illegal literals, nothing
 *  enforces them at runtime): from ≥ 0, to > from; to ≤ 1 is advisory.
 *  Reversal and ping-pong are not representable. */
export interface Progress<S> {
  from?: Sc<S>; // default 0
  to?: Sc<S>; // default 1
}

// Scope a sub-pipeline: selectors inside do not affect ops after the group.
export function group<S>(items: OpItem<S>[]): OpItem<S> {
  return { kind: "group", items };
}

/** Scope a sub-pipeline to a WINDOW of the channel: the subtree runs the same
 *  gate at a remapped clock, so it is seated for channel ≤ from and fully
 *  played for channel ≥ to, stagger and split replayed inside. Acts PRE-gate.
 *  `during({}, items)` is `group(items)`. */
export function during<S>(p: Progress<S>, items: OpItem<S>[]): OpItem<S> {
  return { kind: "group", items, progress: p };
}

/** The PHASED ctx a `during` scope runs under: the channel through the clamped
 *  ramp, and THIS recipe's gate re-run at it. */
function progressCtx<S>(ctx: OpCtx<S>, p: Progress<S>): OpCtx<S> {
  const A = ctx.A;
  // An empty Progress hands back the very ctx it was given, so `during({}, …)`
  // and `group(…)` build the same GRAPH, not merely the same numbers.
  if (p.from === undefined && p.to === undefined) return ctx;
  const q = A.clamp(
    A.div(A.sub(ctx.channel, p.from ?? 0), A.sub(p.to ?? 1, p.from ?? 0)),
    0,
    1,
  );
  const g = ctx.gateAt(q);
  return { ...ctx, channel: q, flight: g.flight, stick: g.stick };
}

// Walk one scope. `weight` is local to this call, so a group's selectors cannot
// mutate the caller's; vertex/frame state threads through the shared `state`.
// A transform takes the weight as an argument; a modifier never sees it — walk
// folds it into the gate pair (`effCtx`), once per distinct weight per scope.
// Progress narrows WHEN (pre-gate), weight scales HOW MUCH (post-gate); the
// order is forced because `w` can be per-VERTEX and the gate must not be.
function walk<S>(
  items: OpItem<S>[],
  state: { v: VertexState<S>; f: PieceFrame<S> },
  weightIn: S,
  ctx: OpCtx<S>,
): void {
  const A = ctx.A;
  let weight = weightIn;
  let eff: OpCtx<S> | null = null;
  // The phased ctxs this scope's `during` groups run under, keyed on the
  // Progress OBJECT so sibling scopes sharing one share a single gate re-run.
  let phased: Map<Progress<S>, OpCtx<S>> | null = null;
  for (const item of items) {
    switch (item.kind) {
      case "selector":
        weight = A.mul(weight, item.weight(state.f, ctx));
        eff = null; // the fold is stale — rebuild it at the next modifier
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
        // ONE angle, written to BOTH levels: the piece's direction and the
        // vertex's own, so `orient` stays uniform across a piece (rigid-safe).
        eff ??= effCtx(ctx, weight);
        const a = item.aim(state.v, state.f, eff);
        state.v = { ...state.v, aim: a };
        state.f = { ...state.f, orient: a };
        break;
      }
    }
  }
}

// Run a pipeline over one piece. The active weight starts at 1.
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

// ── Order-of-operations advisories ─────────────────────────────────────────
// `validatePipeline` warns (never throws) once per recipe on: a spatial
// selector after a modifier (a stale frame; the "modifier seen" flag crosses a
// group boundary in BOTH directions), the `Progress` invariants on LITERAL
// fields only (a knob-bound field is bounded by its knob's range), and a
// dangling chain segment (`arc`/`crease` with no `anchor` before it).

const warnedRecipes = new Set<string>();

interface ScopeState {
  modifierSeen: boolean;
  modifierName: string | undefined;
  anchored: boolean;
}

/** The chain ops that spend cursor material, so all of them need an `anchor`
 *  before them to have any to spend. */
const CHAIN_SEGMENTS = new Set(["arc", "crease", "straight"]);

/** A Progress field's value if it is a plain literal; a backend scalar (a
 *  uniform, a node) reads as undefined. */
function litOf<S>(x: Sc<S> | undefined): number | undefined {
  return typeof x === "number" ? x : undefined;
}

function validateProgress<S>(
  p: Progress<S>,
  warn: (message: string) => void,
): void {
  const from = litOf(p.from);
  const to = litOf(p.to);
  // Defaults only count once the OTHER end is a literal — an all-symbolic
  // window says nothing here.
  const lo = from ?? (to === undefined ? undefined : 0);
  const hi = to ?? (from === undefined ? undefined : 1);
  if (from !== undefined && from < 0) {
    warn(
      `lens ops: during({ from: ${from} }) is negative — the remap is already ` +
        `> 0 at channel 0, so the scope's subtree is off its seat the instant ` +
        `the idle gate opens (the model pops). Use from >= 0.`,
    );
  }
  if (lo !== undefined && hi !== undefined && hi <= lo) {
    warn(
      `lens ops: during({ from: ${lo}, to: ${hi} }) has a non-positive width — ` +
        `the ramp divides by (to - from) = ${hi - lo}, and NaN * 0 = NaN pushes ` +
        `straight THROUGH the hard idle gate into the seated render. Use ` +
        `to > from.`,
    );
  }
  if (to !== undefined && to > 1) {
    warn(
      `lens ops: during({ to: ${to} }) reaches past the end of the channel — ` +
        `the scope never finishes (advisory).`,
    );
  }
}

function validateScope<S>(
  items: OpItem<S>[],
  recipeName: string,
  warn: (message: string) => void,
  incoming: ScopeState = {
    modifierSeen: false,
    modifierName: undefined,
    anchored: false,
  },
): ScopeState {
  let modifierSeen = incoming.modifierSeen;
  let modifierName = incoming.modifierName;
  // The chain cursor is VERTEX state and threads forward out of a group like
  // the aim, so an anchor anywhere earlier in the pipeline counts.
  let anchored = incoming.anchored;
  for (const item of items) {
    switch (item.kind) {
      case "modifier":
        if (item.name === "anchor") anchored = true;
        if (CHAIN_SEGMENTS.has(item.name) && !anchored) {
          warn(
            `lens ops: recipe "${recipeName}" runs an ${item.name} with no ` +
              `anchor before it — the chain cursor is still the seeded rem = 0, ` +
              `so the segment consumes no material and walks off wherever the ` +
              `previous op left the vertex. Start the chain with anchor().`,
          );
        }
        modifierSeen = true;
        modifierName = item.name;
        break;
      case "selector":
        if (item.spatial && modifierSeen) {
          warn(
            `lens ops: spatial selector "${item.name}" runs after modifier ` +
              `"${modifierName}" — it reads a stale frame (modifiers do not ` +
              `advance the frame, and a group does not scope that). Reorder ` +
              `the selector before the modifier.`,
          );
        }
        break;
      case "group": {
        if (item.progress) validateProgress(item.progress, warn);
        const inner = validateScope(item.items, recipeName, warn, {
          modifierSeen,
          modifierName,
          anchored,
        });
        if (inner.modifierSeen) {
          modifierSeen = true;
          modifierName = inner.modifierName ?? modifierName;
        }
        anchored = anchored || inner.anchored;
        break;
      }
      case "transform":
      // An orient op is TRANSPARENT here: it advances neither the vertex nor
      // the frame's placement, so a spatial selector after one is not stale.
      case "orient":
        break;
    }
  }
  return { modifierSeen, modifierName, anchored };
}

export function validatePipeline<S>(
  items: OpItem<S>[],
  recipeName: string,
): void {
  let warned = false;
  const warn = (message: string): void => {
    if (warned || warnedRecipes.has(recipeName)) return;
    warned = true;
    warnedRecipes.add(recipeName);
    console.warn(message);
  };
  validateScope(items, recipeName, warn);
}

// ── Selectors ───────────────────────────────────────────────────────────────
// The per-piece MASK family: spatial selectors read the CURRENT frame, the rest
// read ctx intrinsics. Each carries an EXACT-1 bypass.

// Default edge feathers. A feather of 0 would make smoothstep divide by zero
// exactly on the edge, so keep them > 0.
const SECTOR_FEATHER = 0.3; // radians
const RANK_FEATHER = 0.1;

// The sector's exact-open edge, just under TAU: width ≥ this ⇒ exactly 1.
const SECTOR_OPEN = 6.2; // radians

// RANK: a band on ctx.rank01. Intrinsic. Bypass: lo ≤ 0 AND hi ≥ 1 ⇒ exactly 1.
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

// SECTOR: an angular band on the CURRENT frame theta. Spatial. Comparing
// cos(theta − centre) against the half-width cosines sidesteps angle wrapping.
// cos is monotone only over [0, π], so both caps are load-bearing: the outer
// angle caps at π to keep the ramp edges ORDERED, the width at SECTOR_OPEN to
// keep them DISTINCT. Bypass: width ≥ SECTOR_OPEN ⇒ exactly 1.
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

// FRONT: wrap an arbitrary ctx → weight field as a material (intrinsic) selector.
export function selFront<S>(f: (ctx: OpCtx<S>) => S): OpItem<S> {
  return {
    kind: "selector",
    name: "selFront",
    spatial: false,
    weight: (_f, ctx) => f(ctx),
  };
}

// The part-class ids `ctx.partClass` carries (stamped by ops/frames.ts).
export const PART_CLASS = {
  structure: 0,
  glass: 1,
  iris: 2,
  decal: 3,
  accessory: 4,
  /** the peel's KEEP-set (core/parts isPeelKeep) — a class only so a recipe
   *  can scope itself off it. */
  kept: 5,
} as const;

// ── Orientation ───────────────────────────────────────────────────────────────
// THE DIRECTION CLASS. One op, and all it can do is re-aim: it writes the
// working direction downstream ops move ALONG, and touches nothing else. The
// direction threads FORWARD out of a `group`; the inverse is one `rot(−a)`.

/** Turn the working direction by `rad`. Moves nothing. */
export function rot<S>(rad: Live<S>): OpItem<S> {
  return {
    kind: "orient",
    name: "rot",
    // RELATIVE, off the PIECE's direction. The seat IS the initial aim
    // (aim0 = t0), so `rot(halfSpan)` reaches the seam.
    aim: (_v, f, ctx) => ctx.A.add(f.orient, liveOf(rad, ctx)),
  };
}

// ── Transforms ────────────────────────────────────────────────────────────────
// The rigid motions (approach / orbit / swirl / spread / rise / tilt) plus the
// affine trio (ladder / scale / shear). A transform advances BOTH the vertex
// state AND the piece frame through the identical rigid motion, so spatial
// selectors downstream track the piece. Every displacement is folded by
// ctx.flight AND the active weight `w`, so a transform is identity at
// flight = 0 or w = 0. Rotational carry (v.rot) advances ONLY for orbit and
// swirl; translations do not turn a normal, and `tilt` is deliberately outside
// the carve-out (see its own header).

// APPROACH: axial slide by `axialMm`. A pure translation: the normal is
// untouched, the frame axial takes the same delta.
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

// ORBIT: a RIGID REVOLUTION about the optical axis. angle = flight·rad·w, and
// that one angle turns the piece, its frame, its working direction and its
// normals together, so the piece sweeps around the barrel carrying its facing.
// The SIGN is the caller's: multiply ctx.wrapDir into `rad` at the call site to
// get the house peel handedness.
export function orbit<S>(rad: Live<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "orbit",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      // LIVE: the angle reads the ctx the walk hands it, so a `during` scope
      // uses its own flight rather than the one the op was built under.
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

// SWIRL: `orbit` plus the vortex couplings — `rankScale` scales the angle with
// (rank01 + ½) so angular velocity varies with radius, `exp` gives flight^exp
// (the whip ease), and ctx.wrapDir is applied AFTER the wrap so an unrolled
// sheet sweeps the barrel in the peel's own handedness.
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

// SPREAD: rigid translation of the whole piece outward along a meridian — a
// cartesian add of a per-piece vector, so shape and normal are preserved.
// Direction: THE WORKING DIRECTION `f.orient`, re-aimable by `rot()` (a seam
// throw is `rot(halfSpan); spread()`), the frame running the identical add.
// AXISYMMETRIC PIECES (ctx.axi = 1) have NO meridian, so the direction falls
// back PER VERTEX to the vertex's own and the ring DILATES in place; a dilation
// has no net translation, so the FRAME's displacement carries (1 − axi).
export function spread<S>(frac: Live<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "spread",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const D = A.mul(A.mul(A.mul(ctx.flight, liveOf(frac, ctx)), ctx.R), w);
      // The piece's own meridian, or the VERTEX's own for an axisymmetric
      // piece. axi is 0/1, so the mix selects rather than interpolates.
      const n = { x: A.cos(f.orient), z: A.sin(f.orient) };
      const u = outward(A, v);
      const dv = {
        x: A.mix(n.x, u.x, ctx.axi),
        z: A.mix(n.z, u.z, ctx.axi),
      };
      const Df = A.mul(D, A.sub(1, ctx.axi)); // a dilation moves no centre
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

// RISE: a rigid translation along the optical axis, scaled by `flight`. Axial
// like the ladder, so it stays invariant under rotation about the bore.
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

// TILT: the HINGE — the (radius, axial) pair turns about the hinge point
// (frame radius, pivot) in each vertex's own MERIDIAN half-plane; the meridian
// itself is untouched, so the hinge is the tangent CIRCLE at that
// radius/station and a wedge keeps its curvature through the tilt.
// `pivot` is the hinge's AXIAL station (model-mm, default the piece frame's own
// centre); positive `rad` tips the +Y side of the pivot OUTWARD. The frame
// rides the identical rotation; its meridian and the working direction stay.
// v.rot does NOT advance: rot is a rotation about the OPTICAL axis, while a
// tilt turns normals about the local TANGENT axis.
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
      // The new radius, as the displacement off the current one.
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

// LADDER: axial displacement by the piece's own signed rung (ctx.rung,
// model-mm) × gain. A translation, so no rot; the frame rides along.
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
// Shape changes: the developable bend CHAIN (`anchor`/`arc`/`straight`/
// `crease`) plus coil. A modifier advances ONLY the vertex
// state and never the piece frame, so a spatial selector after one reads a
// stale frame (validatePipeline warns).
//
// THE MODIFIER WEIGHT LAW. A modifier does not scale its displacement by the
// active weight `w`; the weight is folded into the GATE reads instead:
//
//     flightEff = flight · w        stickEff = mix(1, stick, w)
//
// (flight = 0, stick = 1) is the identity pair, so w = 0 gives the EXACT seated
// state and w = 1 leaves the gate untouched. `walk` applies the fold, so a
// modifier just reads `ctx.flight`/`ctx.stick`, as does any `Live` argument.

function effCtx<S>(ctx: OpCtx<S>, w: S): OpCtx<S> {
  const A = ctx.A;
  return {
    ...ctx,
    flight: A.mul(ctx.flight, w),
    stick: A.mix(1, ctx.stick, w),
  };
}

// sin(x)/x with the removable singularity guarded: sinc is EVEN, so evaluate at
// max(|x|, ε). s = 0 still gives chord = 0 exactly (0 · finite).
function sinc<S>(A: Algebra<S>, x: S): S {
  const ax = A.max(A.abs(x), 1e-5);
  return A.div(A.sin(ax), ax);
}

// ── The bend CHAIN ────────────────────────────────────────────────────────────
// `anchor` + `arc`: the developable bend, as a piecewise-constant curvature
// profile a recipe spells in the pipeline, one op per segment. Two invariants:
//
//  • THE CURSOR IS REMAINING MATERIAL. `anchor` seeds `v.rem = ctx.d`,
//    UNCLAMPED — a real wedge overruns its nominal half-span, and negative
//    overrun walks the first arc BACKWARDS past the anchor. Each arc consumes
//    `s = min(rem, len)` and leaves `rem − s`.
//  • THE OFF-INVARIANT. The vertex state carries the OFFSET point, not the
//    chain point: v = chain + off·n̂(aim). Each arc strips `off` along the
//    incoming aim, walks the chain, and re-adds it along the outgoing one.
//
// The chain angle IS `v.aim`: `anchor` starts on whatever direction is in
// force, so `rot()` before it is how a chain is placed. The winding is the
// house one, so there is no `from` argument.

/** ANCHOR: start a bend chain on the current working direction at `radius`
 *  (default the seated R), loading the cursor with this vertex's material.
 *  REPLACES the point; starts the rotation accumulator at `aim − θ_seated`. */
export function anchor<S>(radius?: Live<S>): OpItem<S> {
  return {
    kind: "modifier",
    name: "anchor",
    run: (v, ctx) => {
      const A = ctx.A;
      const n = v.aim;
      const anchorR: Sc<S> = radius === undefined ? ctx.R : liveOf(radius, ctx);
      // The chain origin plus this vertex's wall offset, both along the aim.
      const out = A.add(anchorR, ctx.off);
      return {
        ...v,
        x: A.mul(out, A.cos(n)),
        z: A.mul(out, A.sin(n)),
        rot: A.sub(n, A.add(ctx.t0, ctx.phi)),
        // UNCLAMPED on purpose — see the cursor law above.
        rem: ctx.d,
      };
    },
  };
}

/** ARC: consume `len` material-mm off the chain cursor (omit `len` and it takes
 *  the whole remainder) at constant curvature `q` = R·κ, dimensionless: 1 is
 *  the seated barrel, 0 a straight run, > 1 a tighter fold, < 0 an outward
 *  roll. Constant κ integrates in closed form — the tangent turns by ψ = q·s/R
 *  and the position advances by the exact chord `s·sinc(ψ/2)` about the MID
 *  angle. A LEADING arc (the one taking the negative overrun) should carry the
 *  seated q = 1: with q ≠ 1 an overrun vertex leaves the seated barrel.
 *  `participation` (default 1) is the fraction of this arc's material that
 *  BENDS, the rest SLIPPING straight along the vertex's own EXIT tangent; NOT
 *  scaled by the selection weight. */
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

/** One chain SEGMENT: consume `s` material at constant curvature `q` (R·κ),
 *  with `c` of it bending and the rest slipping along the exit tangent. The
 *  chord walk `arc` and `crease` share. */
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
  const n1 = A.sub(n0, psi); // this vertex's exit tangent angle
  const slip = A.sub(s, bent); // the unbent remainder, along the exit tangent
  // Off the offset point, along the chain, back onto the offset point.
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

/** STRAIGHT: consume `len` material off the chain cursor at ZERO curvature —
 *  the chain's flat run (omit `len` and it takes the whole remainder). The
 *  point slides `s` along its own exit tangent; rot and aim do not move. */
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

/** CREASE: a HARD FOLD in the bend chain. Consumes `width` material-mm at
 *  whatever curvature turns the chain `rad` MORE than the seated barrel turns
 *  over that run: q = 1 + rad·R/width, so `rad` is RELATIVE TO THE SEAT and
 *  rad = 0 gives q = 1 EXACTLY. Positive folds the SAME way the barrel curves.
 *  `width` is the sharpness knob and MUST be > 0 — it divides. Normals are
 *  exact only for an AXIALLY-UNIFORM crease; a ramped `rad` shades
 *  approximately, like `twist`. */
export function crease<S>(rad: Live<S>, width: Live<S>): OpItem<S> {
  return {
    kind: "modifier",
    name: "crease",
    run: (v, ctx) => {
      const A = ctx.A;
      const w = liveOf(width, ctx);
      const s = A.min(v.rem, w);
      // q = 1 + rad·R/width: the seated turn plus the fold. If the cursor runs
      // out mid-crease (s < width) the fold is taken proportionally.
      const q = A.add(1, A.div(A.mul(liveOf(rad, ctx), ctx.R), w));
      return chainStep(v, ctx, s, q, 1);
    },
  };
}

// COIL: map the seated radius R toward R·factor at CONSTANT arc length, so the
// wedge-local angle opens ∝ 1/factor. factor = 1 at flight = 0 ⇒ exact
// identity. Reads the SEATED phi (ctx), not the live meridian. LIVE, so a
// factor may itself read the gate.
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
