// The op pipeline — the scoped-selection model and the selector op family, all
// written against the scalar algebra so a recipe runs identically on the CPU
// (NUM, for tests/tooling) and the GPU (tslAlgebra). This file owns three
// primitives: the vertex/frame state a recipe threads, the `OpItem` union every
// op is expressed as, and `runPipeline` — which walks the items in order,
// feeding each op's output state to the next. The three op families follow it:
// selectors, transforms, modifiers.
//
// The selection model: an "active weight" (0..1) accumulates as the pipeline
// runs. It starts at 1. A selector MULTIPLIES its 0..1 factor into the weight,
// masking every op after it in the current scope. `group([...])` scopes that:
// the weight in force when the group is entered is restored when it exits, so a
// selector inside a group cannot leak out to ops that follow the group.
//
// THE SCOPING LAW: a group scopes WEIGHT and PROGRESS — the two things that live
// in the CTX. `during(progress, items)` is a group that also narrows the CHANNEL
// its subtree's gate reads, so the subtree plays inside a sub-window of the
// recipe's own clock. Everything else THREADS: the vertex state, the piece frame
// and the working direction pass straight through a group boundary in both
// directions. Said the other way — the ctx an op sees is immutable WITHIN a
// scope and re-derived for a nested one; the state is one object every op in the
// pipeline advances.
//
// THE ORDER-OF-OPERATIONS LAW — what each of the four op classes may touch:
//
//   class     | vertex | frame placement | frame/vertex aim | normal (rot)
//   ----------|--------|-----------------|------------------|---------------
//   transform | yes    | yes             | rotations only   | rotations only
//   modifier  | yes    | never           | chain ops only   | yes
//   orient    | never  | never           | yes              | never
//   selector  | no     | no              | no               | no (weight)
//
// Read down the "frame placement" column and the split is the whole design: a
// transform runs the identical rigid motion on the piece frame, so spatial
// selectors downstream track the piece; a modifier reshapes the vertex and
// leaves the frame where it was, so a spatial selector placed after one reads a
// STALE frame (validatePipeline warns). Read the aim column and the two levels
// appear: a rotation carries the piece's facing with it, an orient op IS the
// facing, and a bend chain advances the VERTEX's aim alone — each vertex has its
// own exit tangent while the piece's direction stays put.

import type { Algebra, Sc } from "./algebra";

// The per-vertex state a recipe deforms.
export interface VertexState<S> {
  theta: S;
  radius: S;
  axial: S;
  rot: S;
  /** THE WORKING DIRECTION: an ABSOLUTE angle in the radial plane, seeded to
   *  ctx.t0. n̂ = (cos aim, sin aim) is "out", t̂ = (−sin aim, cos aim) is
   *  "along"; axial is always +Y. Every op that needs "which way" reads it from
   *  here (or from the frame's copy) rather than re-deriving it off ctx.t0, so
   *  the representation is one thing to change. */
  aim: S;
  /** Unspent material on the current bend chain, model-mm. */
  rem: S;
}

// The per-piece frame a recipe advances. Spatial selectors read it; a modifier
// leaves it untouched (that is the whole point of the transform/modifier split).
export interface PieceFrame<S> {
  theta: S;
  radius: S;
  axial: S;
  /** The PIECE's working direction — absolute, seeded to ctx.t0, and the
   *  counterpart of `VertexState.aim`: a chain advances the VERTEX's aim per
   *  vertex (each has its own exit tangent) while the piece's stays put, exactly
   *  as v.theta and f.theta diverge. */
  orient: S;
}

// The immutable per-piece context every op sees. `A` is the backend; the rest
// are seated constants and material coordinates the ops read. `d`/`L` are the
// material coordinates in the HOUSE winding convention (the seam at
// φ = +halfSpan, i.e. d = R·(halfSpan − phi)): `d` is what `anchor` loads the
// chain cursor with, and both are there for material selectors.
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
  rung: S; // per-piece signed ladder rung, model-mm
  /** 0/1 axisymmetry flag (ops/frames.ts `axi`): 1 means the piece is a body
   *  of revolution, so `t0` is the pinned 0 rather than a measured meridian and
   *  ANY op whose direction is "the piece's own meridian" is meaningless on it.
   *  Ops that read it fall back to a per-VERTEX law (see `spread`). */
  axi: S;
  /** Pieces in this piece's own rank LAYER (ops/frames.ts `layerN`): 1 for a
   *  lone ring or solitary body, N for one wedge of an N-cut shell (an adopted
   *  feature reports its host's). INFORMATIONAL: the 0.01mm rank bucket it is
   *  counted over is tighter than the spread of measured median radii, so no
   *  recipe hangs a decision on it. */
  layerN: S;
  /** 0/1 flag (ops/frames.ts `adopted`): 1 means this piece's frame was adopted
   *  from a host shell wedge — bolted hardware (mount screws, contacts, the
   *  focus motor) that RIDES a segmented shell rather than being one. It is the
   *  measured half of the classic's baked participation flag: whatever the host
   *  does, this piece does. */
  adopted: S;
  /** This recipe's RAW 0..1 channel for this piece, PRE-gate — the clock the
   *  gate pair below was computed from. A `during` scope narrows it, and nesting
   *  composes as function composition. */
  channel: S;
  /** Re-run THIS recipe's gate at a remapped channel — same GateSpec, same
   *  rank01/layerPhase. The ONE way a scope gets a (flight, stick) pair, and the
   *  reason ops.ts needs no import from gate.ts: the host (and its CPU mirror)
   *  captures the recipe's spec once and passes this closure. */
  gateAt(channel: Sc<S>): { flight: S; stick: S };
  flight: S;
  stick: S;
  wrapDir: number;
}

