import { NUM } from "../algebra";
import { gate, type GateSpec } from "../gate";
import type { Sc } from "../algebra";

// The gate the hand-built ctx fixtures in this folder carry: `gateAt` is built
// over the real `gate()` so a `during` remap lands on a producible pair.
//
// The spec keeps the two gate laws: layerStagger + partStagger + windowFrac
// = 0.9 ≤ 1 (every piece saturates to the seated pair at channel 0) and
// rollEnd − split + min(overlap, split) = 0.6 > 0 (non-degenerate stick ramp).
export const FIXTURE_GATE_SPEC: GateSpec<number> = {
  layerStagger: 0.2,
  windowFrac: 0.6,
  split: 0.5,
  snap: 0.5,
  snapExp: 2,
  partStagger: 0.1,
  overlap: 0.1,
};

/** The `OpCtx.gateAt` closure for a piece at (rank01, layerPhase). */
export function fixtureGateAt(
  rank01: number,
  layerPhase: number,
): (channel: Sc<number>) => { flight: number; stick: number } {
  return (channel) =>
    gate(NUM, FIXTURE_GATE_SPEC, channel, { rank01, layerPhase });
}
