import { describe, expect, it } from "vitest";
import {
  CAP_BAND_SELECTOR,
  CAP_FADE_ROOT_MARGIN,
  applyCapFades,
  capFadeState,
  type CapFadeTarget,
} from "../cap-fades";

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
    applyCapFades(state, [{ target: a.el, isIntersecting: true }]);
    expect(a.calls).toEqual([["is-in", true]]);
  });

  it("takes it back OUT when it leaves — unlike the [data-reveal] reveal, which fires once", () => {
    const a = spy();
    const b = spy();
    const state = capFadeState([a.el, b.el]);
    applyCapFades(state, [{ target: a.el, isIntersecting: true }]);
    applyCapFades(state, [
      { target: a.el, isIntersecting: false },
      { target: b.el, isIntersecting: true },
    ]);
    expect(lit(a, b)).toEqual([false, true]);
  });

  it("lights only the FIRST intersecting band in document order", () => {
    const a = spy();
    const b = spy();
    const state = capFadeState([a.el, b.el]);
    applyCapFades(state, [
      { target: b.el, isIntersecting: true },
      { target: a.el, isIntersecting: true },
    ]);
    expect(lit(a, b)).toEqual([true, false]);
  });

  it("releases to the next one when the lit band leaves", () => {
    const a = spy();
    const b = spy();
    const state = capFadeState([a.el, b.el]);
    applyCapFades(state, [
      { target: a.el, isIntersecting: true },
      { target: b.el, isIntersecting: true },
    ]);
    expect(lit(a, b)).toEqual([true, false]);
    // only `a` reports out — `b` is still intersecting and never re-reported
    applyCapFades(state, [{ target: a.el, isIntersecting: false }]);
    expect(lit(a, b)).toEqual([false, true]);
  });

  it("falls back to the LAST band when none crosses the line", () => {
    // the bands tile the track, so this only happens past the last one — at
    // maximum scroll, where the line lands exactly on its bottom edge and the
    // CSS path deliberately keeps the final caption lit
    const a = spy();
    const b = spy();
    const state = capFadeState([a.el, b.el]);
    applyCapFades(state, [
      { target: a.el, isIntersecting: false },
      { target: b.el, isIntersecting: false },
    ]);
    expect(lit(a, b)).toEqual([false, true]);
  });

  it("gets there the same way whether the reader scrolled or jumped", () => {
    const a = spy();
    const b = spy();
    const scrolled = capFadeState([a.el, b.el]);
    applyCapFades(scrolled, [{ target: a.el, isIntersecting: true }]);
    applyCapFades(scrolled, [
      { target: a.el, isIntersecting: false },
      { target: b.el, isIntersecting: true },
    ]);
    applyCapFades(scrolled, [{ target: b.el, isIntersecting: false }]);
    const viaScroll = lit(a, b);

    const c = spy();
    const d = spy();
    const jumped = capFadeState([c.el, d.el]);
    applyCapFades(jumped, [
      { target: c.el, isIntersecting: false },
      { target: d.el, isIntersecting: false },
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
    // Why the bottom and not the top: a band for [a, b] spans document
    // [a·S, b·S + 100dvh], so it crosses the bottom line over
    // scrollY ∈ [a·S − 100dvh, b·S] — and with the first-in-document-order rule
    // above, a caption is lit over its own scene shifted by one CAPTION_PAD of
    // scroll. Anchoring to the TOP (`0px 0px -100% 0px`) adds a whole viewport
    // to both ends. No viewport-height term survives either way, so this holds
    // at every screen size — nothing here to "tune".
  });
});
