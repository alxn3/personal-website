import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { gate, type GateSpec } from "../gate";

// An assemble-like spec; the shipped gates are covered by host-knobs.test.ts.
const ASSEMBLE: GateSpec<number> = {
  layerStagger: 0.6,
  windowFrac: 0.4,
  split: 0.95,
  snap: 0,
  snapExp: 2,
  overlap: 0.9,
  flightStart: 0.1,
  rollEnd: 0.9,
};

const GRID = [0, 0.25, 0.5, 0.75, 1];
const at = (spec: GateSpec<number>, c: number, rank01 = 0, layerPhase = 0) =>
  gate(NUM, spec, c, { rank01, layerPhase });

describe("gate — two-phase choreography", () => {
  it("(a) channel 0 is seated (flight 0, stick 1) across a 5×5 grid; channel 1 at rank 0 is fully unseated", () => {
    for (const rank01 of GRID)
      for (const layerPhase of GRID)
        expect(at(ASSEMBLE, 0, rank01, layerPhase)).toEqual({
          flight: 0,
          stick: 1,
        });
    expect(at(ASSEMBLE, 1)).toEqual({ flight: 1, stick: 0 });
  });

  it("(c) monotonic: flight non-increasing, stick non-decreasing as channel falls 1→0", () => {
    let prev = { flight: Infinity, stick: -Infinity };
    for (let i = 0; i <= 20; i++) {
      const g = at(ASSEMBLE, 1 - i / 20, 0.3, 0.2);
      expect(g.flight).toBeLessThanOrEqual(prev.flight);
      expect(g.stick).toBeGreaterThanOrEqual(prev.stick);
      prev = g;
    }
  });

  it("(d) overlap clamp: overlap > split behaves identically to overlap === split", () => {
    const base = { ...ASSEMBLE, split: 0.5 };
    const big = { ...base, overlap: 0.99 };
    const eq = { ...base, overlap: 0.5 };
    for (const rank01 of GRID)
      for (const layerPhase of GRID)
        for (const c of GRID)
          expect(at(big, c, rank01, layerPhase).stick).toBe(
            at(eq, c, rank01, layerPhase).stick,
          );
    // stick is still 0 at win 0 (full spread) despite the large overlap.
    expect(at(big, 1).stick).toBe(0);
  });

  it("(e) layer-phase stagger is linear: phases 0 and 0.5 at partStagger 0.08 offset the window by 0.04", () => {
    // Pure-linear regime: ease(x) = x and flight = 1 − win.
    const spec: GateSpec<number> = {
      layerStagger: 0,
      windowFrac: 1,
      split: 1,
      snap: 1,
      snapExp: 1,
      partStagger: 0.08,
    };
    // A larger phase pushes the window later ⇒ less seated ⇒ higher flight.
    const dFlight = at(spec, 0.5, 0, 0.5).flight - at(spec, 0.5, 0, 0).flight;
    expect(dFlight).toBeCloseTo(0.5 * 0.08, 12);
  });
});
