// The op pipeline — the vertex/frame state a recipe threads, the `OpItem` union
// every op is expressed as, and `runPipeline`, which walks the items in order.
// Written against the scalar algebra, so a recipe runs identically on NUM and
// in the shader ops/emit generates from it. The three op families follow it.
//
// THE SELECTION MODEL: an "active weight" accumulates as the pipeline runs,
// starting at 1. A selector MULTIPLIES its 0..1 factor into it, masking every
// op after it in the current scope; `group([...])` restores the entering weight
// on exit, so a selector cannot leak past its group.
//
// THE SCOPING LAW: a group scopes WEIGHT and PROGRESS — the two things that
// live in the CTX; `during(progress, items)` also narrows the CHANNEL its
// subtree's gate reads. Everything else THREADS, crossing a group boundary in
// both directions.
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
// A transform runs the identical rigid motion on the piece frame, so spatial
// selectors downstream track the piece; a modifier leaves the frame where it
// was, so a spatial selector after one reads a STALE frame (validatePipeline
// warns).

import type { Algebra, Sc } from "./algebra";

/** THE POSITION STATE IS CARTESIAN in the radial plane: `x`/`z` are the point
 *  itself, `axial` is the optical axis (+Y). Cylindrical is the SEATED barrel's
 *  coordinate system, not the moving piece's — every op that displaces a piece
 *  adds a vector, so carrying (θ, r) made each one convert out and back, and
 *  the pole and the ±π branch cut had to be guarded on the way. Angle and
 *  radius are DERIVED where an op genuinely wants them (`thetaOf`/`radiusOf`);
 *  nothing carries a second copy of the position. */
export interface VertexState<S> {
  x: S;
  z: S;
  axial: S;
  rot: S;
  /** THE WORKING DIRECTION: an ABSOLUTE angle in the radial plane, seeded to
   *  ctx.t0. n̂ = (cos aim, sin aim) is "out", t̂ = (sin aim, −cos aim) is
   *  "along"; axial is always +Y. Every op that needs "which way" reads it
   *  here or off the frame's copy, never re-deriving it from ctx.t0. */
  aim: S;
  /** Unspent material on the current bend chain, model-mm. */
  rem: S;
}

// The per-piece frame a recipe advances. Spatial selectors read it; a modifier
// leaves it untouched (that is the whole point of the transform/modifier split).
export interface PieceFrame<S> {
  x: S;
  z: S;
  axial: S;
  /** The PIECE's working direction — absolute, seeded to ctx.t0, and the
   *  counterpart of `VertexState.aim`: a chain advances the VERTEX's aim per
   *  vertex while the piece's stays put, as the two points diverge. */
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

/** Meridian angle. Only for the ops that genuinely want an ANGLE — a motion op
 *  works on the vector and never comes through here. */
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
 *  host's normal rotation uses. Takes the cos/sin PAIR, not the angle: a
 *  transform turns its vertex and its frame through the same one. */
function turn<S>(A: Algebra<S>, p: Radial<S>, c: S, s: S): Radial<S> {
  return {
    x: A.sub(A.mul(p.x, c), A.mul(p.z, s)),
    z: A.add(A.mul(p.x, s), A.mul(p.z, c)),
  };
}

/** Slide `p` out along its own meridian by `d`. A DISPLACEMENT rather than a
 *  rescale, so d = 0 returns the very components it was given — the exact
 *  identity the idle end of every radial op rests on. */
function pushOut<S>(A: Algebra<S>, p: Radial<S>, d: S): Radial<S> {
  const u = outward(A, p);
  return { x: A.add(p.x, A.mul(u.x, d)), z: A.add(p.z, A.mul(u.z, d)) };
}

// The immutable per-piece context every op sees. `A` is the backend; the rest
// are seated constants and material coordinates. `d`/`L` follow the HOUSE
// winding convention (seam at φ = +halfSpan, d = R·(halfSpan − phi)); `d` is
// what `anchor` loads the chain cursor with.
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
  /** 0/1 axisymmetry flag (ops/frames.ts `axi`): ANY op whose direction is "the
   *  piece's own meridian" is meaningless on it, so ops that read it fall back
   *  to a per-VERTEX law (see `spread`). */
  axi: S;
  /** Pieces in this piece's own rank LAYER (ops/frames.ts `layerN`).
   *  INFORMATIONAL — no recipe hangs a decision on it. */
  layerN: S;
  /** 0/1 flag (ops/frames.ts `adopted`): this piece's frame came from a host
   *  shell wedge, so whatever the host does, this piece does. */
  adopted: S;
  /** This recipe's RAW 0..1 channel for this piece, PRE-gate. A `during` scope
   *  narrows it, and nesting composes as function composition. */
  channel: S;
  /** Re-run THIS recipe's gate at a remapped channel — same GateSpec, same
   *  rank01/layerPhase. The ONE way a scope gets a (flight, stick) pair, and
   *  why ops.ts needs no import from gate.ts: the host captures the recipe's
   *  spec once and passes this closure. */
  gateAt(channel: Sc<S>): { flight: S; stick: S };
  flight: S;
  stick: S;
  wrapDir: number;
}

