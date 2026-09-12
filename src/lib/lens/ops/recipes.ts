// The motion vocabulary: channel-gated op pipelines over the scalar algebra.
// A recipe is gateSpec(knobs) — the two-phase window, a function of the LIVE
// knobs — plus build(ctx, knobs), the ORDERED op list, plus knobSpec: one row
// per knob, its PHYSICAL default (radians, model-mm, fractions of R) and, for
// a knob that feeds the gate or a divisor, the reachable range the host clamps
// writes to.
// Ops read ctx when they RUN; only `ctx.wrapDir` is read at BUILD time.

import type { Algebra } from "./algebra";
import type { GateSpec } from "./gate";
import {
  anchor,
  approach,
  arc,
  coil,
  crease,
  during,
  group,
  ladder,
  rise,
  orbit,
  rot,
  selFront,
  selRank,
  selSector,
  spread,
  straight,
  swirl,
  tilt,
  type OpCtx,
  type OpItem,
} from "./ops";
import {
  memoCtx,
  peelOrder,
  selNotAccessory,
  selNotOptical,
  selSheet,
  bendTerm,
  selNotKept,
  stickerPeelOps,
} from "./house";

// Written out rather than taken from Math: these end up as shader literals.
const TAU = 6.283185307179586;
const PI = 3.141592653589793;

// ── ASSEMBLE constants ─────────────────────────────────────────────────────
const ASSEMBLE_SNAP_EXP = 2.0;
const ASSEMBLE_FLIGHT_START = 0.1; // per-shell fly-in foot
const ASSEMBLE_ROLL_END = 0.9; // the curl finishes, THEN the sheet breathes
const ASSEMBLE_SWIRL_EXP = 0.65; // the whip ease
const ASSEMBLE_WRAP_SHEAR = 0.9; // diagonal roll front (corner peel)
const ASSEMBLE_MASK_FEATHER = 0.3; // sector-edge softening (rad)
const ASSEMBLE_CURL_MAX = PI; // cap on the end-roll — past a half turn it hides
const ASSEMBLE_PIN_END = 0.25; // the reel-in pin is spent by 25% stuck
// The gate's second stagger: each layer's own pieces, round the bore.
const ASSEMBLE_PART_STAGGER = 0.25;
const ASSEMBLE_LADDER_GAIN = 0.4; // rung → model-mm, scaled by the depth knob

// ── EXPLODE constants ───────────────────────────────────────────────────────
/** The gate's grain: no rank stagger (the `during` slot below is the order),
 *  a little phase spread. The shares sum to 1, so both ends saturate. */
const EXPLODE_LAYER_STAGGER = 0;
const EXPLODE_PART_STAGGER = 0.15;
const EXPLODE_WINDOW = 0.85;
/** Order-key exponent: spreads the outer rank band over about half the order
 *  axis and collapses the core toward 0, so the middle leaves as one group. */
const EXPLODE_ORDER_EXP = 3;
/** Share of the channel the arrival order spans; the remainder is ONE piece's
 *  own flight. */
const EXPLODE_ORDER_SPREAD = 0.86;
/** How far the piece's own meridian winds the order, against the radial run. */
const EXPLODE_WIND = 0.14;
/** The park's rigid terms: the ladder gain (× rung), the cloud's revolution
 *  (rad, in the house winding) and the hover (model-mm). */
export const EXPLODE_AXIAL_GAIN = 0.4;
const EXPLODE_SPIN = 1.35;
export const EXPLODE_HOVER = 100;
/** How much higher the OUTER ranks hang, as a multiple of the hover. */
export const EXPLODE_HOVER_RANK = 0.55;
/** The dispersal's gain, and its two terms it scales: signed radians round
 *  the bore, and a fraction of the piece's radius, always OUTWARD. */
