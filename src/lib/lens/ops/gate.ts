// The two-phase per-piece choreography gate, written against the scalar algebra
// so it runs on both the CPU (NUM) and, through ops/emit, the GPU.
//
// THE LAW: a staggered window `win` opens per piece (inner ranks first, by
// `rank01 × layerStagger`, plus `layerPhase × partStagger`), then splits at
// `split` into phase 1 (flight = 1 − ease over [flightStart, split]) and
// phase 2 (stick/tape-down = ease over [split − overlap, rollEnd]).
// `ease(0) = 0` and `ease(1) = 1` for any snap, so the identity anchors hold:
// while `layerStagger + partStagger + windowFrac ≤ 1`, every piece saturates
// to win = 1 (flight = 0 AND stick = 1) at channel = 0.
//
// Those anchors being EXACT at both ends is why ops.ts's `during` needs no code
// here: re-running this gate at a remapped channel leaves that scope seated
// below the sub-window and fully played above it, stagger and split replayed
// inside for free. The per-piece windows (flightStart/rollEnd) stay this
// file's — they live in `win` space, after the stagger, and `during` acts
// before it.

import type { Algebra, Sc } from "./algebra";

/** INVARIANT: `split < rollEnd + overlap`, i.e. the stick ramp's denominator
 *  `rollEnd − split + min(overlap, split)` must be POSITIVE — at zero the
 *  seated state computes 0/0 = NaN instead of the identity anchor's exact 1. */
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

  // phase 2: stick ramps 0 → 1 over win ∈ [split − ov, rollEnd]. ov must stay
  // clamped to the split so win = 0 still gives stick = 0 (full roll at full
  // spread).
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
