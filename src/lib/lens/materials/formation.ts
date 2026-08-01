import {
  uniform,
  float,
  vec2,
  vec3,
  mix,
  min,
  max,
  pow,
  clamp,
  fract,
  smoothstep,
  step,
  atan,
  length,
  cos,
  sin,
} from "three/tsl";
// TSL `smoothstep` (above) builds shader graph; this numeric alias runs JS-side.
import { clamp01, smoothstep as smoothstepN } from "../core/math";

// Formation-op pipeline: composable parametric deformations of the SEATED wedge,
// baked into the bloom graph at compile time (materials/bloom.ts folds every
// PRESET below). Each preset gates on its OWN 0..1 channel and contributes
// EXACTLY zero when that channel is 0, so formations compose with the
// explode/unwrap/rewrap core without touching its semantics. A preset is an
// optional GENERATOR plus an ORDERED stack of transforms; application order is
// semantic (spread→coil ≠ coil→spread) and is the intended experiment surface.

const TAU = Math.PI * 2;
// Cap on the wrap roll (the classic peel's own CURL_MAX): past a half turn the
// flap trails straight back over the stuck part rather than winding a scroll.
const CURL_MAX = Math.PI;

// TSL nodes carry math methods the .d.ts doesn't declare; `any` is the escape hatch.
type Node = any;

/** The wedge parametric state threaded through a preset's ops. `rot` is the
 *  cumulative rotation about the optical axis that the NORMAL must follow. */
interface WedgeState {
  theta: Node; // meridian angle about the optical axis
  radius: Node; // distance from the optical axis
  y: Node; // axial coordinate
  rot: Node; // cumulative axis-rotation the normal tracks
}

/** Per-vertex seated quantities a preset needs, supplied by bloom's fields(). */
export interface SeatCtx {
  theta: Node; // seated meridian, atan2(z, x)
  r: Node; // seated radius, length(x, z)
  y: Node; // seated axial coord (p.y)
  phi: Node; // wedge-local angle off centre meridian
  yN: Node; // normalized axial coord
  R: Node; // seated shell radius
  rank01: Node; // shell radius rank 0..1
  t0: Node; // sector centre meridian
  halfSpan: Node; // wedge half-span (uSpan/2) — wrap's seam edge & span
  wrapDir: number; // peel/winding handedness (WRAP_DIR)
}

/** Read-only per-wedge context an op may read but never writes: the seated
 *  SeatCtx fields plus the gate's phase pair (flight: phase-1 spread state,
 *  0 seated .. 1 fully spread; stick: phase-2 tape-down progress, 0 pre-tape
 *  .. 1 flush). */
type FormationCtx = SeatCtx & { flight: Node; stick: Node };

type OpClass = "frame-free" | "seat-anchored";
interface FormationOp {
  name: string; // for the advisory ordering warning
  cls: OpClass;
  run(state: WedgeState, ctx: FormationCtx): WedgeState;
}

/** A GENERATOR builds the wedge state from context (only the wall offset comes
 *  in), so it must run FIRST; its distinct signature keeps it out of a preset's
 *  `ops` list, making a mis-ordered stack unrepresentable. */
type FormationGenerator = (off: Node, ctx: FormationCtx) => WedgeState;

// ── HELIX ASSEMBLE formation ─────────────────────────────────────────────────
// uHelix 0 = seated (bit-exact default) .. 1 = fully spread helical formation.
export const uHelix = uniform(0);
// Snap ease on arrival: blend a plain smoothstep toward pow(win, EXP) so the
// spread state lingers out then rushes home. snapEase(1) = 1 exactly ⇒ flight = 0 at seat.
export const uHelixSnap = uniform(0.65);
// Formation geometry — all × the wedge flight state, all EXACTLY 0 at flight=0:
export const uHelixApproach = uniform(-45); // axial approach from the REAR (−Y, mount side), model-mm
export const uHelixTurns = uniform(0.85); // winding turns about the axis at flight=1
export const uHelixSpread = uniform(0.45); // radial spread as a fraction of the shell radius R
export const uHelixCoil = uniform(0.5); // over-coil curvature-radius factor at full spread
export const uHelixHover = uniform(4); // tape-down hover gap above the seat (model-mm)

// Per-wedge assembly window: inner shell ranks seat FIRST (big inter-layer
// stagger, slight within-layer stagger). Constraint: LAYER + PART + WINDOW ≤ 1,
// so every wedge reaches win = 1 (⇒ flight = 0, zero contribution) at uHelix = 0.
const HELIX_LAYER_STAGGER = 0.55; // stagger between shell layers (by rank01)
const HELIX_PART_STAGGER = 0.08; // stagger between wedges within one layer
const HELIX_WINDOW = 0.35; // fraction of the scrub each wedge takes to seat
const HELIX_SNAP_EXP = 2.4; // pow exponent — higher = later, harder snap
const HELIX_PITCH_MM = -18; // extra rearward axial spread per rank — a LOW-pitch helix
const HELIX_COIL_SHEAR = 0.6; // helical shear (rad) across the panel's axial extent
// Two-phase split of each wedge's window win: phase 1 (flight) seats the panel
// by win = SPLIT; phase 2 (tape-down) drives ONLY the stick op.
const HELIX_SPLIT = 0.7; // win boundary between flight and tape-down
const HELIX_STICK_BLEND = 0.35; // S-bend width as a fraction of the wedge arc (W)
// Contact-end sign: +1 plants the FRONT (+Y) end first and the S-bend sweeps
// ALONG THE AXIS toward the mount end; −1 flips it.
const STICK_FROM = 1;