/** A value an op reads when it RUNS: a constant or a function of the effective
 *  ctx. The function form hands an op a per-piece quantity without making
 *  `build` itself ctx-dependent. */
export type Live<S> = Sc<S> | ((ctx: OpCtx<S>) => Sc<S>);

function liveOf<S>(x: Live<S>, ctx: OpCtx<S>): Sc<S> {
  return typeof x === "function" ? (x as (c: OpCtx<S>) => Sc<S>)(ctx) : x;
}

// An op is one of five kinds: a transform returns new vertex state AND frame, a
// modifier only vertex state, an orient op only the new working direction, a
// selector a 0..1 weight from the frame (spatial) or ctx (intrinsic), and a
// group scopes a sub-pipeline.
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
      /** The NEW working direction, absolute. Returning ONLY an angle is what
       *  makes the class structurally unable to move geometry or turn a normal.
       *
       *  THE WEIGHT LAW: an orient op is NOT scaled by the active weight — a
       *  re-aim that faded with `w` would drift a chain's anchor off the seam
       *  at w = 0 and break the masked-piece identity. */
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
 *  power: m(c) = clamp((c − from)/(to − from), 0, 1)^ease. Every field is a
 *  per-PIECE constant; a per-VERTEX bound would give one piece two progresses
 *  and tear it apart.
 *
 *  THE INVARIANTS (`validatePipeline` warns on illegal literals; nothing
 *  enforces them at runtime):
 *    1. from ≥ 0, so m(0) = 0 EXACTLY — a remap reading ~1 just above the idle
 *       gate pops the model off its seat.
 *    2. to > from, or the ramp divides 0/0 and the NaN survives the idle gate.
 *    3. ease > 0: pow(0, 0) = 1, and x = 0 with e ≤ 0 is undefined in GLSL.
 *    4. to ≤ 1 is advisory: past 1 the scope simply never finishes.
 *
 *  Reversal and ping-pong are deliberately NOT representable: non-monotone time
 *  art belongs at the DRIVER tier, where each channel is separately gated. */
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
 *  fully played for channel ≥ to, stagger and split replayed inside. It acts
 *  PRE-gate, which is what lets both ends land exactly; post-gate remapping
 *  cannot, and remapping the pair jointly IS the weight fold, which can never
 *  express "held complete after". `during({}, items)` is `group(items)`. */
export function during<S>(p: Progress<S>, items: OpItem<S>[]): OpItem<S> {
  return { kind: "group", items, progress: p };
}

/** The PHASED ctx a `during` scope runs under: the channel through the clamped
 *  ramp and the optional power, and THIS recipe's gate re-run at it. */
