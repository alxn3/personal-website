// The recipes — the whole motion vocabulary, expressed as channel-gated op
// pipelines over the scalar algebra. A recipe is three things and nothing else:
//
//   gateSpec(knobs) → the two-phase window this channel plays through
//   build(ctx, knobs) → the ORDERED op list (the recipe IS its order)
//   knobDefaults → the physical values the host binds as uniforms
//
// The knob defaults are PHYSICAL values — radians, model-mm, fractions of R —
// not slider positions; mapping a 0..100 UI onto them is the host's business.
//
// gateSpec is a FUNCTION of the knobs because the gate inputs are LIVE sliders
// too. assemble's window is DERIVED (1 − stagger − partStagger) so offset +
// window ≡ 1 for any slider value, which keeps the channel-0 identity exact.
//
// Every op reads ctx when it RUNS; the only thing a recipe reads at BUILD time
// is `ctx.wrapDir`, a plain number on both backends, which lets a recipe fix
// the SIGN of a rotation at its call site rather than in the op.

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

// Written out rather than taken from Math: a recipe is pure algebra, and these
// end up as shader literals.
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
const ASSEMBLE_LADDER_GAIN = 0.4; // rung → model-mm, scaled by the depth knob

// ── EXPLODE constants ───────────────────────────────────────────────────────
/** the gate's own grain: no rank stagger at all — the ORDER is the `during`
 *  slot below — and a little phase spread so a rank layer's own pieces do not
 *  land together. The shares sum to 1, so both channel ends stay saturating
 *  identities. */
const EXPLODE_LAYER_STAGGER = 0;
const EXPLODE_PART_STAGGER = 0.15;
const EXPLODE_WINDOW = 0.85;
/** THE ORDER KEY's exponent: rank is a value-normalized radius, and the OUTER
 *  fifth of it carries two pieces in five — the whole visible stack. The power
 *  hands that band about half the order axis, so the layers the reader can see
 *  land one at a time instead of together, and collapses the core toward 0, so
 *  the middle leaves first as one group. (`rose` keys its whorl the same way.) */
const EXPLODE_ORDER_EXP = 3;
/** how much of the channel the arrival order is spread over; the remainder is
 *  ONE piece's own flight. Stagger ≫ window is what makes the sequence read
 *  rather than smear. */
const EXPLODE_ORDER_SPREAD = 0.86;
/** how far the piece's own meridian winds the order, against the radial run.
 *  Small on purpose: the build still reads outward, with each turn of the
 *  staircase carrying a few layers' worth of landings around the bore. */
const EXPLODE_WIND = 0.14;
/** how much higher the OUTER ranks hang, as a multiple of `hover`: the cloud
 *  opens upward away from the lens instead of hovering as a second one. */
export const EXPLODE_HOVER_RANK = 0.55;
/** THE DISPERSAL's two terms, both scaled by the `scatter` knob and both spent
 *  along the descent's own helix: radians round the bore, signed, and a
 *  fraction of the piece's radius, always OUTWARD so the fall drifts in. */
const EXPLODE_SCATTER_SWING = 0.6;
const EXPLODE_SCATTER_R = 0.7;
/** the outward scatter's floor, as a share of its own maximum — no piece drifts
 *  in on exactly the ring's own line, so none of them reads as the one that
 *  stayed. */
const EXPLODE_SCATTER_MIN = 0.3;
/** the dispersal bump's gain. The ops fold their own `flight` in, so the drawn
 *  amplitude is `gain × flight × (1 − flight)` — 0 at both channel ends and
 *  `gain / 4` at its peak. 4 puts the mid-fall spread at the knob's full value,
 *  i.e. where the parked cloud used to hold it. */
const EXPLODE_DISPERSE = 4;
/** THE PER-PIECE PHASES the two terms read. Coprime-ish frequencies on three
 *  lane constants, so the scatter is deterministic, backend-stable (no hashing
 *  by fract of a huge product) and uncorrelated between the terms. */