/** A value an op reads when it RUNS: a constant (or plain number, lifted by the
 *  algebra) or a function of the effective ctx. The function form is how a
 *  recipe hands an op a per-piece quantity — `rot(c => c.halfSpan)` reaches the
 *  seam of whatever piece the pipeline is running on — without making `build`
 *  itself ctx-dependent. */
export type Live<S> = Sc<S> | ((ctx: OpCtx<S>) => Sc<S>);

function liveOf<S>(x: Live<S>, ctx: OpCtx<S>): Sc<S> {
  return typeof x === "function" ? (x as (c: OpCtx<S>) => Sc<S>)(ctx) : x;
}

// An op is one of five kinds. A transform returns new vertex state AND a new
// frame; a modifier returns only vertex state; an orient op returns only the new
// working direction; a selector yields a 0..1 weight from the frame (spatial) or
// ctx (intrinsic); a group scopes a sub-pipeline.
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
       *  gate pair before the call (see the modifier weight law below). */
      run(v: VertexState<S>, ctx: OpCtx<S>): VertexState<S>;
    }
  | {
      kind: "orient";
      name: string;
      /** The NEW working direction, absolute. Returning ONLY an angle is what
       *  makes the class structurally unable to move geometry or turn a normal.
       *
       *  THE WEIGHT LAW (subtle): an orient op is NOT scaled by the active
       *  weight — it receives the EFFECTIVE ctx, like a modifier. If a re-aim
       *  faded with `w`, then at w = 0 a chain's anchor would drift off the seam
       *  and the channel-0 / masked-piece identity would break. Gate-driven
       *  re-aims vanish at w = 0 on their own, because they are functions of the
       *  folded gate (flightEff = flight·w): constants survive the mask, gate
       *  terms fade. */
      aim(v: VertexState<S>, f: PieceFrame<S>, ctx: OpCtx<S>): S;
    }
  | {
      kind: "selector";
      name: string;
      spatial: boolean;
      weight(f: PieceFrame<S>, ctx: OpCtx<S>): S;
    }
  | { kind: "group"; items: OpItem<S>[]; progress?: Progress<S> };

/** A sub-window of the recipe's channel, as a clamped ramp then an optional
 *  power: m(c) = clamp((c − from)/(to − from), 0, 1)^ease.
 *
 *  Every field is a per-PIECE constant. A per-VERTEX bound would give one piece
 *  two progresses and tear it apart, which is the same argument that keeps the
 *  gate per piece.
 *
 *  THE INVARIANTS (structural — `validatePipeline` warns on illegal literals but
 *  nothing enforces them at runtime, exactly like the GateSpec law):
 *    1. from ≥ 0, so m(0) = 0 EXACTLY (clamp is min/max on both backends). The
 *       hard idle gate force-zeroes at channel 0; the risk is the discontinuity
 *       just above it — a remap that reads ~1 at channel 1e-6 pops the model off
 *       its seat.
 *    2. to > from, or the ramp divides 0/0 and the NaN survives the idle gate
 *       (NaN · 0 = NaN) into the seated render — the KNOB_LIMITS argument.
 *    3. ease > 0: pow(0, 0) = 1, and x = 0 with e ≤ 0 is undefined behaviour in
 *       GLSL. ease ∈ (0, 1) is a legal ease-out.
 *    4. to ≤ 1 is advisory: past 1 the scope simply never finishes.
 *
 *  Representable = clamped ramp ∘ positive power, i.e. monotone non-decreasing
 *  with m(0) = 0. Reversal (1 − p) and ping-pong are deliberately NOT
 *  representable: non-monotone time art belongs at the DRIVER tier, where each
 *  channel is separately idle-gated. */
export interface Progress<S> {
  from?: Sc<S>; // default 0
  to?: Sc<S>; // default 1
  ease?: Sc<S>; // default 1 (omitted ⇒ no pow node)
}

// Scope a sub-pipeline: selectors inside do not affect ops after the group.
export function group<S>(items: OpItem<S>[]): OpItem<S> {
  return { kind: "group", items };
}

/** Scope a sub-pipeline to a WINDOW of the channel: a group whose subtree runs
 *  the same gate at a remapped clock, so it is seated for channel ≤ from and
 *  fully played for channel ≥ to, with the per-piece stagger and the two-phase
 *  split replaying inside the sub-window.
 *
 *  It acts PRE-gate, on the channel, which is what lets both ends land exactly:
 *  the gate already guarantees p = 0 ⇒ (flight 0, stick 1) and p = 1 ⇒ fully
 *  played. Post-gate remapping cannot — a scope containing `stickPress` would be
 *  left half-live outside its window — and remapping the pair jointly IS the
 *  weight fold, which can never express "held complete after".
 *
 *  `during({}, items)` is `group(items)` to the bit: an omitted field builds no
 *  node at all. */
export function during<S>(p: Progress<S>, items: OpItem<S>[]): OpItem<S> {
  return { kind: "group", items, progress: p };
}

/** The PHASED ctx a `during` scope runs under: the channel through the clamped
 *  ramp and the optional power, and THIS recipe's gate re-run at it. */
