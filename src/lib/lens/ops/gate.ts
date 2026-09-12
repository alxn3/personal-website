// The two-phase per-piece choreography gate, written against the scalar algebra
// so it runs on both the CPU (NUM) and, through ops/emit, the GPU.
//
// A staggered window `win` opens per piece (inner ranks first, by
// `rank01 × layerStagger`, plus `layerPhase × partStagger`), then splits at
// `split` into phase 1 (flight = 1 − ease over [flightStart, split]) and
// phase 2 (stick = ease over [split − overlap, rollEnd]).
//
// INVARIANT: while `layerStagger + partStagger + windowFrac ≤ 1`, every piece
// saturates EXACTLY to win = 1 (flight = 0 AND stick = 1) at channel = 0.
// ops.ts's `during` relies on those anchors being exact at both ends.

import type { Algebra, Sc } from "./algebra";

/** INVARIANT: `split < rollEnd + overlap` — the stick ramp's denominator
 *  `rollEnd − split + min(overlap, split)` must be positive, else NaN. */
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

  // phase 1: flight ramps 1 → 0 over win ∈ [flightStart, split].
  const flight = A.sub(
    1,
    ease(
      A.clamp(A.div(A.sub(win, flightStart), A.sub(split, flightStart)), 0, 1),
    ),
  );

  // phase 2: stick ramps 0 → 1 over win ∈ [split − ov, rollEnd]. ov is clamped
  // to the split so win = 0 still gives stick = 0.
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