function progressCtx<S>(ctx: OpCtx<S>, p: Progress<S>): OpCtx<S> {
  const A = ctx.A;
  const ramp = p.from !== undefined || p.to !== undefined;
  // An empty Progress hands back the very ctx it was given, which is what makes
  // `during({}, …)` and `group(…)` the same GRAPH, not merely the same numbers.
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

// Walk one scope. `weight` is local to this call, so a group's selectors cannot
// mutate the caller's — the weight is restored on exit naturally. The
// vertex/frame state threads through every op via the shared `state` object.
//
// A TRANSFORM takes the weight as an argument and scales its displacement by
// it. A MODIFIER never sees it: walk folds it into the gate pair (`effCtx`) and
// hands over the EFFECTIVE ctx, once per distinct weight per scope.
//
// THE FORCED ORDER, weight against progress:
//
//   channel ──during (pre-gate, per scope)──▶ p' ──gate──▶ (flight, stick)
//   ──the weight fold (post-gate, the scope's w)──▶ (flight·w, mix(1, stick, w))
//
// Progress narrows WHEN, weight scales HOW MUCH. The order is forced: `w` can
// be per-VERTEX, so folding it pre-gate would put the gate on a per-vertex path
// and vary the stagger WITHIN a piece.
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
  // `ctx` is fixed for this call, so Progress identity is the whole key.
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
        // vertex's own. A re-aim after a chain op re-bases the vertex onto the
        // piece's direction, which keeps `orient` uniform across a piece and
        // therefore rigid-safe for `spread`.
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
// `validatePipeline` warns (never throws) once per recipe on three things:
//
//  • a spatial selector after a modifier — the modifier advanced the vertex
//    state but NOT the frame, so the selector reads a stale one. The "modifier
//    seen" flag crosses a group boundary in BOTH directions, `during` included.
//  • the `Progress` invariants, on LITERAL-number fields only: a knob-bound
//    field is a uniform this pass cannot read, and its bound belongs in
//    host.ts's KNOB_LIMITS instead.
//  • a DANGLING chain segment (`arc`/`crease` with no `anchor` before it) —
//    silent nonsense rather than a crash, since the cursor is still the seeded
//    rem = 0 and the segment consumes nothing.

const warnedRecipes = new Set<string>();

interface ScopeState {
  modifierSeen: boolean;
  modifierName: string | undefined;
  anchored: boolean;
}

/** The chain ops that spend cursor material, so all of them need an `anchor`
 *  before them to have any to spend. */
const CHAIN_SEGMENTS = new Set(["arc", "crease", "straight"]);

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
// read ctx intrinsics. Each carries its EXACT-1 bypass so a default-open
// selector cannot perturb a calibrated recipe.

// Default edge feathers. A feather of 0 would make smoothstep divide by zero
// exactly on the edge, so keep them > 0.
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
// cos is monotone only over [0, π], so both caps are load-bearing: capping the
// outer angle at π keeps the two ramp edges ORDERED (uncapped, a wide band
// INVERTS the mask), and capping the width at SECTOR_OPEN keeps them DISTINCT
// at the TAU default, where cos(π) = cos(π) would divide 0 by 0.
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
  /** the peel's KEEP-set (core/parts isPeelKeep) — the mechanism the cards
   *  scene reveals in place. A class only so a recipe can scope itself off it. */
  kept: 5,
} as const;

// ── Orientation ───────────────────────────────────────────────────────────────
// THE DIRECTION CLASS. One op, and everything it can do is re-aim: it writes
// the working direction downstream ops move ALONG, and touches nothing else.
// As STATE, the direction is one angle a recipe turns as often as it likes, in
// the order it says — `spread(...)` after `rot(halfSpan)` is a seam throw.
//
// SCOPING: the direction threads FORWARD out of a `group` like every other
// piece of state. The inverse is one explicit `rot(−a)`.

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
// The rigid motions (approach / orbit / swirl / spread / tilt) plus the affine
// trio (ladder / scale / shear). A transform advances BOTH the vertex state AND
// the piece frame — the frame runs the identical rigid motion, so spatial
// selectors downstream track the piece. Every displacement is folded by
// ctx.flight AND the active weight `w`, so a transform is identity at
// flight = 0 or w = 0. Rotational carry (v.rot) advances ONLY for orbit and
// swirl; translations do not turn a normal, and `tilt` is a rotation
// deliberately outside the carve-out (see its own header).

