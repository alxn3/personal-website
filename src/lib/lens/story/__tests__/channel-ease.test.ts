import { describe, expect, it } from "vitest";
import { EASE_FRAME_MS, easeStep } from "../../core/scene";
import { clamp01 } from "../../core/math";
import {
  assembleAt,
  explodeAt,
  roseAt,
  CARDS_APART,
  EXPLODE_PULSE,
  ROSE_PULSE,
} from "../envelopes";
import {
  atFrac,
  holdCentreOf,
  RANGES,
  rangeOf,
  TOTAL_HOLD,
  TRACK_MAX_PX,
  TRACK_MIN_PX,
  windowEdges,
} from "../story";
import { storyStateAt } from "../state";

// ============================================================================
// THE ILLEGAL PAIRS, ON THE VALUES THE SHADER ACTUALLY READS.
//
// Story mode draws every channel at f(pE), the envelope at ONE eased story p
// (core/scene's evaluate step), so the drawn value on any frame is an authored
// value at SOME p in [0, 1]. An exclusion that holds at every p therefore holds
// on every drawn frame, at every scroll speed, after every jump. The pairs:
//
//   · PEEL × ASSEMBLE — two unwrap chains on one wedge. The story has no peel
//     writer, so this is a TRIPWIRE: add one and these go red.
//   · FOLD × ROSE — the bloom folds material the wrap (cards) or the spread
//     (ending) is still folding.
// ============================================================================

/** a dense sweep plus every scene-fraction edge — the smoothstep feet */
const SWEEP: number[] = (() => {
  const ps = new Set<number>();
  for (let i = 0; i <= 4000; i++) ps.add(i / 4000);
  for (const r of RANGES)
    for (let f = 0; f <= 40; f++) ps.add(atFrac(r, f / 40));
  return [...ps].sort((a, b) => a - b);
})();

/** what one drawn frame shows of the two illegal pairs at p */
const readings = (p: number) => ({
  peelWrap: Math.min(storyStateAt(p).channels.peel, assembleAt(p)),
  wrapRose: Math.min(Math.max(assembleAt(p), explodeAt(p)), roseAt(p)),
});

describe("the illegal pairs, at every p the clock can reach", () => {
  it("never draws the wrap and the bloom on the same wedge", () => {
    for (const p of SWEEP) expect(readings(p).wrapRose, `p ${p}`).toBe(0);
    // …as a WINDOW ORDER, so a retune that overlaps them fails by name
    const [, wrapEnd] = windowEdges(CARDS_APART.fall);
    const [, spreadEnd] = windowEdges(EXPLODE_PULSE.fall);
    const [bloom] = windowEdges(ROSE_PULSE.rise);
    expect(wrapEnd).toBeLessThan(bloom);
    expect(spreadEnd).toBeLessThan(bloom);
  });

  it("never draws two unwrap chains on one wedge — nothing drives peel", () => {
    for (const p of SWEEP) {
      expect(storyStateAt(p).channels.peel, `peel at ${p}`).toBe(0);
      expect(readings(p).peelWrap, `p ${p}`).toBe(0);
    }
  });
});

// --- the clock model --------------------------------------------------------
// One eased p, stepped as core/scene's tick steps it, with every channel drawn
// at f(pE). px → p off the track the page really builds (story.ts
// TRACK_HEIGHT_CSS), so a speed in px/s means what it means in a browser.

const VIEWPORT_PX = 900;
const TRACK_PX = Math.min(
  TRACK_MAX_PX,
  Math.max(TRACK_MIN_PX, TOTAL_HOLD * VIEWPORT_PX),
);
const P_PER_PX = 1 / (TRACK_PX - VIEWPORT_PX);
const FPS = 60;
const rate = (pxPerSec: number) => (pxPerSec / FPS) * P_PER_PX;
const READING = rate(500);
const FLING = rate(2000);

/** a scroll gesture as per-frame p; `null` is a frame with no scroll event */
type Gesture = (number | null)[];

