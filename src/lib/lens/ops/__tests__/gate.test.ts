import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { gate, type GateSpec } from "../gate";

// The gate, run here on the NUM backend (the executable spec). The per-piece
// phase term is the provided `layerPhase` input, not an angle-derived value.

// The calibrated "assemble" values from the brief — the identity anchor.
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

describe("gate — two-phase choreography", () => {
  it("(a) identity anchor: channel 0 gives flight 0 and stick 1 across a 5×5 grid", () => {
    for (const rank01 of GRID) {
      for (const layerPhase of GRID) {
        const { flight, stick } = gate(NUM, ASSEMBLE, 0, {
          rank01,
          layerPhase,
        });
        expect(flight).toBe(0);
        expect(stick).toBe(1);
      }
    }
  });

  it("(b) fully unseated: channel 1, rank 0, phase 0 gives flight 1 and stick 0", () => {
    const { flight, stick } = gate(NUM, ASSEMBLE, 1, {
      rank01: 0,
      layerPhase: 0,
    });
    expect(flight).toBe(1);
    expect(stick).toBe(0);
  });

  it("(c) monotonic: flight non-increasing, stick non-decreasing as channel falls 1→0", () => {
    const rank01 = 0.3;
    const layerPhase = 0.2;
    let prevFlight = Infinity;
    let prevStick = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const channel = 1 - i / 20; // 1 → 0
      const { flight, stick } = gate(NUM, ASSEMBLE, channel, {
        rank01,
        layerPhase,
      });
      expect(flight).toBeLessThanOrEqual(prevFlight);
      expect(stick).toBeGreaterThanOrEqual(prevStick);
      prevFlight = flight;
      prevStick = stick;
    }
  });

  it("(d) overlap clamp: overlap > split behaves identically to overlap === split", () => {
    const base: GateSpec<number> = {
      layerStagger: 0.6,
      windowFrac: 0.4,
      split: 0.5,
      snap: 0,
      snapExp: 2,
      flightStart: 0.1,
      rollEnd: 0.9,
    };
    const big: GateSpec<number> = { ...base, overlap: 0.99 };
    const eq: GateSpec<number> = { ...base, overlap: 0.5 };
    for (const rank01 of GRID) {
      for (const layerPhase of GRID) {
        for (const channel of GRID) {
          const g = { rank01, layerPhase };
          expect(gate(NUM, big, channel, g).stick).toBe(
            gate(NUM, eq, channel, g).stick,
          );
        }
      }
    }
    // stick is still 0 at win 0 (full spread) despite the large overlap.
    expect(gate(NUM, big, 1, { rank01: 0, layerPhase: 0 }).stick).toBe(0);
  });

  it("(e) layer-phase stagger is linear: phases 0 and 0.5 at partStagger 0.08 offset the window by 0.04", () => {
    // Pure-linear regime: snap 1 + snapExp 1 makes ease(x) = x, and
    // windowFrac 1 + split 1 + flightStart 0 makes flight = 1 − win directly.
    const spec: GateSpec<number> = {
      layerStagger: 0,
      windowFrac: 1,
      split: 1,
      snap: 1,
      snapExp: 1,
      partStagger: 0.08,
      flightStart: 0,
      rollEnd: 1,
    };
    const channel = 0.5; // seatedness 0.5, both wins land in [0,1]
    const flightA = gate(NUM, spec, channel, {
      rank01: 0,
      layerPhase: 0,
    }).flight;
    const flightB = gate(NUM, spec, channel, {
      rank01: 0,
      layerPhase: 0.5,
    }).flight;
    // A larger phase pushes the window later ⇒ less seated ⇒ higher flight.
    expect(flightB - flightA).toBeCloseTo(0.5 * 0.08, 12);
  });
});
