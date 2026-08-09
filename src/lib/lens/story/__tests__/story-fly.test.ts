import { describe, expect, it } from "vitest";
import { FLY } from "../../optics/fly-core";
import { smoothstep } from "../../core/math";
import { rangeOf, atFrac } from "../story";
import { flyMixAt, flyDiveP, flyApertureAt, skyOutAt } from "../fly";

describe("story fly span", () => {
  it("the camera hand-over is COMPLETE at the span's first frame", () => {
    const flyR = rangeOf("flythrough");
    const iR = rangeOf("internals");
    // nothing before the last quarter of the internals scene…
    expect(flyMixAt(atFrac(iR, 0.5))).toBe(0);
    expect(flyMixAt(atFrac(iR, 0.75))).toBe(0);
    // …rising over that tail…
    const mid = flyMixAt(atFrac(iR, 0.875));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // …and home BEFORE the dive does anything: the lens is centred and dead-on
    // down the axis on the span's own first frame.
    expect(flyMixAt(flyR.p0)).toBe(1);
    expect(flyMixAt(atFrac(flyR, 0.1))).toBe(1);
  });

  it("mix is 0 outside the span and 1 mid-dive", () => {
    const flyR = rangeOf("flythrough");
    expect(flyMixAt(rangeOf("internals").p0)).toBe(0);
    expect(flyMixAt(atFrac(flyR, 0.5))).toBe(1);
    expect(flyMixAt(atFrac(rangeOf("constellations"), 0.5))).toBe(1);
    expect(flyMixAt(atFrac(rangeOf("trails"), 0.5))).toBe(1);
    expect(flyMixAt(atFrac(rangeOf("rewrap"), 0.3))).toBe(0);
    expect(flyMixAt(atFrac(rangeOf("capsOn"), 0.5))).toBe(0);
  });

  it("dive progress scrubs over flythrough and holds 1 through the sky", () => {
    const flyR = rangeOf("flythrough");
    expect(flyDiveP(flyR.p0)).toBe(0);
    expect(flyDiveP(flyR.p1)).toBeCloseTo(1, 10);
    expect(flyDiveP(atFrac(rangeOf("trails"), 0.9))).toBe(1);
  });

  it("aperture parks shut and is fully open before glass entry", () => {
    expect(flyApertureAt(0)).toBe(FLY.apertureShut);
    expect(flyApertureAt(FLY.pAperture[1])).toBe(0);
    expect(FLY.pAperture[1]).toBeLessThan(FLY.pEnter);
  });

  it("the sky is whole through the dive and gone inside rewrap", () => {
    const rwR = rangeOf("rewrap");
    expect(skyOutAt(atFrac(rangeOf("flythrough"), 0.5))).toBe(1);
    expect(skyOutAt(atFrac(rangeOf("constellations"), 0.5))).toBe(1);
    expect(skyOutAt(atFrac(rangeOf("trails"), 0.9))).toBe(1);
    expect(skyOutAt(rwR.p0)).toBe(1);
    expect(skyOutAt(atFrac(rwR, 0.02))).toBe(1);
    // gone BEFORE the span's own edge (EXIT_END, rewrap-local 0.25): the fade
    // is finished by the time the fly hands the camera back
    expect(skyOutAt(atFrac(rwR, 0.22))).toBe(0);
    expect(skyOutAt(atFrac(rwR, 0.5))).toBe(0);
    expect(skyOutAt(atFrac(rangeOf("capsOn"), 0.5))).toBe(0);
    // halfway down the window it is on the way out, not at either end
    const mid = skyOutAt(atFrac(rwR, 0.12));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("the sky's way out is monotone", () => {
    const rwR = rangeOf("rewrap");
    let prev = 1;
    for (let i = 0; i <= 60; i++) {
      const v = skyOutAt(
        rangeOf("trails").p0 + (rwR.p1 - rangeOf("trails").p0) * (i / 60),
      );
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });

  it("the composed sky mix is still 0 before the dive's sky window", () => {
    // what fly.ts writes to uSkyMix/uStarMix: skyIn(pFly) × skyOutAt(p)
    const mixAt = (p: number) =>
      smoothstep(FLY.pSkyIn[0], FLY.pSkyIn[1], flyDiveP(p)) * skyOutAt(p);
    const flyR = rangeOf("flythrough");
    expect(mixAt(flyR.p0)).toBe(0);
    expect(mixAt(atFrac(flyR, FLY.pSkyIn[0] * 0.5))).toBe(0);
    // …and full once the window is open, all the way to the reveal's fade
    expect(mixAt(atFrac(rangeOf("trails"), 0.5))).toBe(1);
    expect(mixAt(atFrac(rangeOf("rewrap"), 0.22))).toBe(0);
  });
});
