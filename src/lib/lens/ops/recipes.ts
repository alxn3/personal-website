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
  coil,
  group,
  ladder,
  orbit,
  rot,
  selFront,
  selRank,
  selSector,
  spread,
  stickPress,
  swirl,
  twist,
  type OpCtx,
  type OpItem,
} from "./ops";
import {
  foldOps,
  memoCtx,
  rollStepOps,
  selNotAccessory,
  selNotOptical,
  selSheet,
} from "./house";

// Written out rather than taken from Math: a recipe is pure algebra, and these
// end up as shader literals.
const TAU = 6.283185307179586;
const PI = 3.141592653589793;

// ── ASSEMBLE constants (formation.ts:111-176, 297-307) ─────────────────────
const ASSEMBLE_SNAP_EXP = 2.0; // softer snap than helix (2.4)
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
// The house split (rollout and the bend lab use the same 0.95). It must stay
// BELOW rollEnd + overlap: at split = 1 the stick ramp's denominator
// (rollEnd − split + overlap) is exactly 0, so the seated state (win = 1)
// computes stick = 0/0 = NaN where it must be exactly 1 — the identity anchor.
const EXPLODE_SPLIT = 0.95;
const EXPLODE_SNAP_EXP = 2.0;

// ── HELIX constants (formation.ts:82-109, 287-295) ─────────────────────────
const HELIX_LAYER_STAGGER = 0.55;
const HELIX_PART_STAGGER = 0.08;
const HELIX_WINDOW = 0.35;
const HELIX_SPLIT = 0.7;
const HELIX_SNAP_EXP = 2.4;
const HELIX_PITCH_MM = -18; // rearward axial spread per rank — a LOW-pitch helix
const HELIX_COIL_SHEAR = 0.6; // helical shear (rad) across the panel's axial extent
const HELIX_STICK_BLEND = 0.35; // S-bend width as a fraction of the panel
const HELIX_STICK_FROM = 1; // +1 plants the FRONT (+Y) end first

// ── ROLLOUT constants (formation.ts:188-199, 309-316) ──────────────────────
const ROLLOUT_SPLIT = 0.95;
const ROLLOUT_SNAP_EXP = 2.0; // inert at snap 0, kept for the gate signature
const ROLLOUT_MASK_FEATHER = 0.3;
const ROLLOUT_RANK_FEATHER = 0.1;

// ── BEND-LAB constants (formation.ts:213-217, 321-327) ─────────────────────
const BEND_SPLIT = 0.95;
const BEND_SNAP_EXP = 2.0;

// ── SCRATCH constants — the house bench gate, same reasoning as BEND's ──────
const SCRATCH_SPLIT = 0.95;
const SCRATCH_SNAP_EXP = 2.0;

/** Every recipe channel there is: the five authored recipes below plus `scratch`,
 *  the owner's editable bench — a recipe in every respect, kept deliberately
 *  empty of choreography so a new motion can be tried in it directly. */