// ── ASSEMBLE formation (ops-built reassembly — the A/B alternative to the classic
// rewrap "Reassemble") ───────────────────────────────────────────────────────
// uAssemble 0 = seated (bit-exact default) .. 1 = fully disassembled sheets.
export const uAssemble = uniform(0);
// Snap ease on arrival, softer than helix. snapEase(1) = 1 exactly ⇒ flight = 0 at seat.
export const uAssembleSnap = uniform(0); // plain smoothstep — the classic's own ease
export const uAssembleSpread = uniform(1.6); // fast pinned throw (× R) — the classic frame's SPREAD_EXPLODE
// Slow per-piece slide (× R) along the sector centre — the classic's `sep`
// (uSeparate): unpinned, decays with flight alone.
export const uAssembleSep = uniform(0.55);
// SWIRL amplitude (rad), scaled by (rank01+0.5) so outer layers sweep further —
// the classic's uSwirl.
export const uAssembleSwirl = uniform(1.1);
export const uAssembleFlatten = uniform(1); // main-arc curvature factor (rf = R·flatten) — kept as a knob, inert at 1
export const uAssembleRewind = uniform(0.95); // breath gain (see wrap's breath)
export const uAssembleCurl = uniform(0.85); // roll radius ≈ 0.22R — the classic's ρ
// Rig-ladder depth SCALE (default 1, the "Depth" slider). Axial depth on the
// assemble channel flows from the tier ladder in core/rig (assembleFlightState ×
// explode rung), NOT the shader — this scales that one authority. Rig-side only.
export const uAssembleDepth = uniform(1);
// Phase OVERLAP — how far before the split the roll-on begins, so a sheet is
// still flying while its crease is already seating (the classic rewrap's
// reeled-in BEND). Clamped to ≤ split in the gate so phase 2 can never start
// before win = 0, which would break the stick = 0 identity at full spread.
export const uAssembleOverlap = uniform(0.9);

// Assembly window — inner ranks seat FIRST as in helix but slightly softer.
// Stagger and split are LIVE uniforms. The window is DERIVED as 1 − stagger −
// PART, so offset + window ≡ 1 for ANY slider value: at channel = 0 every wedge
// saturates to win = 1 (⇒ flight = 0 AND stick = 1, every op identity). The page caps the
// stagger slider at 0.9 so the window never collapses below ~0.04.
export const uAssembleStagger = uniform(0.6); // classic REWRAP_STAGGER
// Per-wedge (sector) stagger within a shell, live for the meridian-sweep
// exploration. Default 0 = all wedges of a shell share one timeline — the
// derived window below subtracts it as a node, so the graph maths at 0 match
// the old compile-constant exactly.
export const uAssemblePartStagger = uniform(0);
const ASSEMBLE_WINDOW = float(1)
  .sub(uAssembleStagger)
  .sub(uAssemblePartStagger);
// The win boundary between flight and wrap roll-on — live uniform ("Wrap share"
// slider, smaller split = more of each window for the roll-on, the primary
// visual event).
export const uAssembleSplit = uniform(0.95);
const ASSEMBLE_SNAP_EXP = 2.0; // pow exponent — softer snap than helix (2.4)
// Flight-ramp foot: the classic's per-shell fly-in decays over lr 0.1..0.95 —
// with this, flight IS the classic's t-factor under the matched gate.
const ASSEMBLE_FLIGHT_START = 0.1;
// Roll deadline: the classic's wrap completes at lr = 0.9, before the flight's
// 0.95 — the curl finishes, THEN the sheet breathes.
const ASSEMBLE_ROLL_END = 0.9;
const ASSEMBLE_SWIRL_EXP = 0.65; // swirl decay — the classic's pow(t, 0.65)
// Seam edge the wrap adheres at, signed like stick's `from`: −1 puts it at
// φ=+halfSpan, matching WRAP_DIR (−1)'s seam so the roll-on crease advances in
// the classic rewrap's rotational sense.
const ASSEMBLE_WRAP_FROM = -1;
// Diagonal roll front (the classic's corner-peel SHEAR): the rolled length
// varies with axial height; sign alternates per shell (hash of R). Scales the
// roll length, so it vanishes with it at stick = 1 (identity preserved).
const ASSEMBLE_WRAP_SHEAR = 0.9;
// Optional uniform-driven sector mask on the classic reassembly — defaults fully
// open (width ≥ TAU ⇒ the mask is the CONSTANT 1, so the calibrated match is
// bit-exact; see sectorMask). Lets a demo SOLO a sector of the assemble.
export const uAssembleMaskCenter = uniform(0);
export const uAssembleMaskWidth = uniform(TAU);
const ASSEMBLE_MASK_FEATHER = 0.3; // sector-edge softening (rad)