function progressCtx<S>(ctx: OpCtx<S>, p: Progress<S>): OpCtx<S> {
  const A = ctx.A;
  const ramp = p.from !== undefined || p.to !== undefined;
  // An empty Progress hands back the very ctx it was given — no ramp, no pow,
  // no second gate. That is what makes `during({}, …)` and `group(…)` the same
  // graph rather than merely the same numbers.
  if (!ramp && p.ease === undefined) return ctx;
  let q: S = ctx.channel;
  if (ramp) {
    const from = p.from ?? 0;
    const to = p.to ?? 1;
    q = A.clamp(A.div(A.sub(q, from), A.sub(to, from)), 0, 1);
  }
  if (p.ease !== undefined) q = A.pow(q, p.ease);
  const g = ctx.gateAt(q);
  return { ...ctx, channel: q, flight: g.flight, stick: g.stick };
}

// Walk one scope. `weight` is local to this call, so a group (a recursive call)
// gets the current weight but its own selectors cannot mutate the caller's — the
// weight is naturally restored on exit. The vertex/frame state, by contrast,
// threads through every op via the shared `state` object.
//
// The weight reaches the two op families differently. A TRANSFORM takes it as an
// argument and scales its own displacement by it. A MODIFIER never sees it: walk
// folds it into the gate pair (`effCtx`) and hands over the EFFECTIVE ctx, so
// the modifier weight law is structural rather than something each op restates.
// That fold is built at most ONCE per distinct weight per scope — N modifiers
// under one selection share one `flight·w` (on the GPU, one node: TSL has no
// common-subexpression elimination across node objects).
//
// THE FORCED ORDER, weight against progress:
//
//   channel ──during (pre-gate, per scope)──▶ p' ──gate──▶ (flight, stick)
//   ──the weight fold (post-gate, the scope's w)──▶ (flight·w, mix(1, stick, w))
//
// Progress narrows WHEN, weight scales HOW MUCH; progress is outside the gate,
// weight inside; either one at its zero gives the exact seat. The order is
// forced, not a taste: `w` can be per-VERTEX (selAxialBand, selSector,
// selFront-on-yN), so folding it pre-gate would put the gate itself on a
// per-vertex path and vary the stagger WITHIN a piece.
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
  // Progress OBJECT — sibling scopes sharing one Progress share one gate re-run
  // (house.ts `memoCtx`'s argument: on the GPU a second build is a second
  // subgraph, not a cache miss). `ctx` is fixed for the length of this call, so
  // the Progress identity is the whole key.
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
        // vertex's own. (A chain op advances the vertex's alone — each vertex
        // has its own exit tangent — so an explicit re-aim after one re-bases
        // the vertex onto the piece's direction, which is what keeps `orient`
        // uniform across a piece and therefore rigid-safe for `spread`.)
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
// A spatial selector reads the current frame, so placing it after a modifier is
// a latent bug: the modifier advanced the vertex state but NOT the frame, so the
// selector silently sees a stale frame. `validatePipeline` warns (never throws)
// once per recipe. A group scopes the CTX (weight, progress) — `walk` threads the
// vertex/frame state straight through it — so the "modifier seen" flag crosses a
// group boundary in BOTH directions, a `during` boundary included: a modifier
// before a group taints spatial selectors inside it, and a modifier inside a
// group taints those after it.
//
// The same pass checks two more things. The `Progress` invariants, on
// LITERAL-number fields only: a knob-bound field is a uniform this pass cannot
// read, and its bound belongs in host.ts's KNOB_LIMITS instead (see the doc
// block there). And a DANGLING `arc` — one with no `anchor` before it anywhere
// in the pipeline — which is not a crash but a silent nonsense: the cursor is
// still the seeded rem = 0, so the arc consumes nothing and walks the vertex off
// whatever position the last op happened to leave it at.

const warnedRecipes = new Set<string>();

interface ScopeState {
  modifierSeen: boolean;
  modifierName: string | undefined;
  anchored: boolean;
}

/** A Progress field's value if it is a plain literal — a backend scalar (a
 *  uniform, a node) reads as undefined and is left to KNOB_LIMITS. */
function litOf<S>(x: Sc<S> | undefined): number | undefined {
  return typeof x === "number" ? x : undefined;
}

