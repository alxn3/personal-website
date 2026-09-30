import { describe, expect, it } from "vitest";
import {
  DIVE_P0,
  RANGES,
  atFrac,
  holdCentreOf,
  rangeOf,
  windowEdges,
} from "../story";
import {
  WINK_SPAN,
  peelTurnAt,
  DIP_MAX,
  ROCK,
  ROCK_MAX,
  dipAt,
  rockYAt,
  rockZAt,
  uprightAt,
  F_STOPS,
  IRIS_HANDBACK,
  IRIS_HANDOVER,
  INTERIOR_BACK,
  PETALS_P0,
  SHELL_BACK,
  dustAt,
  bgAt,
  bgStopsFor,
  driverOwnsIris,
  fStopOf,
  focalMmAt,
  interiorFadeAt,
  preShutAt,
  shellFadeAt,
} from "../envelopes";
import { internalsApertureAt, internalsBreathAt } from "../internals";
import { bodyTransparent } from "../../materials/unified";
import { EXIT_END, HYST, flyBodyFadeAt, flyInkAt } from "../fly";
import { SPAN_P0 as PETALS_SPAN_P0 } from "../petals";

// Relations between the story's windows, checked on the functions the driver
// calls rather than on copied numbers.

const zoomScene = rangeOf("zoom");
const cardsScene = rangeOf("cards");
const internalsScene = rangeOf("internals");
const flyScene = rangeOf("flythrough");
const rewrapScene = rangeOf("rewrap");

/** A dense sweep of p plus every 1/20 fraction of every scene. */
const SWEEP: number[] = (() => {
  const ps = new Set<number>();
  for (let i = 0; i <= 2000; i++) ps.add(i / 2000);
  for (const r of RANGES)
    for (let f = 0; f <= 20; f++) ps.add(atFrac(r, f / 20));
  return [...ps].sort((a, b) => a - b);
})();

/** true if `f` never falls (dir 1) or never rises (dir −1) across `ps` */
const monotone = (f: (p: number) => number, ps: number[], dir: 1 | -1) =>
  ps.every((p, i) => i === 0 || dir * (f(p) - f(ps[i - 1])) >= 0);

describe("the lens stands up for the internals scene", () => {
  const standUp = SWEEP.filter(
    (p) => p >= atFrac(cardsScene, 0.8) && p <= atFrac(internalsScene, 0.3),
  );

  it("is 0 everywhere the story travels the bore, 1 where it is read", () => {
    for (const p of SWEEP) {
      // lying down through the peel and the cards, and again from the dive on
      if (p <= atFrac(cardsScene, 0.5) || p >= DIVE_P0)
        expect(uprightAt(p), `p ${p}`).toBe(0);
      // upright for the internals scene
      if (p >= atFrac(internalsScene, 0.3) && p <= internalsScene.p1)
        expect(uprightAt(p), `p ${p}`).toBe(1);
    }
    expect(uprightAt(DIVE_P0)).toBe(0);
    expect(monotone(uprightAt, standUp, 1)).toBe(true);
    expect(uprightAt(atFrac(flyScene, 0.08))).toBeGreaterThan(0);
    expect(uprightAt(atFrac(flyScene, 0.08))).toBeLessThan(1);
  });

  it("dips the nose across the turn, and nowhere else", () => {
    for (const p of SWEEP)
      if (p <= cardsScene.p0 || p >= atFrac(internalsScene, 0.3))
        expect(dipAt(p), `p ${p}`).toBe(0);
    // live during the turn, gone once the lens stands up
    expect(dipAt(holdCentreOf(cardsScene))).toBe(DIP_MAX);
    expect(monotone(dipAt, standUp, -1)).toBe(true);
  });
});

// The wobble is added to the turn and tilt, so it must be exactly 0 outside
// its window and start and stop at zero rate.
describe("the spinning-top rock", () => {
  const [P0, P1] = windowEdges(ROCK);
  /** how far the bore leans off its authored axis at p, radians */
  const lean = (p: number) => Math.hypot(rockZAt(p), rockYAt(p));

  it("wobbles while the last pieces land, and nowhere else", () => {
    for (const p of [...SWEEP, P0, P1, P0 - 1e-12, P1 + 1e-12])
      if (p <= P0 || p >= P1) expect(lean(p), `p ${p}`).toBe(0);
    expect(lean((P0 + P1) / 2)).toBeGreaterThan(0);
  });

  it("leans exactly ROCK_MAX at the peak, and never further", () => {
    let peak = 0;
    for (let i = 0; i <= 20000; i++)
      peak = Math.max(peak, lean(P0 + ((P1 - P0) * i) / 20000));
    expect(peak).toBeCloseTo(ROCK_MAX, 15);
    for (const p of SWEEP)
      expect(lean(p), `p ${p}`).toBeLessThanOrEqual(ROCK_MAX + 1e-12);
  });

  it("rises and damps at zero rate at both edges", () => {
    const rate = (p: number, h: number) =>
      Math.hypot(
        rockZAt(p + h) - rockZAt(p - h),
        rockYAt(p + h) - rockYAt(p - h),
      ) /
      (2 * h);
    // the rate shrinks linearly toward each edge
    for (const eps of [1e-6, 1e-5, 1e-4]) {
      expect(rate(P0 + eps, eps / 2), `entry at ${eps}`).toBeLessThan(
        5e4 * eps,
      );
      expect(rate(P1 - eps, eps / 2), `damp at ${eps}`).toBeLessThan(5e4 * eps);
    }
  });

  it("shares no p with the cards scene's turn", () => {
    for (const p of SWEEP)
      expect(
        Math.min(Math.abs(peelTurnAt(p)), Math.abs(rockYAt(p))),
        `both turns live at ${p}`,
      ).toBe(0);
  });
});