// ── ROLLOUT formation (rolling-contact unroll — the inverse of the in-place wrap
// peel) ───────────────────────────────────────────────────────────────────────
// uRollout 0 = seated (bit-exact default) .. 1 = the shell unrolled flat, having
// ROLLED along its own tangent plane like a carpet. Identity-anchored: at flight
// 0 the residual roll's centre IS the barrel axis, so the roll ≡ the seated
// cylinder EXACTLY (before the hard idle gate even applies).
export const uRollout = uniform(0);
// Assembly window — inner ranks first, softer than assemble; snap 0 (plain
// smoothstep). Window DERIVED as 1 − stagger, so offset + window ≡ 1 and every
// wedge saturates to flight = 0 at channel = 0.
export const uRolloutStagger = uniform(0.45);
const ROLLOUT_WINDOW: Node = float(1).sub(uRolloutStagger);
const ROLLOUT_SPLIT = 0.95; // flight-ramp foot deadline (stick unused here)
const ROLLOUT_SNAP_EXP = 2.0; // inert at snap 0, kept for the gate signature
const ROLLOUT_FROM = -1; // seam handedness — matches ASSEMBLE_WRAP_FROM
// Uniform-driven sector + rank mask on the rollout, both defaulting fully open
// (the exact-1 bypasses keep an untouched preset a true identity).
export const uRolloutMaskCenter = uniform(0);
export const uRolloutMaskWidth = uniform(TAU);
export const uRolloutRankLo = uniform(0);
export const uRolloutRankHi = uniform(1);
const ROLLOUT_MASK_FEATHER = 0.3; // sector-edge softening (rad)
const ROLLOUT_RANK_FEATHER = 0.1; // rank-band softening

interface GateSpec {
  layerStagger: Node;
  windowFrac: Node;
  split: Node;
  snap: Node;
  snapExp: number;
  partStagger?: Node | number; // 0
  overlap?: Node | number; // 0 — phase 2 starts this far before the split
  flightStart?: number; // 0 — flight-ramp foot
  rollEnd?: number; // 1 — phase-2 saturation deadline
}

/** Build a two-phase per-wedge gate FACTORY. Staggered windows win (inner ranks
 *  first, by rank01 × layerStagger, plus a slight per-wedge partStagger), split
 *  at `split` into phase 1 (flight = 1 − ease over [flightStart, split]) and
 *  phase 2 (tape-down: stick = ease over [split − overlap, rollEnd]).
 *  ease(0) = 0 and ease(1) = 1 exactly for any snap — the identity anchors.
 *  Constraint: layerStagger + partStagger + windowFrac ≤ 1 ⇒ every wedge
 *  saturates to win = 1 (flight = 0 AND stick = 1, every op identity) at
 *  channel = 0. */
function makeGate(
  spec: GateSpec,
): (channel: Node, seat: SeatCtx) => { flight: Node; stick: Node } {
  const { layerStagger, windowFrac, split, snap, snapExp } = spec;
  const partStagger = spec.partStagger ?? 0;
  const overlap: Node = spec.overlap ?? 0;
  const flightStart = spec.flightStart ?? 0;
  const rollEnd = spec.rollEnd ?? 1;
  const ease = (x: Node): Node =>
    mix(smoothstep(0.0, 1.0, x), pow(x, snapExp), snap);
  return (channel, seat) => {
    const seatedness = float(1).sub(channel);
    const wedgePhase = fract(seat.t0.mul(1 / TAU)); // distinct per wedge, ∈ [0,1)
    const hOffset = seat.rank01
      .mul(layerStagger)
      .add(wedgePhase.mul(partStagger));
    const win = clamp(seatedness.sub(hOffset).div(windowFrac), 0.0, 1.0);
    // phase 1: flight ramps 1 → 0 over win ∈ [flightStart, split]; identity at
    // channel = 0 holds since win saturates to 1 ≥ split ⇒ ease(1) = 1.
    const flight = float(1).sub(
      ease(
        clamp(
          win.sub(flightStart).div(float(split).sub(flightStart)),
          0.0,
          1.0,
        ),
      ),
    );
    // phase 2: stick ramps 0 → 1 over win ∈ [split − ov, rollEnd], saturating
    // to exactly 1 before the window's end when rollEnd < 1. ov is clamped to
    // the split so win = 0 still gives stick = 0 (full roll at full spread); at
    // channel = 0 win = 1 ⇒ ease(1) = 1 ⇒ stick = 1 (identity).
    const ov = min(float(overlap), float(split));
    const stick = ease(
      clamp(
        win.sub(split).add(ov).div(float(rollEnd).sub(split).add(ov)),
        0.0,
        1.0,
      ),
    );
    return { flight, stick };
  };
}

const helixGate = makeGate({
  layerStagger: HELIX_LAYER_STAGGER,
  partStagger: HELIX_PART_STAGGER,
  windowFrac: HELIX_WINDOW,
  split: HELIX_SPLIT,
  snap: uHelixSnap,
  snapExp: HELIX_SNAP_EXP,
  // no overlap — helix's flight completes before the tape-down starts
});

const assembleGate = makeGate({
  layerStagger: uAssembleStagger,
  partStagger: uAssemblePartStagger,
  windowFrac: ASSEMBLE_WINDOW,
  split: uAssembleSplit,
  snap: uAssembleSnap,
  snapExp: ASSEMBLE_SNAP_EXP,
  overlap: uAssembleOverlap,
  flightStart: ASSEMBLE_FLIGHT_START,
  rollEnd: ASSEMBLE_ROLL_END,
});

const rolloutGate = makeGate({
  layerStagger: uRolloutStagger,
  windowFrac: ROLLOUT_WINDOW,
  split: ROLLOUT_SPLIT,
  snap: float(0), // plain smoothstep — no snap ease
  snapExp: ROLLOUT_SNAP_EXP,
  // no overlap — the rollout reads only flight (stick is unused)
});

