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

// CAPTION_BANDS is the HTML LAYOUT of the hero captions: the band element each
// caption is sticky inside (components/LensSceneContent.astro) takes its
// top/height from here at BUILD time, while the canvas reads the same RANGES at
// runtime — one table, two readers, so the two cannot drift. These checks pin
// the DERIVATION, not the numbers: the durations are free to retune.

/** The track's scrollable length — see the scroll-space note in story.ts. The
 *  UNIT is load-bearing and pinned on purpose: svh, never dvh, so an iOS toolbar
 *  cannot re-lay-out the story mid-scroll (the unit law in story.ts). */
const SCROLL = "(100% - 100svh)";
/** a band box's multiple of that length, back out of the emitted CSS */
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
      if (r.p1 < 0.999)
        expect(b.b, `${b.id} end`).toBeCloseTo(r.p1 + CAPTION_PAD, 12);
    }
  });

  it("starts at the track top and the FINAL band runs to the track end", () => {
    expect(CAPTION_BANDS[0].a).toBe(0);
    expect(coeff(CAPTION_BANDS[0].top)).toBe(0);
    const last = CAPTION_BANDS[CAPTION_BANDS.length - 1];
    expect(last.b).toBe(1);
    expect(last.final).toBe(true);
    // the Astro-safe form: `false` on a data-* attribute would be STRINGIFIED,
    // marking every band final, so non-final bands must carry undefined
    expect(last.finalAttr).toBe(true);
    expect(CAPTION_BANDS[0].finalAttr).toBeUndefined();
    // top + height = 1·(100% − 100svh) + 100svh = the whole track
    expect(coeff(last.top) + coeff(last.height)).toBeCloseTo(1, 6);
    expect(CAPTION_BANDS.filter((b) => b.final)).toHaveLength(1);
  });

  it("lays each band out in SCROLL space, with a viewport of pin room", () => {
    for (const b of CAPTION_BANDS) {
      // p = scrollY / (track − viewport), so a band's box is measured in that
      // same scrollable length — NOT in percentages of the track, which would
      // put every band a·100svh late
      expect(b.top, `${b.id} top`).toBe(`calc(${b.a.toFixed(6)} * ${SCROLL})`);
      expect(b.height, `${b.id} height`).toBe(
        `calc(${(b.b - b.a).toFixed(6)} * ${SCROLL} + 100svh)`,
      );
      // the trailing viewport is the sticky caption's pin room: without it a
      // 100svh caption would have none at all
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
      expect(b.b, `${r.scene.id} end`).toBeGreaterThanOrEqual(r.p1);
    }
  });
});

describe("CAPTION_FADE_CSS", () => {
  it("is the overlap two neighbouring bands share, in the same scroll units", () => {
    // the handover IS the overlap: LensStory.astro fades a caption in over the
    // first --cap-fade of its band and out over the last, so a pad change has to
    // carry into both
    expect(CAPTION_BANDS[0].b - CAPTION_BANDS[1].a).toBeCloseTo(
      2 * CAPTION_PAD,
      12,
    );
    expect(CAPTION_FADE_CSS).toBe(
      `calc(${2 * CAPTION_PAD} * ${TRACK_SCROLL_CSS})`,
    );
  });

  it("measures the track's SCROLLABLE length, not its height", () => {
    expect(TRACK_SCROLL_CSS).toBe(`calc(${TRACK_HEIGHT_CSS} - 100svh)`);
  });
});

describe("bandOf", () => {
  it("returns the band a scene id owns", () => {
    expect(bandOf("internals")).toBe(
      CAPTION_BANDS.find((b) => b.id === "internals"),
    );
  });

  it("throws on an id no scene owns — a caption typo is a BUILD error", () => {
    expect(() => bandOf("zomm")).toThrow(/zomm/);
  });
});