// APPROACH: axial slide (axialMm) + a per-rank pitch spread (pitchMm·rank01). A
// pure translation, so the normal is untouched and the frame's axial advances
// by the identical delta.
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
//   about "axis"  (default) — about the optical axis: the piece sweeps around
//     the barrel carrying its facing.
//   about "frame" — about the PIECE CENTRE: the piece SPINS IN PLACE, its
//     frame placement fixed but its direction and normals turning with it.
//
// Revolution WITHOUT spin is the composition of the two, so there is no carry
// flag. The SIGN is the caller's: a recipe wanting the house peel handedness
// multiplies ctx.wrapDir into `rad` at the call site, so a rotation with
// nothing to do with the wrap does not inherit its convention.
export function orbit<S>(
  rad: Live<S>,
  opts: { about?: "axis" | "frame" } = {},
): OpItem<S> {
  return {
    kind: "transform",
    name: "orbit",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      // LIVE, so an angle may read the ctx the walk hands it — a `during`
      // scope's own flight rather than the one it was built under.
      const a = A.mul(A.mul(ctx.flight, liveOf(rad, ctx)), w);
      const ca = A.cos(a);
      const sa = A.sin(a);
      if (opts.about === "frame") {
        const d = turn(A, { x: A.sub(v.x, f.x), z: A.sub(v.z, f.z) }, ca, sa);
        return {
          v: {
            ...v,
            x: A.add(f.x, d.x),
            z: A.add(f.z, d.z),
            rot: A.add(v.rot, a),
          },
          f: { ...f, orient: A.add(f.orient, a) },
        };
      }
      return {
        v: { ...v, ...turn(A, v, ca, sa), rot: A.add(v.rot, a) },
        f: { ...f, ...turn(A, f, ca, sa), orient: A.add(f.orient, a) },
      };
    },
  };
}

// SWIRL: `orbit` plus the couplings that make a set of pieces read as a vortex
// rather than a turning assembly — kept a separate op because those couplings
// ARE the difference:
//
//   • `rankScale` — the angle scales with (rank01 + ½), so angular velocity
//     varies with radius. That is what a vortex IS.
//   • `exp` — flight^exp, the whip ease.
//   • ctx.wrapDir — applied AFTER the wrap, so an unrolled sheet sweeps the
//     barrel in the peel's own handedness.
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
//
// AXISYMMETRIC PIECES (ctx.axi = 1) have NO meridian: `t0` is a pinned 0, so
// sliding a whole ring along it drags it off-axis in a direction that changes
// with a re-export. The direction falls back PER VERTEX to the vertex's own
// meridian, so the ring DILATES in place — and a dilation has no net
// translation, so the FRAME's displacement carries the (1 − axi) factor.
export function spread<S>(frac: Live<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "spread",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const D = A.mul(A.mul(A.mul(ctx.flight, liveOf(frac, ctx)), ctx.R), w);
      // The piece's own meridian, and — for an axisymmetric piece, which has no
      // meridian — the VERTEX's own. axi is a 0/1 flag, so the mix selects a
      // direction rather than interpolating two.
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

// RISE: a rigid translation along the optical axis, scaled by `flight` like
// every other transform here. Axial like the ladder, so it stays invariant
// under rotation about the bore.
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

// TILT: the HINGE — a piece falling open about a horizontal axis at its base.
// The (radius, axial) pair turns about the hinge point (frame radius, pivot)
// in each vertex's own MERIDIAN half-plane; the meridian itself is untouched.
// Every meridian shares the rotation, so the hinge is really the tangent CIRCLE
// at that radius/station — which is what carries a wedge's curvature through
// the tilt instead of flattening it.
//
// `pivot` is the hinge's AXIAL station (model-mm, default the piece frame's own
// centre). Positive `rad` tips the +Y side of the pivot OUTWARD. The frame
// rides the identical rotation; the frame's meridian and the working direction
// stay put.
//
// v.rot does NOT advance, deliberately: rot is a rotation about the OPTICAL
// axis (host law 4) and a tilt turns normals about the local TANGENT axis,
// which one in-plane angle cannot express. Silhouettes exact, shading seated.
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

// SCALE: an affine dilation about the piece frame centre — the vertex taken
// relative to that centre and scaled by mix(1, factor, flight·w), all three
// components alike. The frame is unchanged (its centre is the fixed point).
// rot is left alone: a uniform scale preserves normal directions exactly, and
// the nonuniform case only approximates them.
export function scale<S>(factor: Sc<S>): OpItem<S> {
  return {
    kind: "transform",
    name: "scale",
    run: (v, f, w, ctx) => {
      const A = ctx.A;
      const s = A.mix(1, factor, A.mul(ctx.flight, w));
      const about = (c: S, p: S): S => A.add(c, A.mul(A.sub(p, c), s));
      return {
        v: {
          ...v,
          x: about(f.x, v.x),
          z: about(f.z, v.z),
          axial: about(f.axial, v.axial),
        },
        f,
      };
    },
  };
}

// SHEAR: a tangential shear whose magnitude grows with the vertex's axial
// offset from the frame, added as a cartesian vector perpendicular to the
// vertex's meridian at its radius. The frame and rot are unchanged.
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
      // …along the tangential unit vector at the vertex's own meridian.
      const u = outward(A, v);
      return {
        v: {
          ...v,
          x: A.sub(v.x, A.mul(tang, u.z)),
          z: A.add(v.z, A.mul(tang, u.x)),
        },
        f,
      };
    },
  };
}

