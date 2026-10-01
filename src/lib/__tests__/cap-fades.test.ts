import { describe, expect, it } from "vitest";
import { applyCapFades, capFadeState, type CapFadeTarget } from "../cap-fades";
import {
  CAPTION_BANDS,
  TRACK_MAX_PX,
  TRACK_MIN_PX,
  TRACK_SVH,
} from "../lens/story/story";

// The caption fade fallback, tested through its DOM-free observer body.

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

/** whether each target ended up with `is-in` after the last batch */
const lit = (...spies: { calls: [string, boolean][] }[]) =>
  spies.map((s) => {
    const last = s.calls.at(-1);
    return last?.[0] === "is-in" && last[1];
  });

/** [band index, isIntersecting, above] */
type Report = [number, boolean, boolean];

describe("applyCapFades", () => {
  it.each<[string, number, Report[][], boolean[]]>([
    ["marks a band in when its scene starts", 1, [[[0, true, true]]], [true]],
    [
      "takes it back out when it leaves",
      2,
      [
        [[0, true, true]],
        [
          [0, false, false],
          [1, true, true],
        ],
      ],
      [false, true],
    ],
    [
      "lights only the first intersecting band in document order",
      2,
      [
        [
          [1, true, true],
          [0, true, true],
        ],
      ],
      [true, false],
    ],
    [
      "releases to the next one when the lit band leaves (the next is never re-reported)",
      2,
      [
        [
          [0, true, true],
          [1, true, true],
        ],
        [[0, false, false]],
      ],
      [false, true],
    ],
    [
      "keeps the last band lit once it has started and none crosses the line",
      2,
      [
        [
          [0, false, true],
          [1, false, true],
        ],
      ],
      [false, true],
    ],
    [
      "lights nothing in a gap before the last band",
      2,
      [
        [
          [0, false, true],
          [1, false, false],
        ],
      ],
      [false, false],
    ],
    [
      "ends the same way when the reader scrolls there instead of jumping",
      2,
      [
        [[0, true, true]],
        [
          [0, false, false],
          [1, true, true],
        ],
        [[1, false, true]],
      ],
      [false, true],
    ],
  ])("%s", (_, n, batches, expected) => {
    const spies = Array.from({ length: n }, spy);
    const state = capFadeState(spies.map((s) => s.el));
    for (const batch of batches)
      applyCapFades(
        state,
        batch.map(([i, isIntersecting, above]) => ({
          target: spies[i].el,
          isIntersecting,
          above,
        })),
      );
    expect(lit(...spies)).toEqual(expected);
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
  it.each([390, 844, 900])("agrees with the CSS path at %ipx", (vh) => {
    const track = sweep(vh);
    for (const { y, io, css } of track) {
      // the final caption lights exactly where the CSS path lights it
      if (io === FINAL) expect(css, `y=${y}`).toContain(FINAL);
      if (css.length === 1 && css[0] === FINAL)
        expect(io, `y=${y}`).toBe(FINAL);
      // otherwise a CSS-lit caption, or one entering a gap: in a gap (a
      // capEnd scene) the next band crosses the line up to one viewport
      // before its CSS fade-in starts
      if (io < 0 || css.includes(io)) continue;
      expect(css, `y=${y}`).toEqual([]);
      expect(y, `y=${y}`).toBeGreaterThan(
        CAPTION_BANDS[io].a * (track.length - 1) - vh,
      );
    }
    // the final caption holds at max scroll
    expect(track.at(-1)!.io).toBe(FINAL);
  });

  it("has a mid-track gap at 390px where no caption is lit", () => {
    const gap = sweep(390).filter((r) => r.css.length === 0);
    expect(gap.length).toBeGreaterThan(0);
  });
});