/** JS mirror of assembleGate's flight phase — same law, so rig parts and wedges
 *  fly in lock-step (no partStagger term: a rig part is a whole tier). flight = 0
 *  for every rank at uAssemble = 0 (instrument idle check verifies). */
export function assembleFlightState(rank01: number): number {
  const seatedness = 1 - uAssemble.value;
  const layerStagger = uAssembleStagger.value;
  const windowFrac = 1 - layerStagger - uAssemblePartStagger.value;
  const split = uAssembleSplit.value;
  const snap = uAssembleSnap.value;
  const win = clamp01((seatedness - rank01 * layerStagger) / windowFrac);
  const x = clamp01(
    (win - ASSEMBLE_FLIGHT_START) / (split - ASSEMBLE_FLIGHT_START),
  );
  const eased =
    (1 - snap) * smoothstepN(0, 1, x) + snap * Math.pow(x, ASSEMBLE_SNAP_EXP);
  return 1 - eased;
}

// ── Op library — each op is a FACTORY taking its driving knobs (uniforms or
// constants) explicitly and returning a tagged { cls, run } op, so the same op
// math drives any formation. Every op is identity at channel = 0, where the
// gate gives flight = 0 AND stick = 1.
//
// "frame-free": rigid motions from per-wedge constants — valid on any state, in any order.
// "seat-anchored": read the seated φ/R — exact only while concentric about the axis.

// APPROACH: axial slide toward the rear (axialMm) + a low per-rank pitch spread
// (pitchMm × rank01). Pure axial translation ⇒ the normal is unchanged (no rot).
const approach = (axialMm: Node, pitchMm: number): FormationOp => ({
  name: "approach",
  cls: "frame-free",
  run: (state, ctx) => ({
    ...state,
    y: state.y.add(ctx.flight.mul(axialMm.add(ctx.rank01.mul(pitchMm)))),
  }),
});

// WIND: rigidly rotate the wedge about the optical axis by `turns` turns at full
// spread. A rigid rotation carries the normal with it ⇒ rot += windAngle. Signed
// by wrapDir so the winding handedness matches the peel/spiral.
const wind = (turns: Node): FormationOp => ({
  name: "wind",
  cls: "frame-free",
  run: (state, ctx) => {
    const windAngle = ctx.flight.mul(turns.mul(TAU * ctx.wrapDir));
    return {
      ...state,
      theta: state.theta.add(windAngle),
      rot: state.rot.add(windAngle),
    };
  },
});

// SPREAD: RIGID translation of the whole piece outward along its centre meridian
// (the classic's uSeparate semantics) — translation preserves shape exactly and
// leaves the normal unchanged; a per-vertex radial push is NOT rigid.
const spread = (
  frac: Node,
  opts: { pinned?: boolean; seamDir?: number } = {},
): FormationOp => ({
  name: "spread",
  cls: "frame-free",
  run: (state, ctx) => {
    // PINNED: released by the reel-in pin — fully homed once the sheet is 25%
    // stuck (stick per-wedge-constant ⇒ still one rigid vector per piece).
    // Unpinned (the default) decays with flight alone, like the classic's slow
    // slide `sep`.
    const D0 = ctx.flight.mul(frac).mul(ctx.R);
    const D = opts.pinned
      ? D0.mul(float(1).sub(smoothstep(0.0, 0.25, ctx.stick)))
      : D0;
    // Direction: the sector centre by default (the classic's `sep`); the SEAM
    // meridian when requested (the classic's frame radius AB).
    const dir =
      opts.seamDir !== undefined
        ? ctx.t0.sub(ctx.halfSpan.mul(opts.seamDir))
        : ctx.t0;
    const px = state.radius.mul(cos(state.theta)).add(D.mul(cos(dir)));
    const pz = state.radius.mul(sin(state.theta)).add(D.mul(sin(dir)));
    return {
      ...state,
      theta: atan(pz, px),
      radius: length(vec2(px, pz)),
    };
  },
});

// COIL: map the seated radius R toward R·factor at CONSTANT arc length — the
// wedge-local angle opens ∝ 1/factor; the wall offset rides along untouched.
// factor = 1 at flight=0 ⇒ identity. rot += the opening angle.
const coil = (factor: Node): FormationOp => ({
  name: "coil",
  cls: "seat-anchored",
  run: (state, ctx) => {
    const coilF = mix(float(1), factor, ctx.flight);
    const open = ctx.phi.div(coilF).sub(ctx.phi);
    return {
      theta: state.theta.add(open),
      radius: state.radius.add(ctx.R.mul(coilF.sub(1))),
      y: state.y,
      rot: state.rot.add(open),
    };
  },
});

// SHEAR: a helical twist (rad × yN) about the axis whose angle varies with axial
// height. Rotation about the axis carries the normal ⇒ rot += the same twist.
const shear = (rad: number): FormationOp => ({
  name: "shear",
  cls: "seat-anchored",
  run: (state, ctx) => {
    const twist = ctx.flight.mul(rad).mul(ctx.yN);
    return {
      ...state,
      theta: state.theta.add(twist),
      rot: state.rot.add(twist),
    };
  },
});

