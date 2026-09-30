// The four recipes. Each has a gate spec (its timing window), `build` (the
// ordered op list) and a knob table (defaults in physical units, plus a clamp
// range for any knob that feeds the gate or a divisor).

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

// Written out so the emitted shader literals are exact.
const TAU = 6.283185307179586;
const PI = 3.141592653589793;

// ── Assemble ────────────────────────────────────────────────────────────────
const ASSEMBLE_SNAP_EXP = 2.0;
const ASSEMBLE_FLIGHT_START = 0.1;
const ASSEMBLE_ROLL_END = 0.9; // the curl finishes before the sheet breathes
const ASSEMBLE_SWIRL_EXP = 0.65;
const ASSEMBLE_WRAP_SHEAR = 0.9; // diagonal roll front
const ASSEMBLE_MASK_FEATHER = 0.3; // radians
const ASSEMBLE_CURL_MAX = PI; // end-roll limit
const ASSEMBLE_PIN_END = 0.25; // the reel-in is done by this stick value
// Stagger of each layer's pieces around the bore.
const ASSEMBLE_PART_STAGGER = 0.25;
const ASSEMBLE_LADDER_GAIN = 0.4; // times the depth knob
const ASSEMBLE_ROLL_WALL = 2; // min roll radius, in wall thicknesses

// ── Explode ─────────────────────────────────────────────────────────────────
// Gate shares (they sum to 1); the arrival order comes from `during` instead.
const EXPLODE_LAYER_STAGGER = 0;
const EXPLODE_PART_STAGGER = 0.15;
const EXPLODE_WINDOW = 0.85;
/** Order-key exponent: spreads out the outer ranks, bunches the core together. */
const EXPLODE_ORDER_EXP = 3;
/** Share of the channel the arrival order spans; the rest is one piece's flight. */
const EXPLODE_ORDER_SPREAD = 0.86;
/** Weight of the piece's angle in the order key, next to its rank. */
const EXPLODE_WIND = 0.14;
/** Parked pose: ladder gain (× rung), cloud revolution (rad), hover (model-mm). */
export const EXPLODE_AXIAL_GAIN = 0.4;
const EXPLODE_SPIN = 1.35;
export const EXPLODE_HOVER = 100;
/** Extra hover for the outer ranks, as a multiple of the hover. */
export const EXPLODE_HOVER_RANK = 0.55;
/** Mid-flight scatter: gain, angular swing (rad) and outward push (× R). */
const EXPLODE_SCATTER = 1.35;
const EXPLODE_SCATTER_SWING = 0.6;
const EXPLODE_SCATTER_R = 0.7;
/** Minimum outward scatter, as a share of the maximum. */
const EXPLODE_SCATTER_MIN = 0.3;
/** Scatter bump gain: the amplitude is gain × flight × (1 − flight), zero at
 *  both ends and gain / 4 at the peak. */
const EXPLODE_DISPERSE = 4;
/** Per-piece pseudo-random phase frequencies (on t0, layerPhase, rank01). */
const EXPLODE_SWING_FREQ = [2.7, 11, 4.3] as const;
const EXPLODE_RADIAL_FREQ = [4.9, 7, 9.1] as const;
/** A per-ring turn keyed on `rung` (shared by a whole group), wrapped to ±π. */
const explodeRingTurn = <S>(A: Algebra<S>, rung: S, turnsPerMm: S): S => {
  const a = A.mul(A.mul(turnsPerMm, TAU), rung);
  return A.sub(a, A.mul(TAU, A.floor(A.div(A.add(a, PI), TAU))));
};

// Must stay below rollEnd + overlap, or the seated state is NaN (ops/gate.ts).
const EXPLODE_SPLIT = 0.95;
const EXPLODE_SNAP_EXP = 2.0;

// ── Peel ────────────────────────────────────────────────────────────────────
const PEEL_SPLIT = 0.95;
const PEEL_SNAP_EXP = 2.0;
/** Sharp rank edge, so the layer just below the peeled shells stays put. */
const PEEL_RANK_FEATHER = 0.005;

