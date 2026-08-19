import { describe, expect, it } from "vitest";
import { CHANNEL_EASE } from "../../core/scene";
import { lerp } from "../../core/math";
import {
  assembleAt,
  roseAt,
  wrapBloomWrite,
  WRAP_EASE_P0,
  WRAP_SPENT,
  CARDS_APART,
  RETURN,
  ROSE_PULSE,
} from "../envelopes";
import { peelValueAt } from "../peelcards";
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

// ============================================================================
// THE ILLEGAL PAIRS, ON THE VALUES THE SHADER ACTUALLY READS.
//
// story/__tests__/envelopes.test.ts pins the same two exclusions on the
// AUTHORED envelopes — `min(assembleAt(p), roseAt(p)) === 0` at every p — and
// that layer is the story's intent: it says the table is written so the pairs
// never meet. This file pins the OTHER half, which is the one the deform host
// sees: a channel is drawn at its EASED value (core/scene's tick does
// `value += CHANNEL_EASE·(target − value)` once per rendered frame), and an
// envelope that hands over at one p hands over on the drawn values several
// frames later — for as long as the scroll keeps moving, at any speed a hand
// can produce. Two laws stated in p were therefore false of every real frame:
//
//   · PEEL + ASSEMBLE. The peel scene's unroll and the cards scene's departure
//     are two unwrap chains on one wedge, and the cards scene now CROSSFADES
//     them on purpose — the curl is the departure's first moment. What this
//     file pins is the HAND-OFF'S SMOOTHNESS: the two channels' sum stays near
//     1 through it, so no frame sags toward rest (which is what reads as one
//     animation ending before the next begins) and none drives the pair past
//     its own saturation. It holds exactly because both are written raw below
//     WRAP_EASE_P0 — on the eased channel the wrap lags and the sum dips.
//     WHAT IT DOES NOT ESTABLISH is what the two chains do to a PIECE: the host
//     sums their DISPLACEMENTS, not their channels. That bound is measured
//     per-piece through the CPU mirror in
//     story/__tests__/piece-flow.test.ts ("never double-folds a wedge").
//   · ASSEMBLE × ROSE. The bloom folds the same material the wrap is still
//     unfolding. A fling through the ending's seam drew 0.125 of wrap under a
//     rose at 0.145; the `?story` scrubber's own scene jumps were worse.
//
// THE LAW UNDER TEST IS THE SHIPPED ONE. Both fixes live in
// story/envelopes.ts's `wrapBloomWrite` — a pure function of (p, the live eased
// wrap) that hero-driver.ts only APPLIES — so the rig below calls the real
// thing rather than a description of it: delete the raw clock or the gate and
// this suite goes red, which is the whole point of the extraction (the driver
// itself is DOM-bound and unimportable, so anything left inside it is untested
// by construction). What the rig supplies is the part that is NOT a pure
// function: core/scene's ease loop, the two callbacks' order, and the gestures.
// ============================================================================

/** ONE DISPLAY FRAME, in the real order (core/scene.ts tick + the driver's two
 *  callbacks). The scroll rAF may or may not have fired since the last frame,
 *  which is the whole point of the hold cases: the ease outlives the scroll.
 *
 *  In `LEGACY` the rig writes what the driver wrote BEFORE the fix — both
 *  channels target-only, both authored at p — so the harness can be shown to
 *  have teeth. A simulation that cannot fail the old code cannot vouch for the
 *  new one. */
interface RigOpts {
  /** apply `wrapBloomWrite`; false = the pre-fix target-only writes */
  fixed: boolean;
}
const FIXED: RigOpts = { fixed: true };
const LEGACY: RigOpts = { fixed: false };

class Rig {
  peel = 0;
  peelTarget = 0;
  assemble = 0;
  assembleTarget = 0;
  rose = 0;
  roseTarget = 0;
  lastP = 0;

  constructor(private readonly opts: RigOpts) {}

