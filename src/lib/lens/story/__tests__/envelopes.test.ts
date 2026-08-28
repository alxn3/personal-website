import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
import { WINK_SPAN, peelTurnAt } from "../peelcards";
import {
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
// THE EXTRACTION'S PROOF.
//
// story/envelopes.ts is a pure MOVE out of startHeroStory's closure: the driver
// is DOM-bound (document.getElementById on its first line), so nothing that
// lived in it could ever be imported, and the extraction's only real risk is a
// transcription slip in one of the twelve expressions.
//
// So the expressions are TRANSCRIBED BACK, verbatim from the pre-extraction
// source (story/hero-driver.ts), and pinned with `toBe` —
// bit-identical, not close — over every scene edge, every window edge and a
// dense sweep. A `toBeCloseTo` here would pass on a re-associated sum, and the
// whole claim of this refactor is that the rendered story did not move by one
// ulp.
//
// These transcriptions are DEAD WEIGHT the day they are written, on purpose:
// they exist to make the move provable, and if a window is ever deliberately
// retuned the right edit is to move the number here too and say so in the
// commit. That is the same contract optics/__tests__/trace-goldens.test.ts has.
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
  pulse(p, { rise: ["zoom", 0.15, 0.62], fall: ["peel", 0, 0.4] });
// RETUNED, per this file's own contract (header). Twice: first when the ending
// became the pieces flying in to construct the rose, which moved the explode
// channel's FALL out of `rewrap` (where it was authored off EXPLODE_FALL_F and
// REVEAL_END_F, both spent) into `capsOn`; and again when the ending became one
// long descent — the fall now opens on the last scene's own foot, so the middle
// pieces leave on the still face-on frame and the stack follows under the
// camera's turn. The transcription moves with it; the rise, and every other
// expression below, is still the pre-extraction original.
const oldExplode = (p: number) =>
  pulse(p, {
    rise: ["trails", 0.05, 0.5],
    fall: ["capsOn", 0, 0.64],
  });
// RETUNED, same contract: the sky chapter's half of this channel is GONE. Two
// saturated recipes cannot sum into a rigid parked pose, so the ending is the
// explode recipe alone and the wrap runs over the cards chapter only — one
// pulse where there were two. The peel half is transcribed at its current
// windows, which fill the peel scene: the departure has to PLAY there, and its
// tail runs into the wink instead of stopping ahead of it.
const oldAssemble = (p: number) =>
  pulse(p, { rise: ["peel", 0.1, 0.92], fall: ["cards", 0.12, 0.26] });
const oldPreShut = (p: number) =>
  smoothstep(atFrac(inR, 0.6), atFrac(inR, 0.95), p);
const oldOwnsIris = (p: number) => p < atFrac(caR, 0.15) - 0.02 || p > inR.p1;
const oldInkFill = (p: number) =>
  0.5 * smoothstep(atFrac(zR, 0.0), atFrac(zR, 0.5), p) +
  0.5 * smoothstep(peR.p0, atFrac(peR, 0.35), p);
const oldShellFade = (p: number) =>
  1 -
  smoothstep(WINK_SPAN[0], WINK_SPAN[1], p) +
  smoothstep(rwR.p0, atFrac(rwR, 0.05), p);
// RETUNED, per this file's own contract (header): the flythrough's approach
// grew, and the interior's return is authored to WAIT for the camera's park, so
// its edges left their old hand-authored fractions for the transit DIVE_P0 is
// derived from. The wink half is still the pre-extraction original.
const oldInteriorFade = (p: number) =>
  1 -
  smoothstep(WINK_SPAN[0], WINK_SPAN[1], p) +
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

// The assemble × rose EXCLUSION is not pinned here: the deform host sums the
// recipes off the eased channels, not off these functions, so the law belongs
// on drawn values — `__tests__/channel-ease.test.ts` walks a full-track
// scrubber drag and both real gestures. What is left here is the authored
// intent that test cannot see: that the seam is a HAND-OFF rather than two
// windows that merely miss.
describe("the wrap and the bloom hand over, not merely miss", () => {
  it("SEQUENCES them — the wrap is a whole chapter clear of the bloom", () => {
    // the two fold the same wedge, so they may not overlap. The wrap is the
    // cards chapter's alone now, five scenes ahead of the bloom's foot, and the
    // ending's own coming-together is the EXPLODE channel — which is what the
    // bloom has to be sequenced against here.
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
    // the dip is subtracted from the tip's own tilt, so a nonzero value outside
    // the cards chapter would move the bore off the axis every other span is
    // written against — the dive's included. THE WHOLE PEEL IS IN THAT LIST:
    // the peel's bore roll rides the model's `x`, which is a roll about the
    // bore only while the dip's `z` and the turn's `y` are exactly 0.
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

// The ROCK is a SECOND writer on two of the three axes hero-driver's one
// setModelOrientation call composes, summed with the cards scene's turn and the
// tip's tilt rather than blended — so its whole contract is that it is nothing
// at all outside its own window and leaves at zero rate at both edges. Pinned
// in dipAt's idiom above, because the generated maps cannot see any of it: they
// sample one p inside this window, and the rise is already saturated there.
describe("the spinning-top rock", () => {
  const [P0, P1] = windowEdges(ROCK);
  /** how far the bore leans off its authored axis at p, radians */
  const lean = (p: number) => Math.hypot(rockZAt(p), rockYAt(p));

  it("nutates while the last pieces land, and NOWHERE else", () => {
    // the driver ADDS these to the turn and the tilt, so a nonzero value
    // outside the window moves the bore off the axis the hand-off pose, the
    // bloom and every dive-side span are written against.
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
    // the rate vanishes LINEARLY with the distance inside each edge, which is
    // what "no frame on which the wobble begins as an event" means. A C0 rise
    // (a linear ramp in place of the entry smoothstep) holds it at the ramp's
    // own slope instead, and is invisible to every other pin in the suite.
    for (const eps of [1e-6, 1e-5, 1e-4]) {
      expect(rate(P0 + eps, eps / 2), `entry at ${eps}`).toBeLessThan(
        5e4 * eps,
      );
      expect(rate(P1 - eps, eps / 2), `damp at ${eps}`).toBeLessThan(5e4 * eps);
    }
  });

  it("shares no p with the cards scene's turn — the sum is exact", () => {
    // the driver writes ONE turn, `peelTurnAt(p) + rockYAt(p)`. Both are a hard
    // 0 outside their own spans, so that write is a sum of disjoint supports
    // rather than a blend of two laws over a shared stretch.
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

describe("the extraction's single source", () => {
  // THE STRUCTURAL GUARD, and the most important property of the design: the
  // driver CALLS the envelopes rather than keeping a copy, so it cannot drift
  // by construction. A future envelope written inline in frame() would restore
  // exactly the trap this task removed — and, being inside a DOM-bound closure,
  // would be untestable and unreportable again the moment it landed.
  //
  // WHAT IT CATCHES, exactly: the driver's own TOOLBOX is pinned (the names it
  // imports from core/math.ts and story/story.ts, which is what an envelope
  // would have to be built from — an alias binds a local name, so a renamed
  // import shows up too) and every remaining call of one of those tools is
  // counted, with its one legitimate DOM-bound site named. What it cannot catch
  // is an envelope written in bare arithmetic — a ternary, a hand-rolled clamp
  // — so this is a tripwire on the shapes that have actually appeared here, not
  // a proof.
  const driver = readFileSync(
    new URL("../hero-driver.ts", import.meta.url),
    "utf8",
  );

  /** the LOCAL names the driver binds from one specifier, sorted */
  const importsFrom = (spec: string): string[] => {
    const m = driver.match(
      new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${spec}["']`),
    );
    return (m?.[1] ?? "")
      .split(",")
      .map((s) =>
        s
          .trim()
          .split(/\s+as\s+/)
          .pop()!
          .trim(),
      )
      .filter(Boolean)
      .sort();
  };

  const calls = (name: string) =>
    (driver.match(new RegExp(`\\b${name}\\(`, "g")) ?? []).length;

  it("builds nothing new from the story's own maths", () => {
    // core/math.ts is where an envelope's parts live. FOUR names reach the
    // driver, and all four are spent on the DOM contract below; a fifth
    // (`lerp`, `pulse` under any name, a new primitive) is the signal.
    expect(importsFrom("\\.\\./core/math\\.js")).toEqual([
      "BAND_FEATHER",
      "band",
      "clamp01",
      "smoothstep",
    ]);
    // …and story/story.ts is where the WINDOWS live: the driver may read the
    // table, the ranges and the two constants the tiles are built on, but
    // `pulse` and `atFrac`-authored edges belong to story/envelopes.ts. Even
    // the scrubber's park position arrives as a NAMED law (`holdCentreOf`,
    // shared with story/cost.ts's hold rows) — the driver authors no p at all.
    expect(importsFrom("\\./story\\.js")).toEqual([
      "DIVE_P0",
      "RANGES",
      "STORY",
      "bandOf",
      "holdCentreOf",
      "rangeOf",
    ]);
  });

  it("spends those imports only on the DOM contract", () => {
    // --beat-visibility, from the BLOCK's own band edges
    expect(calls("band"), "band(): --beat-visibility").toBe(1);
    // --beat-local, the track's own scroll fraction, and the roll writer's
    // eased story position (clamped exactly as core/scene's tick() clamps it
    // before sampling the camera — the same value, the same guard)
    expect(
      calls("clamp01"),
      "clamp01(): --beat-local + the track fraction + the roll's eased p",
    ).toBe(3);
    // the ?story panel's per-scene park buttons jump to the named hold centre
    expect(
      calls("holdCentreOf"),
      "holdCentreOf(): the ?story panel's park buttons",
    ).toBe(1);
    // raw window arithmetic stays out of the driver entirely
    expect(calls("atFrac"), "atFrac() belongs to the envelope modules").toBe(0);
    // …and nothing an envelope is ever made of
    expect(calls("lerp"), "lerp() belongs in story/envelopes.ts").toBe(0);
  });

  it("leaves no envelope authored inside the DOM-bound driver", () => {
    expect(driver).toContain('from "./envelopes"');
    expect(
      driver.match(/\bpulse\(/g),
      "a pulse() in hero-driver.ts belongs in story/envelopes.ts",
    ).toBe(null);
    // ONE smoothstep survives, and only one: --beat-progress, whose window is
    // authored per BLOCK in the markup (data-progress-from/-to) and is
    // therefore a property of the DOM rather than of the story.
    const steps = driver.match(/\bsmoothstep\(/g) ?? [];
    expect(
      steps.length,
      "the only smoothstep in hero-driver.ts is --beat-progress's",
    ).toBe(1);
    // …and it is what --beat-progress is written from
    expect(driver).toMatch(/\bprogress = smoothstep\(/);
    expect(driver).toMatch(
      /setProperty\(\s*"--beat-progress",\s*String\(progress\)\s*\)/,
    );
  });

  it("gives the pre-shut ramp exactly one owner", () => {
    // story/internals.ts used to hold a textual twin of hero-driver's `preShut`,
    // kept identical by a comment. It now CALLS preShutAt, which is what makes
    // "one continuous law across both edges of the scene" checkable: with the
    // breath envelope dead (internals-local ≥ 0.6) the two are the same number.
    for (let f = 0.6; f <= 1; f += 0.02) {
      const p = atFrac(inR, Math.min(1, f));
      expect(internalsBreathAt(0, p)).toBe(0);
      expect(internalsApertureAt(0, p), `aperture at internals ${f}`).toBe(
        preShutAt(p),
      );
    }
  });
});