// STICK: tape-down seating (phase 2). The panel hovers `hover` above its seat;
// an S-bend front sweeps ALONG THE AXIS from the contact end (u from yN, signed
// by `from`) and presses it flush: radius += hover·S(0, blend, u − f + blend),
// with front f = stick·(1+blend). At stick=0 the hover is full everywhere; at
// stick=1 the smoothstep is 0 EXACTLY ⇒ identity at channel = 0. Does not
// touch rot: the S-ramp tilts normals about the local TANGENT axis, and the
// hover gap is millimetres, so the shading error in the narrow ramp is negligible.
const stick = (hover: Node, blend: number, from: number): FormationOp => ({
  name: "stick",
  cls: "seat-anchored",
  run: (state, ctx) => {
    const u = float(0.5).sub(ctx.yN.mul(from)); // 0 at the contact end .. 1 at the far end
    const f = ctx.stick.mul(1 + blend); // front sweeps past the far end
    const hoverAmt = hover.mul(smoothstep(0.0, blend, u.sub(f).add(blend)));
    return { ...state, radius: state.radius.add(hoverAmt) };
  },
});

// WRAP: seam-hinged panel + END-ROLL curl (the classic rewrap's look). Two
// tangent-continuous pieces:
//   MAIN: one arc hinged tangent to the barrel at the seam edge, curvature
//         radius rf = R·flatten (flat-ish at stick=0) → R (the barrel) at stick=1.
//   TAIL: beyond the roll front the material continues tangent onto a small
//         OUTWARD circle; the rolled length shrinks with stick, vanishing at stick=1.
// Arc length is preserved on both pieces; prior radial offsets (wall thickness;
// wrap runs FIRST) ride each piece's own normal, so stick=1 reduces to the seated
// surface (the preset's hard idle gate covers the trig rounding). Normals: on
// the outward roll the bend reverses, so the normal angle walks BACK by the roll
// angle ⇒ rot uses the piecewise normal angle − θ_seated.
const wrap =
  (
    flatten: Node,
    curl: Node,
    shearAmt: number,
    from: number,
    rewind: Node | number = 0,
  ): FormationGenerator =>
  (off, ctx) => {
    const halfSpan = ctx.halfSpan;
    // barrel (breath)
    // The wrap rolls onto a barrel whose radius breathes by the classic rewind's
    // dilation law. Identity: flight = 0 at channel 0 ⇒ breath = 0 ⇒ the hinge
    // is home. S(0.75,1): the sheet is 75% stuck before it breathes (seatMix).
    const breath = smoothstep(0.75, 1.0, ctx.stick)
      .mul(ctx.flight)
      .mul(float(rewind)) as Node;
    const R: Node = ctx.R.mul(
      float(1).add(breath.mul(float(2.4).add(ctx.rank01.sub(0.5).mul(1.1)))),
    );
    const flatMix: Node = mix(flatten, float(1), ctx.stick);
    const rf = R.mul(flatMix); // main-arc curvature morph (on the BREATHING radius)
    // material coords
    // The arc coordinate and total length are the SEATED sheet's — material
    // does not grow.
    const L = ctx.R.mul(halfSpan.mul(2)); // total arc length (material units)
    // arcPos is NOT clamped: halfSpan is the NOMINAL span, but real wedges
    // overrun it (cut jitter; the iris family is cut into 7 narrower wedges) and
    // clamping broke the stick = 1 identity — the roll bounds `intoRoll` instead.
    const arcPos = ctx.R.mul(ctx.phi.mul(from).add(halfSpan));
    // Seam hinge meridian + the rewind's counter-rotation — the classic's
    // per-ring twist, seen only during the breath.
    const seamAng: Node = ctx.t0
      .sub(halfSpan.mul(from))
      .add(breath.mul(0.06).mul(ctx.R).mul(ctx.wrapDir));
    // roll front
    // Per-shell alternating shear sign — same hash as the classic (fract(R·5.13)).
    const shearSign = step(0.5, fract(ctx.R.mul(5.13)))
      .mul(2)
      .sub(1);
    // At stick = 0 the roll spans the WHOLE sheet (with psi ramped to 0 it is a
    // flat tangent tail — the flying card); as stick rises the stuck band grows
    // behind a travelling front. The shear tilts the front diagonally (positive
    // yN·sign = MORE STUCK there, a shorter roll); the 4·stick·(1−stick)
    // envelope zeroes the tilt at both exact ends.
    const rollLen: Node = clamp(
      float(1)
        .sub(ctx.stick)
        .mul(L)
        .mul(
          float(1).sub(
            ctx.yN
              .mul(shearSign)
              .mul(shearAmt)
              .mul(ctx.stick.mul(float(1).sub(ctx.stick)).mul(4)),
          ),
        ),
      0.0,
      L,
    );
    const rollR = ctx.R.mul(mix(float(0.45), float(0.18), curl));
    // The classic's curlEff in stick terms: waiting sheets (stick = 0) fly
    // flat; the curl grows over the first half of the stick.
    const curlRamp: Node = smoothstep(0.05, 0.55, ctx.stick);
    // Gated on the roll EXISTING: at stick = 1, rollLen = 0 exactly, so
    // intoRoll = 0 and stuckArc = arcPos for every vertex including the
    // overhang — which is what makes identity exact without clamping arcPos.
    const intoRoll = max(arcPos.sub(L.sub(rollLen)), 0.0).mul(
      step(1e-6, rollLen),
    );
    const stuckArc = arcPos.sub(intoRoll); // ≡ min(arcPos, front) while a roll exists
    // point + normal
    const frontAng = seamAng.add(stuckArc.div(rf).mul(from));
    const cr = R.sub(rf);
    // main-piece point at stuckArc (also the roll's anchor when arcPos passes the front)
    const fx = cr.mul(cos(seamAng)).add(rf.mul(cos(frontAng)));
    const fz = cr.mul(sin(seamAng)).add(rf.mul(sin(frontAng)));
    // ROLL, then a STRAIGHT TAIL: psi capped at a half turn AND scaled by
    // curlRamp; whatever the scaled roll doesn't consume trails straight along
    // the tangent.
    const psi: Node = min(intoRoll.div(rollR), CURL_MAX).mul(curlRamp);
    const tail: Node = intoRoll.sub(rollR.mul(psi)); // straight flap beyond the (scaled) curl
    // roll-circle point: start at F, walk psi in the direction that reverses the
    // bend (outward roll) — the normal walks back with it
    const rollAng = frontAng.sub(psi.mul(from));
    const c2x = fx.add(rollR.mul(cos(frontAng)));
    const c2z = fz.add(rollR.mul(sin(frontAng)));
    const m = step(0.0001, intoRoll); // 1 = on the roll, 0 = on the main arc
    const nAng = mix(frontAng, rollAng, m); // piecewise outward-normal angle
    // tangent at the end of the roll, continued for `tail`
    const tx = tail.mul(-from).mul(sin(rollAng));
    const tz = tail.mul(from).mul(cos(rollAng));
    const rx = c2x.sub(rollR.mul(cos(rollAng))).add(tx);
    const rz = c2z.sub(rollR.mul(sin(rollAng))).add(tz);
    const px = mix(fx, rx, m).add(off.mul(cos(nAng)));
    const pz = mix(fz, rz, m).add(off.mul(sin(nAng)));
    const thetaSeated = ctx.t0.add(ctx.phi);
    return {
      theta: atan(pz, px),
      radius: length(vec2(px, pz)),
      y: ctx.y,
      rot: nAng.sub(thetaSeated), // a generator STARTS the rotation accumulator
    };
  };