  /** the scroll rAF: story/peelcards.ts frame(p) + hero-driver.ts frame(p) */
  scroll(p: number) {
    this.lastP = p;
    // peelcards owns the unroll, value AND target (its own raw clock)
    this.peel = peelValueAt(p);
    this.peelTarget = this.peel;
    this.writeWrapBloom(p);
  }

  /** hero-driver's `writeWrapBloom` — the pair's whole law, applied exactly as
   *  the driver applies it (a `null` leaves the channel to the ease) */
  writeWrapBloom(p: number) {
    if (!this.opts.fixed) {
      this.assembleTarget = assembleAt(p);
      this.roseTarget = roseAt(p);
      return;
    }
    const w = wrapBloomWrite(p, this.assemble);
    this.assembleTarget = w.assembleTarget;
    if (w.assemble !== null) this.assemble = w.assemble;
    this.roseTarget = w.roseTarget;
    if (w.rose !== null) this.rose = w.rose;
  }

  /** core/scene tick()'s ease loop — every channel, one shared constant */
  ease() {
    this.peel = lerp(this.peel, this.peelTarget, CHANNEL_EASE);
    this.assemble = lerp(this.assemble, this.assembleTarget, CHANNEL_EASE);
    this.rose = lerp(this.rose, this.roseTarget, CHANNEL_EASE);
  }

  /** hero-driver's scene.onFrame writer, which runs AFTER the render */
  afterRender() {
    if (this.opts.fixed) this.writeWrapBloom(this.lastP);
  }
}

/** what one drawn frame shows: the TOTAL unwrap on a wedge (the two chains'
 *  channels, which the host sums) and the wrap × bloom product, which must
 *  still be an exact zero. */
const readings = (r: Rig) => ({
  unwrap: r.peel + r.assemble,
  wrapRose: Math.min(r.assemble, r.rose),
});

/** A SCROLL GESTURE, as the per-frame p a display frame is handed: `null` is a
 *  frame with no scroll event (a hold, a settle, the tail of a fling). */
type Gesture = (number | null)[];

/** run a gesture and return the worst reading of every drawn frame. The rig is
 *  SETTLED at `from` first — a reader is parked where a gesture starts, and an
 *  unsettled rig would flatter every channel by starting it below its own
 *  authored value. */
function walk(gesture: Gesture, opts: RigOpts, from?: number) {
  const rig = new Rig(opts);
  rig.scroll(from ?? (gesture.find((p) => p !== null) as number));
  for (let i = 0; i < 400; i++) {
    rig.ease();
    rig.afterRender();
  }
  let wrapRose = 0;
  let liveWrapFrames = 0;
  let unwrapLo = Infinity;
  let unwrapHi = 0;
  for (const p of gesture) {
    if (p !== null) rig.scroll(p);
    rig.ease();
    // ── the render: what this frame draws ──
    const now = readings(rig);
    wrapRose = Math.max(wrapRose, now.wrapRose);
    // the hand-off's own reading, taken only where one of the two is live
    if (rig.lastP >= HANDOFF[0] && rig.lastP <= HANDOFF[1]) {
      unwrapLo = Math.min(unwrapLo, now.unwrap);
      unwrapHi = Math.max(unwrapHi, now.unwrap);
    }
    if (rig.assemble >= WRAP_SPENT) liveWrapFrames++;
    rig.afterRender();
  }
  return { wrapRose, liveWrapFrames, unwrapLo, unwrapHi, rig };
}

// --- the scroll model -------------------------------------------------------
// px → p, off the track the page really builds (story.ts TRACK_HEIGHT_CSS) so a
// speed in px/s means what it means in a browser: p = scrollY / (track − vh).

const VIEWPORT_PX = 900;
const TRACK_PX = Math.min(
  TRACK_MAX_PX,
  Math.max(TRACK_MIN_PX, TOTAL_HOLD * VIEWPORT_PX),
);
const P_PER_PX = 1 / (TRACK_PX - VIEWPORT_PX);
const FPS = 60;
/** p per frame at a scroll speed in px/s */
const rate = (pxPerSec: number) => (pxPerSec / FPS) * P_PER_PX;

/** READING SPEED — a deliberate, controlled scroll. */
const READING = rate(500);
/** A FLICK/FLING — what a trackpad throw does. */
const FLING = rate(2000);