// A piece can only fade smoothly while the body is transparent (ink showing
// or body fading) or fully faded out; otherwise it pops.
describe("every wink runs under cover", () => {
  const covered = (p: number) =>
    bodyTransparent(flyInkAt(p) > 0, flyBodyFadeAt(p) < 1) ||
    flyBodyFadeAt(p) === 0;
  const windows: [string, [number, number]][] = [
    ["wink", WINK_SPAN],
    ["shell.back", SHELL_BACK],
    ["interior.back", INTERIOR_BACK],
  ];
  it("on every frame of every wink window", () => {
    for (const [name, [p0, p1]] of windows)
      for (let i = 0; i <= 200; i++) {
        const p = p0 + ((p1 - p0) * i) / 200;
        expect(covered(p), `${name} at ${p}`).toBe(true);
      }
  });

  it("the interior returns under the approach's ink, whole before the dive draws opaque", () => {
    expect(INTERIOR_BACK[0]).toBeGreaterThanOrEqual(flyScene.p0);
    expect(INTERIOR_BACK[1]).toBeLessThan(DIVE_P0 - HYST);
    expect(interiorFadeAt(INTERIOR_BACK[1])).toBe(1);
    expect(interiorFadeAt(DIVE_P0)).toBe(1);
    // the ink is still strong when the last piece lands
    expect(flyInkAt(INTERIOR_BACK[1])).toBeGreaterThan(0.2);
    // and the shell stays off until the rewrap
    expect(shellFadeAt(DIVE_P0)).toBe(0);
    expect(shellFadeAt(rewrapScene.p0)).toBe(0);
  });
});

describe("the dust has one law", () => {
  it("is off through the dive and from the petals' mount on, and on elsewhere", () => {
    for (const p of [
      0,
      holdCentreOf(zoomScene),
      holdCentreOf(cardsScene),
      DIVE_P0 - 1e-9,
    ])
      expect(dustAt(p), `p ${p}`).toBe(true);
    for (const p of [
      DIVE_P0,
      holdCentreOf(flyScene),
      holdCentreOf(rewrapScene) - 0.1,
      EXIT_END,
    ])
      expect(dustAt(p), `p ${p}`).toBe(false);
    expect(dustAt(EXIT_END + 1e-9)).toBe(true);
    expect(dustAt(PETALS_SPAN_P0 - 1e-9)).toBe(true);
    for (const p of [PETALS_SPAN_P0, 0.99, 1])
      expect(dustAt(p), `p ${p}`).toBe(false);
    // the petals' mount edge is the law's edge
    expect(PETALS_SPAN_P0).toBe(PETALS_P0);
  });
});

describe("the iris gate and the HUD", () => {
  it("hands the iris over at exact edges", () => {
    expect(driverOwnsIris(IRIS_HANDOVER)).toBe(false);
    expect(driverOwnsIris(IRIS_HANDOVER - 1e-12)).toBe(true);
    expect(driverOwnsIris(IRIS_HANDBACK)).toBe(false);
    expect(driverOwnsIris(IRIS_HANDBACK + 1e-12)).toBe(true);
  });

  it("clamps the f-stop: the live channel overshoots on a fast scrub", () => {
    expect(F_STOPS[0]).toBe("2.8");
    expect(F_STOPS[F_STOPS.length - 1]).toBe("22");
    expect(fStopOf(-0.4)).toBe("2.8");
    expect(fStopOf(1.7)).toBe("22");
    expect(focalMmAt(0)).toBe(18);
    expect(focalMmAt(1)).toBe(50);
  });

  it("tints the stage per theme, interpolating between the scenes' hold centres", () => {
    for (const light of [false, true]) {
      const stops = bgStopsFor(light);
      expect(stops.map((s) => s[0])).toEqual(
        RANGES.map((r) => (r.p0 + r.p1) / 2),
      );
      for (const r of RANGES)
        expect(bgAt((r.p0 + r.p1) / 2, light)).toEqual(
          light ? r.scene.bgLight : r.scene.bg,
        );
    }
  });
});

describe("the pre-shut ramp", () => {
  it("gives the pre-shut ramp exactly one owner", () => {
    // once the breath is over (internals ≥ 0.6) the aperture is the ramp alone
    for (let f = 0.6; f <= 1; f += 0.02) {
      const p = atFrac(internalsScene, Math.min(1, f));
      expect(internalsBreathAt(0, p)).toBe(0);
      expect(internalsApertureAt(0, p), `aperture at internals ${f}`).toBe(
        preShutAt(p),
      );
    }
  });
});