const EXPLODE_SCATTER = 1.35;
const EXPLODE_SCATTER_SWING = 0.6;
const EXPLODE_SCATTER_R = 0.7;
/** The outward scatter's floor, as a share of its own maximum. */
const EXPLODE_SCATTER_MIN = 0.3;
/** The dispersal bump's gain. The ops fold their own `flight` in, so the drawn
 *  amplitude is `gain × flight × (1 − flight)`: 0 at both channel ends,
 *  `gain / 4` at its peak. */
const EXPLODE_DISPERSE = 4;
/** Per-piece phase frequencies on three lane constants: deterministic,
 *  backend-stable, uncorrelated between the two terms. */
const EXPLODE_SWING_FREQ = [2.7, 11, 4.3] as const;
const EXPLODE_RADIAL_FREQ = [4.9, 7, 9.1] as const;
/** Ring phase keyed on `rung`, which ops/frames.ts derives per GROUP, so a
 *  ring turns as a unit. The turn is taken the SHORT way round (wrapPi). */
const explodeRingTurn = <S>(A: Algebra<S>, rung: S, turnsPerMm: S): S => {
  const a = A.mul(A.mul(turnsPerMm, TAU), rung);
  return A.sub(a, A.mul(TAU, A.floor(A.div(A.add(a, PI), TAU))));
};

// The house split. MUST stay below rollEnd + overlap, or the stick ramp's
// denominator is 0 and the seated state computes NaN (ops/gate.ts).
const EXPLODE_SPLIT = 0.95;
const EXPLODE_SNAP_EXP = 2.0;

// ── PEEL gate constants — the flight ramp's shape (inert at snap 0) ─────────
const PEEL_SPLIT = 0.95;
const PEEL_SNAP_EXP = 2.0;
/** the peel's own rank feather — see the peel recipe's selRank comment */
const PEEL_RANK_FEATHER = 0.005;

// q of the freed run, INVERTED (ops/house stickerPeelOps negates it). Above 1
// the lip rolls back tighter than the shell it came off.
export const PEEL_CURL = 2.6;
/** Share of the channel the fan order spans; the rest is one piece's unroll. */
const PEEL_STAGGER = 0.72;
/** The rank band that unrolls: the outermost shells only. */
export const PEEL_RANK_LO = 0.97;
const PEEL_RANK_HI = 1;

// ── ROSE constants — bare gate; the wave is a `during` window on the whorl key
const ROSE_SPLIT = 0.95;
const ROSE_SNAP_EXP = 2.0;
// Whorl-key exponent: petal shells live in the top eighth of rank01, so the
// power spreads that band out and collapses the rest toward 0.
const ROSE_WHORL_EXP = 8;
// Crease band default: model-mm of material each hard fold is taken over. The
// fold's radius is ≈ band/fold-angle, and below a shell's wall thickness the
// inner surface folds past the fold's centre. Zero divides; the range floors it.
const ROSE_CREASE_DEFAULT_MM = 1.2;
// Corner-flick axial ramp: the reflex fold is absent over the petal's seated
// half and full at its free tip. Bounds are on yN + 0.5.
const ROSE_FLICK_FROM = 0.45;
const ROSE_FLICK_TO = 1;

/** Every recipe channel there is — the four authored recipes below. */
export type RecipeName = "assemble" | "explode" | "peel" | "rose";

/** One knob: its physical default and, when it reaches the gate or an
 *  `A.div` denominator, the [min, max] every write is clamped into — a NaN in
 *  a live branch reaches the render. Unlimited knobs feed amplitudes only. */
export interface KnobSpec {
  default: number;
  range?: readonly [number, number];
}

export interface Recipe<S> {
  name: RecipeName;
  /** The gate window for this channel, derived from the LIVE knobs. */
  gateSpec(knobs: Record<string, S>): GateSpec<S>;
  /** The ordered op list. Order is the recipe — permuting it changes the motion. */
  build(ctx: OpCtx<S>, knobs: Record<string, S>): OpItem<S>[];
  /** The knob table; its key order is the uniform lane order (ops/emit/layout). */
  knobSpec: Record<string, KnobSpec>;
  /** `knobSpec`'s defaults as plain numbers — what the numeric callers read. */
  knobDefaults: Record<string, number>;
}

