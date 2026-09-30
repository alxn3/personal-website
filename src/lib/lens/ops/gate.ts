// The per-piece timing gate. Each piece gets a staggered window `win` (offset
// by rank01 × layerStagger + layerPhase × partStagger), split into two phases:
// flight falls 1 → 0 over [flightStart, split], stick rises 0 → 1 over
// [split − overlap, rollEnd].
//
// With layerStagger + partStagger + windowFrac ≤ 1, every piece is exactly
// seated (flight 0, stick 1) at channel 0.

import type { Algebra, Sc } from "./algebra";

/** Needs split < rollEnd + overlap, or the stick ramp divides by ≤ 0. */
export interface GateSpec<S> {
  layerStagger: Sc<S>;
  windowFrac: Sc<S>;
  split: Sc<S>;
  snap: Sc<S>;
  snapExp: number;
  partStagger?: Sc<S>; // default 0
  overlap?: Sc<S>; // default 0; stick starts this far before the split
  flightStart?: number; // default 0
  rollEnd?: number; // default 1; stick reaches 1 here
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

  // Phase 1: flight 1 → 0 over win ∈ [flightStart, split].
  const flight = A.sub(
    1,
    ease(
      A.clamp(A.div(A.sub(win, flightStart), A.sub(split, flightStart)), 0, 1),
    ),
  );

  // Phase 2: stick 0 → 1 over win ∈ [split − ov, rollEnd]; ov ≤ split so
  // stick is 0 at win = 0.
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