// ROLLOUT: the shell unrolls by ROLLING along its own tangent plane — a carpet
// laid out flat. Two pieces meeting tangent at the rolling contact:
//   FLAT: material already laid down (arc a ≤ s) lies on the tangent plane at
//         P(a) = R·nHat + tHat·a; its outward normal is the CONSTANT seam angle.
//   ROLL: the residual roll (a > s) is a cylinder of radius R whose centre C
//         rides the plane's barrel side (C = tHat·s). Identity anchor: at flight
//         0 ⇒ s = 0 ⇒ C = origin (the barrel axis), so the roll reproduces the
//         seated cylinder EXACTLY. tHat and the winding sign are pinned by that
//         anchor: tHat = from·(−sin seam, cos seam) makes the flat piece tangent-
//         continuous with the roll AND the roll's θ = seam + from·(a/R) = the
//         seated meridian. Arc length preserved on both pieces; the wall offset
//         rides each piece's own normal, so idle reduces to the seated surface.
const rollOut =
  (from: number): FormationGenerator =>
  (off, ctx) => {
    const R = ctx.R;
    const halfSpan = ctx.halfSpan;
    // material coords — the SEATED sheet's arc coordinate and total length; arcPos
    // is UNCLAMPED (real wedges overrun halfSpan — see wrap's note), the roll/flat
    // split bounds it instead.
    const a: Node = R.mul(ctx.phi.mul(from).add(halfSpan));
    const L: Node = R.mul(halfSpan.mul(2));
    const s: Node = ctx.flight.mul(L); // laid-flat progress
    // seam frame: nHat = outward radial at the seam; tHat = travel direction of
    // the rolling contact (also the roll's winding tangent — pinned by the s = 0
    // seated-cylinder identity).
    const seamAng: Node = ctx.t0.sub(halfSpan.mul(from));
    const cS: Node = cos(seamAng);
    const sS: Node = sin(seamAng);
    const tHx: Node = sS.mul(-from);
    const tHz: Node = cS.mul(from);
    // flat piece
    const fx: Node = R.mul(cS).add(tHx.mul(a));
    const fz: Node = R.mul(sS).add(tHz.mul(a));
    // roll piece: intoRoll = arc past the contact; psi = its subtended angle.
    const intoRoll: Node = max(a.sub(s), 0.0);
    const psi: Node = intoRoll.div(R);
    const cp: Node = cos(psi);
    const sp: Node = sin(psi);
    const cx: Node = tHx.mul(s); // roll centre C = tHat·s
    const cz: Node = tHz.mul(s);
    const rx: Node = cx.add(R.mul(cS.mul(cp).add(tHx.mul(sp))));
    const rz: Node = cz.add(R.mul(sS.mul(cp).add(tHz.mul(sp))));
    // blend: 1 = residual roll, 0 = laid flat (a ≤ s). At flight 0, s = 0 ⇒ every
    // non-seam vertex is on the roll (seated identity); the seam vertex is flat at
    // R·nHat = its own seated point.
    const m: Node = step(1e-6, intoRoll);
    // piecewise outward-normal angle: constant seam angle on the flat, walking by
    // from·psi around the roll (hits the seated meridian at s = 0).
    const nAng: Node = mix(seamAng, seamAng.add(psi.mul(from)), m);
    const px: Node = mix(fx, rx, m).add(off.mul(cos(nAng)));
    const pz: Node = mix(fz, rz, m).add(off.mul(sin(nAng)));
    const thetaSeated = ctx.t0.add(ctx.phi);
    return {
      theta: atan(pz, px),
      radius: length(vec2(px, pz)),
      y: ctx.y,
      rot: nAng.sub(thetaSeated),
    };
  };

