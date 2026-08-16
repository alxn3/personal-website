// The recipes — the whole motion vocabulary, expressed as channel-gated op
// pipelines over the scalar algebra. A recipe is three things and nothing else:
//
//   gateSpec(knobs) → the two-phase window this channel plays through
//   build(ctx, knobs) → the ORDERED op list (the recipe IS its order)
//   knobDefaults → the physical values the host binds as uniforms
//
// The knob defaults are PHYSICAL values — radians, model-mm and fractions of R
// — not slider positions; mapping a 0..100 UI onto them is the host's business.
//
// gateSpec is a FUNCTION of the knobs because the assemble gate's stagger,
// part-stagger, split, overlap and snap are LIVE sliders as well as gate
// inputs; a static spec could only ever bake the defaults. The window is
// DERIVED (1 − stagger − partStagger) so offset + window ≡ 1 for any slider
// value, which is what keeps the channel-0 identity exact.
//
// `build` receives the piece ctx for symmetry with the ops (and so a future
// recipe can specialize per piece). Every op reads ctx when it RUNS; the only
// thing the recipes read at BUILD time is `ctx.wrapDir`, which is a plain
// number on both backends (the seam handedness is a house constant, not a
// per-piece measurement) — that is what lets a recipe fix the SIGN of a rotation
// at the call site instead of every rotation op inheriting the wrap convention.

import type { Algebra } from "./algebra";
import type { GateSpec } from "./gate";
import {
  anchor,
  approach,
  arc,
  crease,
  during,
  group,
  ladder,
  orbit,
  rot,
  selFront,
  selRank,
  selSector,
  spread,
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
  stickerPeelOps,
} from "./house";

// Written out rather than taken from Math: a recipe is pure algebra, and these
// end up as shader literals.
const TAU = 6.283185307179586;
const PI = 3.141592653589793;

// ── ASSEMBLE constants (formation.ts:111-176, 297-307) ─────────────────────
const ASSEMBLE_SNAP_EXP = 2.0;
const ASSEMBLE_FLIGHT_START = 0.1; // the classic's per-shell fly-in foot
const ASSEMBLE_ROLL_END = 0.9; // the curl finishes, THEN the sheet breathes
const ASSEMBLE_SWIRL_EXP = 0.65; // the classic's pow(t, 0.65)
const ASSEMBLE_WRAP_SHEAR = 0.9; // diagonal roll front (corner peel)
const ASSEMBLE_MASK_FEATHER = 0.3; // sector-edge softening (rad)
const ASSEMBLE_CURL_MAX = PI; // cap on the end-roll — past a half turn it hides
const ASSEMBLE_PIN_END = 0.25; // the reel-in pin is spent by 25% stuck
const ASSEMBLE_LADDER_GAIN = 0.4; // rung → model-mm, scaled by the depth knob

// ── EXPLODE constants (the NEW recipe — no classic to match) ────────────────
const EXPLODE_LAYER_STAGGER = 0.3;
const EXPLODE_WINDOW = 0.7;
// The house split (the peel's gate takes the same 0.95). It must stay
// BELOW rollEnd + overlap: at split = 1 the stick ramp's denominator
// (rollEnd − split + overlap) is exactly 0, so the seated state (win = 1)
// computes stick = 0/0 = NaN where it must be exactly 1 — the identity anchor.
const EXPLODE_SPLIT = 0.95;
const EXPLODE_SNAP_EXP = 2.0;

// ── PEEL gate constants — the travelling-front shape the retired `rollout`
// recipe shared with it (formation.ts:188-199). Inert at snap 0, but the gate
// signature still takes an exponent.
const PEEL_SPLIT = 0.95;
const PEEL_SNAP_EXP = 2.0;
/** the peel's own rank feather — see the peel recipe's selRank comment */
const PEEL_RANK_FEATHER = 0.005;

// ── PEEL constants — the story's sticker peel ──────────────────────────────
// q of the freed run, INVERTED (ops/house stickerPeelOps negates it). 1 would
// unroll to a mirror of the seated barrel; above 1 the lip rolls BACK tighter
// than the shell it came off, which is what reads as a sticker rather than as an
// unwrapped tube. Tuned live against the peel scene.
const PEEL_CURL = 2.6;