// ── Modifiers ─────────────────────────────────────────────────────────────────
// Shape changes: the developable bend CHAIN (`anchor` + `arc`, which subsume
// wrap / rollOut / fold, plus `crease`), and coil / twist / stickPress. A
// modifier advances ONLY the vertex state and never the piece frame, so a
// spatial selector after one reads a stale frame (validatePipeline warns).
//
// THE MODIFIER WEIGHT LAW. A modifier does not scale its displacement by the
// active weight `w`; the weight is folded into the GATE reads instead:
//
//     flightEff = flight · w        stickEff = mix(1, stick, w)
//
// (flight = 0, stick = 1) is the identity pair every formation law is built
// around, so w = 0 gives the EXACT seated state and w = 1 leaves the gate
// untouched. Amplitude blending or scaling κ by w would instead take a shape
// OFF the developable surface. `walk` applies the fold, so a modifier just
// reads `ctx.flight`/`ctx.stick`, as does any `Live` argument.

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
// profile a recipe SPELLS IN THE PIPELINE, one op per segment. Two invariants:
//
//  • THE CURSOR IS REMAINING MATERIAL. `anchor` seeds `v.rem = ctx.d`,
//    UNCLAMPED — a real wedge overruns its nominal half-span, and negative
//    overrun walks the first arc BACKWARDS past the anchor. Each arc consumes
//    `s = min(rem, len)` and leaves `rem − s`.
//  • THE OFF-INVARIANT. The vertex state carries the OFFSET point, not the
//    chain point: v = chain + off·n̂(aim). Each arc strips `off` along the
//    incoming aim, walks the chain, and re-adds it along the outgoing one.
//
// The chain angle IS `v.aim` — the interlock with the direction class. `anchor`
// starts on whatever direction is in force, so `rot()` before it is how a chain
// is placed and there is no anchor-angle argument. The winding is the house
// one, so there is no `from` either.

