import { NUM } from "../algebra";
import { gate, type GateSpec } from "../gate";
import type { Sc } from "../algebra";

// The gate the hand-built ctx fixtures in this folder carry.
//
// `OpCtx` holds a raw `channel` and a `gateAt` closure (the ops/ops.ts `during`
// contract: a scope re-runs THIS recipe's gate at a remapped channel), and both
// have to be REAL — a fixture that hands back invented pairs would let a broken
// remap pass. So the fixtures build `gateAt` over the actual `gate()` with the
// house-shaped spec below, exactly as ops/host.ts and ops/cpu.ts do.
//
// The spec keeps the two gate laws: `layerStagger + partStagger + windowFrac`
// = 0.9 ≤ 1 (so every piece saturates to the seated pair at channel 0) and
// `rollEnd − split + min(overlap, split)` = 0.6 > 0 (a non-degenerate stick
// ramp). The op-family suites still pass whatever `flight` / `stick` PAIR the
// case under test is about — a transform's identity does not care which channel
// produced its flight — but a `during` scope inside one of them re-gates through
// this spec and lands on a pair the gate really can produce.
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