// Curvature of the peeled lip, rolled backwards (stickerPeelOps negates it).
export const PEEL_CURL = 2.6;
/** Share of the channel the fan order spans; the rest is one piece's unroll. */
const PEEL_STAGGER = 0.72;
/** The rank band that unrolls: only the outermost shells. */
export const PEEL_RANK_LO = 0.97;
const PEEL_RANK_HI = 1;

// ── Rose ────────────────────────────────────────────────────────────────────
const ROSE_SPLIT = 0.95;
const ROSE_SNAP_EXP = 2.0;
// Whorl-key exponent: spreads out the petal shells at the top of rank01.
const ROSE_WHORL_EXP = 8;
// Material (model-mm) each crease is folded over.
const ROSE_CREASE_DEFAULT_MM = 1.2;
// The corner flick ramps in along the petal, on yN + 0.5.
const ROSE_FLICK_FROM = 0.45;
const ROSE_FLICK_TO = 1;

/** The recipe names. */
export type RecipeName = "assemble" | "explode" | "peel" | "rose";

/** A knob's default, and the clamp range for knobs that feed the gate or a
 *  divisor. */
export interface KnobSpec {
  default: number;
  range?: readonly [number, number];
}

export interface Recipe<S> {
  name: RecipeName;
  /** The gate window, from the live knobs. */
  gateSpec(knobs: Record<string, S>): GateSpec<S>;
  /** The ordered op list. */
  build(ctx: OpCtx<S>, knobs: Record<string, S>): OpItem<S>[];
  /** The knob table; its key order is the uniform lane order. */
  knobSpec: Record<string, KnobSpec>;
  /** `knobSpec`'s defaults as plain numbers. */
  knobDefaults: Record<string, number>;
}

/** A recipe with `knobDefaults` derived from its `knobSpec` rows. */
function recipe<S>(r: Omit<Recipe<S>, "knobDefaults">): Recipe<S> {
  const knobDefaults: Record<string, number> = {};
  for (const k in r.knobSpec) knobDefaults[k] = r.knobSpec[k].default;
  return { ...r, knobDefaults };
}