const EXPLODE_SWING_FREQ = [2.7, 11, 4.3] as const;
const EXPLODE_RADIAL_FREQ = [4.9, 7, 9.1] as const;
/** THE RING PHASE's key: the piece's own ladder station (`rung`), which
 *  ops/frames.ts derives per GROUP — a shell's wedges, its decals and anything
 *  parented under it all carry the same one. So a ring turns as a unit and
 *  stays evenly spaced, while neighbouring shells turn by different amounts.
 *  The turn is taken the SHORT way round (wrapPi), or a far group would unwind
 *  whole turns on the way down instead of the fraction its pose needs. */
const explodeRingTurn = <S>(A: Algebra<S>, rung: S, turnsPerMm: S): S => {
  const a = A.mul(A.mul(turnsPerMm, TAU), rung);
  return A.sub(a, A.mul(TAU, A.floor(A.div(A.add(a, PI), TAU))));
};

// The house split. It MUST stay below rollEnd + overlap, or the stick ramp's
// denominator is 0 and the seated state computes NaN where the identity anchor
// requires exactly 1 (ops/gate.ts).
const EXPLODE_SPLIT = 0.95;
const EXPLODE_SNAP_EXP = 2.0;

// ── PEEL gate constants — the travelling-front shape. Inert at snap 0, but the
// gate signature still takes an exponent.
const PEEL_SPLIT = 0.95;
const PEEL_SNAP_EXP = 2.0;
/** the peel's own rank feather — see the peel recipe's selRank comment */
const PEEL_RANK_FEATHER = 0.005;

// q of the freed run, INVERTED (ops/house stickerPeelOps negates it). Above 1
// the lip rolls BACK tighter than the shell it came off, which is what reads as
// a sticker rather than as an unwrapped tube.
const PEEL_CURL = 2.6;

// ── ROSE constants — the origami-bloom gate, bare like peel's: the wave is a
// `during` window keyed on the whorl key, not the gate's own staggers.
const ROSE_SPLIT = 0.95;
const ROSE_SNAP_EXP = 2.0;
// THE WHORL KEY's exponent. rank01 is normalised over the model's WHOLE radius
// range, and every shell that reads as a petal lives in its top eighth — so a
// linear key spends the wave on parts nobody sees and hands the visible whorls
// nearly the same value. The power spreads that top band out and collapses the
// rest toward 0, so wave, taper and tier all key on what is on screen.
const ROSE_WHORL_EXP = 8;
// THE CREASE BAND's default, model-mm of material each hard fold is taken over.
// A knob (`band`), because the width is a trade: narrow reads as a drawn knife
// line, but the fold's radius is ≈ band/fold-angle, and where that drops below
// a shell's WALL THICKNESS the inner surface has less arc than it needs and
// folds past the fold's centre. Zero would divide — KNOB_LIMITS has the floor.
const ROSE_CREASE_DEFAULT_MM = 1.2;
// The corner FLICK's axial ramp: the reflex fold is absent over the petal's
// seated half and full at its free tip, which makes the fold-back a triangular
// fang rather than a hem down the whole edge. Bounds are on yN + 0.5.
const ROSE_FLICK_FROM = 0.45;
const ROSE_FLICK_TO = 1;

/** Every recipe channel there is — the four authored recipes below. */
export type RecipeName = "assemble" | "explode" | "peel" | "rose";

export interface Recipe<S> {
  name: RecipeName;
  /** The gate window for this channel, derived from the LIVE knobs. */
  gateSpec(knobs: Record<string, S>): GateSpec<S>;
  /** The ordered op list. Order is the recipe — permuting it changes the motion. */
  build(ctx: OpCtx<S>, knobs: Record<string, S>): OpItem<S>[];
  /** Physical defaults; the host binds them as uniforms, tests use them as numbers. */
  knobDefaults: Record<string, number>;
}