/** a straight scroll from `a` to `b` at `dp` per frame, then `hold` still frames */
function sweep(a: number, b: number, dp: number, hold = 0): Gesture {
  const out: Gesture = [];
  const dir = Math.sign(b - a);
  for (let p = a; dir > 0 ? p < b : p > b; p += dir * dp)
    out.push(Math.min(1, Math.max(0, p)));
  out.push(b);
  for (let i = 0; i < hold; i++) out.push(null);
  return out;
}

/** HOW LATE THE DRAWN BLOOM IS, scrolling from inside the reassembly to the end
 *  of the track at `pxPerSec`: the frames between the first p whose ENVELOPE is
 *  open and the first drawn frame whose CHANNEL is, plus what the flower has
 *  reached on the frame the track runs out and where it settles. */
function bloomWait(pxPerSec: number) {
  const START = windowEdges(RETURN)[0];
  const rig = new Rig(FIXED);
  rig.scroll(START);
  for (let i = 0; i < 400; i++) {
    rig.ease();
    rig.afterRender();
  }
  const dp = rate(pxPerSec);
  let p = START;
  let authored = -1;
  let drawn = -1;
  let roseAtTrackEnd = -1;
  for (let f = 0; f < 1200; f++) {
    if (p < 1) {
      p = Math.min(1, p + dp);
      rig.scroll(p);
    }
    rig.ease();
    // ── the render ──
    if (authored < 0 && roseAt(p) > 0) authored = f;
    if (drawn < 0 && rig.rose > 0) drawn = f;
    if (roseAtTrackEnd < 0 && p >= 1) roseAtTrackEnd = rig.rose;
    rig.afterRender();
  }
  return {
    frames: drawn - authored,
    sec: (drawn - authored) / FPS,
    roseAtTrackEnd,
    roseFinal: rig.rose,
  };
}

const cdR = rangeOf("cards");
const peR = rangeOf("peel");

/** THE HAND-OFF: from the frame the unroll is fully out to the frame the
 *  departure saturates. The sum law is read inside it — either side, one chain
 *  owns the wedge alone and is ramping from or to its own 0. */
const HANDOFF: [number, number] = [
  atFrac(peR, 0.5),
  windowEdges(CARDS_APART.rise)[1],
];