/** A recipe with `knobDefaults` derived from its `knobSpec` rows. */
function recipe<S>(r: Omit<Recipe<S>, "knobDefaults">): Recipe<S> {
  const knobDefaults: Record<string, number> = {};
  for (const k in r.knobSpec) knobDefaults[k] = r.knobSpec[k].default;
  return { ...r, knobDefaults };
}

// Knobs arrive already lifted, so they compose with the algebra directly.
export function makeRecipes<S>(
  A: Algebra<S>,
): Record<Recipe<S>["name"], Recipe<S>> {
  // ── the ASSEMBLE wrap's terms ─────────────────────────────────────────────
  // Breathing barrel, seam re-aim, the diagonal shear front and the end-roll.
  // Read off the EFFECTIVE ctx and MEMOIZED on it, so the six ops that read
  // these terms build one shader subgraph rather than six.
  const wrapTerms = (
    knobs: Record<string, S>,
  ): ((ctx: OpCtx<S>) => {
    seamTurn: S;
    Rb: S;
    qMain: S;
    mainLen: S;
    qRoll: S;
    curlLen: S;
    curlRamp: S;
  }) =>
    memoCtx((ctx) => {
      const breath = A.mul(
        A.mul(A.smoothstep(0.75, 1, ctx.stick), ctx.flight),
        knobs.rewind,
      );
      const Rb = A.mul(
        ctx.R,
        A.add(1, A.mul(breath, A.add(2.4, A.mul(A.sub(ctx.rank01, 0.5), 1.1)))),
      );
      const flatMix = A.mix(knobs.flatten, 1, ctx.stick);
      const rf = A.mul(Rb, flatMix);
      // Alternates per shell (a hash of R), so neighbouring layers peel their
      // opposite corners.
      const shearSign = A.sub(
        A.mul(A.step(0.5, A.fract(A.mul(ctx.R, 5.13))), 2),
        1,
      );
      // The roll cannot consume more material than the sheet HAS: rollLen > L
      // would overrun the chain's material budget.
      const rollLen = A.clamp(
        A.mul(
          A.mul(A.sub(1, ctx.stick), ctx.L),
          A.sub(
            1,
            A.mul(
              A.mul(A.mul(ctx.yN, shearSign), ASSEMBLE_WRAP_SHEAR),
              A.mul(A.mul(ctx.stick, A.sub(1, ctx.stick)), 4),
            ),
          ),
        ),
        0,
        ctx.L,
      );
      const rollR = A.mul(ctx.R, A.mix(0.45, 0.18, knobs.curl));
      const hasRoll = A.step(1e-6, rollLen);
      return {
        // Re-aim off the piece's own meridian: one half-span reaches the seam
        // (φ = +halfSpan), and the breath swings it back as the sheet homes.
        seamTurn: A.add(
          ctx.halfSpan,
          A.mul(A.mul(A.mul(breath, 0.06), ctx.R), ctx.wrapDir),
        ),
        Rb,
        qMain: A.div(ctx.R, rf),
        // With NO roll left the main arc must carry the overrun too, so it is
        // extended past any vertex.
        mainLen: A.add(A.sub(ctx.L, rollLen), A.mul(A.sub(1, hasRoll), 1e5)),
        qRoll: A.neg(A.div(ctx.R, rollR)),
        curlLen: A.mul(A.mul(rollR, ASSEMBLE_CURL_MAX), hasRoll),
        curlRamp: A.smoothstep(0.05, 0.55, ctx.stick),
      };
    });

  const assemble = recipe<S>({
    name: "assemble",
    gateSpec: (knobs) => ({
      layerStagger: knobs.stagger,
      partStagger: ASSEMBLE_PART_STAGGER,
      // DERIVED, so offset + window ≡ 1 for any slider: every piece saturates
      // to win = 1 (flight 0, stick 1) at channel 0.
      windowFrac: A.sub(A.sub(1, knobs.stagger), ASSEMBLE_PART_STAGGER),
      split: knobs.split,
      snap: knobs.snap,
      snapExp: ASSEMBLE_SNAP_EXP,
      overlap: knobs.overlap,
      flightStart: ASSEMBLE_FLIGHT_START,
      rollEnd: ASSEMBLE_ROLL_END,
    }),
    // The whole sheet pipeline sits in ONE group scoped by `selSheet`, with
    // the tier ladder OUTSIDE it, so the ladder moves every piece.
    build: (_ctx, knobs) => {
      const wrap = wrapTerms(knobs);
      return [
        group<S>([
          // Optional sector solo, fully open by default (width ≥ TAU ⇒ 1).
          // INSIDE the group, so a solo cannot strand the rest off its rung.
          selSector<S>(
            knobs.maskCenter,
            knobs.maskWidth,
            ASSEMBLE_MASK_FEATHER,
          ),
          selSheet(A),
          // …and off the KEEP-set while `keepScope` is up.
          selNotKept(A, knobs.keepScope),
          // THE WRAP FIRST: the chain rebuilds the point from the material
          // coordinate, so every transform after it moves the BENT sheet.
          rot<S>((c) => wrap(c).seamTurn),
          anchor<S>((c) => wrap(c).Rb),
          arc<S>(
            (c) => wrap(c).qMain,
            (c) => wrap(c).mainLen,
          ),
          // participation = curlRamp: only that share of the roll's material
          // bends, the rest trails straight off the exit tangent.
          arc<S>(
            (c) => wrap(c).qRoll,
            (c) => wrap(c).curlLen,
            { participation: (c) => wrap(c).curlRamp },
          ),
          straight<S>(),
          // Put the direction back on the piece's own meridian: a re-aim
          // threads FORWARD, and `sep` below slides along the sector centre.
          rot<S>((c) => A.neg(wrap(c).seamTurn)),
          // sep — the slow unpinned slide along the sector centre.
          spread<S>(knobs.sep),
          // REEL-IN: seam-meridian throw plus fly-in swirl, both spent by
          // ASSEMBLE_PIN_END of stick. The scoping selector must stay
          // PER-PIECE; a per-vertex one tears the rigid motions apart.
          group<S>([
            selFront<S>((c) =>
              A.sub(1, A.smoothstep(0, ASSEMBLE_PIN_END, c.stick)),
            ),
            // Aim the throw down the SEAM meridian. The re-aim threads forward
            // out of this group, which nothing after it reads.
            rot<S>((c) => c.halfSpan),
            spread<S>(knobs.spreadThrow),
            swirl<S>(knobs.swirl, {
              exp: ASSEMBLE_SWIRL_EXP,
              rankScale: true,
            }),
          ]),
        ]),
        // Axial depth from the tier ladder, scaled by the Depth knob. Unscoped
        // but for the keep-set, so it covers the whole model.
        group<S>([
          selNotKept(A, knobs.keepScope),
          ladder<S>("attr", A.mul(ASSEMBLE_LADDER_GAIN, knobs.depth)),
        ]),
      ];
    },
    knobSpec: {
      spreadThrow: { default: 1.6 },
      sep: { default: 0.55 },
      swirl: { default: 1.1 },
      // a divisor floor (q = R/rf); the ceiling only keeps a silly write finite
      flatten: { default: 1, range: [0.05, 30] },
      rewind: { default: 0.95 },
      // rollR = R·mix(0.45, 0.18, curl) reaches 0 at curl = 5/3
      curl: { default: 0.85, range: [0, 1] },
      depth: { default: 1 },
      // THE GRAIN: `stagger` orders the LAYERS (rank01, outermost first);
      // the window is what it and ASSEMBLE_PART_STAGGER leave, and must stay
      // ≥ 0.05.
      stagger: { default: 0.5, range: [0, 0.65] },
      // a selector weight: outside [0, 1] it inverts or over-scales the scope
      keepScope: { default: 0, range: [0, 1] },
      // the gate's flight span (split − ASSEMBLE_FLIGHT_START) and stick span
      // (ASSEMBLE_ROLL_END − split + min(overlap, split)) must stay positive
      split: { default: 0.95, range: [0.15, 0.95] },
      overlap: { default: 0.9, range: [0.1, 2] },
      snap: { default: 0, range: [0, 1] },
      maskCenter: { default: 0 },
      maskWidth: { default: TAU },
    },
  });

  const explode = recipe<S>({
    name: "explode",
    // Nothing here reads stick, but the split keeps its denominator positive so
    // the channel-0 identity is exact rather than NaN.
    gateSpec: () => ({
      layerStagger: EXPLODE_LAYER_STAGGER,
      partStagger: EXPLODE_PART_STAGGER,
      windowFrac: EXPLODE_WINDOW,
      split: EXPLODE_SPLIT,
      snap: 0,
      snapExp: EXPLODE_SNAP_EXP,
    }),
    // THE DEFAULT SELECTION: accessories drop out at the head, and the optics
    // ride the axial ladder alone. The parked pose (channel 1) is UNIFORM and
    // RIGID — `bloom`, one `orbit`, `rise` + the ladder — while the dispersal
    // and curl windows are exactly 0 at both the park and the seat. Every term
    // rides the SAME per-piece flight, so the fall is one helix.
    build: (ctx, knobs) => {
      // The order key: radius sets the run and the piece's own meridian winds
      // it, so landings step around the bore going outward. Both terms are
      // per-piece constants, so the key is monotone and needs no wrap.
      const ang01 = A.add(A.div(ctx.t0, TAU), 0.5);
      const key = A.div(
        A.add(A.pow(ctx.rank01, EXPLODE_ORDER_EXP), A.mul(EXPLODE_WIND, ang01)),
        1 + EXPLODE_WIND,
      );
      const from = A.mul(A.sub(1, key), EXPLODE_ORDER_SPREAD);
      // The dispersal's per-piece phases: a smooth function of three lane
      // constants, so the CPU mirror and the shaders agree.
      const phase = (f: readonly [number, number, number]) =>
        A.sin(
          A.add(
            A.add(A.mul(ctx.t0, f[0]), A.mul(ctx.layerPhase, f[1])),
            A.mul(ctx.rank01, f[2]),
          ),
        );
      // The flight window the two per-piece terms ride: the ops fold `flight`
      // in, so `1 − flight` is a bump, exactly 0 at the park and at the seat.
      // LIVE, so a `during` scope's own flight drives it.
      const disperse = (c: OpCtx<S>): S =>
        A.mul(A.sub(1, c.flight), EXPLODE_DISPERSE);
      // The curl's own window: `coil` folds `flight` in, so the drawn factor is
      // `1 + curl × flight × (1 − flight)²` — exactly 1 at the park and at the
      // seat. The square is a product, not `pow`: base 0 is a driver-dependent
      // corner. The rebend adds `rebend × bloom`, so the drawn radius at flight
      // f is R·(1 + rebend·bloom·f), the radius `spread` below slides to.
      const curl = (c: OpCtx<S>): S => {
        const left = A.sub(1, c.flight);
        return A.add(
          1,
          A.add(
            A.mul(knobs.curl, A.mul(left, left)),
            A.mul(A.mul(knobs.rebend, knobs.bloom), A.sub(1, ctx.axi)),
          ),
        );
      };
      // The ring phase: a constant turn per ladder group, riding the same rigid
      // revolution EXPLODE_SPIN does — spent by flight, exactly 0 at the seat.
      const ringTurn = explodeRingTurn(A, ctx.rung, knobs.ringPhase);
      return [
        selNotAccessory(A),
        during<S>({ from, to: A.add(from, A.sub(1, EXPLODE_ORDER_SPREAD)) }, [
          // The mid-fall curl, on the bend cast only (ops/house bendTerm) —
          // solids park and fly RIGID. FIRST, because `coil` turns about the
          // BORE: it must run while the piece is still on its seated meridian.
          group<S>([selFront<S>((c) => bendTerm(A, c)), coil<S>(curl)]),
          group<S>([
            selNotOptical(A),
            // The swirl: `orbit`'s angle is `flight × EXPLODE_SPIN`, a rigid
            // revolution about the bore, exactly 0 at channel 0 — one angle for
            // the whole cloud, plus `ringTurn` per ladder group, so a ring is
            // uniform at the park; the per-piece share rides the flight window.
            // The optics are out of all of it.
            orbit<S>((c) =>
              A.add(
                A.add(A.mul(EXPLODE_SPIN, ctx.wrapDir), ringTurn),
                A.mul(
                  A.mul(
                    A.mul(EXPLODE_SCATTER, EXPLODE_SCATTER_SWING),
                    disperse(c),
                  ),
                  phase(EXPLODE_SWING_FREQ),
                ),
              ),
            ),
            // The opening: one uniform slide out along each piece's own
            // meridian — a translation, so the piece stays rigid — plus each
            // piece's own outward share, spent on the flight window.
            // Axisymmetric pieces have no meridian to slide along.
            spread<S>((c) =>
              A.mul(
                A.add(
                  // The sheet's share of the slide moves into the coil as
                  // `rebend` comes up, since the coil's push-out is the same
                  // ride. Non-sheet pieces keep the whole slide.
                  A.mul(
                    knobs.bloom,
                    A.sub(1, A.mul(knobs.rebend, bendTerm(A, ctx))),
                  ),
                  A.mul(
                    A.mul(
                      A.mul(EXPLODE_SCATTER, EXPLODE_SCATTER_R),
                      disperse(c),
                    ),
                    A.add(
                      EXPLODE_SCATTER_MIN,
                      A.mul(
                        (1 - EXPLODE_SCATTER_MIN) / 2,
                        A.add(1, phase(EXPLODE_RADIAL_FREQ)),
                      ),
                    ),
                  ),
                ),
                A.sub(1, ctx.axi),
              ),
            ),
          ]),
          // The hover: model-mm up the axis, higher for the outer ranks.
          // OUTSIDE the optics group — the glass column rides up too, without
          // dilating.
          rise<S>(
            A.mul(
              EXPLODE_HOVER,
              A.add(1, A.mul(EXPLODE_HOVER_RANK, ctx.rank01)),
            ),
          ),
          ladder<S>("attr", EXPLODE_AXIAL_GAIN),
        ]),
      ];
    },
    // `coil` divides by 1 + curl·(1 − flight)² + rebend·bloom·(1 − axi), so
    // all three floors keep that factor ≥ 1.
    knobSpec: {
      bloom: { default: 0.9, range: [0, 10] },
      curl: { default: 0, range: [0, 8] },
      // turns of parked azimuth per model-mm of ladder station
      ringPhase: { default: 0 },
      // 1 = a parked wedge is re-bent to lie ON its ring (drawn radius matches
      // the slide's circle at every flight). /lens keeps the authored shapes.
      rebend: { default: 0, range: [0, 10] },
    },
  });

  // The story's shell peel: the STICKER chain (ops/house stickerPeelOps),
  // scoped to the shell cast — sub-span wedges + decals at the outer ranks.
  // The band is a rank window whose low edge must be SHARP (PEEL_RANK_FEATHER):
  // the gap between the outermost rings and the cladding under them is only
  // ~0.016 of rank01 wide. `Barrel_Base`/`Barrel_Inner` therefore do not curl.
  const peel = recipe<S>({
    name: "peel",
    // A BARE gate — no stagger of its own (the `during` in `build` fans the
    // pieces out); this spec is only the flight ramp's shape.
    gateSpec: () => ({
      layerStagger: 0,
      windowFrac: 1,
      split: PEEL_SPLIT,
      snap: 0, // plain smoothstep
      snapExp: PEEL_SNAP_EXP,
      // no overlap — the peel chain reads only flight (stick is unused)
    }),
    // ONE `during` scope, with the selectors FIRST inside it — `arc` is a
    // modifier, and a spatial selector after one reads a stale frame
    // (validatePipeline). The stagger IS that `during` window, keyed on the
    // piece's MERIDIAN (`peelOrder`, 0 → 1 once round the barrel) because
    // rank01 and layerPhase are both degenerate on this cast.
    build: (ctx) => {
      const from = A.mul(peelOrder(A, ctx.t0, ctx.wrapDir), PEEL_STAGGER);
      return [
        during<S>({ from, to: A.add(from, A.sub(1, PEEL_STAGGER)) }, [
          selSheet(A),
          // The band IS the scope; its low edge stays SHARP, or a wide feather
          // reaches the whole layer below and drags it through the unroll.
          selRank<S>(PEEL_RANK_LO, PEEL_RANK_HI, PEEL_RANK_FEATHER),
          ...stickerPeelOps(A, PEEL_CURL),
        ]),
      ];
    },
    knobSpec: {},
  });

  // ── ROSE — the origami bloom ──────────────────────────────────────────────
  // `selSheet` admits the model's concentric wedge-cut whorls, so the cast is
  // already the flower; the bloom order is the `during` window on the whorl
  // key, INSIDE OUT. The chain walks ACROSS the wedge (the material coordinate
  // d is angular), so each fold in it is a crease running base to tip: base
  // run, flat panels split by creases (`crease` is in radians beyond the
  // seated barrel, ×halfSpan), the corner flick, then `tilt` about a hinge
  // station that must sit INSIDE the barrel's axial extent, or every lever arm
  // shares a sign and the tilt degenerates to a bodily outward slide.
  const rose = recipe<S>({
    name: "rose",
    // A bare gate: no stagger of its own (the `during` window IS the stagger);
    // the house split keeps the stick denominator positive at channel 0.
    gateSpec: () => ({
      layerStagger: 0,
      windowFrac: 1,
      split: ROSE_SPLIT,
      snap: 0,
      snapExp: ROSE_SNAP_EXP,
    }),
    build: (ctx, knobs) => {
      // The WHORL KEY — rank01 re-keyed onto the shells that read as petals.
      // Everything rank-keyed in this recipe uses it.
      const whorl = A.pow(ctx.rank01, ROSE_WHORL_EXP);
      // INSIDE OUT: whorl 0 (the heart) opens at from = 0, whorl 1 (the rim) at
      // from = stagger.
      const from = A.mul(whorl, knobs.stagger);
      // The hinge angle, tapered by whorl depth: outer (whorl = 1) opens the
      // full `lift`, the innermost keeps (1 − taper) of it.
      const angle = A.mul(knobs.lift, A.mix(A.sub(1, knobs.taper), 1, whorl));
      // The fold pattern's material budget, per piece: `base` is the seated
      // run, `facet` the tab beyond the last fold, the tent divides the rest
      // (`creasePos` of it as the centre panel) less one crease band each, so
      // the segments sum to L. max(0, …) guards a negative arc length, which
      // walks the chain BACKWARDS. Built ONCE per piece, not six times.
      const tent = memoCtx<S, { side: S; mid: S; flat: S; fold: S }>((c) => {
        const rest = A.mul(
          c.L,
          A.max(0, A.sub(A.sub(1, knobs.base), knobs.facet)),
        );
        const mid = A.mul(rest, knobs.creasePos);
        return {
          side: A.max(0, A.sub(A.mul(A.sub(rest, mid), 0.5), knobs.band)),
          mid: A.max(0, A.sub(mid, knobs.band)),
          // Flat at full flight, seated barrel at rest — the house identity.
          flat: A.mix(1, 0, c.flight),
          // Each crease turns `crease` × the piece's OWN half-span, so a 5-cut
          // and a 7-cut whorl each refold onto their own sector.
          fold: A.mul(A.mul(c.flight, knobs.crease), c.halfSpan),
        };
      });
      return [
        during<S>({ from, to: A.add(from, A.sub(1, knobs.stagger)) }, [
          selSheet(A),
          rot<S>((c) => c.halfSpan),
          anchor<S>(),
          arc<S>(1, (c) => A.mul(knobs.base, c.L)),
          arc<S>(
            (c) => tent(c).flat,
            (c) => tent(c).side,
          ),
          crease<S>((c) => tent(c).fold, knobs.band),
          arc<S>(
            (c) => tent(c).flat,
            (c) => tent(c).mid,
          ),
          crease<S>((c) => tent(c).fold, knobs.band),
          arc<S>(
            (c) => tent(c).flat,
            (c) => tent(c).side,
          ),
          // The corner flick: a reflex fold (negative — back the other way from
          // the barrel's own curve), ramped in over the petal's free end.
          crease<S>(
            (c) =>
              A.neg(
                A.mul(
                  A.mul(c.flight, knobs.curl),
                  A.smoothstep(
                    ROSE_FLICK_FROM,
                    ROSE_FLICK_TO,
                    A.add(c.yN, 0.5),
                  ),
                ),
              ),
            knobs.band,
          ),
          arc<S>((c) => tent(c).flat),
          // Spend the seam aim: `spread` below slides along the working
          // direction, and the bloom wants it down the sector centre.
          rot<S>((c) => A.neg(c.halfSpan)),
          tilt<S>(angle, { pivot: knobs.hinge }),
          spread<S>(knobs.open),
          orbit<S>(A.mul(knobs.spin, ctx.wrapDir)),
        ]),
        // THE TIER: a rank-keyed axial step that domes the nest, anchored at
        // the heart (`1 − 2·whorl`) — innermost ranks take `+rise`, outermost
        // `−rise`, so `rise` is the tier's HALF depth. OUTSIDE the whorl wave
        // and LAST in the chain, so it is a clean axial lift rather than a
        // longer lever on the hinge the tilt swings.
        group<S>([
          selSheet(A),
          approach<S>(A.mul(knobs.rise, A.sub(1, A.mul(whorl, 2)))),
        ]),
      ];
    },
    // Units: fractions of L (base, facet), of the tent's own material
    // (creasePos), multiples of the piece's half-span (crease), radians (curl,
    // lift, spin), model-mm (hinge, rise), fractions of R (open), channel
    // share (stagger).
    knobSpec: {
      // a `during` denominator: 1 − stagger is each piece's slice of the channel
      stagger: { default: 0.34, range: [0, 0.85] },
      base: { default: 0.1 }, // the seated run, before the petal's folds start
      facet: { default: 0.22 }, // the flicked tab beyond the last fold — the fang's length
      // 1 puts exactly the petal's seated turn on the two hard lines; past the
      // sector break-even a petal is narrower than its share of the ring.
      crease: { default: 1.24 },
      // a shape bound: either end starves a panel below the crease band's width
      creasePos: { default: 0.42, range: [0.05, 0.95] },
      band: { default: ROSE_CREASE_DEFAULT_MM, range: [0.6, 6.6] }, // crease() divides by it
      curl: { default: 1.5 }, // the flick's reflex angle at the free corners
      lift: { default: 1.34 },
      taper: { default: 0.7 },
      // INSIDE the barrel's own axial extent, which is what makes this a hinge
      // rather than a lever — see `tilt` in the recipe header.
      hinge: { default: 20 },
      // Separates over-folded petals rather than opening the ring; the nest
      // must stay closed at mid-bloom and at full open.
      open: { default: 0.15 },
      spin: { default: 0.25 },
      // The tier's HALF depth: +rise at the heart, −rise at the rim. The rim
      // must reach past the bottom of the glass column.
      rise: { default: 22 },
    },
  });

  return { assemble, explode, peel, rose };
}
