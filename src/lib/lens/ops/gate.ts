// The two-phase per-piece choreography gate, written against the scalar algebra
// so it runs on both the CPU (NUM, for tests/tooling) and the GPU (tslAlgebra).
// The per-piece phase term is the caller-provided `layerPhase` (the derived
// index/count value), so the stagger tracks measured layer order.
//
// The law: a staggered window `win` opens per piece (inner ranks first, by
// `rank01 × layerStagger`, plus a per-piece `layerPhase × partStagger`), then
// splits at `split` into phase 1 (flight = 1 − ease over [flightStart, split])
// and phase 2 (stick/tape-down = ease over [split − overlap, rollEnd]).
// `ease(0) = 0` and `ease(1) = 1` for any snap, so the identity anchors hold:
// as long as `layerStagger + partStagger + windowFrac ≤ 1`, every piece
// saturates to win = 1 (flight = 0 AND stick = 1) at channel = 0.
//
// COROLLARY, and the whole reason ops.ts's `during` needs no code here: because
// those anchors are EXACT at both ends, running this same gate at a remapped
// channel m(c) = clamp((c − from)/(to − from), 0, 1) leaves the pieces of that
// scope SEATED for channel ≤ from and fully PLAYED for channel ≥ to — with the
// per-piece stagger and the two-phase split replaying inside the sub-window for
// free. `during` hands the identical GateSpec/rank01/layerPhase a different
// channel; the per-piece windows (flightStart/rollEnd) stay this file's, since
// they live in `win` space AFTER the stagger and `during` acts before it.

import type { Algebra, Sc } from "./algebra";

/** INVARIANT: `split < rollEnd + overlap` — equivalently the stick ramp's
 *  denominator `rollEnd − split + min(overlap, split)` must be POSITIVE. At zero
 *  the seated state (win = 1) computes stick = 0/0 = NaN instead of the exact 1
 *  the identity anchor requires. */
export interface GateSpec<S> {
  layerStagger: Sc<S>;
  windowFrac: Sc<S>;
  split: Sc<S>;
  snap: Sc<S>;
  snapExp: number;
  partStagger?: Sc<S>; // 0
  overlap?: Sc<S>; // 0 — phase 2 starts this far before the split
  flightStart?: number; // 0 — flight-ramp foot
  rollEnd?: number; // 1 — phase-2 saturation deadline
}

export interface GateIn<S> {
  rank01: S;
  layerPhase: S;
}

export function gate<S>(
  A: Algebra<S>,
  spec: GateSpec<S>,
  channel: Sc<S>,
  g: GateIn<S>,
): { flight: S; stick: S } {
  const { layerStagger, windowFrac, split, snap, snapExp } = spec;
  const partStagger = spec.partStagger ?? 0;
  const overlap = spec.overlap ?? 0;
  const flightStart = spec.flightStart ?? 0;
  const rollEnd = spec.rollEnd ?? 1;

  const ease = (x: Sc<S>): S =>
    A.mix(A.smoothstep(0, 1, x), A.pow(x, snapExp), snap);

  const seatedness = A.sub(1, channel);
  const hOffset = A.add(
    A.mul(g.rank01, layerStagger),
    A.mul(g.layerPhase, partStagger),
  );
  const win = A.clamp(A.div(A.sub(seatedness, hOffset), windowFrac), 0, 1);

  // phase 1: flight ramps 1 → 0 over win ∈ [flightStart, split]; identity at
  // channel = 0 holds since win saturates to 1 ≥ split ⇒ ease(1) = 1.
  const flight = A.sub(
    1,
    ease(
      A.clamp(A.div(A.sub(win, flightStart), A.sub(split, flightStart)), 0, 1),
    ),
  );

  // phase 2: stick ramps 0 → 1 over win ∈ [split − ov, rollEnd], saturating to
  // exactly 1 before the window's end when rollEnd < 1. ov is clamped to the
  // split so win = 0 still gives stick = 0 (full roll at full spread); at
  // channel = 0 win = 1 ⇒ ease(1) = 1 ⇒ stick = 1 (identity).
  const ov = A.min(overlap, split);
  const stick = ease(
    A.clamp(
      A.div(A.add(A.sub(win, split), ov), A.add(A.sub(rollEnd, split), ov)),
      0,
      1,
    ),
  );

  return { flight, stick };
}