/** Build the recipes over an algebra. */
export function makeRecipes<S>(
  A: Algebra<S>,
): Record<Recipe<S>["name"], Recipe<S>> {
  // Assemble's wrap terms (breathing radius, seam turn, curl), memoized per ctx
  // so the ops that share them build one shader subgraph.
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
      // ±1 per shell (a hash of R), so neighbouring layers peel opposite corners.
      const shearSign = A.sub(
        A.mul(A.step(0.5, A.fract(A.mul(ctx.R, 5.13))), 2),
        1,
      );
      // Diagonal front in axial mm (yN·height/L, capped), so thin rings barely shear.
      const front = A.mul(
        ctx.yN,
        A.min(1, A.div(ctx.height, A.max(ctx.L, 1e-6))),
      );
      // The roll can't use more material than the sheet has.
      const rollLen = A.clamp(
        A.mul(
          A.mul(A.sub(1, ctx.stick), ctx.L),
          A.sub(
            1,
            A.mul(
              A.mul(A.mul(front, shearSign), ASSEMBLE_WRAP_SHEAR),
              A.mul(A.mul(ctx.stick, A.sub(1, ctx.stick)), 4),
            ),
          ),
        ),
        0,
        ctx.L,
      );
      // The roll can't be tighter than the piece's wall is thick.
      const rollR = A.mul(
        ctx.R,
        A.max(
          A.mix(0.45, 0.18, knobs.curl),
          A.mul(ctx.depth, ASSEMBLE_ROLL_WALL),
        ),
      );
      const hasRoll = A.step(1e-6, rollLen);
      return {
        // Half a span reaches the seam; the breath swings it a little further.
        seamTurn: A.add(
          ctx.halfSpan,
          A.mul(A.mul(A.mul(breath, 0.06), ctx.R), ctx.wrapDir),
        ),
        Rb,
        qMain: A.div(ctx.R, rf),
        // With no roll left, the main arc takes all remaining material.
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
      // Staggers + window sum to 1, so every piece is seated at channel 0.
      windowFrac: A.sub(A.sub(1, knobs.stagger), ASSEMBLE_PART_STAGGER),
      split: knobs.split,
      snap: knobs.snap,
      snapExp: ASSEMBLE_SNAP_EXP,
      overlap: knobs.overlap,
      flightStart: ASSEMBLE_FLIGHT_START,
      rollEnd: ASSEMBLE_ROLL_END,
    }),
    // The sheet motion is scoped to sheets; the ladder after it moves everything.
    build: (_ctx, knobs) => {
      const wrap = wrapTerms(knobs);
      return [
        group<S>([
          // Optional sector mask, fully open by default.
          selSector<S>(
            knobs.maskCenter,
            knobs.maskWidth,
            ASSEMBLE_MASK_FEATHER,
          ),
          selSheet(A),
          selNotKept(A, knobs.keepScope),
          // Wrap first, so the moves after it carry the bent sheet. Thick
          // pieces skip the bend (bendTerm) and move rigidly.
          group<S>([
            selFront<S>((c) => bendTerm(A, c)),
            rot<S>((c) => wrap(c).seamTurn),
            anchor<S>((c) => wrap(c).Rb),
            arc<S>(
              (c) => wrap(c).qMain,
              (c) => wrap(c).mainLen,
            ),
            arc<S>(
              (c) => wrap(c).qRoll,
              (c) => wrap(c).curlLen,
              { participation: (c) => wrap(c).curlRamp },
            ),
            straight<S>(),
            // Undo the seam turn so `sep` slides along the sector centre.
            rot<S>((c) => A.neg(wrap(c).seamTurn)),
          ]),
          spread<S>(knobs.sep),
          // Reel-in: a throw out along the seam plus a swirl, done by
          // ASSEMBLE_PIN_END. The weight must be per-piece to keep it rigid.
          group<S>([
            selFront<S>((c) =>
              A.sub(1, A.smoothstep(0, ASSEMBLE_PIN_END, c.stick)),
            ),
            rot<S>((c) => c.halfSpan),
            spread<S>(knobs.spreadThrow),
            swirl<S>(knobs.swirl, {
              exp: ASSEMBLE_SWIRL_EXP,
              rankScale: true,
            }),
          ]),
        ]),
        // Axial ladder over the whole model, except the kept parts.
        group<S>([
          selNotKept(A, knobs.keepScope),
          ladder<S>(A.mul(ASSEMBLE_LADDER_GAIN, knobs.depth)),
        ]),
      ];
    },
    knobSpec: {
      spreadThrow: { default: 1.6 },
      sep: { default: 0.55 },
      swirl: { default: 1.1 },
      // divisor (q = R/rf)
      flatten: { default: 1, range: [0.05, 30] },
      rewind: { default: 0.95 },
      // rollR = R·mix(0.45, 0.18, curl) hits 0 at curl = 5/3
      curl: { default: 0.85, range: [0, 1] },
      depth: { default: 1 },
      // Layer stagger (outermost first); the window left over must stay ≥ 0.05.
      stagger: { default: 0.5, range: [0, 0.65] },
      // a selector weight
      keepScope: { default: 0, range: [0, 1] },
      // keep the gate's flight and stick spans positive (ops/gate.ts)
      split: { default: 0.95, range: [0.15, 0.95] },
      overlap: { default: 0.9, range: [0.1, 2] },
      snap: { default: 0, range: [0, 1] },
      maskCenter: { default: 0 },
      maskWidth: { default: TAU },
    },
  });

  const explode = recipe<S>({
    name: "explode",
    gateSpec: () => ({
      layerStagger: EXPLODE_LAYER_STAGGER,
      partStagger: EXPLODE_PART_STAGGER,
      windowFrac: EXPLODE_WINDOW,
      split: EXPLODE_SPLIT,
      snap: 0,
      snapExp: EXPLODE_SNAP_EXP,
    }),
    // Accessories are excluded and the optics only rise and ladder. The scatter
    // and curl are zero at both ends, so the parked pose is uniform per ring.
    build: (ctx, knobs) => {
      // Arrival order: by rank, then by angle, so landings step around the bore.
      const ang01 = A.add(A.div(ctx.t0, TAU), 0.5);
      const key = A.div(
        A.add(A.pow(ctx.rank01, EXPLODE_ORDER_EXP), A.mul(EXPLODE_WIND, ang01)),
        1 + EXPLODE_WIND,
      );
      const from = A.mul(A.sub(1, key), EXPLODE_ORDER_SPREAD);
      // A deterministic per-piece phase.
      const phase = (f: readonly [number, number, number]) =>
        A.sin(
          A.add(
            A.add(A.mul(ctx.t0, f[0]), A.mul(ctx.layerPhase, f[1])),
            A.mul(ctx.rank01, f[2]),
          ),
        );
      // The ops multiply by flight, so this makes a bump that is 0 at both ends.
      const disperse = (c: OpCtx<S>): S =>
        A.mul(A.sub(1, c.flight), EXPLODE_DISPERSE);
      // Coil factor 1 + curl·f·(1 − f)² (1 at both ends; a product, since
      // pow(0, …) varies by driver), plus rebend·bloom to bend sheets onto
      // the radius `spread` moves them to.
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
      const ringTurn = explodeRingTurn(A, ctx.rung, knobs.ringPhase);
      return [
        selNotAccessory(A),
        during<S>({ from, to: A.add(from, A.sub(1, EXPLODE_ORDER_SPREAD)) }, [
          // Curl thin pieces first, while they are still at their seated angle.
          group<S>([selFront<S>((c) => bendTerm(A, c)), coil<S>(curl)]),
          group<S>([
            selNotOptical(A),
            // Revolve: a cloud-wide spin, a per-ring turn, and a per-piece swing.
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
            // Slide out along each piece's angle, plus a per-piece scatter.
            // Axisymmetric pieces don't slide.
            spread<S>((c) =>
              A.mul(
                A.add(
                  // With rebend, the coil does the sheets' outward move instead.
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
          // Hover up the axis (outer ranks higher); the optics rise too.
          rise<S>(
            A.mul(
              EXPLODE_HOVER,
              A.add(1, A.mul(EXPLODE_HOVER_RANK, ctx.rank01)),
            ),
          ),
          ladder<S>(EXPLODE_AXIAL_GAIN),
        ]),
      ];
    },
    // The ranges keep coil's divisor ≥ 1.
    knobSpec: {
      bloom: { default: 0.9, range: [0, 10] },
      curl: { default: 0, range: [0, 8] },
      // turns per model-mm of ladder rung
      ringPhase: { default: 0 },
      // 1 = parked sheets are re-bent to lie on their ring
      rebend: { default: 0, range: [0, 1] },
    },
  });

  // Peel: the outermost shell wedges and decals unroll like stickers
  // (stickerPeelOps), one after another around the barrel.
  const peel = recipe<S>({
    name: "peel",
    // No stagger here; the `during` window in `build` orders the pieces.
    gateSpec: () => ({
      layerStagger: 0,
      windowFrac: 1,
      split: PEEL_SPLIT,
      snap: 0,
      snapExp: PEEL_SNAP_EXP,
    }),
    // Ordered by angle around the barrel (`peelOrder`), selectors first.
    build: (ctx) => {
      const from = A.mul(peelOrder(A, ctx.t0, ctx.wrapDir), PEEL_STAGGER);
      return [
        during<S>({ from, to: A.add(from, A.sub(1, PEEL_STAGGER)) }, [
          selSheet(A),
          selRank<S>(PEEL_RANK_LO, PEEL_RANK_HI, PEEL_RANK_FEATHER),
          ...stickerPeelOps(A, PEEL_CURL),
        ]),
      ];
    },
    knobSpec: {},
  });

  // ── Rose: origami bloom ─────────────────────────────────────────────────
  // The sheet wedges fold into petals, inside out. Each wedge flattens into
  // panels split by creases, flicks its corners, then tilts open on a hinge
  // that must sit within the barrel's axial extent.
  const rose = recipe<S>({
    name: "rose",
    // No stagger here; the `during` window in `build` orders the pieces.
    gateSpec: () => ({
      layerStagger: 0,
      windowFrac: 1,
      split: ROSE_SPLIT,
      snap: 0,
      snapExp: ROSE_SNAP_EXP,
    }),
    build: (ctx, knobs) => {
      // rank01 spread over the petal shells.
      const whorl = A.pow(ctx.rank01, ROSE_WHORL_EXP);
      // Inside out: the heart opens first, the rim last.
      const from = A.mul(whorl, knobs.stagger);
      // Hinge angle: full `lift` at the rim, (1 − taper) of it at the heart.
      const angle = A.mul(knobs.lift, A.mix(A.sub(1, knobs.taper), 1, whorl));
      // Panel lengths: after `base` and `facet`, the rest splits into two
      // sides and a middle (`creasePos`), less a crease band each. Clamped at 0
      // so no segment runs backwards. Memoized per ctx.
      const tent = memoCtx<S, { side: S; mid: S; flat: S; fold: S }>((c) => {
        const rest = A.mul(
          c.L,
          A.max(0, A.sub(A.sub(1, knobs.base), knobs.facet)),
        );
        const mid = A.mul(rest, knobs.creasePos);
        return {
          side: A.max(0, A.sub(A.mul(A.sub(rest, mid), 0.5), knobs.band)),
          mid: A.max(0, A.sub(mid, knobs.band)),
          // Seated curvature at rest, flat at full flight.
          flat: A.mix(1, 0, c.flight),
          // In units of the piece's own half-span.
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
          // Corner flick: a backward fold toward the petal's free end.
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
          // Undo the seam turn so `spread` moves along the sector centre.
          rot<S>((c) => A.neg(c.halfSpan)),
          tilt<S>(angle, { pivot: knobs.hinge }),
          spread<S>(knobs.open),
          orbit<S>(A.mul(knobs.spin, ctx.wrapDir)),
        ]),
        // Dome the flower: +rise at the heart down to −rise at the rim. Last,
        // so it doesn't lengthen the tilt's lever.
        group<S>([
          selSheet(A),
          approach<S>(A.mul(knobs.rise, A.sub(1, A.mul(whorl, 2)))),
        ]),
      ];
    },
    // Units: base/facet × L, creasePos × panel material, crease × half-span,
    // curl/lift/spin radians, hinge/rise model-mm, open × R, stagger channel.
    knobSpec: {
      // divisor: 1 − stagger is each piece's slice of the channel
      stagger: { default: 0.34, range: [0, 0.85] },
      base: { default: 0.1 }, // seated run before the first fold
      facet: { default: 0.22 }, // flicked tab after the last fold
      crease: { default: 1.24 },
      creasePos: { default: 0.42, range: [0.05, 0.95] },
      band: { default: ROSE_CREASE_DEFAULT_MM, range: [0.6, 6.6] }, // divisor
      curl: { default: 1.5 }, // corner flick angle
      lift: { default: 1.34 },
      taper: { default: 0.7 },
      hinge: { default: 20 }, // must sit within the barrel's axial extent
      open: { default: 0.15 },
      spin: { default: 0.25 },
      rise: { default: 22 }, // half the dome's depth
    },
  });

  return { assemble, explode, peel, rose };
}