function validateProgress<S>(
  p: Progress<S>,
  warn: (message: string) => void,
): void {
  const from = litOf(p.from);
  const to = litOf(p.to);
  const ease = litOf(p.ease);
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
  if (ease !== undefined && ease <= 0) {
    warn(
      `lens ops: during({ ease: ${ease} }) is non-positive — pow(0, 0) is 1 ` +
        `(and x = 0 with e <= 0 is undefined behaviour in GLSL), so the scope ` +
        `starts fully played and the model pops off its seat. Use ease > 0.`,
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
  // The chain cursor is VERTEX state, so it threads forward out of a group just
  // as the aim does — an anchor anywhere earlier in the pipeline counts.
  let anchored = incoming.anchored;
  for (const item of items) {
    switch (item.kind) {
      case "modifier":
        if (item.name === "anchor") anchored = true;
        if (item.name === "arc" && !anchored) {
          warn(
            `lens ops: recipe "${recipeName}" runs an arc with no anchor ` +
              `before it — the chain cursor is still the seeded rem = 0, so the ` +
              `arc consumes no material and walks off wherever the previous op ` +
              `left the vertex. Start the chain with anchor().`,
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
// read ctx intrinsics. Each carries its EXACT-1 bypass so a default-open
// selector cannot perturb a calibrated recipe.

// Default edge feathers — the house values. A feather of
// 0 would make smoothstep divide by zero exactly on the edge, so keep them > 0.
const SECTOR_FEATHER = 0.3; // radians
const RANK_FEATHER = 0.1;
const AXIAL_FEATHER = 0.05;

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

// SECTOR: an angular band on the CURRENT frame theta. Spatial. The monotone-
// cosine trick (compare cos(theta − centre) against the half-width cosines)
// sidesteps angle wrapping. Bypass: width ≥ SECTOR_OPEN ⇒ exactly 1.
// cos is monotone only over [0, π], and the ramp needs its two edges ORDERED
// there: uncapped, the feathered outer angle passes π and climbs back over the
// inner one, INVERTING the mask for width > 2π − feather (5.98..6.2 with the
// house feather — live, since the bypass only opens at 6.2). Capping the outer
// angle at π restores the order; capping the width at SECTOR_OPEN keeps the two
// edges DISTINCT at the TAU default, where cos(π) = cos(π) would divide 0 by 0.
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
      const c = A.cos(A.sub(f.theta, center));
      const half = A.mul(A.min(width, SECTOR_OPEN), 0.5);
      const inner = A.cos(half);
      const outer = A.cos(A.min(A.add(half, feather), Math.PI));
      const m0 = A.smoothstep(outer, inner, c);
      return A.min(A.add(m0, A.step(SECTOR_OPEN, width)), 1);
    },
  };
}

// PICK: a deterministic per-piece hash gate on the seated constants t0/R.
// Intrinsic. frac = 1 gives exactly 1 (step(h, 1) = 1 since the hash is < 1).
export function selPick<S>(frac: Sc<S>, seed: number): OpItem<S> {
  return {
    kind: "selector",
    name: "selPick",
    spatial: false,
    weight: (_f, ctx) => {
      const A = ctx.A;
      const h = A.fract(
        A.mul(
          A.add(A.add(A.mul(ctx.t0, 12.9898), A.mul(ctx.R, 0.7823)), seed),
          43758.5453,
        ),
      );
      return A.step(h, frac);
    },
  };
}

// CLASS: an exact match on ctx.partClass (an integer id from PART_CLASS),
// implemented as a step-window so it stays a pure algebra expression. Intrinsic.
export function selClass<S>(cls: number): OpItem<S> {
  return {
    kind: "selector",
    name: "selClass",
    spatial: false,
    weight: (_f, ctx) => {
      const A = ctx.A;
      // partClass ≥ cls − 0.5 AND partClass ≤ cls + 0.5.
      return A.mul(
        A.step(cls - 0.5, ctx.partClass),
        A.step(ctx.partClass, cls + 0.5),
      );
    },
  };
}

// AXIAL BAND: a feathered band on the CURRENT frame axial coordinate. Spatial.
// Bypass: lo ≤ −OPEN_EDGE AND hi ≥ +OPEN_EDGE ⇒ exactly 1, in the selRank style.
// The sentinel is FINITE on purpose — ±Infinity would be NaN on the NUM backend
// (∞ − ∞ inside smoothstep) and a broken literal in generated shader code.
const OPEN_EDGE = 1e5; // model-mm, far outside any real band (the lens is ~100mm)

export function selAxialBand<S>(
  lo: Sc<S>,
  hi: Sc<S>,
  feather: number = AXIAL_FEATHER,
): OpItem<S> {
  return {
    kind: "selector",
    name: "selAxialBand",
    spatial: true,
    weight: (f, ctx) => {
      const A = ctx.A;
      const a = f.axial;
      const m0 = A.mul(
        A.smoothstep(A.sub(lo, feather), lo, a),
        A.sub(1, A.smoothstep(hi, A.add(hi, feather), a)),
      );
      // step(edge, x) = x ≥ edge, so these read "lo ≤ −OPEN_EDGE" and "hi ≥ OPEN_EDGE".
      const open = A.mul(A.step(lo, -OPEN_EDGE), A.step(OPEN_EDGE, hi));
      return A.min(A.add(m0, open), 1);
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

// The part-class ids selClass matches against.
export const PART_CLASS = {
  structure: 0,
  glass: 1,
  iris: 2,
  decal: 3,
  accessory: 4,
} as const;

// ── Orientation ───────────────────────────────────────────────────────────────
// THE DIRECTION CLASS. One op, and everything it can do is re-aim: it writes the
// working direction that downstream ops move ALONG, and touches nothing else.
//
// It exists because every direction in this algebra was hard-wired to `ctx.t0`
// derivatives — spread displaced along the sector centre or, with a flag, along
// `t0 − halfSpan·seamDir`; a chain anchored on the same expression. Those flags
// were the same statement written twice, and neither composed. As STATE the
// direction is one angle a recipe can turn as often as it likes, in the order it
// says, and `spread(...)` after `rot(halfSpan)` IS the old seam flag.
//
// SCOPING: the direction threads FORWARD out of a `group`, like every other
// piece of state — a group scopes the CTX (weight, progress) and nothing else.
// The inverse is one explicit `rot(−a)`.

/** Turn the working direction by `rad`. Moves nothing. */
export function rot<S>(rad: Live<S>): OpItem<S> {
  return {
    kind: "orient",
    name: "rot",
    // RELATIVE, off the PIECE's direction: an absolute `dir()` would only ever
    // be spelled `rot(target − aim0)` at the one seat the recipes have, and the
    // seat IS the initial aim (aim0 = t0), so `rot(halfSpan)` reaches the seam.
    aim: (_v, f, ctx) => ctx.A.add(f.orient, liveOf(rad, ctx)),
  };
}

// ── Transforms ────────────────────────────────────────────────────────────────
// The transform op family: the rigid motions (approach / orbit / swirl /
// spread) plus the affine trio (ladder / scale / shear).
// A transform advances BOTH the vertex state AND the piece frame — the frame
// runs the identical rigid motion on its own coordinates, so spatial selectors
// downstream track the piece. Every displacement is folded by ctx.flight AND the
// active selection weight `w`, so a transform is identity at flight = 0 (or w = 0)
// and rides the selection mask like every other op. Rotational carry (v.rot)
// advances ONLY for the rotations (orbit / swirl) — a rigid rotation turns the
// surface normal; translations (approach / spread / ladder) do not.

// APPROACH: axial slide (axialMm) + a per-rank pitch spread (pitchMm·rank01). A
// pure translation, so the normal is untouched. The frame's axial advances by the
// identical delta.
export function approach<S>(axialMm: Sc<S>, pitchMm: number = 0): OpItem<S> {
  return {
    kind: "transform",
    name: "approach",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const delta = A.mul(
        A.mul(ctx.flight, w),
        A.add(axialMm, A.mul(ctx.rank01, pitchMm)),
      );
      return {
        v: { ...v, axial: A.add(v.axial, delta) },
        f: { ...f, axial: A.add(f.axial, delta) },
      };
    },
  };
}

// ORBIT: a RIGID REVOLUTION. angle = flight·rad·w, and that one angle turns the
// piece, its frame, its working direction and its normals together.
//
//   about "axis"  (default) — about the optical axis: v.theta and f.theta
//     advance, so the piece sweeps around the barrel carrying its facing.
//   about "frame" — about the PIECE CENTRE (f.radius, f.theta): the piece SPINS
//     IN PLACE. Its frame placement does not move (the centre is the fixed
//     point) but its direction and normals turn with it.
//
// Revolution WITHOUT spin is the composition — `orbit(a)` then
// `orbit(−a, { about: "frame" })` — so there is no carry flag.
//
// The SIGN is the caller's: a recipe that wants the house peel handedness
// multiplies ctx.wrapDir into `rad` at the call site. Baking it in here (as this
// op used to) meant every rotation in the vocabulary silently inherited the wrap
// convention, whether or not it had anything to do with the wrap.
export function orbit<S>(
  rad: Sc<S>,
  opts: { about?: "axis" | "frame" } = {},
): OpItem<S> {
  return {
    kind: "transform",
    name: "orbit",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const a = A.mul(A.mul(ctx.flight, rad), w);
      if (opts.about === "frame") {
        // The radial-plane cartesian round-trip `scale`/`shear` use, with a
        // rotation about the centre in place of their scale/shove.
        const cx = A.mul(f.radius, A.cos(f.theta));
        const cz = A.mul(f.radius, A.sin(f.theta));
        const dx = A.sub(A.mul(v.radius, A.cos(v.theta)), cx);
        const dz = A.sub(A.mul(v.radius, A.sin(v.theta)), cz);
        const ca = A.cos(a);
        const sa = A.sin(a);
        const nx = A.add(cx, A.sub(A.mul(dx, ca), A.mul(dz, sa)));
        const nz = A.add(cz, A.add(A.mul(dx, sa), A.mul(dz, ca)));
        return {
          v: {
            ...v,
            theta: A.atan2(nz, nx),
            radius: A.sqrt(A.add(A.mul(nx, nx), A.mul(nz, nz))),
            rot: A.add(v.rot, a),
          },
          f: { ...f, orient: A.add(f.orient, a) },
        };
      }
      return {
        v: { ...v, theta: A.add(v.theta, a), rot: A.add(v.rot, a) },
        f: { ...f, theta: A.add(f.theta, a), orient: A.add(f.orient, a) },
      };
    },
  };
}

// SWIRL: the fly-in VORTEX orbit reads as — a rigid rotation per piece, but with
// the couplings that make a set of pieces read as a swirl rather than a turning
// assembly:
//
//   • `rankScale` — the angle scales with (rank01 + ½), so angular velocity
//     varies with radius. That is what a vortex IS, and it is the single
//     biggest contributor to the read.
//   • `exp` — flight^exp, the whip ease (the classic's pow(t, 0.65)).
//   • ctx.wrapDir — applied AFTER the wrap, so an unrolled sheet sweeps the
//     barrel in the peel's own handedness.
//
// It is not a different motion from `orbit`, it is orbit plus a set of gate
// couplings; they are separate ops because the couplings are the whole
// difference between "the assembly turns" and "the parts swirl in", and burying
// them in flags on one op is what hid that for as long as it did.
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
      return {
        v: { ...v, theta: A.add(v.theta, a), rot: A.add(v.rot, a) },
        f: { ...f, theta: A.add(f.theta, a), orient: A.add(f.orient, a) },
      };
    },
  };
}

// SPREAD: rigid translation of the whole piece outward along a meridian (the
// classic uSeparate) — a cartesian add of a per-piece vector, so shape and normal
// are preserved (no rot). Direction: THE WORKING DIRECTION, `f.orient` — seeded
// to the sector centre t0, so an unaimed spread is the classic one, and re-aimed
// by `rot()` (the seam throw is `rot(halfSpan); spread(...)`). The frame runs the
// identical cartesian-add on (f.radius, f.theta).
//
// AXISYMMETRIC PIECES (ctx.axi = 1) have NO meridian: `t0` is the pinned 0, so
// sliding a whole ring along it would drag it off-axis in an arbitrary direction
// that changes with a re-export. The direction falls back PER VERTEX to the
// vertex's own meridian — dir = mix(dirPiece, v.theta, axi) — which is the
// classic explode's radial-dilation semantics for bodies of revolution: the ring
// dilates in place (radius += D, theta unchanged) instead of sliding +X. A
// dilation has no net translation, so the FRAME does not move: its displacement
// carries the (1 − axi) factor. A re-aimed spread rides the same fallback (an
// aimed meridian is still a meridian).
export function spread<S>(frac: Sc<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "spread",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const D = A.mul(A.mul(A.mul(ctx.flight, frac), ctx.R), w);
      const dirPiece = f.orient;
      const move = (
        theta: S,
        radius: S,
        dir: S,
        mag: S,
      ): { theta: S; radius: S } => {
        const px = A.add(A.mul(radius, A.cos(theta)), A.mul(mag, A.cos(dir)));
        const pz = A.add(A.mul(radius, A.sin(theta)), A.mul(mag, A.sin(dir)));
        return {
          theta: A.atan2(pz, px),
          radius: A.sqrt(A.add(A.mul(px, px), A.mul(pz, pz))),
        };
      };
      // axi is a 0/1 flag, so the mix is a select, not an angle interpolation.
      const mv = move(v.theta, v.radius, A.mix(dirPiece, v.theta, ctx.axi), D);
      const mf = move(
        f.theta,
        f.radius,
        dirPiece,
        A.mul(D, A.sub(1, ctx.axi)), // a dilation moves no centre
      );
      return {
        v: { ...v, theta: mv.theta, radius: mv.radius },
        f: { ...f, theta: mf.theta, radius: mf.radius },
      };
    },
  };
}

