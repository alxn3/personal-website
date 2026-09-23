import { describe, expect, it } from "vitest";
import { clamp01, smoothstep } from "../../core/math";
import {
  DIVE_P0,
  RANGES,
  atFrac,
  holdCentreOf,
  pulse,
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
  CHROME_FADE,
  F_STOPS,
  IRIS_HANDBACK,
  IRIS_HANDOVER,
  CARDS_APART,
  EXPLODE_PULSE,
  INTERIOR_BACK,
  PETALS_P0,
  ROSE_PULSE,
  SHELL_BACK,
  assembleAt,
  dustAt,
  bgAt,
  bgStopsFor,
  bgTintAt,
  chromeAt,
  driverOwnsIris,
  explodeAt,
  fStopOf,
  focalMmAt,
  inkFillAt,
  interiorFadeAt,
  preShutAt,
  sceneIndexAt,
  roseAt,
  scrollCueAt,
  shellFadeAt,
  zoomAt,
} from "../envelopes";
import { internalsApertureAt, internalsBreathAt } from "../internals";
import { bodyTransparent } from "../../materials/unified";
// the fly's look laws, read from their owner: the wink-cover law below is
// about where the body is transparent, which is the dive's to say
import { EXIT_END, HYST, flyBodyFadeAt, flyInkAt } from "../fly";
import { SPAN_P0 as PETALS_SPAN_P0 } from "../petals";

// ============================================================================
// THE ENVELOPES' LAWS — the relations between windows the story rests on,
// pinned on the functions the driver calls. No hand copy of any number: a
// retune that keeps the laws passes here and shows in STORY-MAP's diff.
// ============================================================================

const heroR = RANGES[0];
const zR = rangeOf("zoom");
const peR = rangeOf("peel");
const caR = rangeOf("cards");
const inR = rangeOf("internals");
const fR = rangeOf("flythrough");
const rwR = rangeOf("rewrap");
const capR = rangeOf("capsOn");

/** Every scene edge and every scene-fraction the driver's windows are authored
 *  at, plus a dense sweep — a plain lattice would miss the smoothstep feet,
 *  which is exactly where a mistyped edge hides. */
const SWEEP: number[] = (() => {
  const ps = new Set<number>();
  for (let i = 0; i <= 2000; i++) ps.add(i / 2000);
  for (const r of RANGES)
    for (let f = 0; f <= 20; f++) ps.add(atFrac(r, f / 20));
  return [...ps].sort((a, b) => a - b);
})();

// The assemble × rose EXCLUSION belongs on drawn values, so it lives in
// channel-ease.test.ts. What is pinned here is the authored intent: the seam is
// a HAND-OFF, not two windows that merely miss.
describe("the wrap and the bloom hand over, not merely miss", () => {
  it("SEQUENCES them — the wrap is a whole chapter clear of the bloom", () => {
    // the two fold the same wedge, so they may not overlap: the wrap is the
    // cards chapter's alone, and the ending's coming-together is EXPLODE, which
    // is what the bloom is sequenced against here
    const seam = windowEdges(ROSE_PULSE.rise)[0];
    const wrapEnd = windowEdges(CARDS_APART.fall)[1];
    expect(assembleAt(seam)).toBe(0);
    expect(wrapEnd).toBeLessThan(seam);
    expect(assembleAt(wrapEnd - 1e-4)).toBeGreaterThan(0);
    expect(roseAt(seam + 1e-3)).toBeGreaterThan(0);
    // …and the descent's own fall lands a settle beat ahead of it
    expect(windowEdges(EXPLODE_PULSE.fall)[1]).toBeLessThan(seam);
    expect(explodeAt(seam)).toBe(0);
  });
});