describe("the two unwrap chains, on the EASED channels", () => {
  it("hands the wedge over WITHOUT A LULL, at every scroll speed", () => {
    // ONE MOTION, on the channels: the curl's release and the departure's rise
    // cross, so the total never sags toward a rest frame. (The per-PIECE fold
    // bound is piece-flow's, for the reason in this file's header.)
    for (const [name, dp] of [
      ["reading", READING],
      ["fling", FLING],
    ] as const) {
      const w = walk(sweep(0, 1, dp, 240), FIXED);
      expect(w.unwrapLo, `${name}, down the page`).toBeGreaterThan(0.85);
      expect(w.unwrapHi, `${name}, down the page`).toBeLessThanOrEqual(1.001);
      const back = walk(sweep(1, 0, dp, 240), FIXED, 1);
      expect(back.unwrapLo, `${name}, back up it`).toBeGreaterThan(0.85);
      expect(back.unwrapHi, `${name}, back up it`).toBeLessThanOrEqual(1.001);
    }
  });

  it("holds that hand-off through the flick THE REVIEW CAUGHT", () => {
    // a reader parked mid-departure flicks back up into the peel — the gesture
    // that used to draw both chains summed at full strength
    const gesture = sweep(atFrac(cdR, 0.34), atFrac(peR, 0.8), FLING, 180);
    const w = walk(gesture, FIXED);
    expect(w.unwrapLo).toBeGreaterThan(0.85);
    expect(w.unwrapHi).toBeLessThanOrEqual(1.001);
    // …and it is the RAW CLOCK that buys it: left on the ease, the wrap decays
    // over a curl the scroll has already put back, and the same flick folds the
    // wedge under both chains at once.
    expect(walk(gesture, LEGACY).unwrapHi).toBeGreaterThan(1.2);
  });

  it("holds it on the way DOWN, where the ease would sag instead", () => {
    const gesture = sweep(atFrac(peR, 0.8), atFrac(cdR, 0.34), FLING, 120);
    expect(walk(gesture, FIXED).unwrapLo).toBeGreaterThan(0.85);
    expect(walk(gesture, LEGACY).unwrapLo).toBeLessThan(0.7);
  });

  it("keeps the wrap and the bloom off the same wedge through the ending", () => {
    const seam = windowEdges(ROSE_PULSE.rise)[0];
    for (const [name, dp] of [
      ["reading", READING],
      ["fling", FLING],
    ] as const) {
      const into = walk(sweep(seam - 0.09, 1, dp, 300), FIXED, seam - 0.09);
      expect(into.wrapRose, `${name}, into the bloom`).toBe(0);
      const out = walk(sweep(1, seam - 0.09, dp, 300), FIXED, 1);
      expect(out.wrapRose, `${name}, back out of it`).toBe(0);
    }
    // THE HARSHEST INPUT the ending has, now that the wrap is spent a third of
    // a scene before the bloom opens: a `?story` jump from inside the wrap's
    // own fall straight to the end of the track. Ungated it draws the two on
    // one wedge; the floor is a witness the rig reproduces the fault.
    const jump: Gesture = [1, ...Array(300).fill(null)];
    const wrapLive = atFrac(rangeOf("rewrap"), 0.5);
    expect(walk(jump, FIXED, wrapLive).wrapRose).toBe(0);
    expect(walk(jump, LEGACY, wrapLive).wrapRose).toBeGreaterThan(0.05);
  });

  it("keeps both pairs off EVERY `?story` scene jump", () => {
    // The dev scrubber parks the story at a scene's hold centre in one frame —
    // no intermediate p at all, so the eased channels walk the whole distance
    // on their own. It is the harshest input the page has, and the worst
    // offender (0.161 of overlap on the second frame of cards → capsOn).
    const holds = RANGES.map((r) => holdCentreOf(r));
    for (const from of holds)
      for (const to of holds) {
        const jump: Gesture = [to, ...Array(300).fill(null)];
        const w = walk(jump, FIXED, from);
        expect(w.wrapRose, `wrap × rose on ${from} → ${to}`).toBe(0);
        expect(w.unwrapHi, `unwrap sum on ${from} → ${to}`).toBeLessThanOrEqual(
          1.001,
        );
      }
  });

  it("keeps both pairs off a scrubber DRAG, in either direction", () => {
    // the ?story slider: a chain of small jumps with no scroll physics at all
    const drag: Gesture = [];
    for (let i = 0; i <= 100; i++) drag.push(i / 100, null, null);
    for (let i = 100; i >= 0; i--) drag.push(i / 100, null, null);
    const w = walk(drag, FIXED);
    expect(w.wrapRose).toBe(0);
    expect(w.unwrapHi).toBeLessThanOrEqual(1.001);
    expect(w.unwrapLo).toBeGreaterThan(0.85);
  });
});

