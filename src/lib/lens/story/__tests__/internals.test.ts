import { describe, expect, it } from "vitest";
// TEST-ONLY optics import: the seam this file guards is the one between the
// ambient and the dive, and pinning it against a literal `1` would let a change
// to the fly's park drift silently. internals.ts itself must NEVER import from
// optics/ — it is statically imported by hero-driver and would drag the uniform
// boxes into the homepage's initial chunk.
import { FLY } from "../../optics/fly-core";
import { rangeOf, atFrac } from "../story";
import {
  internalsEnvAt,
  internalsFocusAt,
  internalsBreathAt,
  internalsApertureAt,
} from "../internals";

// The ambient's LAWS, not its plumbing: what the handoff chain depends on is
// that the breath is dead before the pre-shut ramp starts, that the ramp still
// arrives at a hard 1, and that nothing runs outside the scene.

const inR = rangeOf("internals");
const caR = rangeOf("cards");
/** a spread of phases through both loop periods — no law here may depend on
 *  where in its cycle the clock happens to be. */
const TIMES = [0, 375, 1250, 2500, 3125, 5000, 6180, 7000, 21_000];

describe("internals ambient envelopes", () => {
  it("are asleep outside the cards+internals span", () => {
    // the ambient wakes a fifth into CARDS now (the peel bares the mechanism a
    // scene early), so the quiet edges are the cards wake-point and inR.p1
    for (const p of [0, caR.p0, atFrac(caR, 0.15), inR.p1, inR.p1 + 0.05, 1]) {
      const env = internalsEnvAt(p);
      expect(env.breath, `breath at p ${p}`).toBe(0);
      expect(env.rack, `rack at p ${p}`).toBe(0);
    }
  });

  it("wake together once the scene has settled", () => {
    const env = internalsEnvAt(atFrac(inR, 0.3));
    expect(env.breath).toBe(1);
    expect(env.rack).toBe(1);
  });

  it("the rack outlives the breath", () => {
    // by local 0.7 the iris has stopped and the focus group is still running
    const env = internalsEnvAt(atFrac(inR, 0.7));
    expect(env.breath).toBe(0);
    expect(env.rack).toBe(1);
  });
});

describe("internals aperture handoff", () => {
  it("stops breathing before the pre-shut ramp starts", () => {
    for (const f of [0.6, 0.62, 0.75, 0.9, 1]) {
      for (const t of TIMES)
        expect(internalsBreathAt(t, atFrac(inR, f)), `t ${t} local ${f}`).toBe(
          0,
        );
    }
  });

  it("ends CLOSED — the fly's parked iris, with nothing left to jump", () => {
    for (const f of [0.95, 0.98, 1]) {
      for (const t of TIMES)
        expect(
          internalsApertureAt(t, atFrac(inR, f)),
          `t ${t} local ${f}`,
        ).toBe(1);
    }
    // THE SEAM ITSELF: the scene hands the channel over at exactly the value
    // story/fly.ts's ramp starts from (flyApertureAt(0) === FLY.apertureShut),
    // so the dive opens the iris from where the internals left it.
    for (const t of TIMES)
      expect(internalsApertureAt(t, inR.p1), `t ${t}`).toBe(FLY.apertureShut);
  });

  it("opens from a clean zero and stays inside the channel", () => {
    // the SPAN arrives at whatever the driver left: wide open at the cards
    // wake-point (the breath is already alive by inR.p0 — no handback there)
    for (const t of TIMES)
      expect(internalsApertureAt(t, atFrac(caR, 0.15))).toBe(0);
    for (const t of TIMES)
      for (const f of [0.1, 0.25, 0.4, 0.5, 0.55, 0.6, 0.8]) {
        const a = internalsApertureAt(t, atFrac(inR, f));
        expect(a, `t ${t} local ${f}`).toBeGreaterThanOrEqual(0);
        expect(a, `t ${t} local ${f}`).toBeLessThanOrEqual(1);
      }
  });

  it("starts its cycle at rest, and takes 5s to come back", () => {
    const p = atFrac(inR, 0.3); // envelope at full
    // PHASE: the raised cosine begins at zero displacement, so the iris is
    // wide open on the ambient's very first frame — nothing to step over on
    // the way in, whatever the envelope is doing.
    expect(internalsBreathAt(0, p)).toBe(0);
    expect(internalsBreathAt(2500, p)).toBeGreaterThan(0);
    // PERIOD: the peak sits at the HALF period, which pins BREATH_MS at 5000 —
    // shift the constant and the crest moves off 2500.
    const peak = internalsBreathAt(2500, p);
    expect(peak).toBeCloseTo(0.55, 10);
    expect(internalsBreathAt(2300, p)).toBeLessThan(peak);
    expect(internalsBreathAt(2700, p)).toBeLessThan(peak);
    expect(internalsBreathAt(5000, p)).toBeCloseTo(0, 10);
  });
});

describe("internals focus rack", () => {
  it("racks the full channel and no further", () => {
    const samples = Array.from({ length: 57 }, (_, i) =>
      internalsFocusAt((i * 7000) / 56, 1),
    );
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
    expect(Math.max(...samples)).toBeCloseTo(1, 10);
    // a raised cosine: both ends of the loop sit at rest, so the envelope can
    // fade in or out without the focus group jumping
    expect(internalsFocusAt(0, 1)).toBe(0);
    expect(internalsFocusAt(7000, 1)).toBeCloseTo(0, 10);
  });

  it("is 0 at the span's edges, where hero-driver takes the channel back", () => {
    for (const t of TIMES) {
      expect(internalsFocusAt(t, internalsEnvAt(atFrac(caR, 0.15)).rack)).toBe(
        0,
      );
      expect(internalsFocusAt(t, internalsEnvAt(inR.p1).rack)).toBe(0);
      expect(internalsFocusAt(t, internalsEnvAt(atFrac(inR, 0.95)).rack)).toBe(
        0,
      );
    }
  });
});