// LADDER: axial displacement by a per-piece signed rung (model-mm) × gain. `rung`
// is ctx.rung when rungOf === "attr" (the shader supplies it per piece), else the
// literal value passed (tests). A translation, so no rot; the frame rides along.
export function ladder<S>(rungOf: "attr" | Sc<S>, gain: Sc<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "ladder",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const rung = rungOf === "attr" ? ctx.rung : rungOf;
      const delta = A.mul(A.mul(A.mul(rung, gain), ctx.flight), w);
      return {
        v: { ...v, axial: A.add(v.axial, delta) },
        f: { ...f, axial: A.add(f.axial, delta) },
      };
    },
  };
}

// SCALE: an affine dilation about the piece frame centre. Express the vertex
// relative to the frame centre (radial-plane cartesian + axial offset), scale all
// three components by mix(1, factor, flight·w), then rebuild the cylindrical
// coords. The frame is unchanged (its centre is the fixed point). rot is left
// unchanged: a uniform scale preserves normal directions exactly; the general
// (nonuniform) case only approximates them — acceptable here.
export function scale<S>(factor: Sc<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "scale",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const s = A.mix(1, factor, A.mul(ctx.flight, w));
      const cx = A.mul(f.radius, A.cos(f.theta));
      const cz = A.mul(f.radius, A.sin(f.theta));
      const vx = A.mul(v.radius, A.cos(v.theta));
      const vz = A.mul(v.radius, A.sin(v.theta));
      const nx = A.add(cx, A.mul(A.sub(vx, cx), s));
      const nz = A.add(cz, A.mul(A.sub(vz, cz), s));
      const na = A.add(f.axial, A.mul(A.sub(v.axial, f.axial), s));
      return {
        v: {
          ...v,
          theta: A.atan2(nz, nx),
          radius: A.sqrt(A.add(A.mul(nx, nx), A.mul(nz, nz))),
          axial: na,
        },
        f,
      };
    },
  };
}

