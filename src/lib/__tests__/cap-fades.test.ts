import { describe, expect, it } from "vitest";
import {
  CAP_BAND_SELECTOR,
  CAP_FADE_ROOT_MARGIN,
  applyCapFades,
  capFadeState,
  type CapFadeTarget,
} from "../cap-fades";
import {
  CAPTION_BANDS,
  TRACK_MAX_PX,
  TRACK_MIN_PX,
  TRACK_SVH,
} from "../lens/story/story";

// The fallback that carries the hero captions on browsers without CSS
// scroll-driven animations. The observer BODY is split out so it is testable
// without a DOM (there is no jsdom in this repo, on purpose). Its targets are
// the BANDS, not the captions — a band's box is its scene, a sticky caption's
// outlives it by a viewport.

const spy = () => {
  const calls: [string, boolean][] = [];
  const el: CapFadeTarget = {
    classList: {
      toggle: (token, force) => {
        calls.push([token, force]);
      },
    },
  };
  return { el, calls };
};

/** the token each target ended up with after the last batch */
const lit = (...spies: { calls: [string, boolean][] }[]) =>
  spies.map((s) => s.calls.at(-1)?.[1] ?? false);

describe("applyCapFades", () => {
  it("marks a band in when its scene starts", () => {
    const a = spy();
    const state = capFadeState([a.el]);
    applyCapFades(state, [{ target: a.el, isIntersecting: true, above: true }]);
    expect(a.calls).toEqual([["is-in", true]]);
  });

  it("takes it back OUT when it leaves — unlike the [data-reveal] reveal, which fires once", () => {
    const a = spy();
    const b = spy();
    const state = capFadeState([a.el, b.el]);
    applyCapFades(state, [{ target: a.el, isIntersecting: true, above: true }]);
    applyCapFades(state, [
      { target: a.el, isIntersecting: false, above: false },
      { target: b.el, isIntersecting: true, above: true },
    ]);
    expect(lit(a, b)).toEqual([false, true]);
  });

  it("lights only the FIRST intersecting band in document order", () => {
    const a = spy();
    const b = spy();
    const state = capFadeState([a.el, b.el]);
    applyCapFades(state, [
      { target: b.el, isIntersecting: true, above: true },
      { target: a.el, isIntersecting: true, above: true },
    ]);
    expect(lit(a, b)).toEqual([true, false]);
  });

  it("releases to the next one when the lit band leaves", () => {
    const a = spy();
    const b = spy();
    const state = capFadeState([a.el, b.el]);
    applyCapFades(state, [
      { target: a.el, isIntersecting: true, above: true },
      { target: b.el, isIntersecting: true, above: true },
    ]);
    expect(lit(a, b)).toEqual([true, false]);
    // only `a` reports out — `b` is still intersecting and never re-reported
    applyCapFades(state, [
      { target: a.el, isIntersecting: false, above: false },
    ]);
    expect(lit(a, b)).toEqual([false, true]);
  });

  it("keeps the LAST band lit once it has started and none crosses the line", () => {
    // at maximum scroll the line lands exactly on the final band's bottom edge
    const a = spy();
    const b = spy();
    const state = capFadeState([a.el, b.el]);
    applyCapFades(state, [
      { target: a.el, isIntersecting: false, above: true },
      { target: b.el, isIntersecting: false, above: true },
    ]);
    expect(lit(a, b)).toEqual([false, true]);
  });

  it("lights nothing in a gap before the last band", () => {
    const a = spy();
    const b = spy();
    const state = capFadeState([a.el, b.el]);
    applyCapFades(state, [
      { target: a.el, isIntersecting: false, above: true },
      { target: b.el, isIntersecting: false, above: false },
    ]);
    expect(lit(a, b)).toEqual([false, false]);
  });

  it("gets there the same way whether the reader scrolled or jumped", () => {
    const a = spy();
    const b = spy();
    const scrolled = capFadeState([a.el, b.el]);
    applyCapFades(scrolled, [
      { target: a.el, isIntersecting: true, above: true },
    ]);
    applyCapFades(scrolled, [
      { target: a.el, isIntersecting: false, above: false },
      { target: b.el, isIntersecting: true, above: true },
    ]);
    applyCapFades(scrolled, [
      { target: b.el, isIntersecting: false, above: true },
    ]);
    const viaScroll = lit(a, b);

    const c = spy();
    const d = spy();
    const jumped = capFadeState([c.el, d.el]);
    applyCapFades(jumped, [
      { target: c.el, isIntersecting: false, above: true },
      { target: d.el, isIntersecting: false, above: true },
    ]);
    expect(lit(c, d)).toEqual(viaScroll);
  });
});