describe("what the two clocks each keep", () => {
  it("draws the cards chapter's wrap at exactly its authored value", () => {
    // the raw half: below WRAP_EASE_P0 the channel IS the envelope, at any
    // scroll speed and after any jump, which is what makes CARDS_APART's
    // containment inside the valley a statement about drawn frames
    const rig = new Rig(FIXED);
    for (const p of [
      ...sweep(atFrac(cdR, 0.9), atFrac(cdR, 0.1), FLING),
      atFrac(cdR, 0.5),
      atFrac(peR, 0.5),
      0.9,
      atFrac(cdR, 0.3),
    ]) {
      if (p === null) continue;
      rig.scroll(p);
      rig.ease();
      if (p < WRAP_EASE_P0)
        expect(rig.assemble, `wrap at ${p}`).toBe(assembleAt(p));
      rig.afterRender();
    }
  });

  it("lets the sky chapter's wrap OUTLIVE the scroll — the ease is still there", () => {
    // the eased half, pinned so a future "put everything on the raw clock" fix
    // cannot quietly take the ending's smear with it: after a fling that lands
    // past the wrap's own last frame, the pieces are still visibly flying home
    // for a good fraction of a second with no scroll left to drive them.
    const [r0, r1] = windowEdges(RETURN);
    const fling = sweep(r0 + (r1 - r0) * 0.4, r1 + 0.02, FLING);
    const w = walk(
      [...fling, ...Array(300).fill(null)],
      FIXED,
      r0 + (r1 - r0) * 0.4,
    );
    // frames drawn with the wrap still folding, all of them after the authored
    // envelope had already handed over
    expect(w.liveWrapFrames).toBeGreaterThan(20);
    // …and it does land: the channel is spent, exactly, not asymptotically
    expect(w.rig.assemble).toBe(0);
  });

  it("opens the bloom once the wrap is spent, not before and not never", () => {
    const seam = windowEdges(ROSE_PULSE.rise)[0];
    const w = walk(
      [...sweep(seam - 0.06, 1, FLING), ...Array(600).fill(null)],
      FIXED,
      seam - 0.06,
    );
    expect(w.rig.assemble).toBe(0);
    expect(w.rig.rose).toBeGreaterThan(0.9);
  });

  it("BOUNDS THE BLOOM'S WAIT — the ending may not be spent waiting", () => {
    // THE COST OF THE GATE, MEASURED AND PINNED. The bloom opening late is a
    // user-visible regression the invariant cannot see: on `WRAP_SPENT` at the
    // shader's own idle epsilon (1e-6) the same gate held the flower shut for
    // 1.05 s at 300 px/s, 1.18 s at 500, and at 1000 px/s and up the WHOLE
    // bloom played after the track had run out — the settle beat capsOn's hold
    // exists to buy, spent on an invisible thousandth of wrap. These bounds are
    // what stop a retune of that threshold from doing it again.
    const wait: Record<number, ReturnType<typeof bloomWait>> = {};
    for (const px of [300, 500, 1000, 2000]) wait[px] = bloomWait(px);

    // reading speeds: a fifth of a second, i.e. under the eye's own hand-over
    expect(wait[300].sec, "300 px/s").toBeLessThanOrEqual(0.15);
    expect(wait[500].sec, "500 px/s").toBeLessThanOrEqual(0.25);
    // and no gesture at all may cost more than a third of the bloom's own rise
    for (const px of [1000, 2000])
      expect(wait[px].sec, `${px} px/s`).toBeLessThanOrEqual(0.6);

    // …and the flower is OPEN on the frame the track ends, at every speed a
    // reader can produce with intent. The 2000 px/s fling is exempt and the
    // cost is the GATE'S, not the rose's own ease (gated ≈ 0.12 at track end
    // vs ≈ 0.88 ungated): accepted because a hard fling is a skip-to-the-end
    // gesture and the settle pin below holds the flower to fully open.
    for (const px of [300, 500, 1000])
      expect(wait[px].roseAtTrackEnd, `${px} px/s at p = 1`).toBeGreaterThan(
        0.95,
      );
    // the gate never STOPS the bloom, at any speed
    for (const px of [300, 500, 1000, 2000])
      expect(wait[px].roseFinal, `${px} px/s settled`).toBeGreaterThan(0.99);
  });

  it("shuts the bloom on the frame the wrap re-opens, scrolling back up", () => {
    // the mirror case, and the one a target-only gate cannot buy: the rose's
    // own decay would otherwise sit under a rising wrap for half a second
    const rig = new Rig(FIXED);
    rig.scroll(1);
    for (let i = 0; i < 400; i++) {
      rig.ease();
      rig.afterRender();
    }
    expect(rig.rose).toBeGreaterThan(0.9);
    const back = windowEdges(CARDS_APART.rise)[1];
    for (const p of sweep(1, back, FLING)) {
      if (p !== null) rig.scroll(p);
      rig.ease();
      expect(Math.min(rig.assemble, rig.rose), `at ${p}`).toBe(0);
      rig.afterRender();
    }
  });
});