// SHEAR: a tangential (theta-direction) shear whose magnitude grows with the
// vertex's axial offset from the frame — displacement = amt·flight·w·(axial −
// f.axial), added as a cartesian vector perpendicular to the vertex's meridian at
// its radius. The frame and rot are unchanged.
export function shear<S>(amt: Sc<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "shear",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const tang = A.mul(
        A.mul(A.mul(amt, ctx.flight), w),
        A.sub(v.axial, f.axial),
      );
      const vx = A.sub(
        A.mul(v.radius, A.cos(v.theta)),
        A.mul(tang, A.sin(v.theta)),
      );
      const vz = A.add(
        A.mul(v.radius, A.sin(v.theta)),
        A.mul(tang, A.cos(v.theta)),
      );
      return {
        v: {
          ...v,
          theta: A.atan2(vz, vx),
          radius: A.sqrt(A.add(A.mul(vx, vx), A.mul(vz, vz))),
        },
        f,
      };
    },
  };
}

// ── Modifiers ─────────────────────────────────────────────────────────────────
// The modifier op family: shape changes — the developable bend CHAIN
// (`anchor` + `arc`, which between them subsume wrap / rollOut / fold), plus
// coil / twist / stickPress. A modifier advances ONLY the vertex state and never
// the piece frame, so a spatial selector placed after one reads a stale frame
// (validatePipeline warns).
//
// THE MODIFIER WEIGHT LAW. A modifier does not scale its displacement by the
// active weight `w` — the weight is folded into the GATE reads, right after the
// gate:
//
//     flightEff = flight · w        stickEff = mix(1, stick, w)
//
// (flight = 0, stick = 1) is the identity pair every formation law is built
// around, so w = 0 gives the EXACT seated state — the selection contract: a
// masked-out piece stays seated. w = 1 leaves the gate untouched (flight·1 and
// mix(1, stick, 1) are both exact). Amplitude blending (`mix(seated, bent, w)`)
// or scaling κ by w would instead take a shape OFF the developable surface.
//
// `walk` applies the fold, so a modifier simply reads `ctx.flight` /
// `ctx.stick` and is already living under the law — as does any `Live` argument
// a recipe hands it, since those are called with the same effective ctx.