/** ANCHOR: start a bend chain HERE — on the current working direction, at
 *  `radius` (default the seated R) — and load the cursor with this vertex's
 *  material. REPLACES the point (it is the chain's origin, not a displacement)
 *  and starts the rotation accumulator at `aim − θ_seated`. */
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
 *  roll. q is only ever multiplied, so a zero-length arc costs only nodes.
 *
 *  Constant κ integrates in closed form — the tangent turns by ψ = q·s/R and
 *  the position advances by the exact chord `s·sinc(ψ/2)` about the MID angle —
 *  so this is a chord chain, never a numeric integration. Making `len` a
 *  function of the gate ANIMATES the boundary: a travelling contact front.
 *
 *  A LEADING arc (the one taking the negative overrun) should carry the seated
 *  q = 1 unless a tangent-line extension is wanted: with q ≠ 1 an overrun
 *  vertex leaves the seated barrel to FIRST order in the curvature deficit.
 *
 *  `participation` (default 1) is the fraction of this arc's material that
 *  BENDS, the rest SLIPPING straight along the vertex's own EXIT tangent. An
 *  AUTHORED field, NOT scaled by the selection weight. */
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
 *  chord walk `arc` and `crease` SHARE, so the two cannot drift apart. */
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
 *  the chain's flat run (omit `len` and it takes the whole remainder).
 *
 *  `arc(0)` says the same thing but pays the chord machinery to do it: ψ = 0
 *  makes the chord `s·sinc(0)`, which the singularity guard evaluates at ε and
 *  returns a hair short of `s`, and the off-invariant strips the wall offset
 *  along the aim only to re-add it along the same aim. With no turn there is
 *  nothing to integrate and nothing to re-seat: the point slides `s` along its
 *  own exit tangent, and rot and aim do not move. */
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

/** CREASE: a HARD FOLD in the bend chain — the origami kink `arc` cannot make.
 *  It consumes `width` material-mm at whatever curvature turns the chain `rad`
 *  MORE than the seated barrel turns over that run: q = 1 + rad·R/width.
 *
 *  THE ANGLE IS RELATIVE TO THE SEAT: `rad` = 0 gives q = 1 EXACTLY, so a
 *  crease whose angle rides the gate is the exact identity at channel 0 like
 *  every other chain op. SIGN: positive folds the SAME way the barrel curves,
 *  negative folds back (a reflex flick). WIDTH is the sharpness knob and MUST
 *  be > 0 — it divides. NORMALS ARE EXACT only for an AXIALLY-UNIFORM crease;
 *  an axially-RAMPED `rad` shades approximately, like `twist`. */
export function crease<S>(rad: Live<S>, width: Live<S>): OpItem<S> {
  return {
    kind: "modifier",
    name: "crease",
    run: (v, ctx) => {
      const A = ctx.A;
      const w = liveOf(width, ctx);
      const s = A.min(v.rem, w);
      // q = 1 + rad·R/width: the seated turn plus the fold. If the cursor runs
      // out mid-crease (s < width) the fold is taken proportionally — the last
      // scrap of material cannot carry a whole fold.
      const q = A.add(1, A.div(A.mul(liveOf(rad, ctx), ctx.R), w));
      return chainStep(v, ctx, s, q, 1);
    },
  };
}

// COIL: map the seated radius R toward R·factor at CONSTANT arc length, so the
// wedge-local angle opens ∝ 1/factor. factor = 1 at flight = 0 ⇒ exact
// identity. Reads the SEATED phi (ctx), not the live meridian, which earlier
// ops moved. LIVE, so a factor that itself reads the gate can vanish at BOTH
// channel ends rather than only at the seated one.
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

// TWIST: torsion — rotation about the optical axis whose angle grows with axial
// height, leaning a straight panel into a helix. Rotation about the axis
// carries the normal, so rot advances by the same angle.
export function twist<S>(rad: Sc<S>): OpItem<S> {
  return {
    kind: "modifier",
    name: "twist",
    run: (v, ctx) => {
      const A = ctx.A;
      const ang = A.mul(A.mul(ctx.flight, rad), ctx.yN);
      return {
        ...v,
        ...turn(A, v, A.cos(ang), A.sin(ang)),
        rot: A.add(v.rot, ang),
      };
    },
  };
}

// STICK PRESS: tape-down seating (the gate's phase 2). The panel hovers `hover`
// above its seat and an S-bend front sweeps ALONG THE AXIS from the contact end
// (u from yN, signed by `from`), pressing it flush. At stick = 1 the smoothstep
// is 0 EXACTLY, so this is the identity at channel = 0. Does not touch rot: the
// S-ramp tilts normals about the local TANGENT axis, which one in-plane angle
// cannot express. `blendFrac` must be > 0 — it is the smoothstep's width.
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
      return { ...v, ...pushOut(A, v, hoverAmt) };
    },
  };
}
