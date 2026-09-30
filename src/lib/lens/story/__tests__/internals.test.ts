import { describe, expect, it } from "vitest";
// test-only optics import; internals.ts itself must not import optics/
import { FLY } from "../../optics/fly-core";
import { rangeOf, atFrac } from "../story";
import { fakeScene } from "./fake-scene";
import {
  createInternalsAmbient,
  internalsEnvAt,
  internalsFocusAt,
  internalsBreathAt,
  internalsApertureAt,
} from "../internals";

// The breath ends before the pre-shut ramp starts, the ramp reaches exactly 1,
// and nothing runs outside the scene.

const inR = rangeOf("internals");
const cdR = rangeOf("cards");
/** the cards wake-point, where the driver hands the channels over */
const WAKE = atFrac(cdR, 0.15);
/** loop times spread across both loop periods */
const TIMES = [0, 375, 1250, 2500, 3125, 5000, 6180, 7000, 21_000];

describe("internals ambient envelopes", () => {
  // asleep outside the cards+internals span, awake together once the scene
  // has settled, and the rack outlives the breath
  it.each([
    [0, 0, 0],
    [cdR.p0, 0, 0],
    [WAKE, 0, 0],
    [atFrac(inR, 0.3), 1, 1],
    [atFrac(inR, 0.7), 0, 1],
    [inR.p1, 0, 0],
    [inR.p1 + 0.05, 0, 0],
    [1, 0, 0],
  ])("at p %f: breath %i, rack %i", (p, breath, rack) => {
    expect(internalsEnvAt(p)).toEqual({ breath, rack });
  });
});

describe("internals aperture handoff", () => {
  it("stops breathing before the pre-shut ramp starts", () => {
    for (const f of [0.6, 0.62, 0.75, 0.9, 1])
      for (const t of TIMES)
        expect(internalsBreathAt(t, atFrac(inR, f)), `t ${t} local ${f}`).toBe(0); // prettier-ignore
  });

  it("ends CLOSED — the fly's parked iris, with nothing left to jump", () => {
    for (const t of TIMES) {
      for (const f of [0.95, 0.98, 1])
        expect(internalsApertureAt(t, atFrac(inR, f)), `t ${t} local ${f}`).toBe(1); // prettier-ignore
      // the aperture ends exactly where the dive's ramp starts
      expect(internalsApertureAt(t, inR.p1), `t ${t}`).toBe(FLY.apertureShut);
    }
  });

  it("opens from a clean zero and stays inside the channel", () => {
    for (const t of TIMES) {
      expect(internalsApertureAt(t, WAKE)).toBe(0);
      for (const f of [0.1, 0.25, 0.4, 0.5, 0.55, 0.6, 0.8]) {
        const a = internalsApertureAt(t, atFrac(inR, f));
        expect(a, `t ${t} local ${f}`).toBeGreaterThanOrEqual(0);
        expect(a, `t ${t} local ${f}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("starts its cycle at rest, and takes 5s to come back", () => {
    const p = atFrac(inR, 0.3); // envelope at full
    // the breath starts at 0, so the iris is wide open on the first frame
    expect(internalsBreathAt(0, p)).toBe(0);
    // the peak is at half the period (BREATH_MS = 5000)
    const peak = internalsBreathAt(2500, p);
    expect(peak).toBeCloseTo(0.55, 10);
    expect(internalsBreathAt(2300, p)).toBeLessThan(peak);
    expect(internalsBreathAt(2700, p)).toBeLessThan(peak);
    expect(internalsBreathAt(5000, p)).toBeCloseTo(0, 10);
  });
});

describe("internals focus rack", () => {
  it("racks the full channel and no further, from rest back to rest", () => {
    const samples = Array.from({ length: 57 }, (_, i) =>
      internalsFocusAt((i * 7000) / 56, 1),
    );
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
    expect(Math.max(...samples)).toBeCloseTo(1, 10);
    expect(internalsFocusAt(0, 1)).toBe(0);
    expect(internalsFocusAt(7000, 1)).toBeCloseTo(0, 10);
  });

  it("is 0 at the span's edges, where hero-driver takes the channel back", () => {
    for (const t of TIMES)
      for (const p of [WAKE, inR.p1, atFrac(inR, 0.95)])
        expect(internalsFocusAt(t, internalsEnvAt(p).rack), `t ${t} p ${p}`).toBe(0); // prettier-ignore
  });
});

describe("the phase-clock rider", () => {
  it("reports motion only inside its span, so an idle scene can sleep", () => {
    const f = fakeScene();
    createInternalsAmbient(f.scene);
    expect(f.evaluate(0)).toBe(false); // outside its span
    const mid = atFrac(inR, 0.5);
    expect(f.evaluate(mid)).toBe(true); // the clock is running
    expect(f.evaluate(mid)).toBe(true);
    expect(f.evaluate(atFrac(rangeOf("rewrap"), 0.5))).toBe(false);
  });
});