describe("the lens stands up for the internals scene", () => {
  it("is 0 everywhere the story travels the bore, 1 where it is read", () => {
    const inR = rangeOf("internals");
    const flR = rangeOf("flythrough");
    // every span written along world +X: the peel and cards, and the dive
    for (const p of [0, 0.2, rangeOf("cards").p0, atFrac(caR, 0.5)])
      expect(uprightAt(p), `p ${p}`).toBe(0);
    // …upright well inside the internals camera transit, and held for the hold
    expect(uprightAt(atFrac(inR, 0.5))).toBe(1);
    expect(uprightAt(holdCentreOf(inR))).toBe(1);
    expect(uprightAt(inR.p1)).toBe(1);
    // …and back on the bore's own axis by the dive's first frame, since
    // story/fly.ts dollies the model along world +X from there
    expect(uprightAt(DIVE_P0)).toBe(0);
    for (let i = 0; i <= 40; i++)
      expect(uprightAt(DIVE_P0 + ((1 - DIVE_P0) * i) / 40), "past the dive").toBe(0); // prettier-ignore
    // the tip itself is monotone up and monotone down — one turn each way
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = uprightAt(atFrac(caR, 0.8) + ((atFrac(inR, 0.3) - atFrac(caR, 0.8)) * i) / 100); // prettier-ignore
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(uprightAt(atFrac(flR, 0.08))).toBeGreaterThan(0);
    expect(uprightAt(atFrac(flR, 0.08))).toBeLessThan(1);
  });

  it("dips the nose across the turn, and NOWHERE else", () => {
    // the dip is subtracted from the tip's tilt, so a nonzero value outside the
    // cards chapter moves the bore off the axis every other span is written
    // against. The peel is in that list: its bore roll rides the model's `x`,
    // which is a roll about the bore only while `z` and `y` are exactly 0.
    for (const p of [0, heroR.p1, zR.p1, peR.p0, DIVE_P0, rwR.p0, 1])
      expect(dipAt(p), `p ${p}`).toBe(0);
    for (let i = 0; i <= 40; i++)
      expect(dipAt(atFrac(peR, i / 40)), `peel ${i / 40}`).toBe(0);
    // it is live where the lens turns, and spent exactly as the lens stands up
    expect(dipAt(caR.p0)).toBe(0);
    expect(dipAt(holdCentreOf(caR))).toBe(DIP_MAX);
    expect(dipAt(atFrac(inR, 0.3))).toBe(0);
    // monotone back to nothing over the stand-up, so nose and tip are one move
    let prev = Infinity;
    for (let i = 0; i <= 100; i++) {
      const v = dipAt(atFrac(caR, 0.8) + ((atFrac(inR, 0.3) - atFrac(caR, 0.8)) * i) / 100); // prettier-ignore
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});

// The ROCK is a SECOND writer on two of the three axes setModelOrientation
// composes, summed with the cards turn and the tip's tilt rather than blended —
// so its contract is: nothing outside its window, zero rate at both edges.
describe("the spinning-top rock", () => {
  const [P0, P1] = windowEdges(ROCK);
  /** how far the bore leans off its authored axis at p, radians */
  const lean = (p: number) => Math.hypot(rockZAt(p), rockYAt(p));

  it("nutates while the last pieces land, and NOWHERE else", () => {
    // the driver ADDS these to the turn and the tilt, so a nonzero value
    // outside the window moves the bore off the axis every other span uses
    for (const p of [0, heroR.p1, peR.p0, DIVE_P0, rwR.p0, capR.p0, P0, P1, 1])
      expect(lean(p), `p ${p}`).toBe(0);
    expect(lean(P0 - 1e-12)).toBe(0);
    expect(lean(P1 + 1e-12)).toBe(0);
    for (const p of SWEEP)
      if (p <= P0 || p >= P1) expect(lean(p), `p ${p}`).toBe(0);
    // …and it is live in between, or the window is dead weight
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

  it("rises and damps at zero rate — C1 at BOTH edges", () => {
    const rate = (p: number, h: number) =>
      Math.hypot(
        rockZAt(p + h) - rockZAt(p - h),
        rockYAt(p + h) - rockYAt(p - h),
      ) /
      (2 * h);
    // the rate vanishes LINEARLY with the distance inside each edge, so there
    // is no frame on which the wobble begins as an event; a C0 rise would hold
    // it at the ramp's own slope and pass every other pin in the suite.
    for (const eps of [1e-6, 1e-5, 1e-4]) {
      expect(rate(P0 + eps, eps / 2), `entry at ${eps}`).toBeLessThan(
        5e4 * eps,
      );
      expect(rate(P1 - eps, eps / 2), `damp at ${eps}`).toBeLessThan(5e4 * eps);
    }
  });

  it("shares no p with the cards scene's turn — the sum is exact", () => {
    // the driver writes ONE turn, `peelTurnAt(p) + rockYAt(p)`; both are a hard
    // 0 outside their own spans, so the write is a sum of disjoint supports
    for (const p of SWEEP)
      expect(
        Math.min(Math.abs(peelTurnAt(p)), Math.abs(rockYAt(p))),
        `both turns live at ${p}`,
      ).toBe(0);
  });
});

// THE COVER LAW: a wink dissolves only while the body is transparent
// (materials/unified.ts `bodyTransparent` — ink showing, or a body fade under
// 1) or wholly faded out; on an opaque body the alphaTest turns every piece
// into a pop. Each wink window is checked against the dive's own look laws.
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
    expect(INTERIOR_BACK[0]).toBeGreaterThanOrEqual(fR.p0);
    expect(INTERIOR_BACK[1]).toBeLessThan(DIVE_P0 - HYST);
    expect(interiorFadeAt(INTERIOR_BACK[1])).toBe(1);
    expect(interiorFadeAt(DIVE_P0)).toBe(1);
    // the ink is still a real share of the look where the last piece lands,
    // so the arrival reads as the peel's dissolve reversed
    expect(flyInkAt(INTERIOR_BACK[1])).toBeGreaterThan(0.2);
    // …and the shell stays off until the rewrap
    expect(shellFadeAt(DIVE_P0)).toBe(0);
    expect(shellFadeAt(rwR.p0)).toBe(0);
  });
});

describe("the dust has one law", () => {
  it("is off through the dive and from the petals' mount on, and on elsewhere", () => {
    for (const p of [0, holdCentreOf(zR), holdCentreOf(caR), DIVE_P0 - 1e-9])
      expect(dustAt(p), `p ${p}`).toBe(true);
    for (const p of [
      DIVE_P0,
      holdCentreOf(fR),
      holdCentreOf(rwR) - 0.1,
      EXIT_END,
    ])
      expect(dustAt(p), `p ${p}`).toBe(false);
    expect(dustAt(EXIT_END + 1e-9)).toBe(true);
    expect(dustAt(PETALS_SPAN_P0 - 1e-9)).toBe(true);
    for (const p of [PETALS_SPAN_P0, 0.99, 1])
      expect(dustAt(p), `p ${p}`).toBe(false);
    // the petals' own mount edge IS the law's edge
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
      for (const p of SWEEP) expect(bgTintAt(stops, p)).toEqual(bgAt(p, light));
    }
  });
});

describe("the pre-shut ramp", () => {
  it("gives the pre-shut ramp exactly one owner", () => {
    // story/internals.ts CALLS preShutAt rather than keeping a twin: with the
    // breath envelope dead (internals-local ≥ 0.6) the two are one number.
    for (let f = 0.6; f <= 1; f += 0.02) {
      const p = atFrac(inR, Math.min(1, f));
      expect(internalsBreathAt(0, p)).toBe(0);
      expect(internalsApertureAt(0, p), `aperture at internals ${f}`).toBe(
        preShutAt(p),
      );
    }
  });
});