// ── Per-piece MASKS — a per-wedge factor 0..1 from seated constants (SeatCtx).
// A masked-out piece keeps the identity phase pair (flight 0, stick 1), so it
// stays fully seated while a preset runs on the rest. Uniform-drivable; each has
// an EXACT-1 bypass so a default-open mask cannot perturb a calibrated preset.
type FormationMask = (seat: SeatCtx) => Node;

// SECTOR: an angular band on t0. The monotone-cosine trick (compare cos(t0 −
// centre) against the half-width cosines) sidesteps angle wrapping. Bypass: when
// width ≥ ~TAU the mask is the CONSTANT 1 exactly.
export const sectorMask =
  (center: Node, width: Node, feather: number): FormationMask =>
  (seat) => {
    const c: Node = cos(seat.t0.sub(center));
    const inner: Node = cos(width.mul(0.5));
    const outer: Node = cos(width.mul(0.5).add(feather));
    const m0: Node = smoothstep(outer, inner, c);
    return min(m0.add(step(6.2, width)), 1);
  };

// RANK: a band on rank01. Bypass: covers [0,1] (lo ≤ 0 AND hi ≥ 1) ⇒ exactly 1.
export const rankMask =
  (lo: Node, hi: Node, feather: number): FormationMask =>
  (seat) => {
    const r: Node = seat.rank01;
    const m0: Node = smoothstep(lo.sub(feather), lo, r).mul(
      float(1).sub(smoothstep(hi, hi.add(feather), r)),
    );
    const open: Node = step(lo, 0).mul(step(1, hi)); // lo ≤ 0 AND hi ≥ 1
    return min(m0.add(open), 1);
  };

// PICK: a deterministic per-WEDGE hash gate (all seated constants ⇒ per-piece,
// not per-vertex). frac = 1 gives exactly 1 (step(h, 1) = 1 since h < 1).
export const pickMask =
  (frac: Node, seed: number): FormationMask =>
  (seat) => {
    const h: Node = fract(
      seat.t0.mul(12.9898).add(seat.R.mul(0.7823)).add(seed).mul(43758.5453),
    );
    return step(h, frac);
  };

// The rollout's default-open sector × rank mask (product of two exact-1 masks is
// exactly 1, so an untouched rollout stays a true identity).
const rolloutMask: FormationMask = (seat) =>
  sectorMask(
    uRolloutMaskCenter,
    uRolloutMaskWidth,
    ROLLOUT_MASK_FEATHER,
  )(seat).mul(
    rankMask(uRolloutRankLo, uRolloutRankHi, ROLLOUT_RANK_FEATHER)(seat),
  );

interface Preset {
  channel: Node; // the 0..1 uniform this preset gates on
  // channel → the per-wedge { flight, stick } phase pair
  gate: (channel: Node, seat: SeatCtx) => { flight: Node; stick: Node };
  /** Optional GENERATOR, applied to the seated state before every transform. A
   *  preset with one builds its own theta/radius from scratch; without one the ops
   *  transform the seated wedge directly. */
  generator?: FormationGenerator;
  ops: FormationOp[]; // ORDERED transform stack (order = application order)
  /** Optional per-piece MASK: masked-out wedges keep the identity phase pair
   *  (flight 0, stick 1) and stay fully seated while the preset runs. */
  mask?: FormationMask;
}

// SWIRL: the classic rewrap's orbital fly-in — a RIGID rotation of the whole
// card about the axis by flight^exp · rad · (rank01+0.5), signed by the winding
// handedness and released by the reel-in pin (homed once the sheet is 25%
// stuck). The SUB-LINEAR exponent makes the fly-in tail read as an orbit.
// Frame-free. Identity at seat: flight = 0 ⇒ pow(0, exp) = 0, doubly zeroed by
// the pin at stick = 1. Rigid axis rotation ⇒ rot += the same angle.
const swirl = (rad: Node, exp: number): FormationOp => ({
  name: "swirl",
  cls: "frame-free",
  run: (state, ctx) => {
    const pin = float(1).sub(smoothstep(0.0, 0.25, ctx.stick));
    const a = pow(ctx.flight, exp)
      .mul(rad)
      .mul(ctx.rank01.add(0.5))
      .mul(ctx.wrapDir)
      .mul(pin);
    return { ...state, theta: state.theta.add(a), rot: state.rot.add(a) };
  },
});

// PRESET table — each entry is a named ORDERED op stack baked into the bloom graph.
// Array order = application order (the experiment surface; see the file header).
const PRESETS: Record<string, Preset> = {
  helix: {
    channel: uHelix,
    gate: helixGate,
    ops: [
      approach(uHelixApproach, HELIX_PITCH_MM),
      wind(uHelixTurns),
      spread(uHelixSpread),
      coil(uHelixCoil),
      shear(HELIX_COIL_SHEAR),
      stick(uHelixHover, HELIX_STICK_BLEND, STICK_FROM),
    ],
  },
  assemble: {
    channel: uAssemble,
    gate: assembleGate,
    generator: wrap(
      uAssembleFlatten,
      uAssembleCurl,
      ASSEMBLE_WRAP_SHEAR,
      ASSEMBLE_WRAP_FROM,
      uAssembleRewind,
    ),
    // TRANSFORM ORDER — all rigid; calibrated to the classic rewrap's visible flight:
    //   sep    — slow slide along the sector centre, unpinned (classic uSeparate)
    //   spread — fast throw along the SEAM meridian, PINNED (classic AB frame
    //            radius, homed by 25% stuck)
    //   swirl  — LAST, after the translations: rotation of the far-flung sheet
    //            about the axis = orbit
    ops: [
      spread(uAssembleSep),
      spread(uAssembleSpread, {
        pinned: true,
        seamDir: ASSEMBLE_WRAP_FROM,
      }),
      swirl(uAssembleSwirl, ASSEMBLE_SWIRL_EXP),
    ],
    // Optional sector solo — fully open by default (bit-exact identity).
    mask: sectorMask(
      uAssembleMaskCenter,
      uAssembleMaskWidth,
      ASSEMBLE_MASK_FEATHER,
    ),
  },
  rollout: {
    channel: uRollout,
    gate: rolloutGate,
    generator: rollOut(ROLLOUT_FROM),
    ops: [],
    mask: rolloutMask,
  },
};