// ── ROSE constants — the origami-bloom prototype's gate, bare like peel's:
// the wave is a `during` window keyed on the whorl key, not the gate's own
// staggers.
const ROSE_SPLIT = 0.95;
const ROSE_SNAP_EXP = 2.0;
// THE WHORL KEY's exponent. rank01 is normalised over the model's WHOLE radius
// range, and on this lens every shell that reads as a petal lives in its top
// eighth: the barrel/cam/chassis/band skins sit at R 27–31 of a 31mm model
// (rank01 0.87…1), everything below rank 0.8 is internal hardware. A linear key
// therefore spends the wave on parts nobody sees and hands the visible whorls
// nearly the SAME value — no bloom order, no tier, no matter how the knobs are
// turned. rank01^8 spreads that top band over 0.34…1 and collapses the rest
// toward 0, so the wave, the taper and the tier all key on what is on screen.
const ROSE_WHORL_EXP = 8;
// THE CREASE BAND's default, model-mm of material each hard fold is taken
// over — a KNOB now (`band`), because the right width is a trade: narrow
// reads as a drawn knife line, but the fold's radius is ≈ band/fold-angle,
// and where that radius drops below a shell's WALL THICKNESS the inner
// surface has less arc than it needs and folds past the fold's centre — the
// owner's "overlap at the crease" on thick panels. Widening the band past
// the wall thickness clears it (paper cannot fold tighter than its thickness
// either). Zero would divide (crease's width is a denominator) — the knob is
// in KNOB_LIMITS with a hard floor.
const ROSE_CREASE_DEFAULT_MM = 1.2;
// The corner FLICK's axial ramp: the reflex fold is absent over the petal's
// seated half and full at its free tip, which is what makes the fold-back a
// triangular fang at the corner instead of a hem down the whole edge. Bounds
// are on yN + 0.5 (0 at the rear edge, 1 at the front).
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
  // THE HOUSE SELECTORS (selSheet / selNotAccessory / selNotOptical) and the
  // roll-step / fold bend CHAINS live in ops/house.ts — the shared vocabulary
  // every recipe here composes from.
  //
  // (the derivations that used to sit here are in that file, unchanged)
  //
  // ── the ASSEMBLE wrap's terms (formation.ts:850-903, verbatim) ────────────
  // The chain itself is four ops in the pipeline below; these are the numbers it
  // walks on. Every read is of the EFFECTIVE ctx — flight and stick already
  // folded through the active selection weight — because `walk` hands the whole
  // chain one effective ctx and MEMOIZES this derivation on it: the six ops that
  // read these terms build them ONCE, which is the difference between one
  // subgraph and six in the compiled shader (TSL has no CSE across node
  // objects).
  //
  // Terms, in order: a breathing barrel (the sheet swells as it homes), a
  // counter-rotating seam re-aim, the diagonal shear front that varies the
  // rolled length with axial height, and the end-roll itself (capped at CURL_MAX
  // of material, curvature reversed).
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
        // With NO roll left the main arc must carry the overrun too: extend it
        // past any vertex (the classic's step-gate on intoRoll).
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
    // THE DEFAULT SELECTION. The shrink-wrap runs on the segmented shells and
    // whatever rides them; the tier ladder moves every piece. Without that
    // split the glass column, the iris mechanism and every
    // axisymmetric ring throw and swirl alongside the shells and the reassembly
    // reads as chaos instead of a layer-by-layer wrap-on. So the whole sheet
    // pipeline lives inside ONE group scoped by `selSheet` (see its derivation
    // above), and the ladder sits OUTSIDE it, unmasked.
    build: (_ctx, knobs) => {
      const wrap = wrapTerms(knobs);
      return [
        group<S>([
          // Optional sector solo, fully open by default (width ≥ TAU ⇒ exactly 1).
          // INSIDE the group on purpose: the classic mask gated the shader flight
          // only, never the rig ladder, so a soloed sector must not strand the
          // rest of the model off its rung.
          selSector<S>(
            knobs.maskCenter,
            knobs.maskWidth,
            ASSEMBLE_MASK_FEATHER,
          ),
          // Adopted shell hardware (screws, motor) carries the adopted flag, so it
          // stays in this set and flies with its wedge — the classic's stamped
          // behaviour. Glass, the iris mechanism, accessories, full rings and
          // every axisymmetric solid fall out and ride the ladder alone.
          selSheet(A),
          // THE WRAP, the sheet's own shape, first: the chain rebuilds
          // theta/radius from the material coordinate, so every transform after
          // it moves the BENT sheet. Aim at the seam, anchor the chain on the
          // breathing barrel, then walk three arcs — the main (nearly seated)
          // arc, the reversed end-roll of which only `curlRamp` of the material
          // actually bends, and a straight tail for whatever is left.
          rot<S>((c) => wrap(c).seamTurn),
          anchor<S>((c) => wrap(c).Rb),
          arc<S>(
            (c) => wrap(c).qMain,
            (c) => wrap(c).mainLen,
          ),
          // participation = curlRamp is the wrap's own law: only that share of
          // the roll's material bends, the rest trails straight off the exit
          // tangent (a pure κ(d) replica diverged by up to 7.5mm).
          arc<S>(
            (c) => wrap(c).qRoll,
            (c) => wrap(c).curlLen,
            { participation: (c) => wrap(c).curlRamp },
          ),
          arc<S>(0),
          // Put the PIECE's direction back on its own meridian. A re-aim threads
          // forward like every other piece of state, and `sep` below is a slide
          // along the sector centre, not along the seam — so the chain's aim has
          // to be spent explicitly rather than scoped away.
          rot<S>((c) => A.neg(wrap(c).seamTurn)),
          // sep — the slow unpinned slide along the sector centre (uSeparate).
          spread<S>(knobs.sep),
          // The REEL-IN group: the fast throw along the seam meridian and the
          // fly-in swirl both home by 25% stuck. In the classic that was a
          // `pinned` flag on each op; here it is one material selector scoping
          // both — safe ONLY because stick is a PER-PIECE quantity (it comes from
          // the gate, which reads per-piece rank/phase), so the group's weight is
          // uniform across the piece's vertices exactly as the flag was. A
          // per-VERTEX selector here would scale the two rigid motions per vertex
          // and tear the piece apart.
          group<S>([
            selFront<S>((c) =>
              A.sub(1, A.smoothstep(0, ASSEMBLE_PIN_END, c.stick)),
            ),
            // Aim the throw down the SEAM meridian — one halfSpan off the seat,
            // the same turn the chain above took and gave back. The re-aim
            // threads forward out of this group, which nothing after it reads
            // (the ladder is axial).
            rot<S>((c) => c.halfSpan),
            spread<S>(knobs.spreadThrow),
            swirl<S>(knobs.swirl, {
              exp: ASSEMBLE_SWIRL_EXP,
              rankScale: true,
            }),
          ]),
        ]),
        // Axial depth from the rig's tier ladder, scaled by the Depth slider —
        // UNSCOPED, so the axial choreography covers the whole model exactly as
        // the classic rig ladder did.
        ladder<S>("attr", A.mul(ASSEMBLE_LADDER_GAIN, knobs.depth)),
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
      stagger: 0.6,
      partStagger: 0,
      split: 0.95,
      overlap: 0.9,
      snap: 0,
      maskCenter: 0,
      maskWidth: TAU,
    },
  };

  const explode: Recipe<S> = {
    name: "explode",
    // A near-uniform gate: a light rank stagger and a wide window, no snap. The
    // flight ramp owns all but the last 5% of the window and nothing in this
    // pipeline reads stick — but the split still keeps the stick denominator
    // positive so the channel-0 identity is exact rather than NaN. All five
    // numbers (and the knob defaults) are WAVE-3 TUNING TARGETS: they get set
    // against the reference teardown shots at the visual gate.
    gateSpec: () => ({
      layerStagger: EXPLODE_LAYER_STAGGER,
      windowFrac: EXPLODE_WINDOW,
      split: EXPLODE_SPLIT,
      snap: 0,
      snapExp: EXPLODE_SNAP_EXP,
    }),
    // THE DEFAULT SELECTION, in assemble's own idiom: an exemption is a
    // per-recipe DEFAULT SELECTION, not a flag baked into the ops (spec
    // decision 4). Two scopes, from the classic teardown's own behaviour:
    //
    //   1. A selector at the pipeline HEAD drops accessories from everything,
    //      the ladder included — they are removable attachments, not parts of
    //      the teardown (see selNotAccessory).
    //   2. A group scopes the three RADIAL ops away from glass and the iris
    //      mechanism, which the classic moved on the axial ladder ALONE.
    //
    // The ladder therefore sits OUTSIDE the group (accessories excluded, the
    // optics still on it) exactly as assemble's does. Moving it past the orbit
    // is motion-neutral: it only ever adds to `axial`, and no op here reads
    // `axial` — the whole pipeline is radial-plane work plus this one slide.
    build: (ctx, knobs) => [
      selNotAccessory(A),
      group<S>([
        selNotOptical(A),
        // The dilation: every piece pushes out along its own sector centre. A
        // plain dilate, deliberately unstaggered — a per-rank stagger
        // ((dilate + (rank01 − 0.5)·1.1)) is a tuning to make against
        // reference, not a default. dilate and sep are ONE spread: consecutive
        // spreads compose additively (displacement is linear in frac), and the
        // fused form skips a full polar round-trip per vertex (2 atan2 + 2
        // sqrt); both knobs stay independently tunable inside the add.
        spread<S>(A.add(knobs.dilate, knobs.sep)),
        // THE SPIRAL. `orbit`'s angle is `flight × spin`, so this is a rigid
        // revolution about the bore that is FULL at channel 1 and exactly 0 at
        // channel 0 — per piece, on the same gate that stages the radius. A
        // piece therefore does not slide straight in as the channel falls: it
        // sweeps round as it comes, and every piece unwinds on its own window.
        // The story's ending is what the angle is tuned for (owner: "the pieces
        // to fly in in a spiral") — it plays there with nothing else turning,
        // the model's own reveal roll being spent a beat earlier. It winds UP
        // invisibly: the channel's rise is under the sky chapter's body cover,
        // and a rigid revolution of the whole cast has no read of its own once
        // established, so only the unwind is ever seen.
        orbit<S>(A.mul(knobs.spin, ctx.wrapDir)),
      ]),
      ladder<S>("attr", knobs.axialGain),
    ],
    // spin 0.7 rad ≈ 40° of sweep per piece, UP from a token 0.06 (3.4°, which
    // read as nothing). THE taste knob for the spiral; it feeds no gate divisor,
    // so it is unbounded and safe to retune. The /lens explode slider wears it
    // too — the teardown swirls now, which is the classic's own behaviour.
    knobDefaults: { dilate: 2.4, sep: 0.55, axialGain: 0.4, spin: 0.7 },
  };

  // The STORY's shell peel — the STICKER chain (ops/house stickerPeelOps),
  // scoped so glass/iris/accessories and axisymmetric bodies can never unroll;
  // the shell cast (sub-span wedges + decals at the outer ranks) is the only
  // participant.
  //
  // THE BAND, RE-MEASURED off the shipped model's baked `_opA.w` (rank01 is a
  // 0.01 mm bucket of each piece's MEDIAN vertex radius, frames.ts rankKeyOf —
  // these were read off a live `__lensModel` walk under `?probe`; the same
  // numbers are now reachable offline through story/__tests__/piece-flow.test.ts,
  // which reads the shipped vertices directly). THE WHOLE SHELL CAST, all 25 wedges
  // and all 18 markings, and the two casts either side of it for context —
  // `selRank`'s weight at rankLo 0.97 / feather 0.005 in the last column:
  //
  //     rank     R mm   pieces                                     weight
  //     1.00000  30.80  Band_Mid_Seg2/3 + 4 decals                  1
  //     0.99931  30.78  Ring_Focus_Seg0..4                          1
  //     0.99550  30.67  Band_Mid_Seg4 + DecalT_Brand/_Serial        1
  //     0.99516  30.66  Band_Mid_Seg0/1                             1
  //   ← rankLo 0.97, feather 0.005: the ramp is [0.965, 0.970]
  //     0.96990  29.93  Ring_Zoom_Seg1/4 + DecalT_MinF/_Zoom_50     0.9987
  //     0.96955  29.92  Ring_Zoom_Seg0/2/3 + 5 decals               0.9772
  //     0.95329  29.45  Barrel_Base_Seg0..4 + 2 decals              0
  //     0.93772  29.00  Chassis_Fixed_Seg0..4 (+ the adopted        0
  //                       Focus_Motor / Focus_GuideRods)
  //     0.91903  28.46  Cam_Barrel_Seg0..6 — seven distinct ranks   0
  //       …0.89273  27.70   INTERLEAVED with the four below
  //     0.89965  27.90  Barrel_Inner_Seg0/3 + 3 decals              0
  //     0.89896  27.88  Barrel_Inner_Seg1                           0
  //     0.88581  27.50  Barrel_Inner_Seg2                           0
  //     0.88270  27.41  Barrel_Inner_Seg4                           0
  //
  // SO THE HARD LOW EDGE IS WHAT MAKES THE CAST, and not by a comfortable
  // margin: rankLo 0.97 lands INSIDE the Ring_Zoom pair. Something DOES live in
  // the feather's reach [0.965, 0.970] — five wedges and seven markings, curling
  // at 0.9772 and 0.9987 rather than at 1, which is a couple of percent of a
  // curl and reads as nothing.
  //
  // AND THAT IS THE WHOLE REASON FOR THE TIGHT FEATHER, rather than the house
  // 0.1 the other recipes take: the gap the edge has to fit in is [0.95329,
  // 0.96955], only 0.016 wide, so a ramp broad enough to pass Ring_Zoom at a
  // flat 1 necessarily reaches past Barrel_Base as well. Measured at feather
  // 0.1: Ring_Zoom 1.0000 but Barrel_Base 0.9255, Chassis_Fixed 0.7546,
  // Cam_Barrel_Seg1 0.4855, Barrel_Inner 0.04–0.21 — half the mechanism on some
  // fraction of a curl. The 0.005 feather buys a clean stop above 0.95329 for
  // the price of those two hundredths.
  //
  // WHAT THEREFORE DOES NOT CURL, though it all drifts away rigidly with the
  // shell cast (story/peelcards.ts): `Barrel_Base` (5) and `Barrel_Inner` (5),
  // plus the 5 markings printed on them. Barrel_Inner is the surprise and the
  // reason is the METRIC: it reaches the outer radius at its lip like the rest
  // of the skin, but it carries the whole inner surface of the barrel too, so
  // its MEDIAN vertex radius (27.4–27.9 mm) drops it below Chassis_Fixed and
  // in among Cam_Barrel — a shell part ranked inside the cladding. Every decal
  // shares its host's rank EXACTLY (frames.ts binds them to a host wedge), so a
  // marking always curls with the wedge it is printed on and no ink is ever
  // left floating. Widening the band to take Barrel_Base needs rankLo ≈ 0.95;
  // taking Barrel_Inner as well needs ≈ 0.88, which is under Cam_Barrel and
  // Chassis_Fixed both — a different cast, not a wider one.
  //
  // THE STICKER CHAIN, not the flat unroll the retired `rollout` recipe used:
  // a wedge half-peeled flat reads as a plate hovering off the barrel rather
  // than as something coming OFF it. The sticker chain frees the same material
  // at −PEEL_CURL instead — the lip inverts at the crease and the freed body
  // rolls back away from the shell, which is the gesture the scene is about.
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
    // ONE `during` scope, which is a group in assemble's idiom: the
    // participation selectors scope the peel chain and nothing else, so a term
    // added to this pipeline after it (an axial slide, a drift) moves the whole
    // model unless it says otherwise. Selectors FIRST inside it — `arc` is a
    // modifier, and a spatial selector after one reads a stale frame
    // (validatePipeline).
    //
    // THE STAGGER IS THE `during` WINDOW, not the gate's. The gate staggers on
    // `rank01` and `layerPhase`, and BOTH are degenerate on the peel's cast:
    //
    //   • the cast IS the outer skin, so every piece of it measures rank01
    //     within 0.07 of 1 — a rank-keyed offset spreads the departures over
    //     seven percent of one window;
    //   • the 0.01mm rank bucket puts most wedges in a layer of ONE (measured on
    //     the shipped model: 68 of its 100 layers are singletons), and a layer of
    //     one has layerPhase 0 by construction.
    //
    // Raise either knob and the whole shell still leaves as one block. So the
    // fan is keyed on the piece's MERIDIAN, which is the one intrinsic that
    // really does separate them — `peelOrder`, 0 → 1 once around the barrel in
    // the house winding direction. The five families of a sector share a window
    // and the sectors go one after another, so the skin peels AROUND the lens
    // and each sector's column is free before the next one starts. `stagger` is
    // how much of the channel the fan spends and the window is the remainder, so
    // `from` ≥ 0 and the last piece's `to` is exactly 1: both identity ends stay
    // exact.
    //
    // (story/peelcards.ts's outward drift keys its own windows on the SAME
    // peelOrder, so a strip leaves on the heels of its own unroll rather than on
    // somebody else's.)
    build: (ctx, knobs) => {
      const from = A.mul(peelOrder(A, ctx.t0, ctx.wrapDir), knobs.stagger);
      return [
        during<S>({ from, to: A.add(from, A.sub(1, knobs.stagger)) }, [
          selSheet(A),
          // The band IS the scope, and its low edge is SHARP
          // (PEEL_RANK_FEATHER — a house 0.1 feather is far too wide here).
          // The wide default feather once reached a whole layer below the
          // band, and everything ADOPTED onto that layer (frames.ts
          // SHELL_ADOPT copies the host's rank) rode the unroll at near-full
          // weight and snapped home on the channel's release (owner-caught).
          // The feather's reach is [0.965, 0.97] and the nearest rank under it
          // is Barrel_Base at 0.9533 (the table above) — nothing lives in the
          // reach, so the peel keeps its hard edge.
          selRank<S>(knobs.rankLo, knobs.rankHi, PEEL_RANK_FEATHER),
          ...stickerPeelOps(A, knobs.curl),
        ]),
      ];
    },
    knobDefaults: { curl: PEEL_CURL, stagger: 0.72, rankLo: 0.97, rankHi: 1 },
  };

  // ── ROSE — the origami bloom (a LOOK prototype; no story wiring) ──────────
  // The model is already a rose in section: 8+ concentric wedge-cut whorls of
  // alternating 5- and 7-petal counts with offset seam meridians (the skin's
  // seg0 sits at −65.9°, the cam whorl's at −26.4° — ~39.5° of stagger between
  // adjacent whorls). `selSheet` admits exactly that nest — every sub-span
  // wedge, everything adopted onto one, every decal — and bars glass, the iris
  // mechanism, accessories and bodies of revolution. So the cast IS the flower;
  // this recipe only has to open it.
  //
  // THE BLOOM ORDER is the `during` window, keyed on the WHORL KEY (rank01
  // re-keyed by ROSE_WHORL_EXP — see its note: on this model the shells that
  // read as petals all sit in the top eighth of rank01, so the raw rank is not
  // a usable wave key even though it is non-degenerate) — INSIDE OUT: the heart
  // opens first and the rim last, petals of one whorl together. `stagger` is how
  // much of the channel the wave spends; the window is the remainder, so both
  // identity ends stay exact (from ≥ 0, last `to` = 1).
  //
  // INSIDE OUT IS THE OWNER'S DIRECTION ("build the rose up petal by petal
  // inside out"), and it is the way a real one opens — a bud's heart parts
  // before its outer whorls lie back. It also puts the wave in step with the
  // ARRIVAL: the explode channel's own gate stages its fall by `rank01 ×
  // layerStagger`, which seats low ranks FIRST, so a petal that flies in early
  // is the petal that folds early and the two read as one motion per piece
  // rather than as a landing followed by a bloom. The key is `whorl` itself
  // now, where it used to be `1 − whorl`; nothing else about the wave changed.
  //
  // THE PETAL is a FOLD PATTERN and a hinge. The reference photo (a folded
  // Kawasaki rose) shows each petal as a set of FLAT FACETS separated by crisp
  // fold lines — a central plane with side planes broken back at a hard
  // dihedral — so the petal's cross-section is a shallow tent with KINKS, not
  // the smooth arc a curvature profile alone can make. The chain walks ACROSS
  // the wedge (the material coordinate d is angular), so a fold line in the
  // chain is a crease running ALONG the petal, base to tip: exactly the
  // reference's creases. Segments, in material order from the seam:
  //   • a seated base run (q = 1) — the petal stays attached to its whorl;
  //   • side panel, CREASE, centre panel, CREASE, side panel — all three flat
  //     (q: 1 → 0) and the two folds carrying the turn the panels no longer do.
  //     `crease` states the fold in RADIANS beyond the seated barrel, so
  //     `crease · halfSpan` per fold puts exactly the seated turn onto the two
  //     hard lines at crease = 1 — but the seated base run and the bands' own
  //     seated turn ride on top, so the SECTOR break-even (petal covers what
  //     it was cut from) sits near crease ≈ 0.37 at the shipped panel splits;
  //     the shipped 1.24 over-folds to ~1.9× the sector, a tighter tent.
  //   • a reflex CREASE and the flat tab beyond it — the corner flick. Keyed on
  //     the axial fraction (ROSE_FLICK_*) so it is a triangular fang at the
  //     petal's free corners rather than a hem down the whole edge; `curl` is
  //     its angle. (This is where the prototype's rolled lip went: a rolled arc
  //     reads soft, and the photo's corners SNAP.)
  //   • `tilt` about a shared axial hinge station INSIDE the barrel's own
  //     extent — the petal falls open backward about a receptacle every petal
  //     grows from, the one motion the radial-plane algebra could not express.
  //     The station is load-bearing for the look: the radial displacement of a
  //     vertex is (y − hinge)·sin a, so a station behind the model (the
  //     prototype's −30) puts every vertex's lever arm on ONE sign and the
  //     tilt degenerates to a bodily outward slide. That slide costs three
  //     ways: the visible cast is flung into a wide annulus around the barred
  //     glass heart (the empty ring read as "gaps between the layers"); the
  //     slide is equal for equal y, so neighbouring whorls' radii collapse
  //     relative to their new size and the tier dies; and the tangential
  //     stretch (theta is never written — a whorl keeps its angular extent
  //     and stretches with the ring) varies along y, distorting each petal.
  //     A station inside the extent flips the lever-arm sign mid-piece: front
  //     edge out, rear edge in — a hinge.
  //     `taper` opens outer whorls further than inner ones, so at full bloom
  //     the centre still cups (a bud's heart) while the outer whorls lie back.
  //   • `spread` + `orbit` — the petal slides off its whorl and the bloom
  //     carries a light phyllotaxis twist in the house winding. `spin` stays
  //     small (it opens sightlines faster than it opens the flower), but
  //     `open` is no longer the tighten era's near-zero: an over-folded petal
  //     (crease > sector break-even) is NARROWER than its share of the ring,
  //     so the slide now separates a whorl's faceted cone into distinct
  //     overlapping petals while the layers beneath close what it opens —
  //     the knobDefaults comment carries the numbers.
  const rose: Recipe<S> = {
    name: "rose",
    // A bare gate, peel's reasoning: no stagger of its own (the `during`
    // window IS the stagger), the house split/snapExp so channel 0 keeps the
    // stick denominator positive and the identity exact.
    gateSpec: () => ({
      layerStagger: 0,
      windowFrac: 1,
      split: ROSE_SPLIT,
      snap: 0,
      snapExp: ROSE_SNAP_EXP,
    }),
    build: (ctx, knobs) => {
      // The WHORL KEY — rank01 re-keyed onto the shells that read as petals
      // (ROSE_WHORL_EXP). Everything rank-keyed in this recipe uses it.
      const whorl = A.pow(ctx.rank01, ROSE_WHORL_EXP);
      // INSIDE OUT: whorl 0 (the heart) opens at from = 0, whorl 1 (the rim) at
      // from = stagger — the reverse of the tightened bloom's outer-first wave.
      const from = A.mul(whorl, knobs.stagger);
      // The hinge angle, tapered by whorl depth: outer (whorl = 1) opens the
      // full `lift`, the innermost keeps (1 − taper) of it.
      const angle = A.mul(knobs.lift, A.mix(A.sub(1, knobs.taper), 1, whorl));
      // THE FOLD PATTERN's material budget, per piece. `base` is the seated run
      // and `facet` the flicked tab beyond the last fold; the tent divides what
      // is left — `creasePos` of it as the centre panel, the rest split evenly
      // between the two side panels. Each panel gives up one crease band, so
      // the segments still sum to L and the tab is the unbounded remainder.
      // max(0, …) is the guard the KNOB_LIMITS on `creasePos` cannot give: an
      // arc with a negative length would walk the chain BACKWARDS.
      // Built ONCE per piece for the whole chain (memoCtx — the GPU's only CSE):
      // six segments each re-deriving the same three terms would be six
      // subgraphs in the shader.
      const tent = memoCtx<S, { side: S; mid: S; flat: S; fold: S }>((c) => {
        const rest = A.mul(
          c.L,
          A.max(0, A.sub(A.sub(1, knobs.base), knobs.facet)),
        );
        const mid = A.mul(rest, knobs.creasePos);
        return {
          side: A.max(0, A.sub(A.mul(A.sub(rest, mid), 0.5), knobs.band)),
          mid: A.max(0, A.sub(mid, knobs.band)),
          // Flat at full flight, the seated barrel at rest — the identity every
          // chain op in the house shares.
          flat: A.mix(1, 0, c.flight),
          // Each side crease turns `crease` × the piece's OWN half-span, so a
          // 5-cut and a 7-cut whorl both refold onto their own sector instead
          // of one count being over-folded by a shared angle.
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
          // Spend the seam aim: tilt hinges in the meridian plane regardless,
          // but `spread` below slides along the working direction and the bloom
          // wants it down the sector centre.
          rot<S>((c) => A.neg(c.halfSpan)),
          tilt<S>(angle, { pivot: knobs.hinge }),
          spread<S>(knobs.open),
          orbit<S>(A.mul(knobs.spin, ctx.wrapDir)),
        ]),
        // THE TIER. Every whorl hinges off the SAME receptacle station, so
        // without this the ranks all reach the same height and the outermost
        // rim hides every rank inside it in profile: a rank-keyed axial step
        // turns the nest into a dome, and that is what makes each rank's
        // silhouette readable from the side.
        //
        // ANCHORED AT THE HEART (`1 − 2·whorl`): the innermost ranks — the
        // glass heart's neighbourhood, which the whorl key collapses to 0 —
        // take exactly `+rise`, and the outermost takes `−rise`, so the rim
        // hangs a full `rise` BELOW the heart's station instead of level with
        // it. The alternative anchor (`1 − whorl`, the tighten era's) lifted
        // the core off a glass column that is barred from the cast and so
        // never travels: the bloom climbed away from its own stem and the rear
        // elements stood bare under the flower's underside (~19 mm of column
        // below the lowest petal at these defaults). Dropping the WHOLE cast
        // instead would have cured that end and bared the front element at the
        // other; keying the drop to the rank cures it with the centre — heart,
        // cells and interior hardware, all at whorl ≈ 0 — held bit-for-bit
        // where the owner tuned it. The rim's own drop is what closes over the
        // rear stack. `rise` is therefore the tier's HALF depth now: heart-to-
        // rim spans 2·rise.
        //
        // OUTSIDE the whorl wave, deliberately: the `during` window is the
        // BLOOM ORDER, and a tier gated by it would only exist once a rank's
        // own window opened — the dome would assemble last, exactly where the
        // pose is least in need of it. On the channel's own flight the dome
        // steps up through the whole scrub, mid-bloom included. LAST in the
        // chain, so it is a clean lift along the axis rather than a longer
        // lever on the hinge the tilt then swings.
        group<S>([
          selSheet(A),
          approach<S>(A.mul(knobs.rise, A.sub(1, A.mul(whorl, 2)))),
        ]),
      ];
    },
    // Physical units: fractions of L (base, facet), fraction of the tent's own
    // material (creasePos), multiples of the piece's half-span (crease),
    // radians (curl, lift, spin), model-mm (hinge, rise), fractions of R
    // (open), channel share (stagger).
    // TASTE KNOBS, tuned live on the /lens bench (the "Rose bloom" animation
    // hands each a slider).
    knobDefaults: {
      stagger: 0.34,
      // OWNER-TUNED 2026-08-14 round 3 (was 0.18): a shorter seated run —
      // the petal's folds start closer to its whorl.
      base: 0.1,
      // the flicked tab beyond the last fold — the fang's own length
      facet: 0.22,
      // 1 = the two hard lines carry exactly the petal's seated turn; the
      // sector break-even (petal still covers what it was cut from) is lower,
      // ≈ 0.37, because the base run and the crease bands' own seated turn
      // ride on top. 1.24 over-folds to ~1.9× the sector — which is what
      // breaks a whorl's continuous faceted cone into separate petals (the
      // reference's own geometry: a folded petal is narrower than its share
      // of the ring, and the layers under it are what close the gap).
      crease: 1.24,
      creasePos: 0.42,
      band: ROSE_CREASE_DEFAULT_MM,
      // the flick's angle, radians of reflex at the free corners
      curl: 1.5,
      lift: 1.34,
      taper: 0.7,
      // INSIDE the barrel's own axial extent (the shells run y 1…76), which is
      // what makes this a hinge instead of a lever: the slide is
      // (y − hinge)·sin a, so at the prototype's −30 every lever arm shared a
      // sign and the whole whorl translated outward into a wide empty annulus
      // around the glass heart — the see-through gaps between layers. At 20
      // the sign flips mid-piece and the petal rotates in place.
      hinge: 20,
      // UP from the tightened bloom's 0.05, and the reversal is deliberate:
      // that value was the only thing holding the whorls closed while the
      // petals were smooth flattened plates, and a slide of 0.05·R was all the
      // ring could take. Over-folded petals (crease > 1) are narrower than
      // their sector, so the slide now SEPARATES them into petals instead of
      // opening the ring — and the shots at mid-bloom and full open show the
      // nest still closed (no background through the whorls), which is the
      // gap-closure floor this may not regress.
      // open 0.15, taper 0.7, rise 22: OWNER-TUNED on the bench (2026-08-14,
      // second round, off the slider readouts) AFTER the tier's re-anchor —
      // tuning inside the new mechanism was its visual sign-off.
      open: 0.15,
      spin: 0.25,
      // The tier's HALF depth (see the op): +rise at the heart, −rise at the
      // rim. At 22 the rim still reaches past the bottom of the barred glass
      // column (whose lowest point sits just below y 0), so the rear elements
      // stay buried in a side view — with less of the stretch the first-cut
      // ±38 gave the bloom.
      rise: 22,
    },
  };

  return { assemble, explode, peel, rose };
}
