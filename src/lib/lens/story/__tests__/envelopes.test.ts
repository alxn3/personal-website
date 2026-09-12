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
  ROSE_PULSE,
  assembleAt,
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

// ============================================================================
// THE ENVELOPES, TRANSCRIBED.
//
// story/envelopes.ts holds expressions that once lived in the DOM-bound driver.
// Each is transcribed back here and pinned with `toBe` — bit-identical, not
// close — over every scene edge, every window edge and a dense sweep, so the
// rendered story cannot move by an ulp.
//
// A deliberate retune means moving the number HERE too, and saying so.
// ============================================================================

const heroR = RANGES[0];
const zR = rangeOf("zoom");
const peR = rangeOf("peel");
const caR = rangeOf("cards");
const inR = rangeOf("internals");
const fR = rangeOf("flythrough");
const rwR = rangeOf("rewrap");
const capR = rangeOf("capsOn");

const OLD_CHROME_FADE_P0 = atFrac(capR, 0.77);
const OLD_F_STOPS = ["2.8", "4", "5.6", "8", "11", "16", "22"];

const oldZoom = (p: number) =>
  pulse(p, { rise: ["zoom", 0.15, 0.85], fall: ["peel", 0, 0.4] });
// RETUNED, per the header's contract: the fall opens on the last scene's own
// foot, so the middle pieces leave on the still face-on frame and the stack
// follows under the camera's turn. The rise is the original.
const oldExplode = (p: number) =>
  pulse(p, {
    rise: ["trails", 0.05, 0.5],
    fall: ["capsOn", 0.03, 0.64],
  });
// RETUNED, same contract: two saturated recipes cannot sum into a rigid parked
// pose, so the wrap runs over the cards chapter only — one pulse, not two. The
// peel half fills the peel scene, its tail running into the wink; the fall
// waits for the wink's end, now inside the cards scene.
const oldAssemble = (p: number) =>
  pulse(p, {
    rise: [
      ["zoom", 0.85],
      ["peel", 0.96],
    ],
    fall: ["cards", 0.16, 0.3],
  });
const oldPreShut = (p: number) =>
  smoothstep(atFrac(inR, 0.6), atFrac(inR, 0.95), p);
const oldOwnsIris = (p: number) => p < atFrac(caR, 0.15) - 0.02 || p > inR.p1;
const oldInkFill = (p: number) =>
  0.5 * smoothstep(atFrac(zR, 0.0), atFrac(zR, 0.5), p) +
  0.5 * smoothstep(peR.p0, atFrac(peR, 0.35), p);
// RETUNED: the wink opens earlier and runs into the cards scene, so the pieces
// dissolve under the turn and the cards are born on them.
const oldShellFade = (p: number) =>
  1 -
  smoothstep(atFrac(peR, 0.57), atFrac(caR, 0.15), p) +
  smoothstep(rwR.p0, atFrac(rwR, 0.05), p);
// RETUNED, same contract: the interior's return WAITS for the camera's park, so
// its edges are authored off the transit DIVE_P0 is derived from. The wink half
// is the original.
const oldInteriorFade = (p: number) =>
  1 -
  smoothstep(atFrac(peR, 0.57), atFrac(caR, 0.15), p) +
  smoothstep(atFrac(fR, fR.scene.transit), atFrac(fR, fR.scene.transit + 0.07), p); // prettier-ignore
const oldSceneIndex = (p: number) => {
  let scn = RANGES.length - 1;
  for (let k = 0; k < RANGES.length; k++) {
    if (p < RANGES[k].p1) {
      scn = k;
      break;
    }
  }
  return scn;
};
const oldFocal = (zoom: number) => Math.round(18 + zoom * 32);
const oldFStop = (aperture: number) =>
  OLD_F_STOPS[Math.round(clamp01(aperture) * (OLD_F_STOPS.length - 1))];
const oldScrollCue = (p: number) =>
  1 - smoothstep(atFrac(heroR, 0.1), atFrac(heroR, 0.9), p);
const oldChrome = (p: number) => 1 - smoothstep(OLD_CHROME_FADE_P0, capR.p1, p);
const oldBgStops = (light: boolean): [number, [number, number, number]][] =>
  RANGES.map((r) => [(r.p0 + r.p1) / 2, light ? r.scene.bgLight : r.scene.bg]);