export type RecipeName =
  "assemble" | "explode" | "helix" | "rollout" | "bend" | "scratch";

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
        // reference, not a default.
        spread<S>(knobs.dilate),
        spread<S>(knobs.sep),
        orbit<S>(A.mul(knobs.spin, ctx.wrapDir)),
      ]),
      ladder<S>("attr", knobs.axialGain),
    ],
    knobDefaults: { dilate: 2.4, sep: 0.55, axialGain: 0.4, spin: 0.06 },
  };

  const helix: Recipe<S> = {
    name: "helix",
    gateSpec: (knobs) => ({
      layerStagger: HELIX_LAYER_STAGGER,
      partStagger: HELIX_PART_STAGGER,
      windowFrac: HELIX_WINDOW,
      split: HELIX_SPLIT,
      snap: knobs.snap,
      snapExp: HELIX_SNAP_EXP,
      // no overlap — the flight completes before the tape-down starts
    }),
    build: (ctx, knobs) => [
      approach<S>(knobs.approach, HELIX_PITCH_MM),
      orbit<S>(A.mul(A.mul(knobs.turns, TAU), ctx.wrapDir)), // turns → radians
      spread<S>(knobs.spread),
      coil<S>(knobs.coil),
      twist<S>(HELIX_COIL_SHEAR),
      stickPress<S>(knobs.hover, HELIX_STICK_BLEND, HELIX_STICK_FROM),
    ],
    knobDefaults: {
      approach: -45,
      turns: 0.85,
      spread: 0.45,
      coil: 0.5,
      hover: 4,
      snap: 0.65,
    },
  };

  const rollout: Recipe<S> = {
    name: "rollout",
    gateSpec: (knobs) => ({
      layerStagger: knobs.stagger,
      windowFrac: A.sub(1, knobs.stagger), // derived, as in assemble
      split: ROLLOUT_SPLIT,
      snap: 0, // plain smoothstep
      snapExp: ROLLOUT_SNAP_EXP,
      // no overlap — the rollout reads only flight (stick is unused)
    }),
    build: (_ctx, knobs) => [
      // Both masks default fully open, and both bypass EXACTLY at 1, so an
      // untouched rollout is a true identity.
      selSector<S>(knobs.maskCenter, knobs.maskWidth, ROLLOUT_MASK_FEATHER),
      selRank<S>(knobs.rankLo, knobs.rankHi, ROLLOUT_RANK_FEATHER),
      // The peel itself: anchor on the seam and walk a travelling κ step.
      ...rollStepOps(A),
    ],
    knobDefaults: {
      stagger: 0.45,
      maskCenter: 0,
      maskWidth: TAU,
      rankLo: 0,
      rankHi: 1,
    },
  };

  const bendLab: Recipe<S> = {
    name: "bend",
    // No stagger — every piece folds on the shared scrub. It is a bench, not a
    // choreography.
    gateSpec: () => ({
      layerStagger: 0,
      windowFrac: 1,
      split: BEND_SPLIT,
      snap: 0,
      snapExp: BEND_SNAP_EXP,
    }),
    build: (_ctx, knobs) =>
      foldOps(A, {
        pos: knobs.pos,
        radius: knobs.radius,
        angle: knobs.angle,
        spikes: knobs.spikes,
      }),
    knobDefaults: { pos: 0.45, radius: 14, angle: -2.4, spikes: 1 },
  };

  // ── SCRATCH ───────────────────────────────────────────────────────────────
  // The owner's directly-editable bench: change the pipeline here, save, HMR
  // reloads. A bench, not a choreography — no stagger, the whole model on one
  // scrub, so what a new op does is visible on its own. The three knobs below
  // are whatever the current experiment needs; the /lens "Scratch" animation
  // (animations.ts) hands them sliders, so renaming one is a two-file edit.
  //
  // To stage part of an experiment against the rest, swap a `group` for a
  // `during`: `during({ from: 0.5 }, [ … ])` holds its subtree seated for the
  // first half of the scrub and plays it over the second.
  const scratch: Recipe<S> = {
    name: "scratch",
    gateSpec: () => ({
      layerStagger: 0,
      windowFrac: 1,
      split: SCRATCH_SPLIT,
      snap: 0,
      snapExp: SCRATCH_SNAP_EXP,
    }),
    build: (ctx, knobs) => [
      group<S>([
        selSheet(A),
        // A BEND CHAIN, spelled out — aim, anchor, arcs. `rot` turns the working
        // direction and moves nothing; one half-span off the piece's own
        // meridian is the seam, which is where a sheet's material coordinate
        // starts. `anchor` puts the chain there and loads the cursor with this
        // vertex's material; each `arc` spends some of it at a constant
        // curvature (q = R·κ: 1 is the seated barrel, 0 flat), and the last one
        // — no length — takes whatever is left.
        rot<S>((c) => c.halfSpan),
        anchor<S>(),
        arc<S>(1, (c) => A.mul(c.L, 0.45)), // seated lead
        // The crease: it flattens out of the barrel as the scrub runs, so at
        // channel 0 (flight 0) q is exactly 1 and the chain is the seated arc.
        arc<S>(
          (c) => A.sub(1, c.flight),
          (c) => A.mul(c.L, 0.2),
        ),
        arc<S>(1), // seated tail (unbounded)
        // Spend the seam aim again: `spread` below slides along the WORKING
        // direction, and the bench wants it along the sector centre.
        rot<S>((c) => A.neg(c.halfSpan)),
        spread<S>(knobs.spread),
        orbit<S>(A.mul(knobs.turn, ctx.wrapDir)),
      ]),
      ladder<S>("attr", knobs.depth),
    ],
    knobDefaults: { spread: 0.5, turn: 0, depth: 0.4 },
  };

  return { assemble, explode, helix, rollout, bend: bendLab, scratch };
}