function effCtx<S>(ctx: OpCtx<S>, w: S): OpCtx<S> {
  const A = ctx.A;
  return {
    ...ctx,
    flight: A.mul(ctx.flight, w),
    stick: A.mix(1, ctx.stick, w),
  };
}

// sin(x)/x with the removable singularity guarded: sinc is EVEN, so evaluate at
// max(|x|, ε). For |x| < ε the substitution errs by < ε²/6 ≈ 2e-11 of the chord
// — invisible at the instrument's 0.01mm quantum — and s = 0 still gives chord
// = 0 exactly (0 · finite).
function sinc<S>(A: Algebra<S>, x: S): S {
  const ax = A.max(A.abs(x), 1e-5);
  return A.div(A.sin(ax), ax);
}

// ── The bend CHAIN ────────────────────────────────────────────────────────────
// `anchor` + `arc`: the developable bend, as a piecewise-constant curvature
// profile a recipe SPELLS IN THE PIPELINE — one op per segment — rather than
// hands over as a data structure. Two things make that exact rather than merely
// equivalent:
//
//  • THE CURSOR IS REMAINING MATERIAL. `anchor` seeds `v.rem = ctx.d` (unclamped
//    — a real wedge overruns its nominal half-span, and negative overrun walks
//    the first arc BACKWARDS past the anchor); each arc consumes
//    `s = min(rem, len)` and leaves `rem − s`. Written that way, a profile
//    walker's three special cases — "floor at 0 after the first segment", "the
//    last segment is unbounded", "the first segment is unfloored" — all
//    DISSOLVE: rem is negative only on the first arc and can never go below 0
//    afterwards, and an arc with no `len` simply takes what is left.
//
//  • THE OFF-INVARIANT. The vertex state carries the OFFSET point, not the chain
//    point: v = chain + off·n̂(aim). So each arc strips `off` along the incoming
//    aim, walks the chain, and re-adds it along the outgoing one — which is what
//    lets an arbitrary number of arcs chain through a state that has nowhere to
//    put a separate chain position.
//
// The chain angle IS `v.aim` (that is the interlock with the direction class):
// `anchor` starts the chain on whatever direction is in force — so `rot()`
// before it is how a chain is placed, which is the whole reason there is no
// anchor-angle argument — and each arc turns the aim by −ψ and carries the same
// −ψ onto the normal accumulator. The winding is the house one (the seam at
// φ = +halfSpan, walking along −t̂), so there is no `from` either.
//
// A breathing barrel and a counter-rotating seam are ANCHOR motion (both are
// arguments that read the gate); a travelling contact front is a moving arc
// BOUNDARY instead — its centre falls out of the chain rather than being placed.

/** ANCHOR: start a bend chain HERE — on the current working direction, at
 *  `radius` (default the seated R) — and load the cursor with this vertex's
 *  material. REPLACES theta/radius (it is the chain's origin, not a
 *  displacement) and starts the rotation accumulator at `aim − θ_seated`. */
export function anchor<S>(radius?: Live<S>): OpItem<S> {
  return {
    kind: "modifier",
    name: "anchor",
    run: (v, ctx) => {
      const A = ctx.A;
      const n = v.aim;
      const anchorR: Sc<S> = radius === undefined ? ctx.R : liveOf(radius, ctx);
      const px = A.mul(anchorR, A.cos(n));
      const pz = A.mul(anchorR, A.sin(n));
      const pxo = A.add(px, A.mul(ctx.off, A.cos(n)));
      const pzo = A.add(pz, A.mul(ctx.off, A.sin(n)));
      return {
        ...v,
        theta: A.atan2(pzo, pxo),
        radius: A.sqrt(A.add(A.mul(pxo, pxo), A.mul(pzo, pzo))),
        rot: A.sub(n, A.add(ctx.t0, ctx.phi)),
        // UNCLAMPED on purpose — see the cursor law above.
        rem: ctx.d,
      };
    },
  };
}