function sweep(a: number, b: number, dp: number, hold = 0): Gesture {
  const out: Gesture = [];
  const dir = Math.sign(b - a);
  for (let p = a; dir > 0 ? p < b : p > b; p += dir * dp)
    out.push(Math.min(1, Math.max(0, p)));
  out.push(b);
  for (let i = 0; i < hold; i++) out.push(null);
  return out;
}

/** run a gesture from a settled `from`, drawing f(pE) each frame */
function walk(gesture: Gesture, from: number) {
  let story = from;
  let target = from;
  let wrapRose = 0;
  let peelWrap = 0;
  let liveSpreadFrames = 0;
  let explode = 0;
  let rose = 0;
  for (const p of gesture) {
    if (p !== null) target = p;
    story = easeStep(story, target, EASE_FRAME_MS);
    const pE = clamp01(story);
    // ── the render: what this frame draws ──
    const r = readings(pE);
    wrapRose = Math.max(wrapRose, r.wrapRose);
    peelWrap = Math.max(peelWrap, r.peelWrap);
    explode = explodeAt(pE);
    rose = roseAt(pE);
    if (explode > 0) liveSpreadFrames++;
  }
  return { wrapRose, peelWrap, liveSpreadFrames, explode, rose, story };
}

describe("the one clock, walked", () => {
  it("keeps both pairs off EVERY `?story` scene jump", () => {
    // the dev scrubber parks the story at a hold centre in one frame — no
    // intermediate p, so the eased p walks the whole distance alone
    const holds = RANGES.map((r) => holdCentreOf(r));
    for (const from of holds)
      for (const to of holds) {
        const w = walk([to, ...Array(300).fill(null)], from);
        expect(w.wrapRose, `wrap × rose on ${from} → ${to}`).toBe(0);
        expect(w.peelWrap, `peel × wrap on ${from} → ${to}`).toBe(0);
      }
  });

  it("keeps both pairs off a fling and a read, in both directions", () => {
    for (const dp of [READING, FLING]) {
      expect(walk(sweep(0, 1, dp, 240), 0).wrapRose).toBe(0);
      expect(walk(sweep(1, 0, dp, 240), 1).wrapRose).toBe(0);
    }
  });

  it("lets the ENDING'S SPREAD outlive the scroll, then rest EXACTLY", () => {
    // after a fling past the descent's last frame the pieces are still flying
    // home with no scroll left to drive them…
    const [r0, r1] = windowEdges(EXPLODE_PULSE.fall);
    const from = r0 + (r1 - r0) * 0.4;
    const w = walk(
      [...sweep(from, r1 + 0.02, FLING), ...Array(300).fill(null)],
      from,
    );
    expect(w.liveSpreadFrames).toBeGreaterThan(20);
    // …and land on the envelope's plateau: an exact 0, not an asymptote, which
    // is what lets ops/host.ts's idle gate skip the recipe outright
    expect(Object.is(w.explode, 0), "spent exactly").toBe(true);
    expect(w.story).toBe(r1 + 0.02);
  });

  it("opens the bloom once the spread is spent, and never stalls it", () => {
    const seam = windowEdges(ROSE_PULSE.rise)[0];
    const w = walk(
      [...sweep(seam - 0.06, 1, FLING), ...Array(600).fill(null)],
      seam - 0.06,
    );
    expect(Object.is(w.explode, 0)).toBe(true);
    expect(w.rose).toBe(1);
  });

  it("shuts the bloom on the frame the fold re-opens, scrolling back up", () => {
    const back = windowEdges(CARDS_APART.rise)[1];
    const w = walk(sweep(1, back, FLING), 1);
    expect(w.wrapRose).toBe(0);
    expect(w.rose).toBe(0);
  });
});

describe("the two chapters the clock is walked through", () => {
  const cdR = rangeOf("cards");
  it("draws the wrap at exactly its authored value once the clock lands", () => {
    // parked anywhere in the cards chapter, the settled frame IS the envelope
    for (const p of [atFrac(cdR, 0.1), atFrac(cdR, 0.5), atFrac(cdR, 0.9)]) {
      const w = walk([p, ...Array(200).fill(null)], 0);
      expect(w.story).toBe(p);
      expect(assembleAt(clamp01(w.story))).toBe(assembleAt(p));
    }
  });
});