describe("the fade contract", () => {
  it("observes BANDS — the element whose box is the scene", () => {
    // spec §3: "it observes bands only". A caption is sticky, so its box rides
    // its band's bottom edge for the last viewport of the band and would stay
    // lit deep into the next scene.
    expect(CAP_BAND_SELECTOR).toBe(".cap-band");
  });

  it("collapses the root onto the viewport's BOTTOM edge", () => {
    const [top, right, bottom, left] = CAP_FADE_ROOT_MARGIN.split(" ");
    // -100% off the TOP shrinks the root down to a zero-height line at the
    // bottom; every other side is untouched, so the line spans the viewport.
    expect(top).toBe("-100%");
    expect([right, bottom, left]).toEqual(["0px", "0px", "0px"]);
  });
});

describe("the fallback against the band geometry", () => {
  /** Scroll the real CAPTION_BANDS past the line at viewport (w×)vh: which band
   *  the fallback lights, and which captions the CSS view-timelines light. */
  const sweep = (vh: number) => {
    const track = Math.min(
      TRACK_MAX_PX,
      Math.max(TRACK_MIN_PX, (TRACK_SVH / 100) * vh),
    );
    const S = track - vh;
    const spies = CAPTION_BANDS.map(() => spy());
    const state = capFadeState(spies.map((s) => s.el));
    const rows: { y: number; io: number; css: number[] }[] = [];
    for (let y = 0; y <= S; y++) {
      const line = y + vh;
      applyCapFades(
        state,
        CAPTION_BANDS.map((band, i) => ({
          target: spies[i].el,
          isIntersecting: band.a * S < line && line < band.b * S + vh,
          above: band.a * S < line,
        })),
      );
      const io = lit(...spies).indexOf(true);
      // CSS: lit over (a·S, b·S); the hero from 0, the final band to the end
      const css = CAPTION_BANDS.flatMap((band, i) =>
        (i === 0 || band.a * S < y) && (band.final || y < band.b * S)
          ? [i]
          : [],
      );
      rows.push({ y, io, css });
    }
    return rows;
  };

  const FINAL = CAPTION_BANDS.length - 1;

  // a short landscape phone (the track clamps to its minimum), a tall phone, a
  // laptop
  for (const vh of [390, 844, 900]) {
    it(`lights the final caption only where the CSS path does at ${vh}px`, () => {
      for (const { y, io, css } of sweep(vh)) {
        if (io === FINAL) expect(css, `y=${y}`).toContain(FINAL);
        if (css.length === 1 && css[0] === FINAL)
          expect(io, `y=${y}`).toBe(FINAL);
      }
    });

    it(`otherwise lights a CSS-lit caption, or one entering a gap, at ${vh}px`, () => {
      // in a gap (a capEnd scene) the next band crosses the line up to one
      // viewport before its CSS fade-in starts
      const track = sweep(vh);
      for (const { y, io, css } of track) {
        if (io < 0 || css.includes(io)) continue;
        expect(css, `y=${y}`).toEqual([]);
        expect(y, `y=${y}`).toBeGreaterThan(
          CAPTION_BANDS[io].a * (track.length - 1) - vh,
        );
      }
    });

    it(`holds the final caption at max scroll at ${vh}px`, () => {
      expect(sweep(vh).at(-1)!.io).toBe(FINAL);
    });
  }

  it("has a mid-track gap at 390px that the old last-band fallback lit", () => {
    const gap = sweep(390).filter((r) => r.css.length === 0);
    expect(gap.length).toBeGreaterThan(0);
  });
});
