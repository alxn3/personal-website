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
  TOTAL_HOLD,
  TRACK_MAX_PX,
  TRACK_MIN_PX,
  windowEdges,
} from "../story";

// assemble/explode × rose must never both be nonzero on one frame (the bloom
// folding pieces that are still moving). Every drawn frame is the envelopes at
// some eased p, so checking every p covers every frame. (Nothing drives peel,
// the other unwrap: story-driver.test.ts pins it at 0.)

/** a dense sweep of p plus every 1/40 fraction of every scene */
const SWEEP: number[] = (() => {
  const ps = new Set<number>();
  for (let i = 0; i <= 4000; i++) ps.add(i / 4000);
  for (const r of RANGES)
    for (let f = 0; f <= 40; f++) ps.add(atFrac(r, f / 40));
  return [...ps].sort((a, b) => a - b);
})();

/** the illegal pair's overlap at p */
const wrapRoseAt = (p: number) =>
  Math.min(Math.max(assembleAt(p), explodeAt(p)), roseAt(p));

describe("the illegal pair, at every p the clock can reach", () => {
  it("never draws the wrap and the bloom on the same wedge", () => {
    for (const p of SWEEP) expect(wrapRoseAt(p), `p ${p}`).toBe(0);
    // and as a window order
    const [, wrapEnd] = windowEdges(CARDS_APART.fall);
    const [, spreadEnd] = windowEdges(EXPLODE_PULSE.fall);
    const [bloom] = windowEdges(ROSE_PULSE.rise);
    expect(wrapEnd).toBeLessThan(bloom);
    expect(spreadEnd).toBeLessThan(bloom);
  });
});

// --- the eased clock, stepped as core/scene's tick does, on the real track
// height so scroll speeds are in real px/s

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
  let liveSpreadFrames = 0;
  let explode = 0;
  let rose = 0;
  for (const p of gesture) {
    if (p !== null) target = p;
    story = easeStep(story, target, EASE_FRAME_MS);
    const pE = clamp01(story);
    wrapRose = Math.max(wrapRose, wrapRoseAt(pE));
    explode = explodeAt(pE);
    rose = roseAt(pE);
    if (explode > 0) liveSpreadFrames++;
  }
  return { wrapRose, liveSpreadFrames, explode, rose, story };
}

describe("the one clock, walked", () => {
  it("keeps the pair off every `?story` scene jump", () => {
    // the dev panel jumps between hold centres in one frame
    const holds = RANGES.map((r) => holdCentreOf(r));
    for (const from of holds)
      for (const to of holds)
        expect(
          walk([to, ...Array(300).fill(null)], from).wrapRose,
          `${from} → ${to}`,
        ).toBe(0);
  });

  it("keeps the pair off a fling and a read, in both directions", () => {
    for (const dp of [READING, FLING]) {
      expect(walk(sweep(0, 1, dp, 240), 0).wrapRose).toBe(0);
      expect(walk(sweep(1, 0, dp, 240), 1).wrapRose).toBe(0);
    }
  });

  it("lets the ending's explode outlive the scroll, then rest exactly", () => {
    // after a fling past the descent the pieces are still flying home
    const [r0, r1] = windowEdges(EXPLODE_PULSE.fall);
    const from = r0 + (r1 - r0) * 0.4;
    const w = walk(
      [...sweep(from, r1 + 0.02, FLING), ...Array(300).fill(null)],
      from,
    );
    expect(w.liveSpreadFrames).toBeGreaterThan(20);
    // and land on exactly 0, so the host can skip the recipe
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