const oldBgTint = (
  stops: [number, [number, number, number]][],
  p: number,
): number[] => {
  let i = 0;
  while (i < stops.length - 2 && p > stops[i + 1][0]) i++;
  const [pa, a] = stops[i];
  const [pb, b] = stops[i + 1];
  const t = clamp01((p - pa) / Math.max(1e-3, pb - pa));
  return a.map((v, k) => Math.round(v + (b[k] - v) * t));
};

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

// THE RELATIONAL PIN the transcription above cannot give: both edges are
// authored off the flythrough's transit, so this fails loudly the day the
// approach is retuned and the return is left behind on a stale fraction.
describe("the interior comes back on the camera's park", () => {
  it("opens no earlier than the dive's first frame", () => {
    expect(INTERIOR_BACK[0]).toBeGreaterThanOrEqual(DIVE_P0);
    expect(INTERIOR_BACK[1]).toBeGreaterThan(DIVE_P0);
    expect(INTERIOR_BACK[1]).toBeLessThan(fR.p1);
    // …so not one mesh has come back while the camera is still swinging on,
    // and the interior is whole again inside the dive
    expect(interiorFadeAt(DIVE_P0)).toBe(0);
    expect(interiorFadeAt(INTERIOR_BACK[1])).toBe(1);
  });
});

describe("the driver's envelopes, extracted", () => {
  it("reproduces every channel pulse bit-for-bit", () => {
    for (const p of SWEEP) {
      expect(zoomAt(p), `zoom at ${p}`).toBe(oldZoom(p));
      expect(explodeAt(p), `explode at ${p}`).toBe(oldExplode(p));
      expect(assembleAt(p), `assemble at ${p}`).toBe(oldAssemble(p));
      expect(preShutAt(p), `preShut at ${p}`).toBe(oldPreShut(p));
    }
  });

  it("reproduces every look envelope bit-for-bit", () => {
    for (const p of SWEEP) {
      expect(inkFillAt(p), `inkFill at ${p}`).toBe(oldInkFill(p));
      expect(shellFadeAt(p), `shellFade at ${p}`).toBe(oldShellFade(p));
      expect(interiorFadeAt(p), `interiorFade at ${p}`).toBe(
        oldInteriorFade(p),
      );
    }
  });

  it("reproduces the chrome, the cue and the scene index bit-for-bit", () => {
    for (const p of SWEEP) {
      expect(chromeAt(p), `chrome at ${p}`).toBe(oldChrome(p));
      expect(scrollCueAt(p), `scrollCue at ${p}`).toBe(oldScrollCue(p));
      expect(sceneIndexAt(p), `scene index at ${p}`).toBe(oldSceneIndex(p));
      expect(driverOwnsIris(p), `iris owner at ${p}`).toBe(oldOwnsIris(p));
    }
    // the gate's own edges, where an off-by-an-epsilon would live
    expect(driverOwnsIris(IRIS_HANDOVER)).toBe(false);
    expect(driverOwnsIris(IRIS_HANDOVER - 1e-12)).toBe(true);
    expect(driverOwnsIris(IRIS_HANDBACK)).toBe(false);
    expect(driverOwnsIris(IRIS_HANDBACK + 1e-12)).toBe(true);
    expect(CHROME_FADE[0]).toBe(OLD_CHROME_FADE_P0);
    expect(CHROME_FADE[1]).toBe(capR.p1);
  });

  it("reproduces the HUD readouts bit-for-bit", () => {
    expect(F_STOPS).toEqual(OLD_F_STOPS);
    for (let i = 0; i <= 1000; i++) {
      const v = i / 1000;
      expect(focalMmAt(v), `focal at ${v}`).toBe(oldFocal(v));
      expect(fStopOf(v), `f-stop at ${v}`).toBe(oldFStop(v));
    }
    // the clamp is load-bearing: the fly drives the aperture channel and the
    // HUD reads the LIVE eased value, which overshoots on a fast scrub
    expect(fStopOf(-0.4)).toBe("2.8");
    expect(fStopOf(1.7)).toBe("22");
  });

  it("reproduces the stage tint bit-for-bit, both themes", () => {
    for (const light of [false, true]) {
      const stops = bgStopsFor(light);
      const old = oldBgStops(light);
      expect(stops).toEqual(old);
      for (const p of SWEEP) {
        expect(bgTintAt(stops, p), `tint at ${p} light=${light}`).toEqual(
          oldBgTint(old, p),
        );
        expect(bgAt(p, light)).toEqual(oldBgTint(old, p));
      }
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