// The knobs arrive already lifted (the host lifts its uniforms once), so they
// compose with the algebra directly.
export function makeRecipes<S>(
  A: Algebra<S>,
): Record<Recipe<S>["name"], Recipe<S>> {
  // The house selectors and bend chains every recipe composes from are in
  // ops/house.ts.
  //
  // ── the ASSEMBLE wrap's terms ─────────────────────────────────────────────
  // The numbers the chain below walks on: a breathing barrel, a
  // counter-rotating seam re-aim, the diagonal shear front that varies the
  // rolled length with axial height, and the end-roll. Every read is of the
  // EFFECTIVE ctx, and the derivation is MEMOIZED on it so the six ops reading
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
        // The chain's re-aim, off the piece's own meridian: one half-span
        // reaches the seam (the house winding puts it at φ = +halfSpan) and the
        // breath swings it back as the sheet homes.
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

  const assemble: Recipe<S> = {
    name: "assemble",
    gateSpec: (knobs) => ({
      layerStagger: knobs.stagger,
      partStagger: knobs.partStagger,
      // DERIVED, so offset + window ≡ 1 for any slider: every piece saturates
      // to win = 1 (flight 0, stick 1) at channel 0.
      windowFrac: A.sub(A.sub(1, knobs.stagger), knobs.partStagger),
      split: knobs.split,
      snap: knobs.snap,
      snapExp: ASSEMBLE_SNAP_EXP,
      overlap: knobs.overlap,
      flightStart: ASSEMBLE_FLIGHT_START,
      rollEnd: ASSEMBLE_ROLL_END,
    }),
    // THE DEFAULT SELECTION: the shrink-wrap runs on the segmented shells and
    // whatever rides them, the tier ladder moves every piece. So the whole
    // sheet pipeline sits in ONE group scoped by `selSheet`, with the ladder
    // OUTSIDE it — without that split the optics throw and swirl alongside the
    // shells, and the reassembly reads as chaos rather than a wrap-on.
    build: (_ctx, knobs) => {
      const wrap = wrapTerms(knobs);
      return [
        group<S>([
          // Optional sector solo, fully open by default (width ≥ TAU ⇒ 1).
          // INSIDE the group on purpose: a soloed sector must not strand the
          // rest of the model off its ladder rung.
          selSector<S>(
            knobs.maskCenter,
            knobs.maskWidth,
            ASSEMBLE_MASK_FEATHER,
          ),
          selSheet(A),
          // …and off the KEEP-set while `keepScope` is up: the cards scene's
          // departure reveals that mechanism in place and may not move it.
          selNotKept(A, knobs.keepScope),
          // THE WRAP, the sheet's own shape, FIRST: the chain rebuilds the
          // point from the material coordinate, so every transform after it
          // moves the BENT sheet. Aim at the seam, anchor on the breathing
          // barrel, then walk the main arc, the reversed end-roll, and a
          // straight tail for whatever is left.
          rot<S>((c) => wrap(c).seamTurn),
          anchor<S>((c) => wrap(c).Rb),
          arc<S>(
            (c) => wrap(c).qMain,
            (c) => wrap(c).mainLen,
          ),
          // participation = curlRamp is the wrap's own law: only that share of
          // the roll's material bends, the rest trails straight off the exit
          // tangent. A pure κ(d) profile cannot reproduce it.
          arc<S>(
            (c) => wrap(c).qRoll,
            (c) => wrap(c).curlLen,
            { participation: (c) => wrap(c).curlRamp },
          ),
          straight<S>(),
          // Put the PIECE's direction back on its own meridian: a re-aim
          // threads FORWARD, and `sep` below slides along the sector centre,
          // not the seam, so the chain's aim must be spent explicitly.
          rot<S>((c) => A.neg(wrap(c).seamTurn)),
          // sep — the slow unpinned slide along the sector centre.
          spread<S>(knobs.sep),
          // The REEL-IN group: the fast throw along the seam meridian and the
          // fly-in swirl both home by ASSEMBLE_PIN_END of stick. One material
          // selector scopes both, safe ONLY because stick is PER-PIECE so the
          // group's weight is uniform across a piece's vertices — a per-VERTEX
          // selector would scale the two rigid motions per vertex and tear the
          // piece apart.
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
        // but for the keep-set, so the axial choreography covers the whole
        // model in the sky chapter and leaves the mechanism alone in the cards.
        group<S>([
          selNotKept(A, knobs.keepScope),
          ladder<S>("attr", A.mul(ASSEMBLE_LADDER_GAIN, knobs.depth)),
        ]),
      ];
    },
    knobDefaults: {
      spreadThrow: 1.6,
      sep: 0.55,
      swirl: 1.1,
      flatten: 1,
      rewind: 0.95,
      curl: 0.85,
      depth: 1,
      // THE GRAIN. `stagger` orders the LAYERS (rank01, outermost first) and
      // `partStagger` orders each layer's OWN pieces (layerPhase, round the
      // bore); the window is the remainder, so a piece's own flight is short
      // against the order and the cast reads as a sequence rather than a sheet.
      // Without the second term the five wedges of a family share one window
      // and fly as one shell.
      stagger: 0.5,
      partStagger: 0.25,
      keepScope: 0,
      split: 0.95,
      overlap: 0.9,
      snap: 0,
      maskCenter: 0,
      maskWidth: TAU,
    },
  };

  const explode: Recipe<S> = {
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
    // THE DEFAULT SELECTION, in assemble's idiom — an exemption is a per-recipe
    // selection, never a flag baked into an op: accessories drop out of
    // everything at the head, and the optics ride the axial ladder alone.
    //
    // THE PARKED POSE (channel 1) IS THE LENS OPENED OUT, NOT REDRAWN. Three
    // terms, all UNIFORM and all RIGID: `bloom` slides every piece out along its
    // own meridian, one `orbit` turns the whole cloud round the bore, and `rise`
    // + the ladder lift it up the axis. Nothing that reaches the park bends,
    // scales or stretches a piece, so there it is drawn at its authored size and
    // shape, evenly spaced and square to its own arc.
    //
    // THE DISPERSAL AND THE CURL ARE THE MOTION'S, NOT THE POSE'S: the two
    // per-piece terms ride `disperse` and the shape ride `curl`, and all three
    // windows are EXACTLY 0 at the park and at the seat because the ops fold the
    // piece's own `flight` in. So the cloud is even, the fall opens out into
    // individual pieces that shut around the glass as they land, and the seat is
    // still exact.
    //
    // THE FALL IS ONE HELIX: every term rides the SAME per-piece flight, so a
    // piece spends its swing, its radius and its height together and traces a
    // corkscrew down onto its seat.
    build: (ctx, knobs) => {
      // THE ORDER IS A SPIRAL STAIRCASE: radius sets the run and the piece's
      // own meridian winds it, so consecutive landings step AROUND the bore as
      // the build goes outward. A piece is seated below its slot's foot, so
      // key 0 (innermost, at the seam) lands first. Both terms are per-piece
      // constants, so the key is monotone in each and needs no wrap.
      const ang01 = A.add(A.div(ctx.t0, TAU), 0.5);
      const key = A.div(
        A.add(A.pow(ctx.rank01, EXPLODE_ORDER_EXP), A.mul(EXPLODE_WIND, ang01)),
        1 + EXPLODE_WIND,
      );
      const from = A.mul(A.sub(1, key), EXPLODE_ORDER_SPREAD);
      // THE DISPERSAL's per-piece phases: a smooth function of three lane
      // constants, so two pieces of one layer scatter differently and the CPU
      // mirror and the shaders agree to the last few digits.
      const phase = (f: readonly [number, number, number]) =>
        A.sin(
          A.add(
            A.add(A.mul(ctx.t0, f[0]), A.mul(ctx.layerPhase, f[1])),
            A.mul(ctx.rank01, f[2]),
          ),
        );
      // THE FLIGHT WINDOW the two per-piece terms ride. The ops multiply their
      // own `flight` in, so `1 − flight` makes a bump: exactly 0 at the park,
      // exactly 0 at the seat, peaking mid-fall at `EXPLODE_DISPERSE / 4` of
      // the knob. LIVE, so a `during` scope's own flight drives it.
      const disperse = (c: OpCtx<S>): S =>
        A.mul(A.sub(1, c.flight), EXPLODE_DISPERSE);
      // THE CURL's own window, on the same idiom: `coil` folds `flight` in too,
      // so the drawn factor is `1 + curl × flight × (1 − flight)²` — exactly 1
      // (the identity) at the park and at the seat, peaking two thirds of the
      // way down, so the wedge shuts as it lands rather than as it leaves. The
      // square is spelled as a product: `pow` with a base of exactly 0 is a
      // driver-dependent corner and this one reaches it at every park frame.
      //
      // …PLUS THE REBEND: `rebend × bloom` more, constant in the factor, so the
      // drawn radius at flight f is R·(1 + rebend·bloom·f) — the SAME radius
      // the `spread` slide below has carried the piece to. At `rebend` 1 a
      // parked wedge therefore LIES ON its ring (its curvature is the circle
      // it sits on) and relaxes back to its own shape as it flies home,
      // matching its current ring the whole way down. Exactly 1 at the seat.
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
      // THE RING PHASE: a per-piece constant turn, one per ladder group, that
      // rides the same rigid revolution `spin` does — so it is the PARK's, spent
      // by the piece's own flight and exactly 0 at the seat.
      const ringTurn = explodeRingTurn(A, ctx.rung, knobs.ringPhase);
      return [
        selNotAccessory(A),
        during<S>({ from, to: A.add(from, A.sub(1, EXPLODE_ORDER_SPREAD)) }, [
          // THE MID-FALL CURL: the shell wedge opens off its seated radius as it
          // leaves and shuts back onto it as it lands, so the pieces visibly
          // curl closed around the glass on the way down. FIRST, because `coil`
          // turns the vertex about the BORE — it has to run while the piece is
          // still on its seated meridian, before the terms below carry it off.
          // …ON THE BEND CAST ONLY (ops/house bendTerm): shells bend; the
          // kept mechanism's chunky solids park and fly RIGID — a bend strains
          // walls by |off|/R, up to 2× girth on the focus drive's sections.
          group<S>([selFront<S>((c) => bendTerm(A, c)), coil<S>(curl)]),
          group<S>([
            selNotOptical(A),
            // THE SWIRL: `orbit`'s angle is `flight × spin`, a rigid revolution
            // about the bore that is exactly 0 at channel 0 and unwinds as the
            // piece comes down — so a piece descends turning rather than
            // dropping. UNIFORM WITHIN A RING at the park: `spin` is one angle
            // for the whole cloud and `ringTurn` one per ladder group, so a
            // ring's own spacing stays even while its SEAM lands somewhere no
            // neighbouring ring's does — without which every shell is cut on the
            // same meridians and the gaps fuse into radial spokes. The per-piece
            // share on top rides the flight window. The optics are out of all of
            // it: the column keeps its line.
            orbit<S>((c) =>
              A.add(
                A.add(A.mul(knobs.spin, ctx.wrapDir), ringTurn),
                A.mul(
                  A.mul(
                    A.mul(knobs.scatter, EXPLODE_SCATTER_SWING),
                    disperse(c),
                  ),
                  phase(EXPLODE_SWING_FREQ),
                ),
              ),
            ),
            // THE OPENING: one uniform slide out along each piece's own
            // meridian. A translation, so the piece arrives rigid — same size,
            // same curvature, same facing — and identical for every piece of a
            // ring, so the ring opens as a regular rosette. On top of it each
            // piece's own share of the radius, outward and never inward and
            // spent on the flight window, so the fall drifts back IN onto the
            // even ring. Axisymmetric pieces have no meridian to slide along.
            spread<S>((c) =>
              A.mul(
                A.add(
                  // THE SHEET'S SHARE OF THE SLIDE MOVES INTO THE COIL as
                  // `rebend` comes up: the coil's push-out IS the ride to the
                  // ring for a re-bent wedge, and a second slide on top would
                  // carry it past it. Non-sheet pieces keep the whole slide.
                  A.mul(
                    knobs.bloom,
                    A.sub(1, A.mul(knobs.rebend, bendTerm(A, ctx))),
                  ),
                  A.mul(
                    A.mul(A.mul(knobs.scatter, EXPLODE_SCATTER_R), disperse(c)),
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
          // THE HOVER: model-mm up the axis, a little higher for the outer
          // ranks so the cloud opens away from the lens rather than sitting on
          // it as a second one. OUTSIDE the optics group, because the glass
          // column is part of the cloud too — it simply rides up without
          // dilating.
          rise<S>(
            A.mul(knobs.hover, A.add(1, A.mul(EXPLODE_HOVER_RANK, ctx.rank01))),
          ),
          ladder<S>("attr", knobs.axialGain),
        ]),
      ];
    },
    knobDefaults: {
      axialGain: 0.4,
      spin: 1.35,
      hover: 100,
      scatter: 1.35,
      bloom: 0.9,
      curl: 0,
      // turns of parked azimuth per model-mm of ladder station
      ringPhase: 0,
      // 1 = a parked wedge is re-bent to lie ON its ring (drawn radius matches
      // the slide's circle at every flight). /lens keeps the authored shapes.
      rebend: 0,
    },
  };

  // The STORY's shell peel — the STICKER chain (ops/house stickerPeelOps),
  // scoped so only the shell cast (sub-span wedges + decals at the outer ranks)
  // can unroll.
  //
  // THE BAND is a rank window, and its low edge has to be SHARP: the gap it
  // must fit in — between the outermost rings and the cladding under them — is
  // only ~0.016 of rank01 wide, so the house 0.1 feather the other recipes take
  // would reach past the cladding and put half the mechanism on some fraction
  // of a curl. Hence PEEL_RANK_FEATHER.
  //
  // WHAT THEREFORE DOES NOT CURL, though it all drifts away rigidly with the
  // shell cast (story/peelcards.ts): `Barrel_Base`, `Barrel_Inner` and the
  // markings on them. Barrel_Inner is the surprise, and the reason is the
  // METRIC — it reaches the outer radius at its lip, but carries the barrel's
  // whole inner surface too, so its MEDIAN vertex radius ranks it in among the
  // cladding. Widening the band far enough to take it reaches under two more
  // shells as well: a different cast, not a wider one.
  //
  // THE STICKER CHAIN, not a flat unroll: a wedge half-peeled flat reads as a
  // plate hovering off the barrel rather than as something coming OFF it. The
  // sticker chain frees the same material at −PEEL_CURL, so the lip inverts at
  // the crease and the freed body rolls back away from the shell.
  const peel: Recipe<S> = {
    name: "peel",
    // A BARE gate — no stagger of its own. See the `during` in `build`: the
    // gate's two stagger inputs are both degenerate on this cast, so the peel
    // fans its pieces out on the CHANNEL instead and this spec is only the
    // flight ramp's shape (PEEL_SPLIT / PEEL_SNAP_EXP).
    gateSpec: () => ({
      layerStagger: 0,
      windowFrac: 1,
      split: PEEL_SPLIT,
      snap: 0, // plain smoothstep
      snapExp: PEEL_SNAP_EXP,
      // no overlap — the peel chain reads only flight (stick is unused)
    }),
    // ONE `during` scope: the participation selectors scope the peel chain and
    // nothing else, so a term added after it moves the whole model unless it
    // says otherwise. Selectors FIRST inside it — `arc` is a modifier, and a
    // spatial selector after one reads a stale frame (validatePipeline).
    //
    // THE STAGGER IS THE `during` WINDOW, not the gate's, because the gate's
    // two stagger inputs are both degenerate on this cast: it IS the outer
    // skin, so every piece measures rank01 within a few hundredths of 1, and
    // the 0.01mm rank bucket puts most wedges in a layer of ONE, whose
    // layerPhase is 0 by construction.
    //
    // So the fan keys on the piece's MERIDIAN — `peelOrder`, 0 → 1 once around
    // the barrel — which is the one intrinsic that really does separate them:
    // the skin peels AROUND the lens, each sector free before the next starts.
    // `stagger` is how much of the channel the fan spends and the window is the
    // remainder, so both identity ends stay exact. story/peelcards.ts's outward
    // drift keys on the SAME peelOrder.
    build: (ctx, knobs) => {
      const from = A.mul(peelOrder(A, ctx.t0, ctx.wrapDir), knobs.stagger);
      return [
        during<S>({ from, to: A.add(from, A.sub(1, knobs.stagger)) }, [
          selSheet(A),
          // The band IS the scope, and its low edge is SHARP: a wide feather
          // reaches a whole layer below the band, and everything ADOPTED onto
          // that layer (which copies its host's rank) then rides the unroll at
          // near-full weight and snaps home on the channel's release.
          selRank<S>(knobs.rankLo, knobs.rankHi, PEEL_RANK_FEATHER),
          ...stickerPeelOps(A, knobs.curl),
        ]),
      ];
    },
    knobDefaults: { curl: PEEL_CURL, stagger: 0.72, rankLo: 0.97, rankHi: 1 },
  };

  // ── ROSE — the origami bloom ──────────────────────────────────────────────
  // The model is already a rose in section: concentric wedge-cut whorls of
  // alternating petal counts with offset seam meridians, and `selSheet` admits
  // exactly that nest. So the cast IS the flower and this recipe only has to
  // open it.
  //
  // THE BLOOM ORDER is the `during` window, keyed on the WHORL KEY, INSIDE OUT:
  // the heart opens first and the rim last. That puts the wave in step with the
  // ARRIVAL — the explode gate stages its fall by rank, seating low ranks
  // FIRST, so a petal that flies in early is the petal that folds early.
  // `stagger` is how much of the channel the wave spends and the window is the
  // remainder, so both identity ends stay exact.
  //
  // THE PETAL is a FOLD PATTERN and a hinge: flat facets separated by crisp
  // fold lines, a shallow tent with KINKS rather than the smooth arc a
  // curvature profile alone can make. The chain walks ACROSS the wedge (the
  // material coordinate d is angular), so a fold in the chain is a crease
  // running ALONG the petal, base to tip. Segments, from the seam:
  //   • a seated base run (q = 1) — the petal stays attached to its whorl;
  //   • side panel, CREASE, centre panel, CREASE, side panel — all three flat,
  //     the two folds carrying the turn the panels no longer do. `crease`
  //     states the fold in RADIANS beyond the seated barrel, so the product
  //     with halfSpan puts the seated turn on the hard lines at crease = 1. The
  //     base run and bands ride on top, so the SECTOR break-even is lower.
  //   • a reflex CREASE and the flat tab beyond it — the corner flick, keyed on
  //     the axial fraction (ROSE_FLICK_*) so it is a triangular fang at the
  //     petal's free corners rather than a hem down the whole edge.
  //   • `tilt` about a shared axial hinge station INSIDE the barrel's own
  //     extent. The station is load-bearing: radial displacement is
  //     (y − hinge)·sin a, so a station BEHIND the model puts every lever arm
  //     on one sign and the tilt degenerates to a bodily outward slide. Inside
  //     the extent the sign flips mid-piece — front edge out, rear edge in, a
  //     hinge. `taper` opens outer whorls further, so the centre still cups.
  //   • `spread` + `orbit` — the petal slides off its whorl with a light
  //     phyllotaxis twist. `spin` stays small (it opens sightlines faster than
  //     it opens the flower); `open` separates an over-folded whorl's faceted
  //     cone into distinct petals while the layers beneath close the gap.
  const rose: Recipe<S> = {
    name: "rose",
    // A bare gate, peel's reasoning: no stagger of its own (the `during` window
    // IS the stagger), the house split so channel 0 keeps the stick denominator
    // positive and the identity exact.
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
      // THE FOLD PATTERN's material budget, per piece. `base` is the seated run
      // and `facet` the flicked tab beyond the last fold; the tent divides what
      // is left, `creasePos` of it as the centre panel. Each panel gives up one
      // crease band, so the segments sum to L. The max(0, …) is the guard
      // KNOB_LIMITS cannot give: a negative arc length walks the chain
      // BACKWARDS. Built ONCE per piece, or six segments become six subgraphs.
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
        // THE TIER. Every whorl hinges off the SAME receptacle station, so
        // without a rank-keyed axial step every rank reaches the same height
        // and the outermost rim hides the rest in profile. The step turns the
        // nest into a dome, which makes each rank readable from the side.
        //
        // ANCHORED AT THE HEART (`1 − 2·whorl`): innermost ranks take `+rise`,
        // outermost `−rise`, so the rim hangs a full `rise` BELOW the heart —
        // `rise` is the tier's HALF depth. Lifting the core instead climbs away
        // from a glass column that is barred from the cast and never travels,
        // baring the rear elements; the rim's own drop is what covers them.
        //
        // OUTSIDE the whorl wave, deliberately: gated by the `during` window
        // the dome would assemble last, where the pose least needs it. LAST in
        // the chain, so it is a clean axial lift rather than a longer lever on
        // the hinge the tilt then swings.
        group<S>([
          selSheet(A),
          approach<S>(A.mul(knobs.rise, A.sub(1, A.mul(whorl, 2)))),
        ]),
      ];
    },
    // Physical units: fractions of L (base, facet), fraction of the tent's own
    // material (creasePos), multiples of the piece's half-span (crease),
    // radians (curl, lift, spin), model-mm (hinge, rise), fractions of R
    // (open), channel share (stagger). All taste knobs, tuned on the /lens
    // bench where the "Rose bloom" animation hands each one a slider.
    knobDefaults: {
      stagger: 0.34,
      base: 0.1, // the seated run, before the petal's folds start
      facet: 0.22, // the flicked tab beyond the last fold — the fang's length
      // 1 puts exactly the petal's seated turn on the two hard lines. Past the
      // sector break-even a petal is NARROWER than its share of the ring, which
      // is what breaks a whorl's continuous faceted cone into separate petals.
      crease: 1.24,
      creasePos: 0.42,
      band: ROSE_CREASE_DEFAULT_MM,
      curl: 1.5, // the flick's reflex angle at the free corners
      lift: 1.34,
      taper: 0.7,
      // INSIDE the barrel's own axial extent, which is what makes this a hinge
      // rather than a lever — see `tilt` in the recipe header.
      hinge: 20,
      // The slide SEPARATES over-folded petals rather than opening the ring.
      // The nest must stay closed at mid-bloom and full open (no background
      // through the whorls); that gap closure is a floor, not a preference.
      open: 0.15,
      spin: 0.25,
      // The tier's HALF depth: +rise at the heart, −rise at the rim. The rim
      // must still reach past the bottom of the barred glass column, or the
      // rear elements stand bare in a side view.
      rise: 22,
    },
  };

  return { assemble, explode, peel, rose };
}