// seated cartesian point rebuilt from a wedge state (optical axis = Y, radial plane
// = X–Z), so the position delta is `reconstruct(final) − reconstruct(seated)`.
const reconstruct = (s: WedgeState): Node =>
  vec3(s.radius.mul(cos(s.theta)), s.y, s.radius.mul(sin(s.theta)));

// One advisory warning per preset name, however many times materials rebuild.
const warnedPresets = new Set<string>();

/** Fold one preset's ops over the seated state; return its position delta (final
 *  cartesian − seated cartesian) and cumulative normal rotation. The delta is built
 *  off the reconstructed SEATED point, so it is EXACTLY zero when the gate is 0:
 *  every op is then identity, final ≡ seated, and the two reconstructions cancel. */
function buildPreset(
  name: string,
  preset: Preset,
  seat: SeatCtx,
): { delta: Node; rot: Node } {
  // ADVISORY ordering check: a seat-anchored op run after the piece has moved
  // off-axis (spread is the only frame-free op that does) reads a seated frame
  // that no longer matches the state. Warn, never throw — helix's stack is
  // owner-blessed at current magnitudes.
  if (!warnedPresets.has(name)) {
    let offAxis = false;
    const late: string[] = [];
    for (const op of preset.ops) {
      if (offAxis && op.cls === "seat-anchored") late.push(op.name);
      if (op.name === "spread") offAxis = true;
    }
    if (late.length > 0) {
      warnedPresets.add(name);
      console.warn(
        `formation preset "${name}": seat-anchored op(s) ${late.join(", ")} run after the off-axis spread — seated-frame math is approximate there (owner-blessed at current magnitudes)`,
      );
    }
  }
  const gated = preset.gate(preset.channel, seat);
  let flight: Node = gated.flight;
  let stick: Node = gated.stick;
  // Per-piece mask: folded right after the gate. flight = 0 AND stick = 1 is the
  // identity pair, so a masked-out piece (m = 0) stays fully seated; m = 1 leaves
  // the gate untouched (flight·1 = flight, mix(1, stick, 1) = stick, both exact).
  if (preset.mask) {
    const m: Node = preset.mask(seat);
    flight = flight.mul(m);
    stick = mix(float(1), stick, m);
  }
  const ctx: FormationCtx = { ...seat, flight, stick };
  const seated: WedgeState = {
    theta: seat.theta,
    radius: seat.r,
    y: seat.y,
    rot: float(0),
  };
  // The generator (if any) builds the state from context; the transforms then act on
  // what it produced. Application order within `ops` is still semantic.
  let state = preset.generator
    ? preset.generator(seat.r.sub(seat.R), ctx)
    : seated;
  for (const op of preset.ops) state = op.run(state, ctx);
  // Hard idle gate: at channel = 0 the ops are identity only up to float
  // rounding (the wrap rebuilds the seated arc through trig), so the preset's
  // contribution is force-zeroed whenever its channel is exactly 0 — the
  // seated render stays bit-exact no matter what the ops compute.
  const on = step(1e-6, preset.channel);
  return {
    delta: reconstruct(state).sub(reconstruct(seated)).mul(on),
    rot: state.rot.mul(on),
  };
}

// Which PRESETS the bloom deform folds in, chosen PER SCENE and baked at material
// build (no lazy recompile). null = every preset — the /lens default and today's
// behavior. The homepage hero passes [] (folds NOTHING: it drives only the classic
// explode/unwrap/rewrap channels, so every formation would contribute a literal 0
// anyway — audit-verified in story/hero-driver.ts). Set by setActiveFormations
// before applyBloom, then read at every material build for the scene's lifetime.
let activeFormations: string[] | null = null;

/** Choose which formation presets the bloom deform folds in (see activeFormations).
 *  Call BEFORE applyBloom / any shading-mode build. null = all presets. */
export function setActiveFormations(names: string[] | null): void {
  activeFormations = names;
}

/** Sum every ACTIVE preset's contribution: the total position delta (added off the
 *  seated cylinder point in bloomPosition) and the total normal rotation about the
 *  optical axis (applied in bloomNormal). Exactly zero when every channel is 0 — and
 *  a preset the scene didn't select contributes a literal 0 (it isn't folded at all). */
export function buildFormations(seat: SeatCtx): { delta: Node; rot: Node } {
  let delta: Node = vec3(float(0), float(0), float(0));
  let rot: Node = float(0);
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (activeFormations !== null && !activeFormations.includes(name)) continue;
    const c = buildPreset(name, preset, seat);
    delta = delta.add(c.delta);
    rot = rot.add(c.rot);
  }
  return { delta, rot };
}
