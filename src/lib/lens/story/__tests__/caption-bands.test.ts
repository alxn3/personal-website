import { describe, expect, it } from "vitest";
import {
  CAPTION_BANDS,
  CAPTION_FADE_CSS,
  CAPTION_PAD,
  RANGES,
  STORY,
  TRACK_HEIGHT_CSS,
  TRACK_SCROLL_CSS,
  bandOf,
  rangeOf,
} from "../story";

// CAPTION_BANDS lays out the hero captions (LensSceneContent.astro) from the
// same RANGES the canvas reads. These check the derivation, not the numbers.

/** The track's scrollable length (svh, not dvh). */
const SCROLL = "(100% - 100svh)";
/** a band length's multiple of SCROLL, parsed from the CSS */
const coeff = (css: string): number => {
  const m = /^calc\((-?[\d.]+) \* \(100% - 100svh\)/.exec(css);
  if (!m) throw new Error(`not a scroll-space band length: ${css}`);
  return Number(m[1]);
};

describe("CAPTION_BANDS", () => {
  it("has exactly one band per story scene, in story order", () => {
    expect(CAPTION_BANDS.map((b) => b.id)).toEqual(STORY.map((s) => s.id));
  });

  it("is each scene's range padded by CAPTION_PAD on both sides", () => {
    for (const b of CAPTION_BANDS) {
      const r = rangeOf(b.id);
      expect(b.a, `${b.id} start`).toBeCloseTo(
        Math.max(0, r.p0 - CAPTION_PAD),
        12,
      );
      // unless the scene sets capEnd
      const end =
        r.scene.capEnd !== undefined
          ? r.p0 + (r.p1 - r.p0) * r.scene.capEnd
          : r.p1 + CAPTION_PAD;
      if (r.p1 < 0.999) expect(b.b, `${b.id} end`).toBeCloseTo(end, 12);
    }
  });

  it("starts at the track top and the FINAL band runs to the track end", () => {
    expect(CAPTION_BANDS[0].a).toBe(0);
    expect(coeff(CAPTION_BANDS[0].top)).toBe(0);
    const last = CAPTION_BANDS[CAPTION_BANDS.length - 1];
    expect(last.b).toBe(1);
    expect(last.final).toBe(true);
    // Astro renders `false` as a string, so non-final bands carry undefined
    expect(last.finalAttr).toBe(true);
    expect(CAPTION_BANDS[0].finalAttr).toBeUndefined();
    // top + height = 1·(100% − 100svh) + 100svh = the whole track
    expect(coeff(last.top) + coeff(last.height)).toBeCloseTo(1, 6);
    expect(CAPTION_BANDS.filter((b) => b.final)).toHaveLength(1);
  });

  it("lays each band out in SCROLL space, with a viewport of pin room", () => {
    for (const b of CAPTION_BANDS) {
      // measured in the scrollable length, not in percentages of the track
      expect(b.top, `${b.id} top`).toBe(`calc(${b.a.toFixed(6)} * ${SCROLL})`);
      expect(b.height, `${b.id} height`).toBe(
        `calc(${(b.b - b.a).toFixed(6)} * ${SCROLL} + 100svh)`,
      );
      // the extra 100svh is the sticky caption's pin room
      expect(coeff(b.top), `${b.id} top`).toBeGreaterThanOrEqual(0);
      expect(coeff(b.height), `${b.id} height`).toBeGreaterThan(0);
      expect(
        coeff(b.top) + coeff(b.height),
        `${b.id} bottom`,
      ).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("is ordered, and neighbours overlap by exactly twice the pad", () => {
    for (let i = 1; i < CAPTION_BANDS.length; i++) {
      const prev = CAPTION_BANDS[i - 1];
      const cur = CAPTION_BANDS[i];
      expect(cur.a, `${cur.id} starts after ${prev.id}`).toBeGreaterThan(
        prev.a,
      );
      // a capEnd caption is gone before the next band opens
      if (rangeOf(prev.id).scene.capEnd !== undefined)
        expect(prev.b, `${prev.id} ends before ${cur.id}`).toBeLessThanOrEqual(
          cur.a,
        );
      else
        expect(prev.b - cur.a, `${prev.id}/${cur.id} crossfade`).toBeCloseTo(
          2 * CAPTION_PAD,
          12,
        );
    }
  });

  it("contains its scene's whole hold — the caption never leaves early", () => {
    for (const r of RANGES) {
      const b = bandOf(r.scene.id);
      expect(b.a, `${r.scene.id} start`).toBeLessThanOrEqual(r.p0);
      // an early end still covers the scene's camera move
      const end =
        r.scene.capEnd !== undefined
          ? r.p0 + (r.p1 - r.p0) * r.scene.transit
          : r.p1;
      expect(b.b, `${r.scene.id} end`).toBeGreaterThanOrEqual(end);
    }
  });
});

describe("CAPTION_FADE_CSS", () => {
  it("is the neighbours' overlap, over the track's SCROLLABLE length", () => {
    // LensStory.astro fades captions in and out over --cap-fade
    expect(CAPTION_FADE_CSS).toBe(
      `calc(${2 * CAPTION_PAD} * ${TRACK_SCROLL_CSS})`,
    );
    expect(TRACK_SCROLL_CSS).toBe(`calc(${TRACK_HEIGHT_CSS} - 100svh)`);
  });
});

describe("bandOf", () => {
  it("returns a scene's band, and throws on a typo — a BUILD error", () => {
    expect(bandOf("internals")).toBe(
      CAPTION_BANDS.find((b) => b.id === "internals"),
    );
    expect(() => bandOf("zomm")).toThrow(/zomm/);
  });
});