/** ARC: consume `len` material-mm off the chain cursor (omit `len` and it takes
 *  the whole remainder — the unbounded last segment) at constant curvature
 *  `q` = R·κ, dimensionless: 1 is the seated barrel, 0 a straight run, > 1 a
 *  tighter fold, < 0 an outward roll. q is only ever multiplied, so a zero-length
 *  or q = 0 arc costs nothing but the nodes.
 *
 *  Constant κ integrates in closed form — the tangent angle turns by ψ = q·s/R
 *  and the position advances by the exact chord `s·sinc(ψ/2)` about the MID
 *  angle — so this is a chord chain, never a numeric integration. Boundaries
 *  ANIMATE by making `len` a function of the gate: a travelling contact front is
 *  a moving boundary.
 *
 *  A LEADING arc (the one that takes the negative overrun) should carry the
 *  seated q = 1 unless a tangent-line extension is what you want: with q ≠ 1 an
 *  overrun vertex at |s| leaves the seated barrel by ≈ (1 − q)·s²/2R in position
 *  and ≈ (1 − q)·s/R on the normal — FIRST order in the curvature deficit, not a
 *  cubic that quietly vanishes.
 *
 *  `participation` (default 1) is the ONE non-arc generalization, and it exists
 *  because the calibrated wrap needs it: the fraction of this arc's material
 *  that BENDS — the rest SLIPS straight along the vertex's own EXIT tangent.
 *  That is the wrap's curl-ramp law (the unconsumed roll trailing as a flat
 *  tail), a per-vertex material redistribution no pure κ(d) reproduces
 *  (measured: 7.5mm peak divergence without it). It is an AUTHORED field and is
 *  NOT scaled by the selection weight.
 *
 *  IDENTITY: at flight = 0 / stick = 1 every house chain reduces to q ≡ 1 off
 *  the seated anchor, and each chord is then an exact chord of the seated circle
 *  — the chain never leaves the barrel, the aim is the seated normal and rot is
 *  0. With the modifier weight law, w = 0 gives that same seated state. */
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
      const bent = A.mul(s, c);
      const psi = A.div(A.mul(liveOf(q, ctx), bent), ctx.R);
      const half = A.mul(psi, 0.5);
      const chord = A.mul(bent, sinc(A, half));
      const n0 = v.aim;
      const nMid = A.sub(n0, half);
      const n1 = A.sub(n0, psi); // this vertex's exit tangent angle
      const slip = A.sub(s, bent); // the unbent remainder, along the exit tangent
      // Off the offset point, along the chain, back onto the offset point.
      const px = A.sub(
        A.mul(v.radius, A.cos(v.theta)),
        A.mul(ctx.off, A.cos(n0)),
      );
      const pz = A.sub(
        A.mul(v.radius, A.sin(v.theta)),
        A.mul(ctx.off, A.sin(n0)),
      );
      const wx = A.add(
        px,
        A.add(A.mul(chord, A.sin(nMid)), A.mul(slip, A.sin(n1))),
      );
      const wz = A.sub(
        pz,
        A.add(A.mul(chord, A.cos(nMid)), A.mul(slip, A.cos(n1))),
      );
      const ox = A.add(wx, A.mul(ctx.off, A.cos(n1)));
      const oz = A.add(wz, A.mul(ctx.off, A.sin(n1)));
      return {
        ...v,
        theta: A.atan2(oz, ox),
        radius: A.sqrt(A.add(A.mul(ox, ox), A.mul(oz, oz))),
        rot: A.sub(v.rot, psi),
        aim: n1,
        rem: A.sub(v.rem, s),
      };
    },
  };
}

// COIL: map the seated radius R toward R·factor at CONSTANT arc length — the
// wedge-local angle opens ∝ 1/factor; the wall offset rides along untouched.
// factor = 1 at flight = 0 ⇒ exact identity. rot += the opening angle. Reads the
// SEATED phi (ctx), not v.theta: earlier ops have already moved the latter.
export function coil<S>(factor: Sc<S>): OpItem<S> {
  return {
    kind: "modifier",
    name: "coil",
    run: (v, ctx) => {
      const A = ctx.A;
      const coilF = A.mix(1, factor, ctx.flight);
      const open = A.sub(A.div(ctx.phi, coilF), ctx.phi);
      return {
        ...v,
        theta: A.add(v.theta, open),
        radius: A.add(v.radius, A.mul(ctx.R, A.sub(coilF, 1))),
        axial: v.axial,
        rot: A.add(v.rot, open),
      };
    },
  };
}

// TWIST: torsion — rotation about the optical axis whose angle grows with axial
// height (rad × yN), leaning a straight panel into a helix. Rotation about the
// axis carries the normal ⇒ rot += the same angle.
export function twist<S>(rad: Sc<S>): OpItem<S> {
  return {
    kind: "modifier",
    name: "twist",
    run: (v, ctx) => {
      const A = ctx.A;
      const ang = A.mul(A.mul(ctx.flight, rad), ctx.yN);
      return { ...v, theta: A.add(v.theta, ang), rot: A.add(v.rot, ang) };
    },
  };
}

// STICK PRESS: tape-down seating (the gate's phase 2). The panel hovers `hover`
// above its seat; an S-bend front sweeps ALONG THE AXIS from the contact end (u
// from yN, signed by `from`) and presses it flush — radius += hover·S(0,
// blendFrac, u − f + blendFrac), front f = stick·(1 + blendFrac). At stick = 0
// the hover is full everywhere; at stick = 1 the smoothstep is 0 EXACTLY ⇒
// identity at channel = 0. Does not touch rot: the S-ramp tilts normals about
// the local TANGENT axis and the hover gap is millimetres, so the shading error
// in the narrow ramp is negligible. `blendFrac` must be > 0 (it is the
// smoothstep's width).
export function stickPress<S>(
  hover: Sc<S>,
  blendFrac: number,
  from: number,
): OpItem<S> {
  return {
    kind: "modifier",
    name: "stickPress",
    run: (v, ctx) => {
      const A = ctx.A;
      const u = A.sub(0.5, A.mul(ctx.yN, from)); // 0 at the contact end .. 1 far end
      const f = A.mul(ctx.stick, 1 + blendFrac); // front sweeps past the far end
      const hoverAmt = A.mul(
        hover,
        A.smoothstep(0, blendFrac, A.add(A.sub(u, f), blendFrac)),
      );
      return { ...v, radius: A.add(v.radius, hoverAmt) };
    },
  };
}
